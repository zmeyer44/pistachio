/**
 * The parts of a tab that are the same whichever way the tabs run: the label,
 * the favicon with its nav controls folded in, the address layer, the close
 * button, and the trailing cluster with the per-tab actions behind the dots.
 * The horizontal strip (components/TabStrip.tsx) and the vertical list
 * compose these; the folder silhouette and the row-only pieces stay with the
 * strip.
 */

import {
  ChevronLeft,
  BookOpen,
  ChevronRight,
  Columns2,
  Focus,
  LoaderCircle,
  Moon,
  MoreHorizontal,
  Pin,
  PinOff,
  RotateCw,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { isReaderUrl } from "@pistachio/shell-contracts/reader";
import { TabMark } from "../components/Favicon";
import { cn } from "../lib/cn";
import { displayHost, prettyUrl } from "../lib/url";
import { useAppStore } from "../store";
import { useShell } from "./shell-host";
import type { ChromeTab } from "./tabs";
import { isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";

/** Compact nav button living inside the tab; swallows tab gestures. */
function TabNavButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-sm text-gray-900 transition-colors duration-150 hover:bg-alpha-200 hover:text-gray-1000"
    >
      {children}
    </button>
  );
}

/**
 * The tab's favicon with its nav controls (back, forward, reload) folded in
 * behind it: at rest the tab shows the bare mark, and hovering THE MARK
 * unfolds every available control to its left in one motion, leaving the row
 * reading like a toolbar — ⟨ ⟩ ⟳ favicon title.
 *
 * `group/nav` wraps the controls AND the mark: the controls collapse to zero
 * width at rest, so the mark is the only way in, and once they are out the
 * pointer is still inside the group they belong to. The whole row tweens as
 * one clip box with the grid 0fr→1fr trick. Directions with no history are
 * omitted entirely — never shown as dead affordances.
 */
export function TabNavCluster({ tab }: { tab: ChromeTab }) {
  const goBack = useAppStore((s) => s.goBack);
  const goForward = useAppStore((s) => s.goForward);
  const reload = useAppStore((s) => s.reload);

  return (
    <span className="no-drag group/nav -m-1 flex shrink-0 items-center p-1">
      <span className="grid grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-200 ease-out group-hover/nav:grid-cols-[1fr] group-hover/nav:opacity-100 group-focus-within/nav:grid-cols-[1fr] group-focus-within/nav:opacity-100">
        {/* Spacing lives on clipped CONTENT, never as padding on the clip box:
            padding does not shrink, so it would leave the controls a couple of
            px wide at rest — enough to catch a hover on the way past. */}
        <span className="flex min-w-0 items-center gap-0.5 overflow-hidden">
          {tab.canGoBack ? (
            <TabNavButton label="Back" onClick={() => void goBack(tab.id)}>
              <ChevronLeft className="size-3" aria-hidden="true" />
            </TabNavButton>
          ) : null}
          {tab.canGoForward ? (
            <TabNavButton label="Forward" onClick={() => void goForward(tab.id)}>
              <ChevronRight className="size-3" aria-hidden="true" />
            </TabNavButton>
          ) : null}
          <TabNavButton label="Reload" onClick={() => void reload(tab.id)}>
            <RotateCw className="size-2.5" aria-hidden="true" />
          </TabNavButton>
          <span aria-hidden="true" className="w-1 shrink-0" />
        </span>
      </span>
      <TabMark tab={tab} />
    </span>
  );
}

export function tabLabel(tab: ChromeTab): string {
  const base = tab.title || prettyUrl(tab.url) || "New tab";
  return tab.kind === "agent" ? `Agent · ${base}` : base;
}

/**
 * The address as the chrome shows it: scheme-less, and the demo portal under
 * its friendly host. A shell-drawn page (home, the daily brief) shows none — its search is the address
 * field (@pistachio/shell-contracts/home), as a new tab's is in any browser.
 */
export function shownAddress(tab: ChromeTab): string {
  if (isShellPageUrl(tab.url)) return "";
  return prettyUrl(tab.url.startsWith("pistachio:") ? `${displayHost(tab.url)}${new URL(tab.url).pathname}` : tab.url);
}

/** Loading spinner and title — the label under every favicon. */
export function TabTitle({ tab }: { tab: ChromeTab }) {
  return (
    <>
      {tab.loading ? (
        <LoaderCircle
          role="img"
          aria-label="Loading"
          className="mr-1 inline-block size-2.5 shrink-0 animate-spin align-[-1px] text-gray-700"
        />
      ) : null}
      {tabLabel(tab)}
    </>
  );
}

/**
 * The label of a tab whose page is on screen — the active tab, or either pane
 * of a split. Title at rest, cross-fading to the clickable address on hover,
 * or when the address itself is keyboard-focused. Strip-only: in the sidebar
 * the address has its own row (the `address` feature).
 */
