import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
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
          "grid size-4 shrink-0 place-items-center rounded-[4px] bg-alpha-200 text-[9px] leading-none font-semibold text-gray-900 [text-box:trim-both_cap_alphabetic]",
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
      className={cn("size-4 shrink-0 rounded-[4px]", className)}
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
 */
export function TabMark({ tab, fallbackFaviconUrl = null, className }: { tab: BrowserTabInfo; fallbackFaviconUrl?: string | null; className?: string }) {
  if (tab.kind === "agent") {
    return (
      <span className={cn("grid size-4 shrink-0 place-items-center rounded-[4px] bg-green-100 text-green-900", className)}>
        <Bot className="size-[62%]" aria-hidden="true" />
      </span>
    );
  }
  return <Favicon src={tab.faviconUrl ?? fallbackFaviconUrl} seed={displayHost(tab.url) || tab.title} className={className} />;
}
