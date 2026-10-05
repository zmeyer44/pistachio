import type { MouseEvent } from "react";
import { sourceHost, type CitedSource } from "../../lib/chat-sources";
import { recentFaviconUrl } from "../../lib/recents";
import { useAppStore } from "../../store";
import { Favicon } from "../Favicon";

/**
 * A page's mark for a source: the favicon the shell has seen for the site
 * — an open tab's, a recent visit's — else the same lookup the recents use.
 */
function useSourceFavicon(url: string): string | null {
  const host = sourceHost(url);
  return useAppStore((state) => {
    const tab = state.snapshot?.tabs.find((candidate) => candidate.faviconUrl !== null && sourceHost(candidate.url) === host);
    if (tab !== undefined) return tab.faviconUrl;
    const recent = state.recents.find((site) => site.host.replace(/^www\./iu, "") === host);
    return recentFaviconUrl({ host, url, faviconUrl: recent?.faviconUrl ?? null });
  });
}

/**
 * A citation: the site's mark and host, and its number when the turn read
 * it — small enough to sit inside a sentence, as the chips ChatGPT and
 * Claude set after a claim do. The whole chip is the link.
 */
export function SourceChip({
  href,
  title,
  index,
  onClick,
  onAuxClick,
}: {
  href: string;
  title: string;
  index: number | null;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onAuxClick: (event: MouseEvent<HTMLElement>) => void;
}) {
  const favicon = useSourceFavicon(href);
  const host = sourceHost(href);
  return (
    <a
      href={href}
      title={title === "" ? href : `${title} — ${href}`}
      draggable={false}
      data-testid="source-chip"
      data-index={index ?? undefined}
      className="chat-cite"
      onClick={onClick}
      onAuxClick={onAuxClick}
    >
      <Favicon src={favicon} seed={host} className="size-3.5 rounded-[3px] text-[8px]" />
      <span className="chat-cite-host">{host}</span>
      {index === null ? null : <span className="chat-cite-index">{index}</span>}
    </a>
  );
}
