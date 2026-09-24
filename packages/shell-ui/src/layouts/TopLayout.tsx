import { TRAFFIC_LIGHTS_W } from "@pistachio/shell-contracts/chrome";
import { ChromeRegion } from "../chrome/manifest-renderers";
import { AgentConsole } from "../components/AgentConsole";
import { ContentArea } from "../components/ContentArea";

/**
 * The top-tabs layout: a 40px titlebar strip over the content row. The strip
 * is the window's drag region; it darkens toward the window edge and its
 * bottom hairline is the panel's top-edge highlight — the active tab's
 * silhouette highlight joins it at the flare tips.
 *
 * The layout places REGIONS and nothing else. What each region holds is the
 * manifest's business (chrome/manifest.ts): leading → tabs → trailing across
 * the strip, after the traffic-light pad.
 */
export function TopLayout() {
  return (
    <div
      data-testid="chrome-layout-ground"
      className="chrome-container chrome-layout-ground grid h-full w-full grid-rows-[40px_minmax(0,1fr)]"
    >
      <header className="chrome-strip drag-region relative flex h-10 shrink-0 items-end">
        {/* Panel top edge — the active tab covers its own span of this line. */}
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-alpha-400" />
        <div className="flex min-w-0 flex-1 items-end gap-1.5 pr-2.5" style={{ paddingLeft: TRAFFIC_LIGHTS_W }}>
          <ChromeRegion layout="top" region="leading" />
          <ChromeRegion layout="top" region="tabs" />
          <div className="no-drag mb-1.5 flex h-7 shrink-0 items-center gap-1.5">
            <ChromeRegion layout="top" region="trailing" />
          </div>
        </div>
      </header>
      <div data-testid="chrome-content-row" className="chrome-layout-ground flex min-h-0 min-w-0">
        <ContentArea />
        <AgentConsole />
      </div>
    </div>
  );
}
