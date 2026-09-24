/**
 * Settings → Sync: the cookie engine's connection, which sites take part,
 * and the restore points other devices published
 * (docs/cloud-sync-design.md §10.2).
 *
 * Three different things share this page because they are three views of one
 * question — "what does this Mac share with my other devices?". The
 * connection row answers it for the engine, the origins table for a site,
 * and the restore-point chooser for tabs and Spaces.
 *
 * Everything the page shows about an origin is asked for per Space: an
 * override is account-wide (control mirrors it to every device), but whether
 * a version is staged or parked behind a cloud lease is a fact about one
 * Space's jar, so the table names the Space it is reading.
 */

import { useEffect, useMemo, useState, useRef } from "react";
import { History, RotateCcw, Search, Undo2 } from "lucide-react";
import type { RemoteRestorePoint, SyncOriginInfo } from "@pistachio/shell-contracts/ipc";
import { useAsyncAction } from "../../../lib/action";
import { cn } from "../../../lib/cn";
import {
  cloudRunInProgress,
  normalizeHostInput,
  originStateLabel,
  originTierLabel,
  ORIGIN_OVERRIDE_ITEMS,
  overrideChoice,
  overrideFromChoice,
  queueLabel,
  relativeMs,
  restorePointKindLabel,
  restorePointSummary,
  seededHosts,
  sortRestorePoints,
  syncStateView,
  workspaceStateLabel,
  type OriginOverrideChoice,
} from "../../../lib/sync";
import { useAppStore } from "../../../store";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Note } from "../../ui/note";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { ConfirmDialog, SettingsDialog } from "../dialogs";
import { Block, Fixed, Group, Page, Row, LoadFailed, Unavailable, useLoadFailure, useUnavailable } from "../parts";

export function SyncPage() {
  // W12: a host that cannot answer for this page says why, and the page
  // says it back — never a screen of controls that all refuse. The page
  // body is a component of its own so its hooks are never skipped.
  const unavailable = useUnavailable("getSyncStatus");
  const failed = useLoadFailure("getSyncStatus");
  if (unavailable !== null) {
    return <Unavailable title="Sync" description="Cookies, Spaces and restore points." reason={unavailable} section="sync" />;
  }
  // And a getter that FAILED is not a getter that refused: showing the
  // section's defaults would report an outage as a fact about the account.
  if (failed !== null) {
    return <LoadFailed title="Sync" description="Cookies, Spaces and restore points." reason={failed} />;
  }
  return <SyncPageBody />;
}

function SyncPageBody() {

  return (
    <Page
      title="Sync"
      description="Sessions, Spaces, and tab restore points travel between your devices sealed under keys only your devices hold. The hub stores ciphertext and routes it; it can read none of it."
    >
      <ConnectionGroup />
      <SpacesGroup />
      <RestorePointsGroup />
      <OriginsGroup />
      <GuaranteesGroup />
    </Page>
  );
}

/* ------------------------------ guarantees ------------------------------ */

function GuaranteesGroup() {
  return (
    <Group title="What the hub can see" note="Each line is a property of the protocol, so there is nothing here to turn off.">
      <Fixed
        label="The hub stores ciphertext"
        note="Records are sealed with a key derived per Space on your devices. The hub routes and orders them; it can read none of them."
        badge="Always on"
      />
      <Fixed
        label="Only enrolled devices are accepted"
        note="Every record is signed by the device that wrote it and checked against the account's device list. An unknown signer's record is dropped, never applied."
        badge="Enforced"
      />
      <Fixed
        label="Agent partitions never sync"
        note="A run's ephemeral partition is skipped by cookie capture, so nothing the agent touches is ever published."
        badge="Enforced"
      />
    </Group>
  );
}

/* ------------------------------ connection ------------------------------ */

