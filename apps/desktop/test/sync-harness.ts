/**
 * Test doubles for the sync service (docs/cloud-sync-design.md §10.2): a
 * cookie jar that behaves like Electron's per-Space session, a hub transport
 * the test drives by hand (hello, hydrate.done, lease answers, revocation),
 * a device store slice with real keys, and the BrowserController surface the
 * service gates. The engines, keys, sealing, and queue files are real.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cookie, CookiesSetDetails, Session } from "electron";
import {
  exportPublicKeyRaw,
  generateAgreementKeypair,
  generateDeviceKeypair,
  type CookieRecordWire,
  type DevicePresence,
  type WorkspaceRecordWire,
} from "@pistachio/sync-protocol";
import type {
  HubTransport,
  LeaseAcquireOptions,
  LeaseOutcome,
  TransportEvents,
  TransportState,
} from "@pistachio/sync-engine";
import type { ControlClient } from "../src/main/account/control-client";
import type { DeviceIdentity } from "../src/main/account/device-store";
import { BookmarkStore } from "../src/main/bookmark-store";
import { MemoryStore } from "../src/main/memory-store";
import { ReminderStore } from "../src/main/reminder-store";
import { SpaceStore } from "../src/main/space-store";
import { WorkspaceRecords } from "../src/main/sync/records";
import type { DeviceRegistryRow } from "../src/main/sync/device-registry";
import { SyncService, type SyncBrowser, type SyncDevice } from "../src/main/sync/service";
import type { SyncStatus, WorkspaceSyncStatus } from "@pistachio/shell-contracts/ipc";
import { EMPTY_TAB_SESSION, type DurableTabSession } from "@pistachio/shell-contracts/tab-session";

export const SPACE_SECRET = new Uint8Array(32).fill(7);
export const WORKSPACE_SECRET = new Uint8Array(32).fill(8);

export function cookieOf(name: string, domain = ".gmail.com", value = `${name}-value`): Cookie {
  return {
    name,
    value,
    domain,
    hostOnly: !domain.startsWith("."),
    path: "/",
    secure: true,
    httpOnly: true,
    session: true,
    sameSite: "lax",
  };
}

/** A cookie jar with Electron's `cookies` surface, driven by the test. */
export class FakeCookieJar extends EventEmitter {
  readonly jar = new Map<string, Cookie>();
  readonly sets: CookiesSetDetails[] = [];
  readonly removals: Array<{ url: string; name: string }> = [];
  /** Cookie names Chromium refuses (prefix rules, SameSite=None without Secure). */
  readonly refuse = new Set<string>();
  /**
   * Parks every `set` until it resolves, so a test can hold a write inside
   * Electron's cookie API the way a slow real one sits there.
   */
  holdSet: Promise<void> | null = null;

  async get(filter: { name?: string; url?: string } = {}): Promise<Cookie[]> {
    return [...this.jar.values()].filter((cookie) => filter.name === undefined || cookie.name === filter.name);
  }

  async set(details: CookiesSetDetails): Promise<void> {
    this.sets.push(details);
    if (this.holdSet !== null) await this.holdSet;
    if (this.refuse.has(details.name ?? "")) throw new Error(`Failed to set cookie ${details.name ?? ""}`);
    const host = new URL(details.url).hostname;
    const cookie: Cookie = {
      name: details.name ?? "",
      value: details.value ?? "",
      domain: details.domain ?? host,
      hostOnly: details.domain === undefined,
      path: details.path ?? "/",
      secure: details.secure ?? false,
      httpOnly: details.httpOnly ?? false,
      session: details.expirationDate === undefined,
      ...(details.expirationDate === undefined ? {} : { expirationDate: details.expirationDate }),
      sameSite: details.sameSite ?? "unspecified",
    };
    this.jar.set(keyOf(cookie), cookie);
  }

  async remove(url: string, name: string): Promise<void> {
    this.removals.push({ url, name });
    const host = new URL(url).hostname;
    for (const [key, cookie] of this.jar) {
      if (cookie.name === name && (cookie.domain ?? "").replace(/^\./, "") === host) this.jar.delete(key);
    }
  }

  async flushStore(): Promise<void> {
    // Nothing to flush.
  }

  /** Put a cookie in the jar (or take it out) and announce it as Chromium would. */
  changed(cookie: Cookie, cause = "explicit", removed = false): void {
    if (removed) this.jar.delete(keyOf(cookie));
    else this.jar.set(keyOf(cookie), cookie);
    this.emit("changed", {}, cookie, cause, removed);
  }
}

function keyOf(cookie: Cookie): string {
  return `${cookie.name}|${cookie.domain ?? ""}|${cookie.path ?? "/"}`;
}

export interface FakeSession {
  cookies: FakeCookieJar;
}

export function fakeSession(): FakeSession {
  return { cookies: new FakeCookieJar() };
}

