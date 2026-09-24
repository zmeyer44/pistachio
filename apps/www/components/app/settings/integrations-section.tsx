"use client";

/**
 * Settings → Integrations: which apps the agent may reach directly, per
 * Space, and the account each is connected as (docs/cloud-sync-design.md
 * D29). Connecting happens on the Mac — the consent page comes back to a
 * listener on the machine that seals the grant — so this page reads and
 * asks for disconnects; it never holds a token. A disconnect from here is
 * a tombstone: the agent stops using the account at once, and the grant
 * itself is revoked by the next device that can open it.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { INTEGRATION_CATALOG, integrationAccessLevel, type IntegrationConnection, type IntegrationProviderConfig } from "@pistachio/protocol";
import {
  Button,
  ControlError,
  disconnectIntegration,
  Empty,
  listIntegrationProviders,
  listIntegrations,
  Note,
  Section,
  Status,
  useSession,
  When,
} from "@pistachio/web-account";

function messageOf(error: unknown): string {
  if (error instanceof ControlError && error.code === "not_found") return "That connection is no longer there.";
  return error instanceof Error ? error.message : "The integrations could not be read.";
}

function ConnectionRow({
  connection,
  token,
  onChanged,
}: {
  connection: IntegrationConnection;
  token: string;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entry = INTEGRATION_CATALOG[connection.provider];
  const level = integrationAccessLevel(connection.provider, connection.access);

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await disconnectIntegration(token, connection.spaceId, connection.id);
      setConfirming(false);
      await onChanged();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pa-section rounded-lg border border-alpha-400 p-4" data-testid={`integration-${connection.provider}`}>
      <div className="pa-row">
        <div>
          <p className="pa-label">{entry.name}</p>
          <p className="pa-caption">
            {connection.accountLabel} · {level?.label ?? connection.access}
            {connection.lastUsedAt === null ? " · not used by the agent yet" : (
              <>
                {" · used "}
                <When iso={connection.lastUsedAt} relative />
              </>
            )}
          </p>
        </div>
        {connection.status === "connected" ? (
          <Status tone="good">Connected</Status>
        ) : connection.status === "revoke_pending" ? (
          <Status tone="alert">Disconnecting</Status>
        ) : (
          <Status tone="alert">Needs reconnecting on your Mac</Status>
        )}
      </div>
      {error === null ? null : <Note tone="alert">{error}</Note>}
      {connection.status === "revoke_pending" ? (
        <p className="pa-caption">
          The agent can no longer use this account. The grant is revoked at {entry.name} the next time your Mac or the cloud browser opens Pistachio&rsquo;s connections; to revoke it sooner, use the security settings of your {entry.name} account.
        </p>
      ) : confirming ? (
        <div className="pa-section rounded-md border border-red-400 bg-red-100 p-3">
          <p className="pa-body">
            Disconnect {entry.name}? The agent stops using this account within moments, including any run in progress. The grant itself is revoked at {entry.name} by your Mac or the cloud browser the next time either opens Pistachio&rsquo;s connections, or right away from the security settings of your {entry.name} account.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="alert" disabled={busy} onClick={() => void disconnect()}>
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
            <Button type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" variant="alert" onClick={() => setConfirming(true)}>
            Disconnect…
          </Button>
        </div>
      )}
    </div>
  );
}

export function IntegrationsSection(): ReactNode {
  const { token, spaces } = useSession();
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [connections, setConnections] = useState<IntegrationConnection[] | null>(null);
  const [providers, setProviders] = useState<IntegrationProviderConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeSpaceId = spaceId ?? spaces[0]?.id ?? null;

  const refresh = useCallback(async (): Promise<void> => {
    if (token === null || activeSpaceId === null) return;
    try {
      const [list, catalog] = await Promise.all([listIntegrations(token, activeSpaceId), listIntegrationProviders(token)]);
      setConnections(list.connections);
      setProviders(catalog.providers);
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [activeSpaceId, token]);

  useEffect(() => {
    setConnections(null);
    void refresh();
  }, [refresh]);

  const offered = Object.values(INTEGRATION_CATALOG).filter((entry) => (providers ?? []).some((provider) => provider.id === entry.id));
  const unconnected = offered.filter((entry) => !(connections ?? []).some((connection) => connection.provider === entry.id));

  return (
    <>
      <Section note="One account per app per Space. The grant is encrypted with the Space key on the Mac that connected it; Pistachio's servers keep only the ciphertext, and the agent sees only the account's name and what it may do.">
        {spaces.length > 1 ? (
          <div className="pa-field">
            <label htmlFor="integrations-space">Space</label>
            <select id="integrations-space" className="pa-input" value={activeSpaceId ?? ""} onChange={(event) => setSpaceId(event.target.value)}>
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>{space.name}</option>
              ))}
            </select>
          </div>
        ) : null}
        {error === null ? null : <Note tone="alert">{error}</Note>}
        {token === null ? (
          <Empty title="Sign in to see your integrations" />
        ) : connections === null ? (
          <p className="pa-caption">Reading your connections…</p>
        ) : connections.length === 0 ? (
          <Empty title="Nothing connected in this Space">
            {offered.length === 0
              ? "This Pistachio service has no integrations configured."
              : `Connect ${offered.map((entry) => entry.name).join(", ")} from Settings → Integrations in Pistachio on your Mac.`}
          </Empty>
        ) : (
          connections.map((connection) => <ConnectionRow key={connection.id} connection={connection} token={token} onChanged={refresh} />)
        )}
      </Section>
      {connections !== null && connections.length > 0 && unconnected.length > 0 ? (
        <Section heading="Available">
          <p className="pa-caption">
            {unconnected.map((entry) => entry.name).join(", ")} can be connected from Settings → Integrations in Pistachio on your Mac.
          </p>
        </Section>
      ) : null}
    </>
  );
}
