/**
 * The renderers behind the manifest (manifest.ts — a sibling named
 * manifest.tsx would be shadowed by it on import), and the one component a
 * layout is allowed to use: `ChromeRegion`, which renders whatever the
 * manifest places in a region, in order. `CHROME_RENDERERS` is a Record
 * keyed by the id union, so a feature added to the manifest without a
 * renderer is a type error, not a blank spot in the sidebar.
 */

import { Globe, Search } from "lucide-react";
import type { FC } from "react";
import { DeskMoreButton, DeskRailToggle } from "../components/desk/DeskSidebarControls";
import { DownloadsChip } from "../components/DownloadsChip";
import { TabMark } from "../components/Favicon";
import { FavoritesGrid } from "../components/FavoritesGrid";
import { MediaStack } from "../components/MediaStack";
import { ScreenShareIndicator } from "../components/ScreenShareIndicator";
import { SidebarMenu } from "../components/SidebarMenu";
import { SyncPill } from "../components/SyncPill";
import { TabList } from "../components/TabList";
import { UpdatePill } from "../components/UpdatePill";
import { Kbd } from "../components/ui/kbd";
import { cn } from "../lib/cn";
import { useSidebarRail } from "../components/sidebar-rail";
import { deskAvailable } from "../lib/desk/open";
import { selectActiveTab, useAppStore } from "../store";
import { ActionButton, useAction } from "./actions";
import { featuresIn, type ChromeFeatureId, type SidebarRegion } from "./manifest";
import { shownAddress } from "./tab-parts";
import { useChromeTabs } from "./tabs";

/* ------------------------------ navigation ------------------------------ */

/** The sidebar toolbar's back / forward / reload. */
function NavigationCluster() {
  return (
    <>
      <ActionButton id="back" />
      <ActionButton id="forward" />
      <ActionButton id="reload" />
    </>
  );
}

/* -------------------------------- address ------------------------------- */

/**
 * The sidebar's address row: the active tab's mark and address as one pill
 * that opens the address modal on that tab. It is a button and never an
 * input — nothing half-typed can sit over the page. Runs as a shell command,
 * like every control that opens a modal.
 */
function SidebarAddress() {
  const rail = useSidebarRail();
  const { hint, run } = useAction("editAddress");
  const tab = useAppStore(selectActiveTab);
  const chrome = useChromeTabs().find((t) => t.id === tab?.id) ?? null;
  const shown = chrome === null ? "" : shownAddress(chrome);
  // Lit like the active tab while the address modal is up over this tab.
  const editing = useAppStore(
    (s) => s.overlay === "url" && !s.urlBarNew && (s.urlBarTabId === null || s.urlBarTabId === tab?.id),
  );
  // As a rail (a desk's dock): the same button, its icon alone.
  if (rail)
    return (
      <button
        type="button"
        data-testid="sidebar-address"
        title={hint === null ? "Search or enter URL" : `Search or enter URL (${hint})`}
        aria-label="Edit address"
        aria-expanded={editing}
        onClick={run}
        className={cn(
          "no-drag grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-gray-900 transition-colors [&_svg]:size-[18px]",
          editing ? "bg-background-100 shadow-small" : "bg-alpha-100 hover:bg-alpha-200",
        )}
      >
        <Search aria-hidden="true" />
      </button>
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

/** The favorites grid — presets first, then the person's own. */
function FavoritesFeature() {
  return <FavoritesGrid />;
}

/* --------------------------------- tabs --------------------------------- */

/** The list down the sidebar, with its new-tab tail inside its FLIP container. */
function TabsFeature() {
  return <TabList />;
}

/* -------------------------------- media --------------------------------- */

function MediaFeature() {
  return <MediaStack />;
}

/* ------------------------------ screenShare ----------------------------- */

function ScreenShareFeature() {
  return <ScreenShareIndicator />;
}

/* ------------------------------ sidebarPin ------------------------------ */

/**
 * Last in the toolbar row, pushed to its far end: the sidebar's button to
 * its next place (docs/spaces.md §3). On the desktop, where the desk is the
 * browser, beside the desk's card (arrange, feel): the whole sidebar's goes
 * to the rail, the hidden sidebar's (brought out over the desk) keeps it
 * open. On the web, the ⌘S action itself (whole ⇄ hidden). (The rail's head
 * draws its own: SidebarChrome.)
 */
function SidebarPinFeature() {
  if (deskAvailable())
    return (
      <span className="ml-auto flex items-center gap-0.5">
        <DeskMoreButton />
        <DeskRailToggle />
      </span>
    );
  return (
    <span className="ml-auto flex items-center">
      <ActionButton id="toggleSidebarPinned" />
    </span>
  );
}

/* ---------------------------------- menu --------------------------------- */

/** The sidebar footer's menu: the active Space's avatar, with the chrome's other controls as rows. */
function MenuFeature() {
  return <SidebarMenu />;
}

/* ------------------------------ footer pills ----------------------------- */

function DownloadsFeature() {
  return <DownloadsChip />;
}

function SyncFeature() {
  return <SyncPill />;
}

function UpdateFeature() {
  return <UpdatePill />;
}

/* -------------------------------- registry ------------------------------- */

export const CHROME_RENDERERS: Record<ChromeFeatureId, FC> = {
  navigation: NavigationCluster,
  address: SidebarAddress,
  favorites: FavoritesFeature,
  tabs: TabsFeature,
  media: MediaFeature,
  screenShare: ScreenShareFeature,
  sidebarPin: SidebarPinFeature,
  menu: MenuFeature,
  downloads: DownloadsFeature,
  sync: SyncFeature,
  update: UpdateFeature,
};

/**
 * Everything the manifest places in one region of the sidebar, in order.
 * The sidebar composes regions and nothing else — it never names a feature.
 */
export function ChromeRegion({ region }: { region: SidebarRegion }) {
  return (
    <>
      {featuresIn(region).map((feature) => {
        const Feature = CHROME_RENDERERS[feature.id];
        return <Feature key={feature.id} />;
      })}
    </>
  );
}
