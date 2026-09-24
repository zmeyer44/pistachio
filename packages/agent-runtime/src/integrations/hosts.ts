/**
 * Connections into tool hosts, the way both executors do it: each usable
 * connection is opened (by a function the caller supplies, since sealing is
 * the caller's business), its refresh token minting access tokens on demand
 * through the shared OAuth helpers.
 *
 * Two things keep a host honest after it is bound. A grant the provider
 * has revoked is reported once, and the host answers every later call with
 * the message the model should relay. And a connection the person has
 * since disconnected — from another device, mid-run — is noticed: the host
 * re-reads its row every so often, and a row that is gone or no longer
 * `connected` ends the host's use of the grant; a `revoke_pending` row is
 * a tombstone left by a device that could not open the grant, and this one
 * revokes it at the provider on its behalf.
 */

import {
  INTEGRATION_CATALOG,
  type IntegrationConnection,
  type IntegrationConnectionPayload,
  type IntegrationProviderConfig,
} from "@pistachio/protocol";
import type { IntegrationToolHost } from "./host.js";
import { OAuthError, cachedAccessToken, refreshAccessToken, revokeToken, type FetchLike } from "./oauth.js";

export type IntegrationSkipReason = "reconnect_required" | "revoke_pending" | "provider_not_configured" | "unreadable";

export interface IntegrationHostsOptions {
  connections: readonly IntegrationConnection[];
  providers: readonly IntegrationProviderConfig[];
  /** Open a connection's sealed payload; throw when this device cannot. */
  openPayload: (connection: IntegrationConnection) => Promise<IntegrationConnectionPayload>;
  fetch?: FetchLike;
  now?: () => Date;
  /**
   * The connection's current row, or null when it is gone. Consulted every
   * `STATUS_RECHECK_MS` while a host is in use, so a disconnect made
   * elsewhere reaches a run already holding the opened grant.
   */
  refetch?: (connection: IntegrationConnection) => Promise<IntegrationConnection | null>;
  /** A grant the provider refused for good; the host has already stopped using it. */
  onReconnectRequired?: (connection: IntegrationConnection, reason: string) => void;
  /** This device revoked a tombstoned grant at the provider; the caller deletes the row. */
  onRevoked?: (connection: IntegrationConnection) => void | Promise<void>;
  /** A call on the connection succeeded. */
  onUsed?: (connection: IntegrationConnection) => void;
  /** Something that keeps a connection out of the run, for the log. */
  onSkipped?: (connection: IntegrationConnection, reason: IntegrationSkipReason) => void;
}

/** How long a bound host trusts its last reading of the connection's row. */
export const STATUS_RECHECK_MS = 30_000;

/** What a tool host says when its grant is dead: the person must connect again in Settings. */
export function reconnectMessage(connection: Pick<IntegrationConnection, "provider" | "accountLabel">): string {
  return `${INTEGRATION_CATALOG[connection.provider].name} (${connection.accountLabel}) needs to be connected again in Settings → Integrations before it can be used`;
}

/** What a tool host says once the person has disconnected the account. */
export function disconnectedMessage(connection: Pick<IntegrationConnection, "provider" | "accountLabel">): string {
  return `${INTEGRATION_CATALOG[connection.provider].name} (${connection.accountLabel}) was disconnected in Settings → Integrations and can no longer be used`;
}

function isPayload(value: unknown): value is IntegrationConnectionPayload {
  return typeof value === "object" && value !== null && (value as { version?: unknown }).version === 1 && typeof (value as { refreshToken?: unknown }).refreshToken === "string" && (value as { refreshToken: string }).refreshToken !== "";
}

async function openOrNull(options: Pick<IntegrationHostsOptions, "openPayload">, connection: IntegrationConnection): Promise<IntegrationConnectionPayload | null> {
  try {
    const opened: unknown = await options.openPayload(connection);
    return isPayload(opened) ? opened : null;
  } catch {
    return null;
  }
}