export function ActiveTabLabel({ tab, onEdit }: { tab: ChromeTab; onEdit: () => void }) {
  return (
    <span className="relative min-w-0 flex-1 self-stretch">
      <span className="pointer-events-none absolute inset-0 flex items-center transition-opacity duration-150 group-has-[:focus-visible]:opacity-0 group-hover:opacity-0">
        <span className="min-w-0 truncate text-[12.5px] font-medium">
          <TabTitle tab={tab} />
        </span>
      </span>
      <ActiveTabUrl tab={tab} onEdit={onEdit} />
    </span>
  );
}

/**
 * A visible tab's address layer: the current URL rendered as a pressable
 * field that opens the address modal ON THIS TAB — the tab itself is never an
 * editable input, so a stray click on the strip can never leave a half-typed
 * address sitting over the page. (⌘L opens the same modal on the active tab.)
 */
export function ActiveTabUrl({ tab, onEdit }: { tab: ChromeTab; onEdit: () => void }) {
  const shown = shownAddress(tab);

  return (
    <button
      type="button"
      title="Edit address (⌘L)"
      aria-label="Edit address"
      // A drag handle, not just a control: this field covers the active tab's
      // whole title area on hover, so the strip lets a press here start a tab
      // drag (and then swallows the click that ends it).
      data-drag-handle="true"
      onClick={(e) => {
        e.stopPropagation();
        onEdit();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="pointer-events-none absolute inset-x-0 inset-y-[3px] flex w-full min-w-0 cursor-pointer items-center rounded-[7px] px-1.5 text-left font-mono text-[11.5px] text-gray-900 opacity-0 transition-opacity duration-150 hover:bg-alpha-200 hover:text-gray-1000 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none group-hover:pointer-events-auto group-hover:opacity-100"
    >
      <span className="min-w-0 truncate">
        {shown.length > 0 ? shown : <span className="text-gray-700">Search or enter URL</span>}
      </span>
    </button>
  );
}

export function TabCloseButton({ tab }: { tab: ChromeTab }) {
  const closeTab = useAppStore((s) => s.closeTab);
  return (
    <button
      type="button"
      title="Close tab"
      aria-label={`Close ${tab.title || "tab"}`}
      onClick={(e) => {
        e.stopPropagation();
        void closeTab(tab.id);
      }}
      className="grid size-6 cursor-pointer place-items-center rounded-md text-gray-700 hover:bg-alpha-300 hover:text-gray-1000"
    >
      <X className="size-3" aria-hidden="true" />
    </button>
  );
}

/** Opens the tab in the second pane, or dissolves the split it is part of. */
export function SplitToggleButton({ tab }: { tab: ChromeTab }) {
  const setSplit = useAppStore((s) => s.setSplit);
  const splitWith = useAppStore((s) => s.splitWith);
  const selectTab = useAppStore((s) => s.selectTab);
  const inSplit = tab.splitGroup !== null;

  return (
    <button
      type="button"
      title={inSplit ? "Close split" : "Open in split view"}
      aria-label={inSplit ? `Close split for ${tab.title || "tab"}` : `Open ${tab.title || "tab"} in split view`}
      onClick={(e) => {
        e.stopPropagation();
        if (inSplit) {
          void (async () => {
            // A control on an inactive split still acts on THAT pair: restore
            // it first, then dissolve the now-active group.
            if (!tab.active && !tab.split) await selectTab(tab.id);
            await setSplit("single");
          })();
        }
        else if (tab.active) void setSplit("vertical");
        else void splitWith(tab.id, "right");
      }}
      className={cn(
        "grid size-6 cursor-pointer place-items-center rounded-md hover:bg-alpha-300 hover:text-gray-1000",
        inSplit ? "text-green-900" : "text-gray-700",
      )}
    >
      <Columns2 className="size-3" aria-hidden="true" />
    </button>
  );
}

/**
 * Opens the agent chat with this tab as the working context. A shell
 * command, not a store call, so it works from any chrome page.
 */
export function DelegateButton({ tab }: { tab: ChromeTab }) {
  const { run } = useShell();
  if (tab.kind !== "human") return null;
  return (
    <button
      type="button"
      title="Ask Pistachio about this tab"
      aria-label={`Ask Pistachio about ${tab.title || "tab"}`}
      onClick={(e) => {
        e.stopPropagation();
        run({ type: "delegate", tabId: tab.id });
      }}
      className="grid size-6 cursor-pointer place-items-center rounded-md text-gray-700 hover:bg-alpha-300 hover:text-green-900"
    >
      <Sparkles className="size-3" aria-hidden="true" />
    </button>
  );
}

/**
 * Keeps this tab as a pin on the sidebar shelf, or lets a pinned one go
 * (@pistachio/shell-contracts/sidebar). Only a person's own page: an agent tab is the run's,
 * and a favorite's tab is the grid's to keep.
 */
export function PinToggleButton({ tab }: { tab: ChromeTab }) {
  const sidebarCommand = useAppStore((s) => s.sidebarCommand);
  const pinned = useAppStore(
    (s) => tab.anchorId !== null && (s.snapshot?.sidebar.entries.some((e) => e.kind === "pin" && e.id === tab.anchorId) ?? false),
  );
  if (tab.kind !== "human" || (tab.anchorId !== null && !pinned)) return null;
  return (
    <button
      type="button"
      title={pinned ? "Unpin tab" : "Pin tab"}
      aria-label={pinned ? `Unpin ${tab.title || "tab"}` : `Pin ${tab.title || "tab"}`}
      onClick={(e) => {
        e.stopPropagation();
        if (pinned) void sidebarCommand({ type: "unpin", pinId: tab.anchorId ?? "" });
        else void sidebarCommand({ type: "pinTab", tabId: tab.id, folderId: null, index: 10_000 });
      }}
      className={cn(
        "grid size-6 cursor-pointer place-items-center rounded-md hover:bg-alpha-300 hover:text-gray-1000",
        pinned ? "text-green-900" : "text-gray-700",
      )}
    >
      {pinned ? <PinOff className="size-3" aria-hidden="true" /> : <Pin className="size-3" aria-hidden="true" />}
    </button>
  );
}

export function SuspendButton({ tab }: { tab: ChromeTab }) {
  const suspendTab = useAppStore((state) => state.suspendTab);
  if (tab.kind !== "human" || tab.lifecycle === "suspended" || tab.active || tab.split) return null;
  return (
    <button
      type="button"
      title="Suspend tab"
      aria-label={`Suspend ${tab.title || "tab"}`}
      onClick={(event) => {
        event.stopPropagation();
        void suspendTab(tab.id);
      }}
      className="grid size-6 cursor-pointer place-items-center rounded-md text-gray-700 hover:bg-alpha-300 hover:text-gray-1000"
    >
      <Moon className="size-3" aria-hidden="true" />
    </button>
  );
}

export type TabActionId = "delegate" | "split" | "pin" | "suspend";

function renderDelegate(tab: ChromeTab): React.ReactNode {
  return <DelegateButton key="delegate" tab={tab} />;
}

function renderSplit(tab: ChromeTab): React.ReactNode {
  return <SplitToggleButton key="split" tab={tab} />;
}

function renderPin(tab: ChromeTab): React.ReactNode {
  return <PinToggleButton key="pin" tab={tab} />;
}

function renderSuspend(tab: ChromeTab): React.ReactNode {
  return <SuspendButton key="suspend" tab={tab} />;
}

/**
 * The per-tab actions, in the order they unfold behind the dots. Both the
 * strip's and the list's trailing cluster render this list, so a new per-tab
 * action is added here and nowhere else.
 */
export const TAB_ACTIONS: ReadonlyArray<{ id: TabActionId; render(tab: ChromeTab): React.ReactNode }> = [
  { id: "delegate", render: renderDelegate },
  { id: "split", render: renderSplit },
  { id: "pin", render: renderPin },
  { id: "suspend", render: renderSuspend },
];

/**
 * The tab's actions (split, delegate, …) folded behind one three-dot button,
 * so a hovered tab shows a single control instead of a growing row of them.
 * Hovering the dots swaps them for the actions IN PLACE: the button collapses
 * to zero width as the icons unfold into its slot, both tweening over the same
 * 200ms so the swap reads as one control widening.
 */
export function TabActions({ actions }: { actions: React.ReactNode[] }) {
  const items = actions.filter(Boolean);
  if (items.length === 0) return null;

  return (
    <span className="group/actions -my-1 -mr-1 flex shrink-0 items-center">
      <button
        type="button"
        title="Tab actions"
        aria-label="Tab actions"
        onClick={(e) => e.stopPropagation()}
        className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-md text-gray-700 transition-[width,opacity] duration-200 ease-out hover:bg-alpha-300 hover:text-gray-1000 group-hover/actions:pointer-events-none group-hover/actions:w-0 group-hover/actions:opacity-0 group-focus-within/actions:pointer-events-none group-focus-within/actions:w-0 group-focus-within/actions:opacity-0"
      >
        <MoreHorizontal className="size-3 shrink-0" aria-hidden="true" />
      </button>
      <span className="grid grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-200 ease-out group-hover/actions:grid-cols-[1fr] group-hover/actions:opacity-100 group-focus-within/actions:grid-cols-[1fr] group-focus-within/actions:opacity-100">
        <span className="flex min-w-0 items-center overflow-hidden">{items}</span>
      </span>
    </span>
  );
}

/**
 * What a tab shows in its trailing slot at rest: a delegated tab carries a
 * live dot for as long as its run is driving; a human tab shows nothing.
 */
export function TabRestMark({ tab }: { tab: ChromeTab }) {
  if (tab.lifecycle === "suspended") {
    return (
      <span
        role="img"
        aria-label="Sleeping"
        title="Sleeping"
        className="grid size-6 shrink-0 place-items-center text-gray-700"
      >
        <Moon className="size-3" aria-hidden="true" />
      </span>
    );
  }
  if (tab.kind !== "agent") return null;
  return (
    <span
      aria-hidden="true"
      className="animate-pulse-dot mx-1 inline-block size-[6px] shrink-0 rounded-full bg-accent"
      style={{ boxShadow: "0 0 5px var(--color-green-400)" }}
    />
  );
}

/**
 * A tab reading its page in reader view says so beside its mark — and the
 * badge is the way back: pressing it returns that tab to the page the article
 * came from, without making it the active tab, the way the audio signal mutes
 * without switching.
 */
export function TabReaderMark({ tab }: { tab: ChromeTab }) {
  if (!isReaderUrl(tab.url)) return null;
  return (
    <button
      type="button"
      title="Leave reader view"
      aria-label={`Leave reader view for ${tab.title || "this tab"}`}
      data-testid={`tab-reader-mark-${tab.id}`}
      // The row starts a drag on pointerdown and selects on click; this badge
      // is neither, so both stop here.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void useAppStore.getState().toggleReaderView(tab.id);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      className="tab-reader-mark"
    >
      <BookOpen aria-hidden="true" />
    </button>
  );
}

/** Chrome-style per-tab audio signal; pressing it toggles only that tab's sound. */
export function TabAudioIndicator({ tab }: { tab: ChromeTab }) {
  const status = useAppStore((state): "none" | "playing" | "muted" => {
    const media = state.media.find((item) => item.tabId === tab.id);
    if (media === undefined || !media.playing) return "none";
    return media.muted ? "muted" : "playing";
  });
  if (status === "none") return null;

  const muted = status === "muted";
  const label = `${muted ? "Unmute" : "Mute"} audio from ${tab.title || "tab"}`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid="tab-audio-indicator"
      data-muted={muted || undefined}
      onClick={(event) => {
        event.stopPropagation();
        void useAppStore.getState().controlMedia(tab.id, { type: "mute" });
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      className="tab-audio-indicator"
    >
      {muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
    </button>
  );
}

/**
 * A tab held in forced focus says so for as long as it is — the page there
 * thinks it is in front, which is worth knowing — and, like the audio signal,
 * pressing the mark undoes it without switching to the tab.
 */
export function TabForcedFocusMark({ tab }: { tab: ChromeTab }) {
  if (tab.forcedFocus !== true) return null;
  const label = `Stop forcing focus on ${tab.title || "tab"}`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={`tab-forced-focus-mark-${tab.id}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void useAppStore.getState().setForcedFocus(tab.id, false);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      className="tab-audio-indicator"
    >
      <Focus aria-hidden="true" />
    </button>
  );
}

/**
 * The tab's trailing slot: its rest mark, then its controls (TAB_ACTIONS
 * behind the dots, then close) once the tab is hovered or focused. The two
 * are clip boxes that cross rather than a display swap — the rest mark's
 * width tweens to zero over exactly the span the controls' width tweens open.
 * `omit` drops actions that make no sense for this tab's place (the left pane
 * of a fused split tab carries no split toggle; the right one does).
 */
export function TabTrailing({ tab, omit = [] }: { tab: ChromeTab; omit?: readonly TabActionId[] }) {
  const actions = TAB_ACTIONS.filter((action) => !omit.includes(action.id)).map((action) => action.render(tab));
  return (
    <span className="-my-1 -mr-1 flex shrink-0 items-center">
      <TabForcedFocusMark tab={tab} />
      <TabAudioIndicator tab={tab} />
      <span className="grid grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-200 ease-out group-hover:grid-cols-[1fr] group-hover:opacity-100 group-has-[:focus-visible]:grid-cols-[1fr] group-has-[:focus-visible]:opacity-100">
        <span className="flex min-w-0 items-center overflow-hidden">
          <TabActions actions={actions} />
          <TabCloseButton tab={tab} />
        </span>
      </span>
      <span className="grid grid-cols-[1fr] transition-[grid-template-columns,opacity] duration-200 ease-out group-hover:grid-cols-[0fr] group-hover:opacity-0 group-has-[:focus-visible]:grid-cols-[0fr] group-has-[:focus-visible]:opacity-0">
        <span className="flex min-w-0 items-center overflow-hidden">
          <TabRestMark tab={tab} />
        </span>
      </span>
    </span>
  );
}
