import { CircleUserRound, Globe, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import type { SpaceInfo } from "@pistachio/shell-contracts/ipc";
import { ActionMenuItem } from "../chrome/actions";
import { useShell } from "../chrome/shell-host";
import { cn } from "../lib/cn";
import { useAppStore } from "../store";
import type { PlaneRow } from "../lib/chrome-status";
import { RenderingStatus, useBrowserStatus } from "./StatusControl";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { MenuItem, MenuLabel, MenuPanel, MenuSeparator, useMenuButton } from "./ui/menu";

/**
 * The sidebar footer's one menu, at the row's start: the active Space's
 * avatar. Hover shows the menu, a click pins it. The Space and who is
 * signed in head the panel, any other Space to switch to follows, and below
 * them the controls the strip lays out as separate buttons — the agent
 * panel, reminders, bookmarks, settings — folded into one list (the
 * manifest hides each of those in the sidebar and names this as the reason).
 */
export function SidebarMenu() {
  const status = useBrowserStatus();
  const spaces = useAppStore((state) => state.snapshot?.spaces ?? EMPTY_SPACES);
  const activeSpaceId = useAppStore((state) => state.snapshot?.activeSpaceId ?? null);
  const switchSpace = useAppStore((state) => state.switchSpace);
  const email = useAppStore((state) => state.account.email);
  const menu = useMenuButton({ dismissed: useCompactSidebarHidden() });
  useFooterMenuOpen(menu.open);
  const { run } = useShell();
  const active = spaces.find((space) => space.id === activeSpaceId) ?? null;
  const parent = active?.parentSpaceId == null ? null : (spaces.find((space) => space.id === active.parentSpaceId) ?? null);
  const others = spaces.filter((space) => space.id !== activeSpaceId);
  // The cloud browser's plane is not a row here; the rest still open what reports them.
  const planes = status.planes.filter((plane): plane is MenuPlane => plane.id !== "cloud");
  return (
    <div ref={menu.rootRef} className="no-drag relative flex shrink-0" {...menu.rootProps}>
      <button
        ref={menu.triggerRef}
        type="button"
        data-testid="sidebar-menu-button"
        aria-label={active === null ? "Menu" : `Space: ${active.name}`}
        title={active?.name ?? "Menu"}
        {...menu.triggerProps}
        className={cn(
          "grid size-6 cursor-pointer place-items-center rounded-full transition-transform hover:scale-105",
          menu.open && "ring-2 ring-alpha-600 ring-offset-2 ring-offset-(--chrome-surface)",
        )}
      >
        {active === null ? (
          <Avatar size={20} aria-hidden="true">
            <AvatarFallback />
          </Avatar>
        ) : (
          <SpaceAvatar space={active} size={20} />
        )}
      </button>
      {menu.open ? (
        <MenuPanel menu={menu} label="Sidebar menu" align="start" testId="sidebar-menu">
          {active === null ? null : (
            <>
              <div data-testid="sidebar-menu-profile" className="flex items-center gap-2 px-2 py-1.5">
                <SpaceAvatar space={active} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] leading-4 font-medium">{active.name}</span>
                  <span className="block truncate text-[10.5px] leading-3.5 text-gray-700">
                    {email ?? (parent === null ? "Current Space" : `Forked from ${parent.name}`)}
                  </span>
                </span>
              </div>
              {others.length > 0 ? (
                <>
                  <MenuLabel>Switch to</MenuLabel>
                  {others.map((space) => (
                    <MenuItem
                      key={space.id}
                      icon={<SpaceAvatar space={space} size={16} />}
                      label={space.name}
                      note={space.parentSpaceId === null ? undefined : "Forked Space"}
                      testId={`space-chip-${space.id}`}
                      onSelect={() => void switchSpace(space.id)}
                    />
                  ))}
                </>
              ) : null}
              <MenuSeparator />
            </>
          )}
          <RenderingStatus rendering={status.rendering} />
          {/* A row that answers for something managed elsewhere carries that
              address (`PlaneRow.href`) and opens it in a tab of the outer
              browser; every other row opens the settings section that can
              change what it reports. */}
          {planes.map((plane) => (
            <MenuItem
              key={plane.id}
              icon={PLANE_ICON[plane.id]}
              label={`${plane.label} · ${plane.value}`}
              note={plane.note}
              tone={plane.tone === "amber" || plane.tone === "red" ? "amber" : plane.tone === "gray" ? "default" : "green"}
              testId={`menu-plane-${plane.id}`}
              href={plane.href}
              onSelect={() => run({ type: "openSettings", section: plane.section })}
            />
          ))}
          {status.rendering !== null || planes.length > 0 ? <MenuSeparator /> : null}
          <ActionMenuItem id="toggleConsole" testId="agent-panel-toggle" />
          <ActionMenuItem id="openBrief" testId="brief-button" />
          <ActionMenuItem id="openNotes" testId="notes-button" />
          <ActionMenuItem id="openReminders" testId="reminders-button" />
          <ActionMenuItem id="openBookmarks" testId="bookmarks-button" />
          <ActionMenuItem id="tidyTabs" testId="tidy-tabs-menu-item" />
          <ActionMenuItem id="openDownloads" testId="downloads-menu-item" />
          <ActionMenuItem id="openSettings" testId="settings-button" />
        </MenuPanel>
      ) : null}
    </div>
  );
}
const EMPTY_SPACES: SpaceInfo[] = [];

type MenuPlane = PlaneRow & { id: Exclude<PlaneRow["id"], "cloud"> };

const PLANE_ICON: Record<MenuPlane["id"], React.ReactNode> = {
  identity: <RefreshCw />,
  egress: <Globe />,
  managed: <CircleUserRound />,
};

/** A Space's colour disc with its initial. */
function SpaceAvatar({ space, size }: { space: SpaceInfo; size: 16 | 20 | 24 }) {
  return (
    <Avatar size={size} aria-hidden="true">
      <AvatarFallback className="font-bold text-gray-1000" style={{ background: space.color }}>
        {space.name.charAt(0)}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * Tell the store while this footer menu is open. The panel opens upward over
 * the media stack, whose video is a native view composited ABOVE this page,
 * so no z-index can put the menu over it: the stack takes the view down for
 * the duration instead (MediaStack reads `footerMenusOpen`).
 */
export function useFooterMenuOpen(open: boolean): void {
  const setFooterMenuOpen = useAppStore((state) => state.setFooterMenuOpen);
  useEffect(() => {
    if (!open) return;
    setFooterMenuOpen(true);
    return () => setFooterMenuOpen(false);
  }, [open, setFooterMenuOpen]);
}

/** The compact column has left the layout: a menu opened from it goes with it. */
export function useCompactSidebarHidden(): boolean {
  return useAppStore(
    (state) => state.settings.layout.mode === "sidebar" && state.settings.layout.sidebar === "compact" && !state.sidebarRevealed,
  );
}