function ConnectionGroup() {
  const status = useAppStore((state) => state.syncStatus);
  const retrySync = useAppStore((state) => state.retrySync);
  const { busy, run } = useAsyncAction();
  const view = syncStateView(status);

  const retry = () =>
    run(async () => {
      await retrySync();
      return null;
    });

  return (
    <Group
      title="Connection"
      note="The engine dials the hub only while this Mac is enrolled, and only with its device token."
      footer={status.remoteChanged ? "Another device changed something this Mac has not pulled yet." : "End-to-end encrypted; keys never leave your devices."}
      footerHighlight={status.remoteChanged}
      footerAction={
        <Button variant="secondary" size="sm" loading={busy} onClick={() => void retry()} data-testid="sync-retry">
          Retry now
        </Button>
      }
    >
      <Row label="State" note={view.note}>
        <Badge
          variant={
            view.tone === "green"
              ? "green-subtle"
              : view.tone === "amber"
                ? "amber-subtle"
                : view.tone === "red"
                  ? "red-subtle"
                  : "gray-subtle"
          }
          size="sm"
          data-testid="sync-state"
        >
          {view.label}
        </Badge>
      </Row>
      <Row label="Waiting to publish" note="Changes captured here that the hub has not acknowledged.">
        <span className="text-label-13 text-gray-900">{queueLabel(status.queueDepth)}</span>
      </Row>
      <Row label="Last converged" note="When this Mac and the hub last agreed on every record.">
        <span className="text-label-13 text-gray-900">{relativeMs(status.lastConvergedMs) || "never"}</span>
      </Row>
    </Group>
  );
}

/* -------------------------------- Spaces -------------------------------- */

function SpacesGroup() {
  const spaces = useAppStore((state) => state.snapshot?.spaces ?? []);
  const status = useAppStore((state) => state.syncStatus);
  const cloudSpaces = useAppStore((state) => state.cloud.spaces);
  const off = status.state === "off";

  return (
    <Group
      title="Spaces"
      note="Every Space of this account takes part while this Mac is enrolled — each with its own key, so one Space's sessions never open another's."
      footer="To keep one site out of sync everywhere, give it a Never override below."
    >
      {spaces.map((space) => {
        const cloud = cloudSpaces.find((row) => row.spaceId === space.id)?.enabled ?? space.cloudEnabled;
        return (
          <Row
            key={space.id}
            label={
              <span className="flex items-center gap-2">
                <span className="size-2.5 rounded-full" style={{ background: space.color }} aria-hidden="true" />
                {space.name}
              </span>
            }
            note={`${cloud ? "Cloud browser holds this Space's key" : "This Mac and your other desktops only"} · ${space.egressPolicy === "identity" ? "identity egress" : "direct egress"}`}
          >
            <Badge variant={off ? "gray-subtle" : "green-subtle"} size="sm">
              {off ? "Not syncing" : "Syncing"}
            </Badge>
          </Row>
        );
      })}
    </Group>
  );
}

/* ---------------------------- restore points ---------------------------- */

