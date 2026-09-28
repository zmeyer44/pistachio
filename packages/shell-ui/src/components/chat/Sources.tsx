import { memo, type MouseEvent } from "react";
import { cn } from "../../lib/cn";
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

/**
 * Every page a turn read, under its reply: the answer's provenance at a
 * glance, and a way to each page. Cards, not chips — here there is room
 * for the title — and the whole card opens the page as a Glance.
 */
export const SourcesRow = memo(function SourcesRow({ sources, className }: { sources: readonly CitedSource[]; className?: string }) {
  const openLink = useAppStore((state) => state.openLink);
  if (sources.length === 0) return null;
  const open = (event: MouseEvent<HTMLElement>, href: string, inNewTab: boolean): void => {
    event.preventDefault();
    const { x, y, width, height } = event.currentTarget.getBoundingClientRect();
    void openLink(href, { x, y, width, height }, inNewTab);
  };
  return (
    <div className={cn("chat-sources", className)} data-testid="sources-row">
      <span className="chat-sources-label">Sources</span>
      <ul className="chat-sources-list">
        {sources.map((source) => (
          <li key={source.url}>
            <SourceCard source={source} onOpen={open} />
          </li>
        ))}
      </ul>
    </div>
  );
});

function SourceCard({ source, onOpen }: { source: CitedSource; onOpen: (event: MouseEvent<HTMLElement>, href: string, inNewTab: boolean) => void }) {
  const favicon = useSourceFavicon(source.url);
  return (
    <a
      href={source.url}
      title={source.url}
      draggable={false}
      data-testid="source-card"
      className="chat-source"
      onClick={(event) => onOpen(event, source.url, event.metaKey || event.ctrlKey)}
      onAuxClick={(event) => {
        if (event.button === 1) onOpen(event, source.url, true);
      }}
    >
      <span className="chat-source-head">
        <Favicon src={favicon} seed={source.host} className="size-4 rounded-[4px]" />
        <span className="chat-source-host">{source.host}</span>
        <span className="chat-source-index">{source.index}</span>
      </span>
      <span className="chat-source-title">{source.title}</span>
    </a>
  );
}
