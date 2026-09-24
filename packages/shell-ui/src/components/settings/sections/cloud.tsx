/**
 * Settings → Cloud browser: which Spaces the hosted browser holds a key for,
 * where a new conversation runs by default, and the channels that can start
 * one without you (docs/cloud-sync-design.md §10.4, §7.3).
 *
 * The page is about one decision made three times: WHAT THE CLOUD BROWSER
 * MAY OPEN. Enabling a Space wraps that Space's root secret to the cloud
 * device's public key, so it is asked for with the same ceremony a device
 * revocation gets — including which key is being wrapped to, since a
 * substituted key is exactly what the pin in Settings → Devices exists to
 * catch. Disabling withdraws it and needs no ceremony.
 *
 * A channel's secret is shown once, on the answer that minted it. It never
 * enters the store (store.ts strips it before the row lands), so this page
 * is the only place it will ever exist.
 */

import { useEffect, useState } from "react";
import { Cloud, KeyRound, Link2, Monitor, Trash2 } from "lucide-react";
import type { ThreadListItem } from "@pistachio/protocol";
import type { ChannelInfo } from "@pistachio/shell-contracts/ipc";
import type { SpaceInfo } from "@pistachio/shell-contracts/spaces";
import { useAsyncAction } from "../../../lib/action";
import {
  channelNameError,
  channelSeenLabel,
  cloudSpaceEnabled,
  liveCloudThreads,
  liveStateView,
  MAX_CHANNEL_NAME,
  outboundUrlError,
  outboundUrlValue,
  sortChannels,
} from "../../../lib/cloud";
import { useAppStore } from "../../../store";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Note } from "../../ui/note";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { ConfirmDialog } from "../dialogs";
import { Block, Fixed, Group, OneTimeSecret, Page, Row, LoadFailed, Unavailable, useLoadFailure, useUnavailable } from "../parts";
import { Fingerprint } from "./devices";

export function CloudPage() {
  // W12: a host that cannot answer for this page says why, and the page
  // says it back — never a screen of controls that all refuse. The page
  // body is a component of its own so its hooks are never skipped.
  const unavailable = useUnavailable("getCloudStatus");
  const failed = useLoadFailure("getCloudStatus");
  if (unavailable !== null) {
    return <Unavailable title="Cloud browser" description="The hosted browser this account can hand work to." reason={unavailable} section="cloud" />;
  }
  // And a getter that FAILED is not a getter that refused: showing the
  // section's defaults would report an outage as a fact about the account.
  if (failed !== null) {
    return <LoadFailed title="Cloud browser" description="The hosted browser this account can hand work to." reason={failed} />;
  }
  return <CloudPageBody />;
}

function CloudPageBody() {

  return (
    <Page
      title="Cloud browser"
      description="A browser Pistachio runs for you, in its own machine, holding the Spaces you hand it a key for. It signs in with the same sealed sessions this Mac has, so a run can continue while your laptop is shut."
    >
      <DeviceGroup />
      <SpacesGroup />
      <DefaultsGroup />
      <LiveRunsGroup />
      <ChannelsGroup />
      <GuaranteesGroup />
    </Page>
  );
}

/* ------------------------------ the device ------------------------------- */