function RestorePointsGroup() {
  const workspace = useAppStore((state) => state.workspaceSync);
  const runWorkspaceSync = useAppStore((state) => state.runWorkspaceSync);
  // Which of the two buttons is waiting, not just that one of them is.
  const [pending, setPending] = useState<"push" | "refresh" | null>(null);
  const [chooser, setChooser] = useState(false);
  const { error, run } = useAsyncAction();
  const blocked = cloudRunInProgress(workspace);
  const points = sortRestorePoints(workspace.remoteRestorePoints);

  const start = async (kind: "push" | "refresh") => {
    setPending(kind);
    await run(() => runWorkspaceSync({ kind }));
    setPending(null);
  };

  return (
    <>
      <Group
        title="Tabs and Spaces"
        note="Each device publishes a restore point — its Spaces and their open tabs — sealed under the workspace key. Pull one to rebuild those tabs here."
        footer={
          blocked
            ? "The cloud browser is driving a site of this account. Pushing would overwrite what it is doing, so it waits."
            : workspace.lastPushMs === null
              ? "This Mac has not published a restore point yet."
              : `This Mac last published ${relativeMs(workspace.lastPushMs) || "just now"}.`
        }
        footerHighlight={blocked}
        footerAction={
          <>
            <Button variant="tertiary" size="sm" loading={pending === "refresh"} onClick={() => void start("refresh")}>
              Refresh
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={pending === "push"}
              disabled={blocked || workspace.state === "off"}
              onClick={() => void start("push")}
              data-testid="workspace-push"
            >
              Push now
            </Button>
          </>
        }
      >
        <Row label="Workspace sync" note="Spaces travel as one document; tabs as a restore point per device.">
          <Badge
            variant={workspace.state === "error" ? "red-subtle" : workspace.state === "idle" ? "green-subtle" : "gray-subtle"}
            size="sm"
          >
            {workspaceStateLabel(workspace)}
          </Badge>
        </Row>
        <Row
          label="Restore points from other devices"
          note={points.length === 0 ? "None published yet, or this Mac has not caught up with the workspace stream." : "Newest first, one per device."}
        >
          <Button variant="secondary" size="sm" disabled={points.length === 0} onClick={() => setChooser(true)} data-testid="open-restore-points">
            Choose…
          </Button>
        </Row>
        {blocked ? (
          <Block>
            <Note type="warning" size="sm" data-testid="push-blocked">
              Push is unavailable while a cloud run is in progress: the cloud browser holds an exclusive lease on an
              origin of this account, and this Mac&rsquo;s parked writes go out the moment it releases. Pull and Merge
              still work.
            </Note>
          </Block>
        ) : null}
        {/* The failure of the button just pressed, or the one the lane is
            sitting in — never both, since a refused run publishes the same
            sentence it answered with. */}
        {blocked || (error ?? workspace.error) === null ? null : (
          <Block>
            <Note type="error" size="sm">
              {error ?? workspace.error}
            </Note>
          </Block>
        )}
      </Group>
      {chooser ? <RestorePointDialog points={points} onClose={() => setChooser(false)} /> : null}
    </>
  );
}

/**
 * The Pull/Merge chooser, cloned from components/SpaceForkDialog.tsx: pick
 * the moment to restore, then say whether it replaces this Mac's tabs for
 * those Spaces or is folded into them.
 */
