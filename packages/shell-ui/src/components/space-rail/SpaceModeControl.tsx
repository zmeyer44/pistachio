import { AppWindow, SquareStack } from "lucide-react";
import { spaceShowsTabs, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { askSpread, currentSpace, deskAvailable } from "../../lib/desk/open";
import { useAppStore } from "../../store";
import type { MenuEntry } from "../ContextMenu";

/** What the two ways say, on the control and in the space's menu. */
const WORDS = {
  tabs: { label: "Tabs", title: "Tabs: one page at a time, filling the desk", menu: "Show as tabs" },
  windows: { label: "Windows", title: "Windows: pages side by side on the desk, laid out as you like", menu: "Show as windows" },
} as const;

/**
 * The space shown as tabs (false) or as windows (true): main's `setWindows`, which the desk follows (DeskSurface). A
 * space not in front (its tile's menu) is spread out as windows when the desk passes to it (askSpread).
 */
function showAsWindows(groupId: string, windows: boolean): void {
  if (currentSpace() !== groupId) askSpread(groupId, windows);
  void useAppStore.getState().tabGroupCommand({ type: "setWindows", groupId, windows });
}

/**
 * How a space shows its tabs on the desk (docs/space-tabs.md), in the double sidebar's card under its head: **Tabs**,
 * as a browser does and Home does — one page at a time, filling the desk, every space's way to start with — or
 * **Windows**, the desk's free windows, side by side, laid out (its layouts then under this). A segmented control, its
 * thumb under the way it is shown; a click on the other asks main (`setWindows`). Going to windows brings out the
 * windows as the space last had them, or its tabs used most lately, tiled; going to tabs leaves the page in use
 * filling the desk, the others going home into their rows. The desk can make a space one of windows itself: its page
 * carried off the whole desk, or a second window brought out beside it (a row dragged out). Not for an empty space,
 * which has no page to show either way.
 */
export function SpaceModeControl({ group }: { group: TabGroupInfo }): React.ReactNode {
  if (group.tabIds.length === 0) return null;
  const tabs = spaceShowsTabs(group);
  const mode = tabs ? "tabs" : "windows";
  return (
    <div data-testid="space-mode" data-mode={mode} role="radiogroup" aria-label="Show this space's tabs as" className="space-mode">
      <span className="space-mode-thumb" aria-hidden="true" />
      {(["tabs", "windows"] as const).map((way) => (
        <button
          key={way}
          type="button"
          role="radio"
          aria-checked={way === mode}
          data-testid={`space-mode-${way}`}
          title={WORDS[way].title}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (way !== mode) showAsWindows(group.id, way === "windows");
          }}
          className="space-mode-option no-drag"
        >
          {way === "tabs" ? <AppWindow aria-hidden="true" /> : <SquareStack aria-hidden="true" />}
          {WORDS[way].label}
        </button>
      ))}
    </div>
  );
}

/**
 * The space's menu's way to the other (its tile's right click and its head's ⋯ — the control's twin, there for the
 * rail standing alone, which has no card): "Show as windows", or "Show as tabs". The desktop's: the web has no desk.
 */
export function spaceModeEntries(group: TabGroupInfo): MenuEntry[] {
  if (!deskAvailable() || group.tabIds.length === 0 || group.loose === true) return [];
  const tabs = spaceShowsTabs(group);
  return [
    tabs
      ? { label: WORDS.windows.menu, icon: <SquareStack aria-hidden="true" />, onSelect: () => showAsWindows(group.id, true) }
      : { label: WORDS.tabs.menu, icon: <AppWindow aria-hidden="true" />, onSelect: () => showAsWindows(group.id, false) },
  ];
}
