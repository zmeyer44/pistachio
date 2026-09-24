/**
 * A cloud run's dedicated integrations (D29): the connections control
 * lists for the run's Space, opened with the Space seal key on this device
 * and bound as the tool hosts the agent runtime takes. The host logic is
 * the runtime's own (`integrationHostsFor`); this device only supplies the
 * opening of the ciphertext.
 */

import type { IntegrationConnection, IntegrationConnectionPayload, IntegrationProviderConfig } from "@pistachio/protocol";
import { integrationHostsFor as openHosts, type FetchLike, type IntegrationSkipReason, type IntegrationToolHost } from "@pistachio/agent-runtime/integrations";
import { fromBase64, fromUtf8, integrationConnectionSealAad, open } from "@pistachio/sync-protocol";

export { disconnectedMessage, reconnectMessage } from "@pistachio/agent-runtime/integrations";

export interface IntegrationHostsOptions {
  spaceId: string;
  sealKey: CryptoKey;
  connections: IntegrationConnection[];
  providers: IntegrationProviderConfig[];
  fetch?: FetchLike;
  now?: () => Date;
  /** The connection's current row from control, or null when it is gone; polled while a host is in use. */
  refetch?: (connection: IntegrationConnection) => Promise<IntegrationConnection | null>;
  onReconnectRequired?: (connection: IntegrationConnection, reason: string) => void;
  /** This device revoked a tombstoned grant at the provider; the row is the caller's to delete. */
  onRevoked?: (connection: IntegrationConnection) => void | Promise<void>;
  onUsed?: (connection: IntegrationConnection) => void;
  onSkipped?: (connection: IntegrationConnection, reason: IntegrationSkipReason) => void;
}

/** A connection's payload, opened with the Space seal key under its own AAD. */
export async function openIntegrationPayload(sealKey: CryptoKey, spaceId: string, connection: IntegrationConnection): Promise<IntegrationConnectionPayload> {
  const plaintext = await open(sealKey, fromBase64(connection.sealedPayload), integrationConnectionSealAad(spaceId, connection.id));
  return JSON.parse(fromUtf8(plaintext)) as IntegrationConnectionPayload;
}

export function integrationHostsFor(options: IntegrationHostsOptions): Promise<IntegrationToolHost[]> {
  return openHosts({
    connections: options.connections,
    providers: options.providers,
    openPayload: (connection) => openIntegrationPayload(options.sealKey, options.spaceId, connection),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.refetch === undefined ? {} : { refetch: options.refetch }),
    ...(options.onReconnectRequired === undefined ? {} : { onReconnectRequired: options.onReconnectRequired }),
    ...(options.onRevoked === undefined ? {} : { onRevoked: options.onRevoked }),
    ...(options.onUsed === undefined ? {} : { onUsed: options.onUsed }),
    ...(options.onSkipped === undefined ? {} : { onSkipped: options.onSkipped }),
  });
}
