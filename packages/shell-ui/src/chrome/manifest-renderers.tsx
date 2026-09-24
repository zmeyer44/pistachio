/**
 * The renderers behind the manifest (manifest.ts — a sibling named
 * manifest.tsx would be shadowed by it on import), and the one component a
 * layout is allowed to use: `ChromeRegion`, which renders whatever the
 * manifest places in a region, in order. `CHROME_RENDERERS` is a Record
 * keyed by the id union, so a feature added to the manifest without a
 * renderer is a type error, not a blank spot in one layout.
 */

import { Globe } from "lucide-react";
import type { FC } from "react";
import type { SpaceInfo } from "@pistachio/shell-contracts/ipc";
import { DownloadsChip } from "../components/DownloadsChip";
import { TabMark } from "../components/Favicon";
import { FavoritesGrid } from "../components/FavoritesGrid";
import { MediaStack } from "../components/MediaStack";
import { SidebarMenu } from "../components/SidebarMenu";
import { StatusControl } from "../components/StatusControl";
import { SyncPill } from "../components/SyncPill";
import { TabList } from "../components/TabList";
import { TabStrip } from "../components/TabStrip";
import { UpdatePill } from "../components/UpdatePill";
import { Kbd } from "../components/ui/kbd";
import { cn } from "../lib/cn";
import { selectActiveTab, useAppStore } from "../store";
import { ActionButton, useAction } from "./actions";
import { featuresIn, type ChromeFeatureId, type SidebarRegion, type TopRegion } from "./manifest";
import { shownAddress } from "./tab-parts";
import { useChromeTabs } from "./tabs";

/** Which way the chrome runs: the strip is horizontal, the sidebar vertical. */
export type ChromeOrientation = "horizontal" | "vertical";

export interface ChromeRendererProps {
  orientation: ChromeOrientation;
}

/** The 24px button variant an orientation implies. */
function buttonVariant(orientation: ChromeOrientation): "strip" | "sidebar" {
  return orientation === "horizontal" ? "strip" : "sidebar";
}

/* ------------------------------ navigation ------------------------------ */

/** The sidebar toolbar's back / forward / reload. */
function NavigationCluster({ orientation }: ChromeRendererProps) {
  const variant = buttonVariant(orientation);
  return (
    <>
      <ActionButton id="back" variant={variant} />
      <ActionButton id="forward" variant={variant} />
      <ActionButton id="reload" variant={variant} />
    </>
  );
}

/* -------------------------------- address ------------------------------- */

/**
 * The sidebar's address row: the active tab's mark and address as one pill
 * that opens the address modal on that tab. Like the strip's ActiveTabUrl,
 * it is a button and never an input — nothing half-typed can sit over the
 * page. Runs as a shell command, like every control that opens a modal.
 */
function SidebarAddress() {
  const { hint, run } = useAction("editAddress");
  const tab = useAppStore(selectActiveTab);
  const chrome = useChromeTabs().find((t) => t.id === tab?.id) ?? null;
  const shown = chrome === null ? "" : shownAddress(chrome);
  // Lit like the active tab while the address modal is up over this tab.
  const editing = useAppStore(
    (s) => s.overlay === "url" && !s.urlBarNew && (s.urlBarTabId === null || s.urlBarTabId === tab?.id),
  );
  return (
    <button
      type="button"
      data-testid="sidebar-address"
      title={hint === null ? "Edit address" : `Edit address (${hint})`}
      aria-label="Edit address"
      aria-expanded={editing}
      onClick={run}
      className={cn(
        "no-drag group flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left transition-colors",
        editing ? "bg-background-100 shadow-small" : "bg-alpha-100 hover:bg-alpha-200",
      )}
    >
      {chrome === null ? <Globe className="size-4 shrink-0 text-gray-700" aria-hidden="true" /> : <TabMark tab={chrome} />}
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-gray-900">
        {shown.length > 0 ? shown : <span className="text-gray-700">Search or enter URL</span>}
      </span>
      {hint === null ? null : (
        <Kbd small className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">{hint}</Kbd>
      )}
    </button>
  );
}

/* ------------------------------- favorites ------------------------------ */

/** The favorites grid — presets first, then the person's own. Sidebar only (see the manifest's reason). */
function FavoritesFeature() {
  return <FavoritesGrid />;
}

/* --------------------------------- tabs --------------------------------- */

/** The strip across the top, or the list down the sidebar — each with its new-tab tail inside its FLIP container. */
function TabsFeature({ orientation }: ChromeRendererProps) {
  return orientation === "horizontal" ? <TabStrip /> : <TabList />;
}

/* -------------------------------- media --------------------------------- */

function MediaFeature() {
  return <MediaStack />;
}

/* ------------------------------ sidebarPin ------------------------------ */

/** Last in the toolbar row, pushed to its far end. */
function SidebarPinFeature({ orientation }: ChromeRendererProps) {
  return (
    <span className="ml-auto flex items-center">
      <ActionButton id="toggleSidebarPinned" variant={buttonVariant(orientation)} />
    </span>
  );
}

/* ---------------------------------- menu --------------------------------- */

/** The sidebar footer's menu: the active Space's avatar, with the strip's trailing buttons as rows (see the manifest's fold reason). */
function MenuFeature() {
  return <SidebarMenu />;
}

