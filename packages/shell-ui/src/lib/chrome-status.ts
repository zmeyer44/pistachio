/**
 * What the chrome says about the three planes that only exist once this Mac
 * is enrolled — the account and its sync, the cloud browser, and identity
 * egress (docs/cloud-sync-design.md §10.6).
 *
 * Two consumers, one derivation: the SyncPill, which is empty unless
 * something is worth interrupting for, and the browser-status rows the
 * status card and the sidebar footer's menu both show. Pure, so both agree
 * and vitest can pin every sentence.
 */

import type { ThreadListItem } from "@pistachio/protocol";
import type { AccountState, CloudStatus, EgressStatus, SyncStatus, WorkspaceSyncStatus } from "@pistachio/shell-contracts/ipc";
import type { SettingsSection } from "@pistachio/shell-contracts/settings";
import { cloudRunInProgress, queueLabel, syncStateView } from "./sync";
import { cloudEnabledSpaceIds, cloudSpaceEnabled, liveCloudThreads } from "./cloud";
import { egressHealthView, spaceEgressStatus, spaceEgressView } from "./egress";
import { accountHref } from "./account-link";
import type { CopySurface } from "./surface-copy";

export type StatusTone = "green" | "amber" | "gray" | "red" | "blue";

/* -------------------------------- the pill ------------------------------- */

/** Where the pill sends you: a settings page, or the live view of one run. */
export type SyncPillAction = { kind: "settings"; section: SettingsSection } | { kind: "live"; runId: string };

export interface SyncPillView {
  /** Machine-readable state, for `data-state` and the tests. */
  state: "revoked" | "paused" | "queued" | "cloud-run";
  label: string;
  title: string;
  tone: "amber" | "red" | "blue";
  action: SyncPillAction;
}

export interface SyncPillInput {
  sync: SyncStatus;
  workspace: WorkspaceSyncStatus;
  cloud: CloudStatus;
  threads: readonly ThreadListItem[];
  /**
   * Where the shell is running. On a stream surface the SYNC states are
   * dropped: this session dials no hub of its own and the host publishes no
   * sync status, so a "paused"/"queued"/"revoked" pill could only be the
   * resting default dressed up as news. What a run in this very session is
   * doing is still worth saying, so the cloud-run states stay.
   */
  surface?: CopySurface;
}

/**
 * The pill's one sentence, or null — which is the usual answer. A pill that
 * says "connected" is a pill nobody reads, so the chrome shows nothing while
 * sync is doing its job and speaks only when something is stuck, waiting, or
 * happening somewhere else.
 */
export function syncPillView({ sync, workspace, cloud, threads, surface = "native" }: SyncPillInput): SyncPillView | null {
  const speaksForSync = surface === "native";
  if (speaksForSync && sync.revoked) {
    return {
      state: "revoked",
      label: "Sync revoked",
      title: "This device's key is no longer accepted. Sign in again in Settings → Account to resume syncing.",
      tone: "red",
      action: { kind: "settings", section: "account" },
    };
  }
  if (speaksForSync && sync.state === "paused") {
    return {
      state: "paused",
      label: "Sync paused",
      title:
        sync.queueDepth > 0
          ? `The hub is unreachable; ${queueLabel(sync.queueDepth)} on this Mac.`
          : "The hub is unreachable. Nothing is lost — changes wait on this Mac.",
      tone: "amber",
      action: { kind: "settings", section: "sync" },
    };
  }
  if (speaksForSync && sync.queueDepth > 0) {
    return {
      state: "queued",
      label: queueLabel(sync.queueDepth),
      title: "Changes captured here that the hub has not acknowledged yet.",
      tone: "amber",
      action: { kind: "settings", section: "sync" },
    };
  }
  const live = liveCloudThreads(threads);
  const running = live[0];
  if (running !== undefined) {
    return {
      state: "cloud-run",
      label: live.length === 1 ? "Cloud run" : `${String(live.length)} cloud runs`,
      title:
        live.length === 1
          ? "A run is working in the cloud browser. Open the live view to watch it."
          : `${String(live.length)} runs are working in the cloud browser. Open the newest one's live view.`,
      tone: "blue",
      action: { kind: "live", runId: running.runId },
    };
  }
  // Main only surfaces the cloud's exclusive lease as the refusal it answers
  // a Push with (lib/sync.ts), so a lease held while no thread of this Mac
  // knows about the run still has something to say.
  if (cloudRunInProgress(workspace) && cloud.available) {
    return {
      state: "cloud-run",
      label: "Cloud run",
      title: "The cloud browser holds a lease on an origin of this account; this Mac's writes go out when it releases.",
      tone: "blue",
      action: { kind: "settings", section: "cloud" },
    };
  }
  return null;
}

/* ------------------------------ status rows ------------------------------ */

export interface PlaneRow {
  id: "identity" | "cloud" | "egress" | "managed";
  label: string;
  /** The right-hand value: two words at most, it sits in a 96px column. */
  value: string;
  /** The same fact in a sentence, for the menu's second line and the title. */
  note: string;
  tone: StatusTone;
  section: SettingsSection;
  /**
   * Where the row's own answer lives when it is somewhere else entirely: the
   * dashboard, on a stream surface. Null on the desktop, and null for every
   * row that names a settings section this shell can actually open.
   */
  href: string | null;
}

export interface PlanesInput {
  account: AccountState;
  sync: SyncStatus;
  cloud: CloudStatus;
  egress: EgressStatus;
  activeSpaceId: string | null;
  threads: readonly ThreadListItem[];
  /**
   * The dashboard's root, where the shell knows it (`Surface.accountUrl`).
   * Only the stream surface has one, and only the folded row uses it.
   */
  accountUrl?: string;
}