function DeviceGroup() {
  const cloud = useAppStore((state) => state.cloud);
  const view = liveStateView(cloud);

  return (
    <Group
      title="The cloud device"
      note="The cloud browser is a device of this account like any other: it has its own key pair, it appears in Settings → Devices, and it can be revoked there."
      footer={
        cloud.available
          ? "Its key was pinned the first time a Space enabled it. A different key stops everything until you confirm it."
          : "Nothing is available until this Mac is enrolled and control names a cloud browser."
      }
    >
      <Row label="Availability" note="Enrolled, control reachable, and a cloud browser address known.">
        <Badge variant={cloud.available ? "green-subtle" : "gray-subtle"} size="sm" data-testid="cloud-available">
          {cloud.available ? "Available" : "Unavailable"}
        </Badge>
      </Row>
      <Row
        label="Pinned key"
        note={
          cloud.device === null ? (
            "No Space has handed the cloud browser a key yet, so there is nothing to pin."
          ) : (
            <span className="flex flex-col gap-1">
              <Fingerprint value={cloud.device.fingerprint} />
              <span className="font-mono text-[11px] break-all">{cloud.device.deviceId}</span>
            </span>
          )
        }
      >
        {cloud.device === null ? null : (
          <Badge variant="blue-subtle" size="sm" icon={<KeyRound aria-hidden="true" />}>
            Pinned
          </Badge>
        )}
      </Row>
      <Row label="Address" note="Where this Mac dials for hosted runs and the live view.">
        <span className="font-mono text-label-12 break-all text-gray-900">{cloud.cloudBrowserUrl ?? "not known yet"}</span>
      </Row>
      <Row label="Live view" note={view.note}>
        <Badge
          variant={
            view.tone === "green" ? "green-subtle" : view.tone === "amber" ? "amber-subtle" : view.tone === "red" ? "red-subtle" : "gray-subtle"
          }
          size="sm"
          data-testid="cloud-live-state"
        >
          {view.label}
        </Badge>
      </Row>
    </Group>
  );
}

/* -------------------------------- Spaces --------------------------------- */

function SpacesGroup() {
  const spaces = useAppStore((state) => state.snapshot?.spaces ?? EMPTY_SPACES);
  const cloud = useAppStore((state) => state.cloud);
  const [confirming, setConfirming] = useState<SpaceInfo | null>(null);

  return (
    <>
      <Group
        title="Spaces the cloud browser may open"
        note="Enabling a Space wraps its root secret to the cloud device's key. Nothing else of yours is reachable from there — a Space you leave off stays unreadable to it."
        footer="Turning a Space off deletes its wrapper on the control plane; the cloud browser cannot open it again without a new one."
      >
        {spaces.map((space) => (
          <SpaceRow key={space.id} space={space} onEnable={() => setConfirming(space)} />
        ))}
      </Group>
      {confirming === null ? null : (
        <EnableDialog space={confirming} fingerprint={cloud.device?.fingerprint ?? null} onClose={() => setConfirming(null)} />
      )}
    </>
  );
}

const EMPTY_SPACES: SpaceInfo[] = [];

function SpaceRow({ space, onEnable }: { space: SpaceInfo; onEnable: () => void }) {
  const cloud = useAppStore((state) => state.cloud);
  const disableCloud = useAppStore((state) => state.disableCloud);
  const { busy, error, run } = useAsyncAction();
  const enabled = cloudSpaceEnabled(cloud, space.id, space.cloudEnabled);

  const change = async (next: boolean) => {
    if (next) {
      onEnable();
      return;
    }
    await run(() => disableCloud(space.id));
  };

  return (
    <Row
      label={
        <span className="flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: space.color }} aria-hidden="true" />
          {space.name}
        </span>
      }
      note={
        <span className="flex flex-col gap-0.5">
          <span>
            {enabled
              ? "The cloud browser holds this Space's key and can run in it."
              : "The cloud browser cannot open this Space."}
          </span>
          {error === null ? null : <span className="text-red-900">{error}</span>}
        </span>
      }
    >
      <span className="flex items-center gap-2" data-testid={`cloud-space-${space.id}`}>
        {busy ? <span className="text-label-12 text-gray-700">Working…</span> : null}
        <Switch
          checked={enabled}
          disabled={busy || !cloud.available}
          label={`Run ${space.name} in the cloud browser`}
          onChange={(next) => void change(next)}
        />
      </span>
    </Row>
  );
}

