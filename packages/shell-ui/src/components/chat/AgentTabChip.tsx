import { memo } from "react";
import type { RunSummary } from "@pistachio/protocol";
import { agentDrivenTabId } from "@pistachio/shell-contracts/agent-glow";
import { cn } from "../../lib/cn";
import { displayHost } from "../../lib/url";
import { useAppStore } from "../../store";
import { TabMark } from "../Favicon";
import { Button } from "../ui/button";
import type { ChatDensity } from "./parts";

/**
 * Where the agent is working, when it is not the page the person is on.
 *
 * The agent browses in tabs behind the person's (it opens its own in the
 * background, and only `tab_show` — "take me to…" — switches tabs), so the
 * pane's ring never lights and nothing on screen moves. This line under the
 * live reply is what says a page is open and being worked: the tab's mark
 * with the agent's ring, whether it is one the run opened, its title, and a
 * button that takes the person there — the switch is theirs to make.
 *
 * Gone as soon as that tab is on screen (the pane is ringed then) or the
 * agent stops driving.
 */
export const AgentTabChip = memo(function AgentTabChip({ run, density }: { run: RunSummary; density: ChatDensity }) {
  const tabId = agentDrivenTabId(run);
  const tab = useAppStore((state) => (tabId === null ? null : (state.snapshot?.tabs.find((candidate) => candidate.id === tabId) ?? null)));
  const onScreen = useAppStore((state) => tabId !== null && (state.snapshot?.visibleTabIds.includes(tabId) ?? false));
  const selectTab = useAppStore((state) => state.selectTab);
  if (tab === null || onScreen) return null;
  const opened = run.toolCalls.some((call) => call.name === "tab.open" && call.tabId === tab.id);
  const title = tab.title || displayHost(tab.url) || "a page";
  return (
    <div
      data-testid="agent-tab-chip"
      data-tab-id={tab.id}
      className={cn(
        "flex w-fit max-w-full min-w-0 items-center gap-2 rounded-full bg-background-100 py-1 pr-1 pl-2.5 shadow-border",
        density === "page" ? "text-[13px]" : "text-label-12",
      )}
    >
      <TabMark tab={tab} working />
      <span className="min-w-0 truncate text-gray-700">
        {opened ? "Browsing in a new tab" : "Browsing in another tab"}
        <span aria-hidden="true"> · </span>
        <span className="text-gray-1000" data-testid="agent-tab-chip-title">
          {title}
        </span>
      </span>
      <Button
        variant="tertiary"
        size="xs"
        shape="circle"
        className="shrink-0"
        aria-label={`Show ${title}`}
        title="Go to this tab"
        data-testid="agent-tab-chip-show"
        onClick={() => void selectTab(tab.id)}
      >
        Show
      </Button>
    </div>
  );
});
