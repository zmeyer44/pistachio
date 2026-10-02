import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Bot } from "lucide-react";
import { agentRingDelayMs } from "@pistachio/shell-contracts/agent-glow";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { cn } from "../lib/cn";
import { displayHost } from "../lib/url";

/**
 * 16px favicon with a letter-tile fallback when the image is missing or fails.
 * `letter={false}` leaves the tile blank: a miniature (a tab group's cluster)
 * has no room for a letter, and a plain tile reads as "a page" where a
 * four-pixel glyph reads as dirt.
 */
export function Favicon({ src, seed, className, letter: showLetter = true }: { src: string | null; seed: string; className?: string; letter?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (src === null || src.length === 0 || failed) {
    const letter = seed.replace(/^www\./, "").charAt(0).toUpperCase() || "•";
    return (
      <span
        className={cn(
          "favicon grid size-4 shrink-0 place-items-center rounded-[4px] bg-alpha-200 text-[9px] leading-none font-semibold text-gray-900 [text-box:trim-both_cap_alphabetic]",
          className,
        )}
      >
        {showLetter ? letter : null}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className={cn("favicon size-4 shrink-0 rounded-[4px]", className)}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * A tab's 16px mark. A delegated (agent) tab gets the bot glyph in an accent
 * tile rather than the page's favicon: the mark is what tells the two kinds of
 * tab apart at a glance, before the title is read.
 *
 * A tab reports no favicon until its page has one (Chromium finds it during
 * the load, sometimes after). `fallbackFaviconUrl` — the icon the tab's
 * anchor last kept — stands in until then, so opening a favorite or a pin
 * does not drop its tile to a letter for the length of the load.
 *
 * `working` rings the mark with the agent's comet while the agent works in
 * the tab (@pistachio/shell-contracts/agent-glow `agentDrivenTabId`) — the
 * pane's own ring in miniature, and the one place the person sees it when
 * the agent works in a tab behind theirs. The caller says so: this file is
 * also drawn by views that have no store.
 */
export function TabMark({
  tab,
  fallbackFaviconUrl = null,
  working = false,
  className,
}: {
  tab: BrowserTabInfo;
  fallbackFaviconUrl?: string | null;
  working?: boolean;
  className?: string;
}) {
  // Phased on the wall clock like every other ring, taken as this one goes on.
  const delay = useMemo(() => (working ? `${String(agentRingDelayMs(Date.now()))}ms` : undefined), [working]);
  const mark =
    tab.kind === "agent" ? (
      <span className={cn("grid size-4 shrink-0 place-items-center rounded-[4px] bg-green-100 text-green-900", className)}>
        <Bot className="size-[62%]" aria-hidden="true" />
      </span>
    ) : (
      <Favicon src={tab.faviconUrl ?? fallbackFaviconUrl} seed={displayHost(tab.url) || tab.title} className={className} />
    );
  if (!working) return mark;
  return (
    <span
      data-testid="tab-agent-working"
      title="Pistachio is working in this tab"
      className="agent-ring agent-ring-mark relative flex shrink-0"
      style={{ "--agent-ring-delay": delay } as CSSProperties}
    >
      {mark}
    </span>
  );
}