/**
 * Finish the disconnects a keyless device asked for: open each tombstoned
 * grant, tell the provider it is over, and hand the row to the caller to
 * delete. A tombstone this device cannot open is left for one that can;
 * one the provider will not take back (offline, already gone) is left for
 * the next attempt. Returns the connections that remain after the sweep.
 */
export async function sweepPendingRevocations(
  options: Pick<IntegrationHostsOptions, "connections" | "openPayload" | "fetch" | "onRevoked" | "onSkipped">,
): Promise<IntegrationConnection[]> {
  const fetchImpl = options.fetch ?? fetch;
  const remaining: IntegrationConnection[] = [];
  for (const connection of options.connections) {
    if (connection.status !== "revoke_pending") {
      remaining.push(connection);
      continue;
    }
    const payload = await openOrNull(options, connection);
    if (payload === null) {
      options.onSkipped?.(connection, "unreadable");
      continue;
    }
    const revoked = await revokeToken(INTEGRATION_CATALOG[connection.provider], payload.refreshToken, fetchImpl);
    if (!revoked) {
      options.onSkipped?.(connection, "revoke_pending");
      continue;
    }
    await options.onRevoked?.(connection);
  }
  return remaining;
}

export async function integrationHostsFor(options: IntegrationHostsOptions): Promise<IntegrationToolHost[]> {
  const now = options.now ?? ((): Date => new Date());
  const fetchImpl = options.fetch ?? fetch;
  const hosts: IntegrationToolHost[] = [];
  for (const connection of await sweepPendingRevocations(options)) {
    if (connection.status !== "connected") {
      options.onSkipped?.(connection, "reconnect_required");
      continue;
    }
    const client = options.providers.find((provider) => provider.id === connection.provider);
    if (client === undefined) {
      options.onSkipped?.(connection, "provider_not_configured");
      continue;
    }
    const payload = await openOrNull(options, connection);
    if (payload === null) {
      options.onSkipped?.(connection, "unreadable");
      continue;
    }
    const entry = INTEGRATION_CATALOG[connection.provider];
    let dead: string | null = null;
    let checkedAt = now().getTime();
    let checking: Promise<void> | null = null;
    /**
     * Whether the person still has this account connected. One reading per
     * window, shared by concurrent calls; a row that is gone or no longer
     * `connected` ends the host, and a tombstone is revoked here since this
     * device holds the opened grant the tombstoning device did not.
     */
    const stillConnected = async (): Promise<void> => {
      if (dead !== null || options.refetch === undefined) return;
      if (now().getTime() - checkedAt < STATUS_RECHECK_MS) return;
      if (checking === null) {
        checking = (async () => {
          let current: IntegrationConnection | null;
          try {
            current = await options.refetch!(connection);
          } catch {
            return;
          } finally {
            checkedAt = now().getTime();
          }
          if (current !== null && current.status === "connected") return;
          dead = current === null || current.status === "revoke_pending" ? disconnectedMessage(connection) : reconnectMessage(connection);
          if (current?.status === "revoke_pending") {
            const revoked = await revokeToken(entry, payload.refreshToken, fetchImpl);
            if (revoked) await options.onRevoked?.(current);
          }
        })().finally(() => {
          checking = null;
        });
      }
      await checking;
    };
    const mint = cachedAccessToken(async () => {
      if (dead !== null) throw new Error(dead);
      try {
        return await refreshAccessToken(entry, { client, refreshToken: payload.refreshToken }, fetchImpl, now);
      } catch (error: unknown) {
        if (error instanceof OAuthError && error.needsReconnect) {
          dead = reconnectMessage(connection);
          options.onReconnectRequired?.(connection, error.message);
          throw new Error(dead);
        }
        throw error;
      }
    }, now);
    hosts.push({
      provider: connection.provider,
      accountLabel: connection.accountLabel,
      access: connection.access,
      accessToken: async (tokenOptions) => {
        await stillConnected();
        if (dead !== null) throw new Error(dead);
        return mint(tokenOptions);
      },
      used: () => options.onUsed?.(connection),
    });
  }
  return hosts;
}