function EnableDialog({
  space,
  fingerprint,
  onClose,
}: {
  space: SpaceInfo;
  fingerprint: string | null;
  onClose: () => void;
}) {
  const enableCloud = useAppStore((state) => state.enableCloud);
  const { busy, error, run } = useAsyncAction();

  const confirm = async () => {
    if (await run(() => enableCloud(space.id))) onClose();
  };

  return (
    <ConfirmDialog
      icon={<Cloud aria-hidden="true" />}
      title={`Let the cloud browser open ${space.name}?`}
      subtitle="This hands one Space's key to a machine you do not sit at."
      does={[
        `Wraps ${space.name}'s root secret to the cloud device's public key, so it can open that Space's sealed sessions.`,
        "Lets a run you start be executed there, in its own copy of those sessions, while this Mac is closed.",
        "Adds the cloud device to this Space's sync group: what it captures converges back to your devices.",
      ]}
      doesNot={[
        "Does not give it any other Space — each Space has its own key, and only this one is wrapped.",
        "Does not start anything: a run in the cloud is something you ask for each time, or a channel does.",
        "Does not move your tabs. The cloud browser opens its own.",
      ]}
      confirmLabel="Enable this Space"
      confirmVariant="default"
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() => void confirm()}
      testId="cloud-enable-dialog"
    >
      <div className="rounded-md bg-background-200 px-3.5 py-3 shadow-border">
        <p className="flex items-center gap-1.5 text-label-12 font-medium text-gray-1000">
          <KeyRound aria-hidden="true" className="size-3.5" />
          Key being wrapped to
        </p>
        {fingerprint === null ? (
          <p className="mt-1 text-label-12 text-gray-900">
            The first Space to enable the cloud browser pins its key. Compare the fingerprint afterwards in Settings →
            Devices.
          </p>
        ) : (
          <Fingerprint value={fingerprint} className="mt-1.5" />
        )}
      </div>
    </ConfirmDialog>
  );
}

/* ------------------------------- defaults -------------------------------- */

function DefaultsGroup() {
  const runByDefault = useAppStore((state) => state.settings.cloud.runByDefault);
  const updateSettings = useAppStore((state) => state.updateSettings);

  return (
    <Group
      title="New conversations"
      note="Where the console sends the next task you type. Either way the choice is one click away in the composer."
      footer="A preference of this Mac. Your other devices keep their own."
    >
      <Row
        label="Run in cloud by default"
        note="Applies only in Spaces the cloud browser can open; anywhere else the console runs the task here."
      >
        <Switch
          checked={runByDefault}
          label="Run in cloud by default"
          onChange={(next) => void updateSettings({ cloud: { runByDefault: next } })}
        />
      </Row>
    </Group>
  );
}

/* ------------------------------- live runs ------------------------------- */

function LiveRunsGroup() {
  const threads = useAppStore((state) => state.snapshot?.threads ?? EMPTY_THREADS);
  const openLiveView = useAppStore((state) => state.openLiveView);
  // Where there is no live view to open (a streamed surface: the pane IS the
  // live view, so the host refuses the member) the row says so instead of
  // offering a button that raises a dead overlay.
  const liveViewUnavailable = useAppStore((state) => state.unavailable["openLiveView"] ?? null);
  // Which row is waiting, not just that one is: every run has its own button.
  const [watching, setWatching] = useState<string | null>(null);
  const { error, run } = useAsyncAction();
  const live = liveCloudThreads(threads);

  const watch = async (runId: string) => {
    setWatching(runId);
    await run(() => openLiveView(runId));
    setWatching(null);
  };

  return (
    <Group
      title="Runs in the cloud"
      note="Watching one opens its live view over the page area: the cloud browser's screen, and its keyboard and pointer once you take control."
      footer={
        live.length === 0
          ? "Nothing is running in the cloud right now."
          : "The live view is a screencast of a machine elsewhere; nothing it shows is on this Mac."
      }
    >
      {live.length === 0 ? (
        <Block>
          <p className="text-copy-13 text-gray-900">
            Start one from the console with &ldquo;Run in cloud&rdquo;, or let a channel start one for you.
          </p>
        </Block>
      ) : (
        live.map((thread) => (
          <Row
            key={thread.runId}
            label={thread.title.trim() === "" ? "Untitled conversation" : thread.title}
            note={`${thread.status.replaceAll("_", " ")} · ${String(thread.messageCount)} messages`}
          >
            {liveViewUnavailable === null ? (
              <Button
                variant="secondary"
                size="sm"
                prefix={<Monitor aria-hidden="true" />}
                loading={watching === thread.runId}
                onClick={() => void watch(thread.runId)}
                data-testid={`watch-run-${thread.runId}`}
              >
                Watch live
              </Button>
            ) : (
              <span className="text-[11px] leading-4 text-gray-700">{liveViewUnavailable}</span>
            )}
          </Row>
        ))
      )}
      {error === null ? null : (
        <Block>
          <Note type="error" size="sm">
            {error}
          </Note>
        </Block>
      )}
    </Group>
  );
}

