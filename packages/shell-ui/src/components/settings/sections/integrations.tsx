/**
 * Settings → Integrations: the apps the agent may reach directly through
 * their API with a grant you gave — Gmail and Google Calendar — one account per app per
 * Space (docs/cloud-sync-design.md D29).
 *
 * Connecting opens the app's own sign-in page as a tab; the grant comes
 * back to this Mac, is sealed under the Space key, and control keeps only
 * the ciphertext. The access level is the real gate: it decides which
 * permissions are asked for and which tools the agent is given.
 */

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Mail, Plug, ShieldCheck } from "lucide-react";
import type { IntegrationAccess, IntegrationProvider } from "@pistachio/protocol";
import type { IntegrationConnectionInfo, IntegrationProviderInfo } from "@pistachio/shell-contracts/ipc";
import { create } from "zustand";
import { actionMessage, useAsyncAction, type AsyncAction } from "../../../lib/action";
import { useAppStore } from "../../../store";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Note } from "../../ui/note";
import { Select } from "../../ui/select";
import { Block, Fixed, Group, LoadFailed, Page, probe, Row, Unavailable, useLoadFailure, useUnavailable } from "../parts";
import { shellApi } from "../../../api";
import { useCalendarAgendaStore } from "../../home/use-calendar-agenda";

const PROVIDER_ICON: Record<IntegrationProvider, typeof Mail> = { gmail: Mail, google_calendar: CalendarDays };

/**
 * A row's action, held outside the row. The consent page closes Settings,
 * so the row that asked to connect is unmounted while the answer is still
 * on its way, and the one the person comes back to is a new mount: state
 * kept in the component would show them neither the wait nor the refusal.
 */
const useRowActionStore = create<{ busy: Record<string, boolean>; errors: Record<string, string | null> }>(() => ({ busy: {}, errors: {} }));

function useRowAction(key: string): Pick<AsyncAction, "busy" | "error" | "run"> {
  const busy = useRowActionStore((s) => s.busy[key] === true);
  const error = useRowActionStore((s) => s.errors[key] ?? null);
  const run = useCallback(
    async (work: () => Promise<string | null>): Promise<boolean> => {
      const settle = (failure: string | null) => useRowActionStore.setState((s) => ({ busy: { ...s.busy, [key]: false }, errors: { ...s.errors, [key]: failure } }));
      useRowActionStore.setState((s) => ({ busy: { ...s.busy, [key]: true }, errors: { ...s.errors, [key]: null } }));
      try {
        const failure = await work();
        settle(failure);
        return failure === null;
      } catch (cause) {
        settle(actionMessage(cause));
        return false;
      }
    },
    [key],
  );
  // A refusal is for the visit that sees it: leaving the page puts it down,
  // unless the answer is still to come.
  useEffect(
    () => () => {
      if (useRowActionStore.getState().busy[key] !== true) useRowActionStore.setState((s) => ({ errors: { ...s.errors, [key]: null } }));
    },
    [key],
  );
  return { busy, error, run };
}

