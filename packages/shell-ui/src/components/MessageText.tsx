import { type MouseEvent, useMemo } from "react";
import { linkify } from "../lib/linkify";
import { useAppStore } from "../store";

/**
 * Message text with its URLs made clickable. In the console (`links="glance"`,
 * the default) a click previews the page as a Glance above the live tab, so
 * the console keeps its place beside the page; ⌘-click or middle-click opens
 * a real tab, as anywhere else in a browser. Full-window surfaces such as the
 * Reminders page pass `links="tab"`: a preview would open behind them, so
 * every click opens a tab. Inherits the surrounding colour so it reads the
 * same in a dark bubble.
 */
export function MessageText({ text, links = "glance" }: { text: string; links?: "glance" | "tab" }) {
  const openLink = useAppStore((state) => state.openLink);
  const parts = useMemo(() => linkify(text), [text]);
  const open = (event: MouseEvent<HTMLAnchorElement>, href: string, inNewTab: boolean): void => {
    event.preventDefault();
    const { x, y, width, height } = event.currentTarget.getBoundingClientRect();
    void openLink(href, { x, y, width, height }, inNewTab || links === "tab");
  };
  return (
    <>
      {parts.map((part, index) =>
        part.type === "text" ? (
          part.value
        ) : (
          <a
            key={index}
            href={part.href}
            title={part.href}
            draggable={false}
            className="cursor-pointer underline decoration-current/40 underline-offset-2 transition-colors outline-none hover:decoration-current focus-visible:rounded-xs focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => open(event, part.href, event.metaKey || event.ctrlKey)}
            onAuxClick={(event) => {
              if (event.button === 1) open(event, part.href, true);
            }}
          >
            {part.label}
          </a>
        ),
      )}
    </>
  );
}