/* --------------------------------- policy -------------------------------- */

function PolicyFeature({ orientation }: ChromeRendererProps) {
  return <StatusControl orientation={orientation} />;
}

/* ---------------------------- split / console ---------------------------- */

function SplitFeature({ orientation }: ChromeRendererProps) {
  return <ActionButton id="toggleSplit" variant={buttonVariant(orientation)} testId="split-toggle" />;
}

function ConsoleFeature({ orientation }: ChromeRendererProps) {
  return <ActionButton id="toggleConsole" variant={buttonVariant(orientation)} testId="agent-panel-toggle" />;
}

function RemindersFeature({ orientation }: ChromeRendererProps) {
  return <ActionButton id="openReminders" variant={buttonVariant(orientation)} testId="reminders-button" />;
}

function BookmarksFeature({ orientation }: ChromeRendererProps) {
  return <ActionButton id="openBookmarks" variant={buttonVariant(orientation)} testId="bookmarks-button" />;
}

function DownloadsFeature({ orientation }: ChromeRendererProps) {
  return <DownloadsChip orientation={orientation} />;
}

function SyncFeature({ orientation }: ChromeRendererProps) {
  return <SyncPill orientation={orientation} />;
}

function UpdateFeature({ orientation }: ChromeRendererProps) {
  return <UpdatePill orientation={orientation} />;
}

function SettingsFeature({ orientation }: ChromeRendererProps) {
  return <ActionButton id="openSettings" variant={buttonVariant(orientation)} testId="settings-button" />;
}

/* --------------------------------- spaces -------------------------------- */

function SpaceChip({ space, active }: { space: SpaceInfo; active: boolean }) {
  const switchSpace = useAppStore((state) => state.switchSpace);
  return (
    <button
      type="button"
      title={`${space.name}${space.parentSpaceId === null ? "" : " · forked Space"}`}
      aria-label={`Space: ${space.name}`}
      aria-pressed={active}
      data-testid={`space-chip-${space.id}`}
      onClick={() => {
        if (!active) void switchSpace(space.id);
      }}
      className={cn(
        "grid size-[20px] shrink-0 cursor-pointer place-items-center rounded-full text-[9.5px] font-bold text-gray-1000 transition-transform",
        active ? "scale-110 ring-2 ring-alpha-600 ring-offset-2 ring-offset-(--chrome-surface)" : "opacity-60 hover:scale-105 hover:opacity-90",
      )}
      style={{ background: space.color }}
    >
      {space.name.charAt(0).toUpperCase()}
    </button>
  );
}

/** The strip shows every Space as a chip; the sidebar folds the active one into its footer menu. */
function SpacesFeature() {
  return <SpaceChips />;
}

/** The space chips, set off from the buttons before them by a hairline. */
function SpaceChips() {
  const spaces = useAppStore((s) => s.snapshot?.spaces ?? EMPTY_SPACES);
  const activeSpaceId = useAppStore((s) => s.snapshot?.activeSpaceId ?? null);
  return (
    <>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-alpha-200" />
      {spaces.map((space) => (
        <SpaceChip key={space.id} space={space} active={space.id === activeSpaceId} />
      ))}
      <ActionButton id="forkSpace" variant="strip" testId="fork-space-button" />
    </>
  );
}
const EMPTY_SPACES: SpaceInfo[] = [];

/** A feature the manifest hides in both layouts (its reasons say where it lives instead). */
function NothingFeature() {
  return null;
}

/* -------------------------------- registry ------------------------------- */

export const CHROME_RENDERERS: Record<ChromeFeatureId, FC<ChromeRendererProps>> = {
  navigation: NavigationCluster,
  address: SidebarAddress,
  // Hidden in both layouts: the button rides with the active page's own
  // controls (TabStrip, PaneToolbar), so nothing to place here.
  siteInfo: NothingFeature,
  favorites: FavoritesFeature,
  tabs: TabsFeature,
  media: MediaFeature,
  sidebarPin: SidebarPinFeature,
  menu: MenuFeature,
  policy: PolicyFeature,
  split: SplitFeature,
  console: ConsoleFeature,
  reminders: RemindersFeature,
  watchtower: ({ orientation }) => <ActionButton id="openWatchtower" variant={buttonVariant(orientation)} testId="watchtower-button" />,
  bookmarks: BookmarksFeature,
  downloads: DownloadsFeature,
  spaces: SpacesFeature,
  sync: SyncFeature,
  update: UpdateFeature,
  settings: SettingsFeature,
};

/**
 * Everything the manifest places in one region of one layout, in order. A
 * layout composes regions and nothing else — it never names a feature.
 */
export function ChromeRegion(props: { layout: "top"; region: TopRegion } | { layout: "sidebar"; region: SidebarRegion }) {
  const features = props.layout === "top" ? featuresIn("top", props.region) : featuresIn("sidebar", props.region);
  const orientation: ChromeOrientation = props.layout === "top" ? "horizontal" : "vertical";
  return (
    <>
      {features.map((feature) => {
        const Feature = CHROME_RENDERERS[feature.id];
        return <Feature key={feature.id} orientation={orientation} />;
      })}
    </>
  );
}
