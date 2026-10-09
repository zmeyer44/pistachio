import { useEffect } from "react";
import { UrlBar } from "./components/UrlBar";
import { TabSwitcher } from "./components/TabSwitcher";
import { SidebarLayout } from "./layouts/SidebarLayout";
import { useSidebarMode } from "./lib/sidebar-mode";
import { useAppStore } from "./store";

/**
 * The chrome: the sidebar layout, with the overlays that sit outside it.
 * The address modal is a fixed overlay, so it sits beside the layout rather
 * than inside it.
 */
export function ChromeLayoutRoot() {
  // A reveal only means something for the hidden sidebar; any other mode
  // starts it over, so a switch back to hidden begins away.
  const hidden = useSidebarMode() === "hidden";
  const setSidebarRevealed = useAppStore((state) => state.setSidebarRevealed);
  useEffect(() => {
    if (!hidden) setSidebarRevealed(false);
  }, [hidden, setSidebarRevealed]);
  return (
    <>
      <SidebarLayout />
      <UrlBar />
      <TabSwitcher />
    </>
  );
}