function usedLabel(iso: string | null): string {
  if (iso === null) return "Not used by the agent yet";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Used" : `Used ${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

export function IntegrationsPage() {
  // W12: a host that cannot answer for this page says why, and the page
  // says it back — never a screen of controls that all refuse. The page
  // body is a component of its own so its hooks are never skipped.
  // As in the vault page: `integrationProviders` is not in the initial
  // load's probe set, so the page records how it answered at FIRST USE
  // (`probe` below) and this guard can actually fire.
  const unavailable = useUnavailable("integrationProviders");
  const failed = useLoadFailure("integrationProviders");
  if (unavailable !== null) {
    return <Unavailable title="Integrations" description="Accounts the agent may act in on your behalf." reason={unavailable} section="integrations" />;
  }
  if (failed !== null) {
    return <LoadFailed title="Integrations" description="Accounts the agent may act in on your behalf." reason={failed} />;
  }
  return <IntegrationsPageBody />;
}

function IntegrationsPageBody() {

  const spaces = useAppStore((s) => s.snapshot?.spaces ?? []);
  const activeSpaceId = useAppStore((s) => s.snapshot?.activeSpaceId ?? null);
  const enrolled = useAppStore((s) => s.account.state === "enrolled");
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [providers, setProviders] = useState<IntegrationProviderInfo[] | null>(null);
  const [connections, setConnections] = useState<IntegrationConnectionInfo[] | null>(null);
  const { error, run } = useAsyncAction();

  const selected = spaceId ?? activeSpaceId ?? spaces[0]?.id ?? null;
  const spaceName = spaces.find((space) => space.id === selected)?.name ?? selected ?? "";

  const refresh = useCallback(async () => {
    if (!enrolled || selected === null) {
      setConnections([]);
      setProviders(await probe("integrationProviders", () => shellApi().integrationProviders()).catch(() => []));
      return;
    }
    await run(async () => {
      const [list, catalog] = await Promise.all([
        shellApi().integrationList(selected),
        probe("integrationProviders", () => shellApi().integrationProviders()),
      ]);
      setConnections(list);
      setProviders(catalog);
      return null;
    });
  }, [enrolled, run, selected]);

  useEffect(() => {
    setConnections(null);
    void refresh();
  }, [refresh]);

  return (
    <Page
      title="Integrations"
      description="Apps the agent may use directly, with a grant you give once. It reads and writes through the app's own API instead of driving the site in a tab, and only as far as the access you choose."
    >
      <Group
        title={spaces.length > 1 ? `Connected in ${spaceName}` : "Connected apps"}
        note="One account per app per Space. The grant is encrypted with the Space key before it leaves this Mac; the servers keep only the ciphertext, and the agent never sees a token — only the account's name and what it may do."
        footerAction={
          spaces.length > 1 ? (
            <Select
              aria-label="Space"
              value={selected ?? ""}
              items={spaces.map((space) => ({ value: space.id, label: space.name }))}
              onValueChange={(value) => setSpaceId(value)}
            />
          ) : undefined
        }
        footer={
          !enrolled
            ? "Sign in and enroll this Mac to connect an app."
            : providers === null || connections === null
              ? "Checking what is connected…"
              : connections.length === 0
                ? "Nothing connected yet."
                : `${String(connections.length)} connected.`
        }
      >
        {error === null ? null : (
          <Block>
            <Note type="error">{error}</Note>
          </Block>
        )}
        {(providers ?? []).map((provider) => (
          <ProviderRow
            // Keyed by Space as well: a row's draft state must not survive a
            // switch to another Space's connection of the same provider.
            key={`${selected ?? ""}:${provider.id}`}
            provider={provider}
            spaceId={selected}
            enrolled={enrolled}
            connection={(connections ?? []).find((connection) => connection.provider === provider.id) ?? null}
            onChanged={async () => {
              // The home page's schedule reads a connected calendar; what it holds is now out of date.
              useCalendarAgendaStore.getState().invalidate();
              await refresh();
            }}
          />
        ))}
      </Group>

      <Group title="How it stays private">
        <Fixed
          label="The agent never holds the grant"
          note="Access tokens stay on this Mac or its cloud worker and are never sent to the model. Relevant message and event content can be sent to Pistachio's AI providers when the agent works on your task."
        />
        <Row
          label="How Google data is used"
          note="Gmail and Calendar data powers the tasks you request, your schedule, and the daily brief when you open or enable it. AI features send the context they need through Pistachio's services and Vercel AI Gateway to model providers. Disconnecting stops future access; existing conversations and reports remain until removed."
        >
          <a className="text-sm underline" href="https://pistachio.run/privacy#google" target="_blank" rel="noreferrer">
            Privacy policy
          </a>
        </Row>
        <Row
          label="The access level is a real gate"
          note="A read-only connection asks the app for read-only permission, and the agent is given only the reading tools. Raising the level asks the app for more and hands over more tools; lowering it takes them away."
        >
          <Badge variant="green-subtle" size="sm">
            <ShieldCheck aria-hidden="true" /> Always
          </Badge>
        </Row>
        <Row
          label="Disconnecting revokes the grant"
          note="The app is told the grant is over and the ciphertext is deleted. You can also withdraw Pistachio's access from the app's own security settings at any time."
        >
          <Badge variant="green-subtle" size="sm">
            <Plug aria-hidden="true" /> Always
          </Badge>
        </Row>
      </Group>
    </Page>
  );
}

/* ------------------------------ one provider ---------------------------- */

function ProviderRow({
  provider,
  spaceId,
  enrolled,
  connection,
  onChanged,
}: {
  provider: IntegrationProviderInfo;
  spaceId: string | null;
  enrolled: boolean;
  connection: IntegrationConnectionInfo | null;
  onChanged: () => Promise<void>;
}) {
  // The level shown is the connection's own whenever there is one; the
  // draft matters only before a connect. Re-read when the connection
  // changes (a refresh, a reconnect under a new id) so the row never shows
  // a level control did not record.
  const [access, setAccess] = useState<IntegrationAccess>(connection?.access ?? "write");
  useEffect(() => {
    if (connection !== null) setAccess(connection.access);
  }, [connection]);
  const [removing, setRemoving] = useState(false);
  const { busy, error, run } = useRowAction(`${spaceId ?? ""}:${provider.id}`);
  const Icon = PROVIDER_ICON[provider.id];
  const levels = provider.accessLevels.map((level) => ({ value: level.id, label: level.label }));
  const levelNote = provider.accessLevels.find((level) => level.id === access)?.note ?? "";
  const canConnect = enrolled && provider.available && spaceId !== null;
  const disconnecting = connection?.status === "revoke_pending";

  const connect = async (): Promise<void> => {
    if (spaceId === null) return;
    const ok = await run(async () => {
      await shellApi().integrationConnect(spaceId, provider.id, access);
      return null;
    });
    if (ok) await onChanged();
  };

  const changeAccess = async (next: IntegrationAccess): Promise<void> => {
    if (connection === null || spaceId === null) {
      setAccess(next);
      return;
    }
    const before = connection.access;
    setAccess(next);
    const ok = await run(async () => {
      await shellApi().integrationSetAccess(spaceId, connection.id, next);
      return null;
    });
    // A change control did not take is not one the row may keep showing.
    if (!ok) setAccess(before);
    await onChanged();
  };

  const disconnect = async (): Promise<void> => {
    if (connection === null || spaceId === null) return;
    const ok = await run(async () => {
      await shellApi().integrationDisconnect(spaceId, connection.id);
      return null;
    });
    setRemoving(false);
    if (ok) await onChanged();
  };

  return (
    <Block
      note={
        <span className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-label-14 text-gray-1000">
            <Icon className="size-3.5 text-gray-700" aria-hidden="true" />
            {provider.name}
            {connection === null ? (
              provider.available ? null : (
                <Badge variant="gray-subtle" size="sm">
                  Not available on this server
                </Badge>
              )
            ) : connection.status === "connected" ? (
              <Badge variant="green-subtle" size="sm">
                Connected
              </Badge>
            ) : connection.status === "revoke_pending" ? (
              <Badge variant="amber-subtle" size="sm">
                Disconnecting
              </Badge>
            ) : (
              <Badge variant="amber-subtle" size="sm">
                Needs reconnecting
              </Badge>
            )}
          </span>
          <span>{provider.description}</span>
          {connection === null ? null : (
            <span className="text-gray-700">
              <span className="font-mono text-[11px]">{connection.accountLabel}</span> · {usedLabel(connection.lastUsedAt)}
            </span>
          )}
          {error === null ? null : <span className="text-red-900">{error}</span>}
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-2" data-testid={`integration-${provider.id}`}>
        <label className="flex items-center gap-2 text-label-13 text-gray-1000">
          Access
          <Select
            aria-label={`${provider.name} access`}
            value={access}
            items={levels}
            disabled={busy || !canConnect || disconnecting}
            onValueChange={(value) => void changeAccess(value)}
          />
        </label>
        <span className="grow text-copy-13 text-gray-900">{levelNote}</span>
        {connection === null ? (
          <Button size="sm" disabled={busy || !canConnect} onClick={() => void connect()}>
            {busy ? "Waiting for sign-in…" : `Connect ${provider.name}`}
          </Button>
        ) : disconnecting ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onChanged()}>
            Finish disconnecting
          </Button>
        ) : removing ? (
          <>
            <Button variant="error" size="sm" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </Button>
            <Button variant="tertiary" size="sm" disabled={busy} onClick={() => setRemoving(false)}>
              Keep
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" disabled={busy || !canConnect} onClick={() => void connect()}>
              {busy ? "Waiting for sign-in…" : connection.status === "connected" ? "Reconnect" : "Connect again"}
            </Button>
            <Button variant="tertiary" size="sm" disabled={busy} onClick={() => setRemoving(true)}>
              Disconnect
            </Button>
          </>
        )}
      </div>
    </Block>
  );
}