function RestorePointDialog({ points, onClose }: { points: RemoteRestorePoint[]; onClose: () => void }) {
  const spaces = useAppStore((state) => state.snapshot?.spaces ?? []);
  const runWorkspaceSync = useAppStore((state) => state.runWorkspaceSync);
  const [deviceId, setDeviceId] = useState(() => points[0]?.deviceId ?? "");
  const [excluded, setExcluded] = useState<readonly string[]>([]);
  const [pending, setPending] = useState<"replace" | "merge" | null>(null);
  const { error, run } = useAsyncAction();
  const selected = points.find((point) => point.deviceId === deviceId) ?? points[0] ?? null;

  const scoped = selected === null ? [] : selected.spaceIds;
  const included = scoped.filter((spaceId) => !excluded.includes(spaceId));

  const pull = async (mode: "replace" | "merge") => {
    if (selected === null || included.length === 0) return;
    setPending(mode);
    const pulled = await run(() =>
      runWorkspaceSync({
        kind: "pull",
        deviceId: selected.deviceId,
        mode,
        // Omitted means every Space in the point; only send a list when the
        // person narrowed it, so the common case stays the simple call.
        ...(included.length === scoped.length ? {} : { spaceIds: included }),
      }),
    );
    setPending(null);
    if (pulled) onClose();
  };

  return (
    <SettingsDialog
      icon={<History aria-hidden="true" />}
      title="Restore tabs from another device"
      subtitle="Every point is that device's Spaces and open tabs at the moment it published."
      busy={pending !== null}
      onClose={onClose}
      testId="restore-point-dialog"
      footer="Replace rebuilds the listed Spaces; Merge only adds what is missing."
      actions={
        <>
          <Button variant="secondary" size="sm" disabled={pending !== null} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={pending === "merge"}
            disabled={selected === null || included.length === 0}
            onClick={() => void pull("merge")}
            data-testid="restore-merge"
          >
            Merge
          </Button>
          <Button
            size="sm"
            loading={pending === "replace"}
            disabled={selected === null || included.length === 0}
            onClick={() => void pull("replace")}
            data-testid="restore-replace"
          >
            Pull (replace)
          </Button>
        </>
      }
    >
      <fieldset>
        <legend className="mb-2 text-label-12 font-medium text-gray-1000">Restore point</legend>
        <div className="flex flex-col gap-2">
          {points.map((point) => (
            <button
              key={point.deviceId}
              type="button"
              role="radio"
              aria-checked={point.deviceId === selected?.deviceId}
              onClick={() => {
                setDeviceId(point.deviceId);
                setExcluded([]);
              }}
              className={cn(
                "cursor-pointer rounded-md px-3 py-2.5 text-left outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
                point.deviceId === selected?.deviceId
                  ? "bg-green-100 shadow-[0_0_0_1px_var(--color-green-700)]"
                  : "bg-background-100 shadow-border hover:bg-gray-100",
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-label-13 font-medium text-gray-1000">{point.name}</span>
                <Badge variant="gray-subtle" size="sm">
                  {restorePointKindLabel(point)}
                </Badge>
              </span>
              <span className="mt-0.5 block text-label-12 text-gray-900">{restorePointSummary(point)}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {selected === null || scoped.length === 0 ? null : (
        <fieldset>
          <legend className="mb-2 text-label-12 font-medium text-gray-1000">Spaces to restore</legend>
          <div className="overflow-hidden rounded-md bg-background-100 shadow-border">
            {scoped.map((spaceId) => {
              const space = spaces.find((candidate) => candidate.id === spaceId) ?? null;
              const on = !excluded.includes(spaceId);
              return (
                <div key={spaceId} className="flex items-center gap-3 border-t border-alpha-400 px-3.5 py-2.5 first:border-t-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-label-13 text-gray-1000">{space?.name ?? spaceId}</span>
                    <span className="block truncate text-label-12 text-gray-900">
                      {space === null ? "Not on this Mac yet — it arrives with the Spaces document." : `Space ${spaceId}`}
                    </span>
                  </span>
                  <Switch
                    checked={on}
                    label={`Restore ${space?.name ?? spaceId}`}
                    onChange={(next) =>
                      setExcluded((current) =>
                        next ? current.filter((id) => id !== spaceId) : [...current, spaceId],
                      )
                    }
                  />
                </div>
              );
            })}
          </div>
        </fieldset>
      )}

      <Note type="warning" size="sm">
        Replace closes the tabs those Spaces have here and opens the ones in the restore point. Agent tabs and Spaces you
        left out are untouched. The sessions those tabs need are installed first, so nothing loads signed out.
      </Note>
      {included.length === 0 ? (
        <Note type="secondary" size="sm">
          Choose at least one Space to restore.
        </Note>
      ) : null}
      {error === null ? null : (
        <Note type="error" size="sm">
          {error}
        </Note>
      )}
    </SettingsDialog>
  );
}

/* -------------------------------- origins ------------------------------- */

function OriginsGroup() {
  const spaces = useAppStore((state) => state.snapshot?.spaces ?? []);
  const activeSpaceId = useAppStore((state) => state.snapshot?.activeSpaceId ?? null);
  const tabs = useAppStore((state) => state.snapshot?.tabs ?? []);
  const lookupSyncOrigin = useAppStore((state) => state.lookupSyncOrigin);
  const [chosen, setChosen] = useState<string | null>(null);
  const [rows, setRows] = useState<SyncOriginInfo[]>([]);
  const [host, setHost] = useState("");
  const [rollback, setRollback] = useState<SyncOriginInfo | null>(null);
  const { busy, error, setError, run } = useAsyncAction();
  const lastSpaceId = useRef<string | null>(null);

  const spaceId = chosen ?? activeSpaceId ?? spaces[0]?.id ?? "";
  // The seeds belong to the Space the table is showing, which is why the id
  // is passed in: the lookups below are made under it, and the snapshot's
  // tabs are the active Space's.
  const openHosts = useMemo(() => seededHosts(tabs, spaceId).join(" "), [tabs, spaceId]);

  // The open sites of the Space, looked up once so the table is not empty on
  // arrival. There is no "list every origin" channel by design — the corpus
  // is thousands of rows and the answer is per Space — so the page asks
  // about the sites in front of the person, and about whatever else is typed.
  useEffect(() => {
    let cancelled = false;
    // Only a Space change starts from an empty table. This effect also re-runs
    // whenever the open tabs change — a background tab redirecting is enough —
    // and blanking then would drop a row the person had just looked up, or
    // whose override they were reading.
    setRows((current) => (spaceId === lastSpaceId.current ? current : []));
    lastSpaceId.current = spaceId;
    if (spaceId === "") return;
    void (async () => {
      const found: SyncOriginInfo[] = [];
      for (const candidate of openHosts.split(" ").filter((value) => value !== "")) {
        const result = await lookupSyncOrigin(spaceId, candidate);
        if (cancelled) return;
        if (result.ok) found.push(result.value);
      }
      // Merge rather than replace: a manual lookup keeps its place, and a row
      // the person just changed keeps the state they set on it.
      if (!cancelled) {
        setRows((current) => [
          ...current,
          ...found.filter((row) => !current.some((existing) => existing.host === row.host)),
        ]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spaceId, openHosts, lookupSyncOrigin]);

  const lookup = async () => {
    const normalized = normalizeHostInput(host);
    if (normalized === "") {
      setError("Type a host, like mail.example.com.");
      return;
    }
    if (spaceId === "") {
      setError("Open a Space first — an origin's state is a fact about one jar.");
      return;
    }
    const found = await run(async () => {
      const result = await lookupSyncOrigin(spaceId, normalized);
      if (!result.ok) return result.error;
      setRows((current) => [result.value, ...current.filter((row) => row.host !== result.value.host)]);
      return null;
    });
    if (found) setHost("");
  };

  const replace = (info: SyncOriginInfo) =>
    setRows((current) => current.map((row) => (row.host === info.host ? info : row)));

  return (
    <>
      <Group
        title="Sites"
        note="The shipped corpus decides which sites sync; your override beats it and follows you to every device. Sensitive sites stay out either way."
        footer="Tier 0 is never synced. Tier 2 rotates its cookies, so it is applied as soon as it arrives rather than staged."
      >
        <Block label="Look up a site" note="Any host — it does not have to be open.">
          <div className="flex flex-wrap items-start gap-2">
            <Select
              aria-label="Space"
              value={spaceId}
              items={spaces.map((space) => ({ value: space.id, label: space.name }))}
              onValueChange={(next) => setChosen(next)}
              className="w-44"
            />
            <Input
              value={host}
              placeholder="mail.example.com"
              spellCheck={false}
              aria-label="Host"
              error={error}
              disabled={busy}
              onChange={(event) => setHost(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void lookup();
                }
              }}
              className="w-64"
              containerClassName="w-64"
              data-testid="origin-host"
            />
            <Button variant="secondary" size="sm" loading={busy} prefix={<Search aria-hidden="true" />} onClick={() => void lookup()}>
              Look up
            </Button>
          </div>
        </Block>
        {rows.map((info) => (
          <OriginRow
            key={info.host}
            info={info}
            onChanged={replace}
            onRollback={() => setRollback(info)}
          />
        ))}
      </Group>
      {rollback === null ? null : (
        <RollbackDialog
          info={rollback}
          onClose={() => setRollback(null)}
          onDone={(info) => {
            replace(info);
            setRollback(null);
          }}
        />
      )}
    </>
  );
}

function OriginRow({
  info,
  onChanged,
  onRollback,
}: {
  info: SyncOriginInfo;
  onChanged: (info: SyncOriginInfo) => void;
  onRollback: () => void;
}) {
  const setSyncOriginOverride = useAppStore((state) => state.setSyncOriginOverride);
  const { busy, error, run } = useAsyncAction();

  const change = (choice: OriginOverrideChoice) =>
    run(async () => {
      const result = await setSyncOriginOverride(info.spaceId, info.host, overrideFromChoice(choice));
      if (!result.ok) return result.error;
      onChanged(result.value);
      return null;
    });

  return (
    <Row
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-label-13 text-gray-1000">{info.host}</span>
          {info.rotatingAuth ? (
            <Badge variant="blue-subtle" size="sm">
              Rotating auth
            </Badge>
          ) : null}
          {info.sensitive ? (
            <Badge variant="amber-subtle" size="sm">
              Sensitive
            </Badge>
          ) : null}
          {info.staged ? (
            <Badge variant="gray-subtle" size="sm">
              Staged
            </Badge>
          ) : null}
          {info.deferred ? (
            <Badge variant="amber-subtle" size="sm">
              Parked · cloud lease
            </Badge>
          ) : null}
        </span>
      }
      note={
        <span className="flex flex-col gap-0.5">
          <span>
            {originTierLabel(info)} · {originStateLabel(info)}
          </span>
          {error === null ? null : <span className="text-red-900">{error}</span>}
        </span>
      }
    >
      <span className="flex items-center gap-2">
        <Select
          aria-label={`Sync ${info.host}`}
          value={overrideChoice(info)}
          items={ORIGIN_OVERRIDE_ITEMS}
          disabled={busy}
          onValueChange={(next) => void change(next)}
          className="w-40"
        />
        <Button
          variant="tertiary"
          size="sm"
          svgOnly
          aria-label={`Roll back this site: ${info.host}`}
          title="Roll back this site"
          onClick={onRollback}
          data-testid={`rollback-${info.host}`}
        >
          <Undo2 aria-hidden="true" />
        </Button>
      </span>
    </Row>
  );
}

function RollbackDialog({
  info,
  onClose,
  onDone,
}: {
  info: SyncOriginInfo;
  onClose: () => void;
  onDone: (info: SyncOriginInfo) => void;
}) {
  const rollbackSyncOrigin = useAppStore((state) => state.rollbackSyncOrigin);
  const lookupSyncOrigin = useAppStore((state) => state.lookupSyncOrigin);
  const { busy, error, run } = useAsyncAction();

  const confirm = () =>
    run(async () => {
      const failure = await rollbackSyncOrigin(info.spaceId, info.host);
      if (failure !== null) return failure;
      // The row the table keeps has to be the rolled-back one, so the answer
      // is looked up again before the dialog closes.
      const refreshed = await lookupSyncOrigin(info.spaceId, info.host);
      onDone(refreshed.ok ? refreshed.value : info);
      return null;
    });

  return (
    <ConfirmDialog
      icon={<RotateCcw aria-hidden="true" />}
      title={`Roll back ${info.host}?`}
      subtitle="Put this site's cookies in this Space back to the last version everyone agreed on."
      does={[
        "Restores this Space's cookies for the site from the last converged snapshot.",
        "Publishes that restoration, so your other devices follow it.",
        "Leaves the site's page open — reload it to see the restored session.",
      ]}
      doesNot={[
        "Does not undo anything on the site itself; a password you changed there stays changed.",
        "Does not touch other sites, other Spaces, or agent partitions.",
        "Does not change the site's sync setting — it stays as it is above.",
      ]}
      confirmLabel="Roll back this site"
      confirmVariant="warning"
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() => void confirm()}
      testId="rollback-origin-dialog"
    />
  );
}
