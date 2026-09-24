import type { ReactNode } from "react";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { displayHost } from "../lib/url";
import { Favicon } from "./Favicon";

/**
 * What a pane shows until its page is on screen: the tab's favicon, large and
 * pulsing, stacked over a caption. The favicon and caption are one column that
 * is centered as a block — centering a caption on its own puts it inside the
 * favicon. Desktop shows it while a sleeping tab wakes; the web's panes show
 * it until their first paint, which covers the wake too.
 */
export function PanePlaceholder({ tab, children }: { tab: BrowserTabInfo; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <span className="animate-pulse-dot">
        <Favicon
          src={tab.faviconUrl}
          seed={displayHost(tab.url) || tab.title || "•"}
          className="size-16 rounded-2xl text-[28px] shadow-menu"
        />
      </span>
      {children}
    </div>
  );
}
