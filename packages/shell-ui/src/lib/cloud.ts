/**
 * What Settings → Cloud, the console, and the chrome say about the hosted
 * cloud browser and the channels bound to it (docs/cloud-sync-design.md
 * §10.4, §7.3).
 *
 * Pure, like lib/sync.ts beside it: every sentence these pages can say is a
 * function of `cloud:status`, the thread list, and the Spaces, so it is
 * testable without a store, a window, or an IPC bridge.
 */

import { isTerminalStatus, type RunSummary, type ThreadListItem } from "@pistachio/protocol";
import { agentIsDriving } from "@pistachio/shell-contracts/agent-glow";
import type { ChannelInfo, CloudStatus } from "@pistachio/shell-contracts/ipc";
import { relativeTime } from "./run";

/** Statuses that leave a cloud run with nothing in flight. */

/** A run this desktop did not execute — its tabs live in the cloud browser. */
/**
 * Whether the page the live view is showing is one the agent is driving
 * right now — the condition the view's ring (styles.css "Agent control")
 * keys off, the same one a local run's pane uses (@pistachio/shell-contracts/agent-glow).
 * The status and control come from the cloud browser itself over the live
 * socket, not from the console's open run: the view can be on a run other
 * than the open one, and the socket is the fresher source in any case. The
 * screencast follows the run's active tab, which is the tab the agent works
 * in while it holds control (a viewer's focus is dropped under `agent`), so
 * an open view with the agent in control is by construction showing its tab.
 */
export function cloudAgentIsDriving(
  cloud: Pick<CloudStatus, "liveState" | "liveControl" | "liveStatus">,
): boolean {
  return (
    cloud.liveState === "open" &&
    cloud.liveControl !== null &&
    cloud.liveStatus !== null &&
    agentIsDriving({ control: cloud.liveControl, status: cloud.liveStatus })
  );
}

export function isCloudRun(run: Pick<RunSummary, "executor"> | Pick<ThreadListItem, "executor"> | null | undefined): boolean {
  return run?.executor?.kind === "cloud";
}

/** The cloud runs that are still going, newest first: what a live view can open on. */
export function liveCloudThreads(threads: readonly ThreadListItem[]): ThreadListItem[] {
  return threads
    .filter((thread) => isCloudRun(thread) && !isTerminalStatus(thread.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Whether the cloud browser holds this Space's key right now. */
export function cloudSpaceEnabled(cloud: CloudStatus, spaceId: string | null, fallback = false): boolean {
  if (spaceId === null) return false;
  return cloud.spaces.find((row) => row.spaceId === spaceId)?.enabled ?? fallback;
}

export function cloudEnabledSpaceIds(cloud: CloudStatus): string[] {
  return cloud.spaces.filter((row) => row.enabled).map((row) => row.spaceId);
}

/**
 * Whether a run may be started in the cloud at all, and — when it may not —
 * the one sentence that says what is missing. The console shows the reason
 * on a disabled control rather than hiding the control, so "run in the
 * cloud" is discoverable before it is possible.
 */
export interface CloudReadiness {
  ready: boolean;
  reason: string | null;
}

export function cloudReadiness(cloud: CloudStatus, spaceId: string | null): CloudReadiness {
  if (!cloud.available) {
    return { ready: false, reason: "Sign in and enroll this Mac to use the cloud browser." };
  }
  if (cloud.device === null) {
    return { ready: false, reason: "No Space has handed the cloud browser a key yet — enable one in Settings → Cloud browser." };
  }
  if (spaceId === null) return { ready: false, reason: "Open a Space first: a cloud run happens inside one Space." };
  if (!cloudSpaceEnabled(cloud, spaceId)) {
    return { ready: false, reason: "This Space is not enabled for the cloud browser. Turn it on in Settings → Cloud browser." };
  }
  return { ready: true, reason: null };
}

export interface CloudStateView {
  label: string;
  note: string;
  tone: "green" | "amber" | "gray" | "red";
}

/** The live view's connection, in words. */
export function liveStateView(cloud: CloudStatus): CloudStateView {
  switch (cloud.liveState) {
    case "open":
      return {
        label: cloud.liveControl === "human" ? "You have control" : "Watching",
        note:
          cloud.liveControl === "human"
            ? "Clicks and keys you make here are sent to the cloud page."
            : "The agent is driving. Take control to type or click.",
        tone: cloud.liveControl === "human" ? "green" : "amber",
      };
    case "connecting":
      return { label: "Connecting", note: "Dialling the cloud browser with this device's token.", tone: "amber" };
    case "revoked":
      return { label: "Revoked", note: cloud.liveError ?? "The cloud browser stopped accepting this device.", tone: "red" };
    case "error":
      return { label: "Disconnected", note: cloud.liveError ?? "The live view ended.", tone: "red" };
    default:
      return { label: "Closed", note: "Nothing is being watched right now.", tone: "gray" };
  }
}

/* ------------------------------- channels -------------------------------- */

export function channelIsRevoked(channel: ChannelInfo): boolean {
  return channel.revokedAt !== null;
}

/** Live channels first, then by creation, newest first, then by name. */
export function sortChannels(channels: readonly ChannelInfo[]): ChannelInfo[] {
  return [...channels].sort((a, b) => {
    const revoked = Number(channelIsRevoked(a)) - Number(channelIsRevoked(b));
    if (revoked !== 0) return revoked;
    const created = createdAt(b) - createdAt(a);
    if (created !== 0) return created;
    return a.name.localeCompare(b.name) || a.linkId.localeCompare(b.linkId);
  });
}

function createdAt(channel: ChannelInfo): number {
  const value = Date.parse(channel.createdAt ?? "");
  return Number.isNaN(value) ? 0 : value;
}

/** "Created 3d ago" / "Revoked 5m ago" / "Created". */
export function channelSeenLabel(channel: ChannelInfo, now: number = Date.now()): string {
  if (channel.revokedAt !== null) {
    const when = relativeTime(channel.revokedAt, now);
    return when === "" ? "Revoked" : `Revoked ${when}`;
  }
  if (channel.createdAt === null) return "Created";
  const when = relativeTime(channel.createdAt, now);
  return when === "" ? "Created" : `Created ${when}`;
}

export const MAX_CHANNEL_NAME = 64;

/** The refusal to show beside the name field, or null when it is usable. */
export function channelNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Give the channel a name — it is what the thread list will show.";
  if (trimmed.length > MAX_CHANNEL_NAME) return `Keep the name under ${String(MAX_CHANNEL_NAME)} characters.`;
  return null;
}

/**
 * The optional address a finished run posts its answer back to. Control vets
 * it properly (§7.3 `vetOutboundUrl` — no private addresses, no redirects
 * into them); this only keeps an obviously wrong value from making the round
 * trip, and says why in the field.
 */
export function outboundUrlError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "That is not a web address. Paste the full https:// URL the answer should be posted to.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "An outbound address has to be http or https.";
  if (url.hostname === "") return "That address has no host.";
  return null;
}

/** The trimmed address, or undefined when the field was left empty. */
export function outboundUrlValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