export class FakeBrowser implements SyncBrowser {
  readonly sessions = new Map<string, FakeSession>();
  readonly hydrating: string[] = [];
  readonly ready: string[] = [];
  readonly applied: Array<{ spaceId: string; mode: "replace" | "merge"; tabIds: string[] }> = [];
  readonly reloaded: string[] = [];

  jar(spaceId: string): FakeCookieJar {
    return this.session(spaceId).cookies;
  }

  session(spaceId: string): FakeSession {
    let session = this.sessions.get(spaceId);
    if (session === undefined) {
      session = fakeSession();
      this.sessions.set(spaceId, session);
    }
    return session;
  }

  sessionFor(spaceId: string): Session {
    return this.session(spaceId) as unknown as Session;
  }

  markSessionHydrating(spaceId: string): void {
    this.hydrating.push(spaceId);
  }

  markSessionReady(spaceId: string): void {
    this.ready.push(spaceId);
  }

  async applyDurableSession(durable: DurableTabSession, spaceId: string, mode: "replace" | "merge"): Promise<void> {
    this.applied.push({ spaceId, mode, tabIds: (durable.spaces[spaceId]?.tabs ?? []).map((tab) => tab.id) });
  }

  reloadSpace(spaceId: string): void {
    this.reloaded.push(spaceId);
  }
}

export class FakeTransport implements HubTransport {
  state: TransportState = "offline";
  started: string[] | null = null;
  declared: string[] = [];
  reconnects = 0;
  stops = 0;
  readonly published: CookieRecordWire[] = [];
  readonly workspace: WorkspaceRecordWire[] = [];
  readonly leaseCalls: Array<{ spaceId: string; originId: string; opts: LeaseAcquireOptions | undefined }> = [];
  readonly released: string[] = [];
  leaseOutcome: LeaseOutcome = { granted: true, exclusive: false };

  constructor(
    readonly url: string | null,
    readonly events: TransportEvents,
  ) {}

  start(spaceIds: string[]): void {
    this.started = [...spaceIds];
    this.declared = [...spaceIds];
    this.state = "connecting";
    this.events.onStateChanged?.("connecting");
  }

  addSpace(spaceId: string): void {
    if (!this.declared.includes(spaceId)) this.declared.push(spaceId);
  }

  async updateSpaces(spaceIds: string[]): Promise<void> {
    this.declared = [...spaceIds];
  }

  stop(): void {
    this.stops += 1;
    if (this.state === "off") return;
    this.state = "offline";
    this.events.onStateChanged?.("offline");
  }

  reconnect(): void {
    this.reconnects += 1;
  }

  publish(records: CookieRecordWire[]): void {
    this.published.push(...records);
  }

  publishWorkspace(docs: WorkspaceRecordWire[]): void {
    this.workspace.push(...docs);
  }

  async flushCookiePublishes(): Promise<boolean> {
    return true;
  }

  async acquireLease(spaceId: string, originId: string, opts?: LeaseAcquireOptions): Promise<LeaseOutcome> {
    this.leaseCalls.push({ spaceId, originId, opts });
    return this.leaseOutcome;
  }

  releaseLease(_spaceId: string, originId: string): void {
    this.released.push(originId);
  }

  presence(): DevicePresence[] {
    return [];
  }

  /** hello.ack, then hydrate.done for every declared Space and the workspace stream. */
  connect(): void {
    this.state = "connected";
    this.events.onStateChanged?.("connected");
    for (const spaceId of this.declared) this.events.onHydrated?.(spaceId);
    this.events.onWorkspaceHydrated?.();
  }

  offline(): void {
    this.state = "offline";
    this.events.onStateChanged?.("offline");
  }

  /** The hub closed the socket 4003. */
  revoke(): void {
    this.state = "off";
    this.events.onStateChanged?.("off");
    this.events.onRevoked?.();
  }
}

export async function fakeDevice(
  deviceId = "mac-a",
  spaceSecret: (spaceId: string) => Uint8Array | null = () => SPACE_SECRET,
): Promise<SyncDevice & { keypair: Awaited<ReturnType<typeof generateDeviceKeypair>> }> {
  const keypair = await generateDeviceKeypair();
  const agreement = await generateAgreementKeypair();
  const identity: DeviceIdentity = {
    deviceId,
    signingKey: keypair.privateKey,
    signingPublicKey: keypair.publicKey,
    devicePublicKeyRaw: await exportPublicKeyRaw(keypair.publicKey),
    agreementPrivateKey: agreement.privateKey,
    agreementPublicKey: agreement.publicKey,
    agreementPublicKeyRaw: await exportPublicKeyRaw(agreement.publicKey),
  };
  return {
    keypair,
    deviceId,
    deviceName: "Mac A",
    identity: () => identity,
    spaceSecret,
    workspaceSecret: () => WORKSPACE_SECRET,
    enrollment: () => ({
      state: "enrolled",
      userId: "user-1",
      email: "a@example.com",
      controlUrl: "http://control.test",
      token: "device-token",
      bootstrapToken: null,
    }),
  };
}

