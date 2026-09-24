/**
 * The report's preview panel: press anything on a report — a meeting, a
 * message, a to-do, a page — and its details come in from the right, over a
 * page that stays where it was. It is chrome around the report, like the bar
 * above it, not a catalog component: a spec cannot place one, and everything
 * it shows is the pressed item's own props.
 *
 * The container is an events-calendar page's event panel, to the pixel: 550px
 * wide and 8px clear of the pane's top, right and bottom, 16px corners, a 48px
 * header of 30px controls over a hairline, a body padded 12/16/16 whose
 * sections sit 24px apart. It narrows with the PANE like the page under it
 * (registry.tsx): 480px at 650 and under, 420px at 500 and under, and at 450
 * and under it is a sheet — full width, 32px down from the top, 32px corners.
 *
 * It fills the pane, not the window. The page that mounts the report gives it
 * somewhere to go (`ReportOverlayHost`: an element laid over the pane that
 * does not scroll with it); with nowhere given it falls back to the viewport.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsRight,
  Copy,
  Globe,
  Mail,
  MessageSquare,
  Sparkles,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { ReportSource } from "@pistachio/reports/catalog";
import { cn } from "../../lib/cn";
import { hueOf, initials, isWebUrl } from "../../lib/reports";
import { SiteIcon } from "../home/parts";
import { FOCUS, Tick, useRun, useTicked } from "./parts";

// ---------------------------------------------------------------------------
// What a block says about one of its items

/** The square at the top of the panel: whatever best stands for the item when it has no picture of its own. */
export type PreviewCover =
  | { kind: "date"; startsAt: string | null }
  | { kind: "person"; name: string }
  | { kind: "site"; url: string; host: string }
  | { kind: "glyph" };

/** One of the two-line rows under the title. `"date"` draws the little calendar page in its tile. */
export interface PreviewFact {
  icon: LucideIcon | "date";
  startsAt?: string | null;
  title: string;
  detail: string | null;
}

export interface PreviewItem {
  /** The item's source key: where its tick lives. */
  key: string;
  source: ReportSource;
  /** What it is, in a word: "Event", "Email", "To-do". */
  kind: string;
  title: string;
  byline: string | null;
  cover: PreviewCover;
  facts: PreviewFact[];
  /** Where it stands right now, above what can be done about it. */
  status: { title: string; detail: string | null; tone: "live" | "next" | "done" | "plain" } | null;
  /** Source material quoted at length: a message's opening words, a page's description. */
  note: { label: string; text: string } | null;
  url: string | null;
  openLabel: string;
  meetingUrl: string | null;
  prompt: string | null;
  promptLabel: string;
  tick: { todo: string; done: string } | null;
}

const SOURCE_NAME: Record<ReportSource, string> = {
  calendar: "Google Calendar",
  gmail: "Gmail",
  reminder: "Pistachio",
  todo: "Home",
  web: "Your reading",
  thread: "Your agent",
  pistachio: "Pistachio",
};

const SOURCE_GLYPH: Record<ReportSource, LucideIcon> = {
  calendar: CalendarDays,
  gmail: Mail,
  reminder: Bell,
  todo: Check,
  web: Globe,
  thread: MessageSquare,
  pistachio: Sparkles,
};

// ---------------------------------------------------------------------------
// Opening one

interface PreviewApi {
  openId: string | null;
  open: (id: string) => void;
  register: (id: string, item: PreviewItem) => () => void;
}

const PreviewContext = createContext<PreviewApi | null>(null);

/** Where the panel is drawn: an element covering the pane. Null draws it over the viewport. */
export const ReportOverlayHost = createContext<HTMLElement | null>(null);

const INTERACTIVE = "button, a, input, select, textarea, [role='checkbox']";
/** How long the panel takes to leave: the length of `--animate-panel-out` and `--animate-sheet-out` (theme.css). */
const CLOSE_MS = 300;

/**
 * Makes a block's item open the panel. `card` goes on the item's frame, so a
 * press anywhere on it that is not already a control opens the preview;
 * `open` goes on the one control that is its name, for the keyboard.
 */
