/**
 * The tray of local apps fastened under the address field (docs/local-apps.md
 * §1, components/UrlBar.tsx): one slim strip of pills, a pill per project —
 * a running dot, its name once, then each of its ports — on both of the
 * bar's faces. It is one stop of the bar's keyboard ring (↑/↓ reach it, ←/→
 * walk it, ⇥ jumps into it from anywhere in the field); UrlBar owns the
 * selection and what a choice does, this only draws.
 *
 * It never wraps: a second line would push the list down by a row for apps
 * that typing a port's first digit narrows to one anyway. Nor does it slice
 * the rest behind a "+N" that has to be opened: that is a mode, and a port
 * behind it is no longer a → away. It scrolls sideways instead, fading at a
 * side with more beyond it, and a count at the right edge says how many
 * ports are past it — a fade alone can fall between two pills and say
 * nothing.
 */

import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { AppWindow, Laptop } from "lucide-react";
import { cn } from "../lib/cn";
import type { Entry } from "./address-palette";
import { Kbd } from "./ui/kbd";

export type LocalEntry = Extract<Entry, { kind: "local" }>;

/** One pill: a project's name, then its ports, each a stop at `index` in the bar's list. */
export interface TrayPill {
  key: string;
  name: string;
  ports: Array<{ entry: LocalEntry; index: number }>;
}

/** How far a side fades when there is more beyond it, in px — about half a pill, so a cut one reads as "more", not broken. */
const FADE = 28;
/** Past the right side's fade, the clear room the count of what is beyond ("+3") sits in, over nothing. */
const COUNT_ROOM = 28;

