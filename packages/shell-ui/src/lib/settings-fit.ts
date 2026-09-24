/**
 * Whether the settings page should take the console's room as well as its
 * own. The page shares the window with the sidebar and the agent chat; at
 * the smallest window with both open it is left a column too narrow for
 * a row's control to sit beside its label. Below SETTINGS_MIN_CONTENT_W of
 * content width the page is painted over the console instead, which stays
 * mounted and open underneath — it is back untouched once settings closes.
 */

import { useEffect, useState } from "react";
import { SIDEBAR_EDGE_W } from "@pistachio/shell-contracts/chrome";
import { useAppStore } from "../store";

/** The least content width a settings section lays out well in. */
export const SETTINGS_MIN_CONTENT_W = 620;

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

export function useSettingsCoversConsole(): boolean {
  const settingsOpen = useAppStore((state) => state.overlay === "settings");
  const consoleOpen = useAppStore((state) => state.consoleOpen);
  const consoleWidth = useAppStore((state) => state.consoleWidth);
  const sidebarLayout = useAppStore(
    (state) => state.settings.layout.mode === "sidebar",
  );
  const pinned = useAppStore(
    (state) => state.settings.layout.sidebar === "pinned",
  );
  const sidebarWidth = useAppStore((state) => state.sidebarWidth);
  const windowWidth = useWindowWidth();
  if (!settingsOpen || !consoleOpen) return false;
  const chrome = sidebarLayout ? (pinned ? sidebarWidth : SIDEBAR_EDGE_W) : 0;
  return windowWidth - chrome - consoleWidth < SETTINGS_MIN_CONTENT_W;
}