const EMPTY_THREADS: ThreadListItem[] = [];

/* ------------------------------- channels -------------------------------- */

function ChannelsGroup() {
  const channels = useAppStore((state) => state.channels);
  const refreshChannels = useAppStore((state) => state.refreshChannels);
  const available = useAppStore((state) => state.cloud.available);
  const [deleting, setDeleting] = useState<ChannelInfo | null>(null);
  const rows = sortChannels(channels);

  // The list is small and changes on another machine's schedule, so it is
  // re-read when the page opens rather than followed by a subscription.
  useEffect(() => {
    void refreshChannels();
  }, [refreshChannels]);

  return (
    <>
      <Group
        title="Channels"
        note="An authenticated webhook bound to one Space. A signed message on it starts a run in the cloud browser, as you, in that Space."
        footer={
          available
            ? "Each channel signs with its own secret. Delete one and its calls stop being accepted at once."
            : "Channels need an enrolled Mac: the control plane binds them to your account."
        }
      >
        <ChannelForm />
        {rows.length === 0 ? (
          <Block>
            <p className="text-copy-13 text-gray-900">No channels yet.</p>
          </Block>
        ) : (
          rows.map((channel) => <ChannelRow key={channel.linkId} channel={channel} onDelete={() => setDeleting(channel)} />)
        )}
      </Group>
      {deleting === null ? null : <DeleteChannelDialog channel={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

function ChannelForm() {
  const spaces = useAppStore((state) => state.snapshot?.spaces ?? EMPTY_SPACES);
  const activeSpaceId = useAppStore((state) => state.snapshot?.activeSpaceId ?? null);
  const available = useAppStore((state) => state.cloud.available);
  const createChannel = useAppStore((state) => state.createChannel);
  const [name, setName] = useState("");
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [outbound, setOutbound] = useState("");
  const [field, setField] = useState<"name" | "outbound" | null>(null);
  const { busy, error, setError, run } = useAsyncAction();
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);

  const chosen = spaceId ?? activeSpaceId ?? spaces[0]?.id ?? "";

  const create = async () => {
    const nameFailure = channelNameError(name);
    if (nameFailure !== null) {
      setField("name");
      setError(nameFailure);
      return;
    }
    const urlFailure = outboundUrlError(outbound);
    if (urlFailure !== null) {
      setField("outbound");
      setError(urlFailure);
      return;
    }
    if (chosen === "") {
      setField(null);
      setError("Open a Space first — a channel is bound to one.");
      return;
    }
    setField(null);
    const created = await run(async () => {
      const result = await createChannel({
        name: name.trim(),
        spaceId: chosen,
        outboundUrl: outboundUrlValue(outbound),
      });
      if (!result.ok) return result.error;
      setSecret({ name: result.value.name, secret: result.value.secret });
      return null;
    });
    if (!created) return;
    setName("");
    setOutbound("");
  };

  return (
    <>
      <Block label="Create a channel" note="It starts runs in this Space, in the cloud browser, until you delete it.">
        <div className="flex flex-wrap items-start gap-2">
          <Input
            value={name}
            placeholder="Support inbox"
            maxLength={MAX_CHANNEL_NAME}
            aria-label="Channel name"
            disabled={busy || !available}
            error={field === "name" ? error : null}
            onChange={(event) => setName(event.target.value)}
            className="w-52"
            containerClassName="w-52"
            data-testid="channel-name"
          />
          <Select
            aria-label="Space"
            value={chosen}
            items={spaces.map((space) => ({ value: space.id, label: space.name }))}
            disabled={busy || !available}
            onValueChange={(next) => setSpaceId(next)}
            className="w-40"
            data-testid="channel-space"
          />
          <Input
            value={outbound}
            placeholder="https://example.com/hooks/pistachio (optional)"
            spellCheck={false}
            aria-label="Outbound URL"
            disabled={busy || !available}
            error={field === "outbound" ? error : null}
            onChange={(event) => setOutbound(event.target.value)}
            className="w-72"
            containerClassName="w-72"
            data-testid="channel-outbound"
          />
          <Button
            variant="secondary"
            size="sm"
            prefix={<Link2 aria-hidden="true" />}
            loading={busy}
            disabled={!available}
            onClick={() => void create()}
            data-testid="channel-create"
          >
            Create
          </Button>
        </div>
        {error === null || field !== null ? null : (
          <Note type="error" size="sm" className="mt-3" data-testid="channel-error">
            {error}
          </Note>
        )}
      </Block>
      {secret === null ? null : (
        <Block>
          <OneTimeSecret
            value={secret.secret}
            testId="channel-secret"
            label={`Signing secret for “${secret.name}”`}
            warning={
              <>
                This is the only time this secret is shown. Copy it into whatever will call the channel — Pistachio keeps
                no copy, and a channel whose secret is lost has to be deleted and made again.
              </>
            }
          />
        </Block>
      )}
    </>
  );
}

function ChannelRow({ channel, onDelete }: { channel: ChannelInfo; onDelete: () => void }) {
  const spaces = useAppStore((state) => state.snapshot?.spaces ?? EMPTY_SPACES);
  const space = spaces.find((candidate) => candidate.id === channel.spaceId) ?? null;
  const revoked = channel.revokedAt !== null;
  return (
    <Row
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span>{channel.name}</span>
          <Badge variant="gray-subtle" size="sm">
            {space?.name ?? channel.spaceId}
          </Badge>
          {revoked ? (
            <Badge variant="red-subtle" size="sm">
              Deleted
            </Badge>
          ) : null}
        </span>
      }
      note={
        <span className="flex flex-col gap-0.5">
          <span className="font-mono text-[11px] break-all">{channel.linkId}</span>
          <span>
            {channelSeenLabel(channel)}
            {channel.outboundUrl === null ? " · no outbound address" : ` · posts back to ${channel.outboundUrl}`}
          </span>
        </span>
      }
    >
      {revoked ? null : (
        <Button
          variant="tertiary"
          size="sm"
          prefix={<Trash2 aria-hidden="true" />}
          onClick={onDelete}
          data-testid={`channel-delete-${channel.linkId}`}
        >
          Delete…
        </Button>
      )}
    </Row>
  );
}

function DeleteChannelDialog({ channel, onClose }: { channel: ChannelInfo; onClose: () => void }) {
  const deleteChannel = useAppStore((state) => state.deleteChannel);
  const { busy, error, run } = useAsyncAction();

  const confirm = async () => {
    if (await run(() => deleteChannel(channel.linkId))) onClose();
  };

  return (
    <ConfirmDialog
      icon={<Trash2 aria-hidden="true" />}
      title={`Delete “${channel.name}”?`}
      subtitle="Whatever calls this channel stops being able to reach you."
      does={[
        "Control refuses every later call signed with this channel's secret.",
        "The address stays dead: a channel made again gets a new id and a new secret.",
      ]}
      doesNot={[
        "Does not stop or undo runs this channel already started — end those in the console.",
        "Does not change the Space it was bound to, or what the cloud browser may open.",
      ]}
      confirmLabel="Delete channel"
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() => void confirm()}
      testId="delete-channel-dialog"
    />
  );
}

/* ------------------------------ guarantees ------------------------------- */

function GuaranteesGroup() {
  return (
    <Group title="What the cloud browser cannot do" note="Each line is a property of how the keys are handed over, so there is nothing here to turn off.">
      <Fixed
        label="It reads only the Spaces you enabled"
        note="Every Space has its own root secret. Only the ones switched on above are wrapped to its key; the rest are ciphertext to it."
        badge="Enforced"
      />
      <Fixed
        label="Its key is pinned on this Mac"
        note="If control ever offers a different cloud key, nothing is wrapped to it until you confirm the change in Settings → Devices."
        badge="Enforced"
      />
      <Fixed
        label="You can take the page back"
        note="A live view under your control drives the cloud page directly; the agent is paused for as long as you hold it."
        badge="Always on"
      />
    </Group>
  );
}
