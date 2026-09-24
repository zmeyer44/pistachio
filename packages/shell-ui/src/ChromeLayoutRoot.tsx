import { useEffect } from "react";
import { UrlBar } from "./components/UrlBar";
import { TabSwitcher } from "./components/TabSwitcher";
import { SidebarLayout } from "./layouts/SidebarLayout";
import { TopLayout } from "./layouts/TopLayout";
import { useAppStore } from "./store";

/**
 * The one switch on the layout setting. Both layouts are built from the same
 * pieces — ContentArea and AgentConsole — arranged
 * around regions the manifest fills; changing the setting re-arranges the
 * chrome live, and nothing is lost because every feature is placed in both.
 * The address modal is a fixed overlay, so it sits outside the switch and
 * survives a layout change.
 */
export function ChromeLayoutRoot() {
  const mode = useAppStore((state) => state.settings.layout.mode);
  // A reveal only means something for the compact sidebar; any other layout
  // starts it over, so a switch back to compact begins hidden.
  const compact = useAppStore((state) => state.settings.layout.mode === "sidebar" && state.settings.layout.sidebar === "compact");
  const setSidebarRevealed = useAppStore((state) => state.setSidebarRevealed);
  useEffect(() => {
    if (!compact) setSidebarRevealed(false);
  }, [compact, setSidebarRevealed]);
  return (
    <>
      {mode === "sidebar" ? <SidebarLayout /> : <TopLayout />}
      <UrlBar />
      <TabSwitcher />
    </>
  );
}
