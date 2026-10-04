import { useEffect } from "react";
import { UrlBar } from "./components/UrlBar";
import { TabSwitcher } from "./components/TabSwitcher";
import { SidebarLayout } from "./layouts/SidebarLayout";
import { useAppStore } from "./store";

/**
 * The chrome: the sidebar layout, with the overlays that sit outside it.
 * The address modal is a fixed overlay, so it sits beside the layout rather
 * than inside it.
 */
export function ChromeLayoutRoot() {
  // A reveal only means something for the compact sidebar; pinning starts it
  // over, so a switch back to compact begins hidden.
  const compact = useAppStore((state) => state.settings.layout.sidebar === "compact");
  const setSidebarRevealed = useAppStore((state) => state.setSidebarRevealed);
  useEffect(() => {
    if (!compact) setSidebarRevealed(false);
  }, [compact, setSidebarRevealed]);
  return (
    <>
      <SidebarLayout />
      <UrlBar />
      <TabSwitcher />
    </>
  );
}