export interface FakeControl {
  overrides: Array<{ host: string; mode: string | null }>;
  policyCalls: number;
  devices: DeviceRegistryRow[];
  client: ControlClient;
}

export function fakeControl(devices: DeviceRegistryRow[] = []): FakeControl {
  const state: FakeControl = {
    overrides: [],
    policyCalls: 0,
    devices,
    client: undefined as unknown as ControlClient,
  };
  state.client = {
    syncPolicy: async () => {
      state.policyCalls += 1;
      return { version: 1, origins: [], overrides: {} };
    },
    setSyncPolicyOverride: async (host: string, mode: string) => {
      state.overrides.push({ host, mode });
    },
    deleteSyncPolicyOverride: async (host: string) => {
      state.overrides.push({ host, mode: null });
    },
    listDevices: async () => state.devices,
  } as unknown as ControlClient;
  return state;
}

export interface SyncHarness {
  dir: string;
  service: SyncService;
  spaces: SpaceStore;
  records: WorkspaceRecords;
  browser: FakeBrowser;
  device: Awaited<ReturnType<typeof fakeDevice>>;
  control: FakeControl;
  transports: FakeTransport[];
  transport(): FakeTransport;
  statuses: SyncStatus[];
  workspaceStatuses: WorkspaceSyncStatus[];
  enrolled: boolean;
  restorePoint: DurableTabSession;
  persisted: Set<() => void>;
  tokenCalls: number;
}

export async function syncHarness(
  options: {
    enrolled?: boolean;
    hubUrl?: string | null;
    packaged?: boolean;
    devices?: DeviceRegistryRow[];
    /** Null models a Space whose root secret this Mac never received. */
    spaceSecret?: (spaceId: string) => Uint8Array | null;
  } = {},
): Promise<SyncHarness> {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-sync-"));
  const device = await fakeDevice("mac-a", options.spaceSecret);
  const control = fakeControl(options.devices);
  const harness: SyncHarness = {
    dir,
    service: undefined as unknown as SyncService,
    spaces: new SpaceStore(dir),
    records: new WorkspaceRecords({
      bookmark: new BookmarkStore(dir),
      reminder: new ReminderStore(dir),
      memory: new MemoryStore(dir),
    }),
    browser: new FakeBrowser(),
    device,
    control,
    transports: [],
    transport: () => {
      const transport = harness.transports.at(-1);
      if (transport === undefined) throw new Error("no transport was built");
      return transport;
    },
    statuses: [],
    workspaceStatuses: [],
    enrolled: options.enrolled ?? true,
    restorePoint: structuredClone(EMPTY_TAB_SESSION),
    persisted: new Set(),
    tokenCalls: 0,
  };
  const hubUrl = options.hubUrl === undefined ? "ws://hub.test/v1/hub/ws" : options.hubUrl;
  harness.service = new SyncService({
    device,
    spaces: harness.spaces,
    records: harness.records,
    browser: () => harness.browser,
    restorePoint: () => structuredClone(harness.restorePoint),
    onSessionPersisted: (listener) => {
      harness.persisted.add(listener);
      return () => harness.persisted.delete(listener);
    },
    control: () => (harness.enrolled ? control.client : null),
    enrolled: () => harness.enrolled,
    getToken: async () => {
      harness.tokenCalls += 1;
      return harness.enrolled ? "device-token" : null;
    },
    hubUrl: () => hubUrl,
    hubUrlPinned: hubUrl !== null,
    packaged: options.packaged ?? false,
    listDevices: () => control.client.listDevices(),
    userDataDir: dir,
    publishStatus: (status) => harness.statuses.push(status),
    publishWorkspaceStatus: (status) => harness.workspaceStatuses.push(status),
    transportFactory: (url, events) => {
      const transport = new FakeTransport(url, events);
      harness.transports.push(transport);
      return transport;
    },
    discoveryWaitMs: 0,
    retryDeferredIntervalMs: 50,
    hydrationRetryMs: 5,
    secretWaitMs: 1,
  });
  return harness;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `condition` holds; the sync service's work is real async crypto and I/O. */
export async function waitFor(condition: () => boolean, timeoutMs = 4_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Dial, complete hello + hydration, and wait for the Space's gate to open. */
export async function connected(harness: SyncHarness, spaceId = "work"): Promise<FakeTransport> {
  harness.service.start();
  await waitFor(() => harness.transports.length === 1 && harness.transport().started !== null, 4_000, "the hub dial");
  const transport = harness.transport();
  transport.connect();
  await waitFor(() => harness.browser.ready.includes(spaceId), 4_000, "hydration");
  return transport;
}
