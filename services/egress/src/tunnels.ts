/**
 * Live tunnel bookkeeping: which sockets belong to which device, credential,
 * and user, so caps can be enforced and revocations can cut running tunnels.
 * Nothing here knows the target — a tunnel is identified only by the
 * authenticated ids and its byte counters.
 */

import type net from "node:net";

export interface TunnelIdentity {
  readonly userId: string;
  readonly deviceId: string;
  readonly credentialId: string;
}

/** One CONNECT that passed authentication, from slot reservation to close. */
export class Tunnel {
  readonly identity: TunnelIdentity;
  readonly client: net.Socket;
  readonly startedAt: number;
  upstream: net.Socket | null = null;
  bytesToTarget = 0;
  bytesToClient = 0;
  #destroyed = false;

  constructor(identity: TunnelIdentity, client: net.Socket, startedAt: number) {
    this.identity = identity;
    this.client = client;
    this.startedAt = startedAt;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  /** Tear down both ends immediately (revocation, idle, shutdown). */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.upstream?.destroy();
    this.client.destroy();
  }
}

/** Per-device, per-credential, and per-user indexes over live tunnels. */
export class TunnelRegistry {
  readonly #byDevice = new Map<string, Set<Tunnel>>();
  readonly #byCredential = new Map<string, Set<Tunnel>>();
  readonly #byUser = new Map<string, Set<Tunnel>>();
  readonly #all = new Set<Tunnel>();

  get size(): number {
    return this.#all.size;
  }

  countForDevice(deviceId: string): number {
    return this.#byDevice.get(deviceId)?.size ?? 0;
  }

  countForUser(userId: string): number {
    return this.#byUser.get(userId)?.size ?? 0;
  }

  countForCredential(credentialId: string): number {
    return this.#byCredential.get(credentialId)?.size ?? 0;
  }

  /** Users with at least one live tunnel. */
  activeUsers(): string[] {
    return [...this.#byUser.keys()];
  }

  add(tunnel: Tunnel): void {
    if (this.#all.has(tunnel)) return;
    this.#all.add(tunnel);
    index(this.#byDevice, tunnel.identity.deviceId, tunnel);
    index(this.#byCredential, tunnel.identity.credentialId, tunnel);
    index(this.#byUser, tunnel.identity.userId, tunnel);
  }

  /** True when the tunnel was registered (so a caller can act exactly once). */
  remove(tunnel: Tunnel): boolean {
    if (!this.#all.delete(tunnel)) return false;
    unindex(this.#byDevice, tunnel.identity.deviceId, tunnel);
    unindex(this.#byCredential, tunnel.identity.credentialId, tunnel);
    unindex(this.#byUser, tunnel.identity.userId, tunnel);
    return true;
  }

  /** Destroy every tunnel of a device; returns how many were cut. */
  destroyByDevice(deviceId: string): number {
    return destroyAll(this.#byDevice.get(deviceId));
  }

  /** Destroy every tunnel opened with a credential; returns how many were cut. */
  destroyByCredential(credentialId: string): number {
    return destroyAll(this.#byCredential.get(credentialId));
  }

  destroyAll(): number {
    return destroyAll(this.#all);
  }
}

function index(map: Map<string, Set<Tunnel>>, key: string, tunnel: Tunnel): void {
  let set = map.get(key);
  if (set === undefined) {
    set = new Set();
    map.set(key, set);
  }
  set.add(tunnel);
}

function unindex(map: Map<string, Set<Tunnel>>, key: string, tunnel: Tunnel): void {
  const set = map.get(key);
  if (set === undefined) return;
  set.delete(tunnel);
  if (set.size === 0) map.delete(key);
}

function destroyAll(set: Set<Tunnel> | undefined): number {
  if (set === undefined) return 0;
  const tunnels = [...set];
  for (const tunnel of tunnels) tunnel.destroy();
  return tunnels.length;
}