export function LocalTray({
  pills,
  shown,
  arriving,
  selected,
  hint,
  fresh,
  onBreathed,
  onSelect,
  onActivate,
  onLeave,
}: {
  pills: TrayPill[];
  /** False folds it away: typing reached none of the apps. */
  shown: boolean;
  /** The apps came after the bar opened: the tray unfolds from nothing rather than being there. */
  arriving: boolean;
  selected: number;
  /** "⇥ to pick": typing reached some, and the selection is still the typed text's. */
  hint: boolean;
  /** Ports not there when the bar opened, whose dot breathes once as it turns up. */
  fresh: ReadonlySet<number>;
  onBreathed: (ports: number[]) => void;
  onSelect: (index: number) => void;
  onActivate: (entry: LocalEntry, event: MouseEvent) => void;
  onLeave: () => void;
}) {
  // Folding, the strip keeps the pills it last had: an empty strip closing reads as a glitch.
  const [held, setHeld] = useState(pills);
  if (pills.length > 0 && pills !== held) setHeld(pills);
  const drawn = pills.length > 0 ? pills : held;

  const scroller = useRef<HTMLDivElement>(null);
  /**
   * Whether there is more to the left, and how many ports lie past the right
   * edge or under its fade. A fade alone can fall in the gap between two
   * pills and show nothing at all; the count says there is more, and how much.
   */
  const [more, setMore] = useState({ before: false, beyond: 0 });
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const measure = () => {
      const before = node.scrollLeft > 1;
      let beyond = 0;
      if (node.scrollLeft + node.clientWidth < node.scrollWidth - 1) {
        // A port counts as beyond once it reaches half into the fade: past there it is no longer read.
        const edge = node.getBoundingClientRect().right - COUNT_ROOM - FADE / 2;
        for (const port of node.querySelectorAll('[data-testid="local-app"]')) if (port.getBoundingClientRect().right > edge) beyond += 1;
      }
      setMore((was) => (was.before === before && was.beyond === beyond ? was : { before, beyond }));
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild !== null) observer.observe(node.firstElementChild);
    return () => {
      node.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [drawn]);
  const after = more.beyond > 0 ? COUNT_ROOM : 0;
  const mask =
    more.before || more.beyond > 0
      ? `linear-gradient(to right, transparent 0, #000 ${more.before ? FADE : 0}px, #000 calc(100% - ${after + (more.beyond > 0 ? FADE : 0)}px), transparent calc(100% - ${after}px))`
      : undefined;

  // The dots that breathe go one after another, left to right, so a tray arriving whole ripples rather than flashes.
  const delays = new Map<string, number>();
  for (const pill of drawn) if (pill.ports.some(({ entry }) => fresh.has(entry.app.port))) delays.set(pill.key, delays.size * 60);

  return (
    <div
      data-testid="local-tray"
      data-shown={shown ? "" : undefined}
      aria-hidden={!shown}
      inert={!shown}
      className={cn(
        "grid shrink-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        shown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        arriving && "starting:grid-rows-[0fr] starting:opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        {/* A press here never takes the keyboard from the field, whose keys
            work the bar: a pill's click closes it anyway, the count's does not. */}
        <div className="flex items-center gap-3.5 pr-3.5 pb-2.5 pl-5" onMouseLeave={onLeave} onMouseDown={(e) => e.preventDefault()}>
          {/* Under the field's globe: these are on this Mac, not the web. */}
          <span className="grid size-[18px] shrink-0 place-items-center text-gray-700" title="Running on this Mac">
            <Laptop className="size-[15px]" strokeWidth={1.75} aria-hidden="true" />
          </span>
          {/* As wide as its pills, up to the row: a hint after them sits beside them, not at the far end. */}
          <div className="relative flex min-w-0 items-center">
            <div
              ref={scroller}
              role="group"
              aria-label="Running on this Mac"
              onWheel={(e) => {
                // A mouse's wheel only turns up and down; the strip only goes sideways.
                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
              }}
              style={{ maskImage: mask, WebkitMaskImage: mask }}
              className="min-w-0 scroll-pr-14 scroll-pl-7 overflow-x-auto scroll-smooth [scrollbar-width:none] motion-reduce:scroll-auto [&::-webkit-scrollbar]:hidden"
            >
              <div className="flex w-max items-center gap-1.5">
                {drawn.map((pill) => {
                  const delay = delays.get(pill.key);
                  return (
                    <span key={pill.key} role="group" aria-label={pill.name} className="flex h-6 shrink-0 items-center rounded-full bg-alpha-100">
                      {pill.ports.map(({ entry, index }, i) => {
                        const active = shown && index === selected;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            tabIndex={-1}
                            data-testid="local-app"
                            // Folded, the held pills are no stops: their old indices now name the list's rows, which the bar scrolls to by this.
                            data-index={shown ? index : undefined}
                            data-port={entry.app.port}
                            data-selected={active ? "" : undefined}
                            data-open={entry.tabId === null ? undefined : ""}
                            aria-label={`${pill.name}, port ${entry.app.port}${entry.tabId === null ? "" : ", open in a tab"}`}
                            onMouseMove={() => onSelect(index)}
                            onClick={(e) => onActivate(entry, e)}
                            className={cn(
                              "flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-full text-[12px] transition-colors duration-100 ease-out",
                              i === 0 ? "pr-1.5 pl-2" : "px-1.5",
                              i === pill.ports.length - 1 && "pr-2",
                              active ? "bg-alpha-300" : "hover:bg-alpha-200",
                            )}
                          >
                            {i === 0 ? (
                              <>
                                <span
                                  data-local-dot=""
                                  aria-hidden="true"
                                  onAnimationEnd={() => onBreathed(pill.ports.map((port) => port.entry.app.port))}
                                  style={delay === undefined ? undefined : { animationDelay: `${delay}ms` }}
                                  className={cn("size-1.5 shrink-0 rounded-full bg-green-700", delay !== undefined && "animate-[local-breathe_1s_ease-out_both]")}
                                />
                                <span className="max-w-[132px] truncate font-semibold text-gray-1000">{pill.name}</span>
                              </>
                            ) : null}
                            <span className={cn("font-medium tabular-nums", active ? "text-gray-1000" : "text-gray-800")}>{entry.app.port}</span>
                            {entry.tabId === null ? null : (
                              <AppWindow className="-ml-0.5 size-3 shrink-0 text-gray-800" strokeWidth={2} aria-hidden="true" />
                            )}
                          </button>
                        );
                      })}
                    </span>
                  );
                })}
              </div>
            </div>
            {more.beyond > 0 ? (
              <button
                type="button"
                tabIndex={-1}
                data-testid="local-tray-more"
                aria-label={`${more.beyond} more`}
                onClick={() => {
                  const node = scroller.current;
                  node?.scrollBy({ left: node.clientWidth - 2 * FADE - COUNT_ROOM });
                }}
                className="absolute right-0 grid h-6 cursor-pointer place-items-center rounded-full px-1.5 text-[11.5px] font-semibold text-gray-800 tabular-nums transition-colors duration-100 ease-out hover:text-gray-1000"
              >
                +{more.beyond}
              </button>
            ) : null}
          </div>
          {hint ? (
            <span data-testid="local-tray-hint" className="flex shrink-0 animate-backdrop-in items-center gap-1.5 text-[11.5px] text-gray-700">
              <Kbd small>⇥</Kbd>
              to pick
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