/**
 * What the status card says, in as many rows as the surface has planes.
 *
 * ON A MAC, three: the rows that replaced "Hosted control · Connected" and
 * "Deterministic policy · Active" — two claims the browser was making that
 * nothing behind them could confirm. Each names a plane that either exists on
 * this Mac or says why it does not.
 *
 * IN A BROWSER TAB, one. All three planes are among the members the session
 * host refuses as "managed from the web app's settings pages"
 * (docs/web-browser-design.md §11), so no `account:changed`, `sync:status`,
 * `cloud:status` or `egress:status` is ever published to this shell and all
 * three rows would read their RESTING DEFAULTS: "Signed out", "Off",
 * "Direct". That is the same fault the store's two maps exist to prevent — a
 * getter that never answered rendered as a fact — three times over, on the
 * one card whose whole job is to be trusted. So the three fold into one row
 * that says where the answers are, with the way there beside it.
 *
 * The site's own rows — the session, the enforcement summary and the way into
 * Site controls — are not planes and are untouched by either branch: they are
 * about the page in front of the person, which this host answers for.
 */
export function planesFor(input: PlanesInput, surface: CopySurface = "native"): PlaneRow[] {
  if (surface === "stream") return [managedElsewhereRow(input)];
  return [identityRow(input), cloudRow(input), egressRow(input)];
}

/** The desktop's three rows, under the name its callers and tests use. */
export function browserPlanes(input: PlanesInput): PlaneRow[] {
  return planesFor(input, "native");
}

/**
 * The whole account family in one line (§11, §15).
 *
 * The sentence is the shell's rather than the host's on purpose: the host's
 * refusal reasons are per-member and arrive one at a time, and this row
 * stands for four of them at once. `accountHref` gives it the dashboard's
 * account page when the surface knows the address, which is the same route
 * Settings → Account's `Unavailable` offers — a reader who clicks either one
 * lands in the same place.
 */
export const MANAGED_ELSEWHERE = "Account, sync, cloud and egress are managed from the web app";

function managedElsewhereRow({ accountUrl }: PlanesInput): PlaneRow {
  return {
    id: "managed",
    label: "Account & sync",
    value: "Web app",
    note: MANAGED_ELSEWHERE,
    tone: "gray",
    section: "account",
    href: accountHref(accountUrl, "account"),
  };
}

function identityRow({ account, sync }: PlanesInput): PlaneRow {
  if (account.revoked || sync.revoked) {
    return {
      id: "identity",
      label: "Account & sync",
      value: "Revoked",
      note: "Control stopped accepting this device's key. Sign in again to resume syncing.",
      tone: "red",
      section: "account",
      href: null,
    };
  }
  if (account.state !== "enrolled") {
    return {
      id: "identity",
      label: "Account & sync",
      value: account.state === "signed-up" ? "Not enrolled" : "Signed out",
      note:
        account.state === "signed-up"
          ? "Signed in, but this Mac has not enrolled its keys yet — nothing syncs until it does."
          : "No account on this Mac. Sessions stay here; nothing is published anywhere.",
      tone: "gray",
      section: "account",
      href: null,
    };
  }
  const view = syncStateView(sync);
  return {
    id: "identity",
    label: "Account & sync",
    value: view.label,
    note: `${account.email ?? "This account"} · ${view.note}`,
    tone: view.tone,
    section: "sync",
    href: null,
  };
}

function cloudRow({ cloud, activeSpaceId, threads }: PlanesInput): PlaneRow {
  const running = liveCloudThreads(threads).length;
  if (running > 0) {
    return {
      id: "cloud",
      label: "Cloud browser",
      value: running === 1 ? "Running" : `${String(running)} runs`,
      note: "A run is working in the cloud browser, in its own copy of this account's sessions.",
      tone: "blue",
      section: "cloud",
      href: null,
    };
  }
  if (!cloud.available) {
    return {
      id: "cloud",
      label: "Cloud browser",
      value: "Off",
      note: "Not available until this Mac is enrolled and control names a cloud browser.",
      tone: "gray",
      section: "cloud",
      href: null,
    };
  }
  const enabled = cloudEnabledSpaceIds(cloud);
  if (enabled.length === 0) {
    return {
      id: "cloud",
      label: "Cloud browser",
      value: "No Spaces",
      note: "Available, but no Space has handed it a key. It can open nothing of yours.",
      tone: "gray",
      section: "cloud",
      href: null,
    };
  }
  const here = cloudSpaceEnabled(cloud, activeSpaceId);
  return {
    id: "cloud",
    label: "Cloud browser",
    value: here ? "This Space" : `${String(enabled.length)} Spaces`,
    note: here
      ? "This Space's key is with the cloud browser: a run here can be handed over."
      : `${String(enabled.length)} Spaces are enabled, but not this one.`,
    tone: "green",
    section: "cloud",
    href: null,
  };
}

function egressRow({ egress, activeSpaceId }: PlanesInput): PlaneRow {
  const row = activeSpaceId === null ? null : spaceEgressStatus(egress, activeSpaceId);
  if (row === null || row.policy === "direct") {
    const health = egressHealthView(egress);
    return {
      id: "egress",
      label: "Identity egress",
      value: "Direct",
      note:
        egress.enabled && health.tone === "red"
          ? "This Space goes out directly. Another Space uses the gateway, which is down."
          : "This Space's requests go out from this Mac's own address.",
      tone: "gray",
      section: "egress",
      href: null,
    };
  }
  const view = spaceEgressView(row, egress);
  return {
    id: "egress",
    label: "Identity egress",
    value: view.label,
    note: view.note,
    tone: view.tone,
    section: "egress",
    href: null,
  };
}