export function usePreviewable(item: PreviewItem): { open: () => void; active: boolean; card: { "data-preview-id": string; "data-previewing": boolean; onClick: (event: MouseEvent) => void } } {
  const api = useContext(PreviewContext);
  const id = useId();
  // Every render, so the panel never shows a stale moment ("in 45 min") for an item whose clock moved on.
  useEffect(() => api?.register(id, item));
  const open = useCallback(() => api?.open(id), [api, id]);
  const active = api?.openId === id;
  return {
    open,
    active,
    card: {
      "data-preview-id": id,
      "data-previewing": active,
      onClick: (event) => {
        if (event.target instanceof Element && event.target.closest(INTERACTIVE) === null) open();
      },
    },
  };
}

/** Wraps a report page: holds which item is open, and draws the panel for it. */
export function ReportPreview({ children }: { children: ReactNode }) {
  const items = useRef(new Map<string, PreviewItem>());
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  const api = useMemo<PreviewApi>(
    () => ({
      openId,
      open: (id) => {
        if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
        setClosing(false);
        setOpenId(id);
      },
      register: (id, item) => {
        items.current.set(id, item);
        return () => {
          if (items.current.get(id) === item) items.current.delete(id);
        };
      },
    }),
    [openId],
  );

  // The order the page reads in, which is the order the panel steps through.
  const order = (): string[] => [...(root.current?.querySelectorAll<HTMLElement>("[data-preview-id]") ?? [])].flatMap((element) => (element.dataset["previewId"] !== undefined && items.current.has(element.dataset["previewId"]) ? [element.dataset["previewId"]] : []));

  const close = useCallback(() => {
    setClosing(true);
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(
      () => {
        setOpenId(null);
        setClosing(false);
        if (opener.current?.isConnected === true) opener.current.focus({ preventScroll: true });
        opener.current = null;
      },
      reduced ? 0 : CLOSE_MS,
    );
  }, []);

  const item = openId === null ? undefined : items.current.get(openId);
  const ids = openId === null ? [] : order();
  const index = openId === null ? -1 : ids.indexOf(openId);
  const step = (by: number) => {
    const next = ids[index + by];
    if (next === undefined) return;
    setOpenId(next);
    // The page follows along underneath, so closing the panel lands beside what was last read.
    root.current?.querySelector(`[data-preview-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
  };

  // An item that left the page (a refresh dropped it) takes its panel with it.
  useEffect(() => {
    if (openId !== null && item === undefined) setOpenId(null);
  }, [openId, item]);

  return (
    <PreviewContext.Provider value={api}>
      <div ref={root} className="contents">
        {children}
      </div>
      {openId === null || item === undefined ? null : (
        <PreviewPanel key="panel" id={openId} item={item} closing={closing} onClose={close} onPrevious={index > 0 ? () => step(-1) : null} onNext={index >= 0 && index < ids.length - 1 ? () => step(1) : null} />
      )}
    </PreviewContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// The panel

/** The header's controls: all 30px tall, the worded ones pills, the rest circles. */
const CONTROL = cn("shrink-0 cursor-pointer text-[14px] leading-[21px] font-medium text-gray-900 transition-colors hover:text-gray-1000 disabled:cursor-default disabled:opacity-40", FOCUS);
const PILL = cn(CONTROL, "inline-flex h-[30px] items-center gap-1.5 rounded-full bg-alpha-100 px-2.5 hover:bg-alpha-200 disabled:hover:bg-alpha-100");
const ROUND = cn(CONTROL, "grid size-[30px] place-items-center rounded-full");

function PreviewPanel({ id, item, closing, onClose, onPrevious, onNext }: { id: string; item: PreviewItem; closing: boolean; onClose: () => void; onPrevious: (() => void) | null; onNext: (() => void) | null }) {
  const host = useContext(ReportOverlayHost);
  const run = useRun();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  const linkable = isWebUrl(item.url);

  // Once, when it opens, and on the panel itself rather than a control in it: nothing is ringed until the reader tabs.
  // Stepping to another item keeps focus where the reader put it.
  useEffect(() => panel.current?.focus({ preventScroll: true }), []);
  useEffect(() => setCopied(false), [id]);

  const copy = () => {
    if (!linkable) return;
    void navigator.clipboard
      .writeText(item.url ?? "")
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    // It is modal: the page behind is out of reach, so Tab goes round the panel.
    const stops = [...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], [tabindex='0']") ?? [])];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const tree = (
    <div data-testid="report-preview" data-state={closing ? "closing" : "open"} className={cn(host === null ? "fixed" : "absolute", "inset-0 z-20", closing && "pointer-events-none")} onKeyDown={onKeyDown}>
      <div aria-hidden="true" className={cn("report-scrim absolute inset-0", closing ? "animate-scrim-out" : "animate-scrim-in")} onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby={titleId}
        className={cn(
          // Its own compositor layer for the length of its life, so the slide never repaints what is in it.
          "report-panel absolute top-2 right-2 bottom-2 flex w-[550px] flex-col overflow-hidden rounded-2xl bg-background-200 text-gray-1000 outline-none will-change-[transform,opacity]",
          "@max-[651px]:w-[480px] @max-[501px]:w-[420px]",
          "@max-[451px]:inset-x-0 @max-[451px]:top-8 @max-[451px]:bottom-0 @max-[451px]:w-auto @max-[451px]:rounded-t-[32px] @max-[451px]:rounded-b-none",
          closing ? "animate-panel-out @max-[451px]:animate-sheet-out" : "animate-panel-in @max-[451px]:animate-sheet-in",
        )}
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-alpha-400 px-3 py-2">
          <button type="button" data-testid="report-preview-close" aria-label="Close" className={cn(ROUND, "hover:bg-alpha-100")} onClick={onClose}>
            <ChevronsRight className="size-4 @max-[451px]:hidden" strokeWidth={2} aria-hidden="true" />
            <ChevronsDown className="hidden size-4 @max-[451px]:block" strokeWidth={2} aria-hidden="true" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {linkable ? (
              <>
                <button type="button" className={PILL} onClick={copy}>
                  {copied ? <Check className="size-3.5" strokeWidth={2} aria-hidden="true" /> : <Copy className="size-3.5" strokeWidth={2} aria-hidden="true" />}
                  <span aria-live="polite">{copied ? "Copied" : "Copy Link"}</span>
                </button>
                <button type="button" data-testid="report-preview-open" className={cn(PILL, "min-w-0 shrink")} onClick={() => run.open(item.url)}>
                  <span className="truncate">{item.openLabel}</span>
                  <ArrowUpRight className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" data-testid="report-preview-previous" aria-label="Previous item" className={cn(ROUND, "bg-alpha-100 hover:bg-alpha-200 disabled:hover:bg-alpha-100")} disabled={onPrevious === null} onClick={() => onPrevious?.()}>
              <ChevronUp className="size-[18px]" strokeWidth={2} aria-hidden="true" />
            </button>
            <button type="button" data-testid="report-preview-next" aria-label="Next item" className={cn(ROUND, "bg-alpha-100 hover:bg-alpha-200 disabled:hover:bg-alpha-100")} disabled={onNext === null} onClick={() => onNext?.()}>
              <ChevronDown className="size-[18px]" strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Keyed by the item, so stepping to the next one starts it at the top. */}
        <div key={id} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="flex flex-col gap-6 px-4 pt-3 pb-4">
            <Cover item={item} />

            <div className="flex flex-col gap-2">
              <p className="flex w-fit max-w-full items-center gap-2 rounded-lg bg-alpha-100 py-1 pr-2.5 pl-1.5 text-[14px] leading-[21px] text-gray-800">
                <SourceBadge source={item.source} />
                <span className="truncate">
                  {item.kind} from <span className="font-medium text-gray-1000">{SOURCE_NAME[item.source]}</span>
                </span>
              </p>
              {/* A short name gets the panel's full voice; a long one steps down so it still fits in three lines. */}
              <h2
                id={titleId}
                data-testid="report-preview-title"
                // The size first: tailwind-merge drops a `leading` that a font size follows.
                className={cn(item.title.length > 32 ? "text-[24px] @max-[451px]:text-[22px]" : "text-[32px] @max-[451px]:text-[26px]", "leading-[1.2] font-semibold tracking-[-0.02em] text-pretty text-gray-1000")}
              >
                {item.title}
              </h2>
              {item.byline === null ? null : <p className="truncate text-[16px] leading-6 text-gray-800">{item.byline}</p>}
            </div>

            {item.facts.length === 0 ? null : (
              <div className={cn("grid gap-x-4 gap-y-3", item.facts.length > 1 && "grid-cols-2 @max-[451px]:grid-cols-1")}>
                {item.facts.map((fact) => (
                  <Fact key={`${fact.title}|${fact.detail ?? ""}`} fact={fact} />
                ))}
              </div>
            )}

            <Actions item={item} />

            {item.note === null ? null : (
              <section>
                <h3 className="border-b border-alpha-400 pb-2 text-[14px] leading-[21px] font-medium text-gray-800">{item.note.label}</h3>
                <p className="pt-4 text-[16px] leading-6 text-pretty whitespace-pre-line text-gray-1000">{item.note.text}</p>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(tree, host ?? document.body);
}

/** The cover's colour is the item's own where it has one — a sender's, a site's — and the theme's otherwise. */
function coverHue(item: PreviewItem): string {
  if (item.cover.kind === "person") return `oklch(0.74 0.13 ${String(hueOf(item.cover.name))})`;
  if (item.cover.kind === "site") return `oklch(0.74 0.11 ${String(hueOf(item.cover.host))})`;
  return "var(--theme-accent)";
}

function Cover({ item }: { item: PreviewItem }) {
  const hue = coverHue(item);
  const background = [
    `radial-gradient(90% 90% at 12% 8%, color-mix(in oklab, ${hue} 62%, transparent) 0%, transparent 70%)`,
    `radial-gradient(80% 80% at 92% 96%, color-mix(in oklab, ${hue} 38%, var(--color-blue-700)) 0%, transparent 72%)`,
    `color-mix(in oklab, ${hue} 26%, var(--color-background-100))`,
  ].join(", ");
  const Glyph = SOURCE_GLYPH[item.source];
  const start = item.cover.kind === "date" && item.cover.startsAt !== null ? new Date(item.cover.startsAt) : null;
  const dated = start !== null && !Number.isNaN(start.getTime());
  return (
    <div aria-hidden="true" className="relative mx-auto mt-4 size-[200px] @max-[451px]:size-[160px]">
      {/* The glow: the cover again, blurred out past its own edge. */}
      <div className="absolute inset-0 scale-110 rounded-[24px] opacity-45 blur-2xl" style={{ background }} />
      <div className="relative grid size-full place-items-center overflow-hidden rounded-2xl text-gray-1000 shadow-[inset_0_0_0_1px_var(--color-alpha-200)]" style={{ background }}>
        {dated ? (
          <div className="flex flex-col items-center">
            <span className="text-[14px] leading-none font-semibold tracking-[0.12em] uppercase opacity-70">{start.toLocaleDateString(undefined, { weekday: "long" })}</span>
            <span className="mt-1.5 text-[80px] leading-none font-semibold tracking-[-0.05em] tabular-nums @max-[451px]:text-[64px]">{start.getDate()}</span>
            <span className="mt-1 text-[16px] leading-none font-medium opacity-80">{start.toLocaleDateString(undefined, { month: "long" })}</span>
          </div>
        ) : item.cover.kind === "person" ? (
          <span className="text-[72px] leading-none font-semibold tracking-[-0.04em] @max-[451px]:text-[56px]">{initials(item.cover.name)}</span>
        ) : item.cover.kind === "site" ? (
          <span className="grid size-24 place-items-center rounded-[22px] bg-background-100 shadow-[0_0_0_1px_var(--color-alpha-300),0_8px_24px_var(--color-alpha-200)] @max-[451px]:size-20">
            <SiteIcon url={item.cover.url} faviconUrl={null} label={item.cover.host} className="size-14 rounded-xl @max-[451px]:size-12" />
          </span>
        ) : (
          <Glyph className="size-[72px] opacity-80 @max-[451px]:size-14" strokeWidth={1.25} />
        )}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: ReportSource }) {
  const Glyph = SOURCE_GLYPH[source];
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-gray-1000 text-background-100">
      <Glyph className="size-3" strokeWidth={2.25} aria-hidden="true" />
    </span>
  );
}

/** A 40px hairline tile beside two lines: what it is, and the detail under it. */
function Fact({ fact }: { fact: PreviewFact }) {
  const start = fact.icon === "date" && fact.startsAt !== null && fact.startsAt !== undefined ? new Date(fact.startsAt) : null;
  const dated = start !== null && !Number.isNaN(start.getTime());
  const Glyph = fact.icon === "date" ? CalendarDays : fact.icon;
  return (
    <div className="flex min-w-0 items-center gap-4">
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-alpha-400 text-gray-900">
        {dated ? (
          <span className="flex size-full flex-col text-center">
            <span className="bg-alpha-300 py-0.5 text-[8px] leading-3 font-semibold tracking-[0.04em] uppercase">{start.toLocaleDateString(undefined, { month: "short" })}</span>
            <span className="flex-1 text-[16px] leading-[22px] font-medium tabular-nums">{start.getDate()}</span>
          </span>
        ) : (
          <Glyph className="size-5" strokeWidth={1.75} aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] leading-6 font-medium text-gray-1000" title={fact.title}>
          {fact.title}
        </span>
        {fact.detail === null ? null : (
          <span className="block truncate text-[14px] leading-[21px] text-gray-800" title={fact.detail}>
            {fact.detail}
          </span>
        )}
      </span>
    </div>
  );
}

const STATUS_DOT: Record<NonNullable<PreviewItem["status"]>["tone"], string> = {
  live: "bg-green-700",
  next: "bg-blue-700",
  done: "bg-gray-600",
  plain: "bg-gray-600",
};

/** The panel's one card: where the item stands, then everything that can be done about it, the main thing first. */
function Actions({ item }: { item: PreviewItem }) {
  const run = useRun();
  const done = useTicked(item.key);
  const joinable = isWebUrl(item.meetingUrl);
  const askable = item.prompt !== null && item.prompt.trim() !== "";
  if (item.status === null && !joinable && !askable && item.tick === null) return null;
  const button = "flex h-[38px] w-full cursor-pointer items-center justify-center gap-2 rounded-lg text-[16px] leading-6 font-medium transition-colors";
  const primary = "bg-gray-1000 text-background-100 hover:bg-gray-900";
  const secondary = "bg-alpha-100 text-gray-1000 hover:bg-alpha-200";
  return (
    <section data-testid="report-preview-actions" className="overflow-hidden rounded-xl border border-alpha-300 bg-background-100 shadow-[0_1px_4px_var(--color-alpha-300)]">
      <h3 className="bg-alpha-100 px-4 py-2 text-[14px] leading-[21px] font-medium text-gray-800">{done ? "Done" : "Next step"}</h3>
      {item.status === null ? null : (
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-alpha-200">
            <span className={cn("size-2 rounded-full", STATUS_DOT[item.status.tone], item.status.tone === "live" && "animate-pulse-dot")} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[16px] leading-6 font-medium text-gray-1000">{item.status.title}</span>
            {item.status.detail === null ? null : <span className="block text-[14px] leading-[21px] text-gray-800">{item.status.detail}</span>}
          </span>
        </div>
      )}
      {joinable || askable || item.tick !== null ? (
        <div className={cn("flex flex-col gap-2 px-4 py-3", item.status !== null && "border-t border-alpha-300")}>
          {joinable ? (
            <button type="button" className={cn(button, primary, FOCUS)} onClick={() => run.open(item.meetingUrl)}>
              <Video className="size-4" strokeWidth={1.75} aria-hidden="true" />
              Join meeting
            </button>
          ) : null}
          {askable ? (
            <button type="button" data-testid="report-preview-ask" className={cn(button, joinable ? secondary : primary, FOCUS)} onClick={() => run.ask(item.prompt)}>
              <Sparkles className="size-4" strokeWidth={1.75} aria-hidden="true" />
              {item.promptLabel}
            </button>
          ) : null}
          {item.tick === null ? null : (
            <div className="flex h-[38px] items-center justify-between gap-3 rounded-lg bg-alpha-100 pr-2.5 pl-3.5 text-[16px] leading-6 text-gray-1000">
              <span className="truncate">{done ? item.tick.done : item.tick.todo}</span>
              <Tick itemKey={item.key} label={`${item.tick.todo}: ${item.title}`} />
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
