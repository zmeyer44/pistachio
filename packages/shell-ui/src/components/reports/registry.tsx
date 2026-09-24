/**
 * The report registry: one React component per name in the report catalog
 * (`@pistachio/reports/catalog`), and nothing else. A generated report can only
 * ever be made of these, which is what keeps every report in the app's own
 * style however it was composed.
 *
 * The page borrows its proportions from an events calendar page — a tinted
 * wash behind a transparent bar, a 3.5:1 cover with the mark's tile hanging
 * off its lower edge, a 960px column, a main column beside a 260px aside, a
 * dashed timeline of roomy cards — drawn with the shell's own tokens, so it
 * follows the theme and the colour scheme like the home page does.
 *
 * It steps down the way that page does, but by the width of the PANE (the
 * nearest `@container`), since a pane can be half a window:
 *
 *   ≤1008  the cover loses its corners and runs edge to edge
 *   ≤1000  the gutter between the columns tightens, 40px to 24px
 *   ≤820   one column; the wash goes; title 32px, headings 20px, tile 80px
 *   ≤650   title 28px, tile 72px, card text drops a size
 *   ≤450   title 24px, tile 64px, cards pad evenly, sections sit closer
 *
 * Tailwind's `@max-[N]` means "narrower than N", so each step is written as
 * its width plus one: `@max-[821px]` is "820 and under".
 */
/* eslint-disable react/prop-types -- every component's props are typed by the catalog's zod schemas, through defineRegistry */
import { createContext, useContext, type ReactNode } from "react";
import { defineRegistry } from "@json-render/react";
import {
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  Clock,
  Globe,
  Info,
  Mail,
  MapPin,
  MessageSquare,
  Sparkles,
  TriangleAlert,
  Video,
  type LucideIcon,
} from "lucide-react";
import { isTerminalStatus } from "@pistachio/protocol";
import { reportCatalog, type ReportIcon, type ReportSource, type ReportTone, type ScheduleItem } from "@pistachio/reports/catalog";
import { cn } from "../../lib/cn";
import { hueOf, initials, isWebUrl, scheduleMoments, startsIn, type ScheduleMoment } from "../../lib/reports";
import { useAppStore } from "../../store";
import { PistachioMark } from "../PistachioMark";
import { SiteIcon } from "../home/parts";
import { useNow } from "../home/use-now";
import { FOCUS, Tick, useRun, useTicked } from "./parts";
import { ReportPreview, usePreviewable, type PreviewItem } from "./preview";

const RING = "shadow-[0_0_0_1px_var(--color-alpha-300),0_1px_2px_var(--color-alpha-100)]";
const CHIP = cn(
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-alpha-100 px-2.5 text-[13px] font-medium text-gray-1000 transition-colors hover:bg-alpha-200",
  FOCUS,
);
/** The page's column: 960px, a 16px gutter at every width. */
const COLUMN = "mx-auto w-full max-w-[960px] px-4";
/** A roomy card: more room on the text side until the pane is phone-sized. */
const CARD = cn("rounded-xl bg-background-100 py-3 pr-3 pl-4 @max-[451px]:p-3", RING);
/** An icon's tile: a hairline square with no fill of its own, so it takes the colour of whatever it sits on — the page, a card, a hovered row. */
const ICON_TILE = "grid shrink-0 place-items-center rounded-lg border border-alpha-400 text-gray-800";
/** Card text, which drops a size with the pane: a title, and the lines around it. */
const CARD_TITLE = "text-[20px] leading-[1.3] font-medium tracking-[-0.01em] text-gray-1000 @max-[651px]:text-[18px]";
const CARD_LINE = "text-[16px] leading-6 @max-[651px]:text-[14px] @max-[651px]:leading-[21px]";

const SOURCE_ICON: Record<ReportSource, LucideIcon> = {
  calendar: CalendarDays,
  gmail: Mail,
  reminder: Bell,
  todo: Check,
  web: Globe,
  thread: MessageSquare,
  pistachio: Sparkles,
};

const SECTION_ICON: Record<ReportIcon, LucideIcon> = {
  calendar: CalendarDays,
  mail: Mail,
  check: Check,
  bell: Bell,
  book: BookOpen,
  sparkles: Sparkles,
  message: MessageSquare,
  clock: Clock,
  chart: BarChart3,
};

/** The three colours a tone's cover is washed with. Tokens, so both colour schemes get their own. */
const TONE_WASH: Record<ReportTone, [string, string, string]> = {
  clear: ["var(--theme-accent)", "var(--color-blue-700)", "var(--color-green-700)"],
  busy: ["var(--color-amber-700)", "var(--color-red-700)", "var(--theme-accent)"],
  focus: ["var(--color-green-700)", "var(--theme-accent)", "var(--color-blue-700)"],
  quiet: ["var(--color-gray-700)", "var(--color-blue-700)", "var(--theme-accent)"],
};

function coverBackground(tone: ReportTone): string {
  const [a, b, c] = TONE_WASH[tone];
  return [
    `radial-gradient(90% 150% at 8% 0%, color-mix(in oklab, ${a} 46%, transparent) 0%, transparent 62%)`,
    `radial-gradient(70% 130% at 92% 8%, color-mix(in oklab, ${b} 38%, transparent) 0%, transparent 58%)`,
    `radial-gradient(80% 120% at 62% 118%, color-mix(in oklab, ${c} 34%, transparent) 0%, transparent 60%)`,
    // A tinted ground rather than the page's white, so the cover keeps an edge where it meets the page.
    `color-mix(in oklab, ${a} 16%, var(--color-background-100))`,
  ].join(", ");
}

// ---------------------------------------------------------------------------
// Shared pieces

/**
 * Whether a block is being drawn in the narrow aside column. The composer
 * decides where a block goes; the block only adapts its frame to the width —
 * a list in the aside is a quiet panel, the same list in main is a section.
 */
const AsideContext = createContext(false);

function Block({ title, subtitle, icon, testId, children }: { title: string; subtitle: string | null; icon?: LucideIcon; testId: string; children: ReactNode }) {
  const aside = useContext(AsideContext);
  if (aside)
    return (
      <SidePanel title={title} testId={testId}>
        {subtitle === null ? null : <p className="-mt-1.5 text-[12.5px] text-gray-700">{subtitle}</p>}
        {children}
      </SidePanel>
    );
  return (
    <section data-testid={testId}>
      <SectionHeading title={title} subtitle={subtitle} {...(icon === undefined ? {} : { icon })} />
      {children}
    </section>
  );
}

function SectionHeading({ title, subtitle, icon }: { title: string; subtitle: string | null; icon?: LucideIcon }) {
  const Icon = icon;
  return (
    <header className="mb-4 flex min-w-0 items-baseline gap-2.5 @max-[451px]:mb-3">
      {Icon === undefined ? null : <Icon className="size-[18px] shrink-0 translate-y-[2px] text-gray-700 @max-[821px]:size-4" strokeWidth={1.75} aria-hidden="true" />}
      <h2 className="min-w-0 shrink-0 text-[24px] leading-[1.2] font-semibold tracking-[-0.02em] text-gray-1000 @max-[821px]:text-[20px]">{title}</h2>
      {subtitle === null ? null : <span className="truncate text-[16px] text-gray-700 @max-[821px]:text-[14px]">{subtitle}</span>}
    </header>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-[13.5px] leading-snug text-gray-700">{children}</p>;
}

// ---------------------------------------------------------------------------
// Previews: what each kind of item tells the panel (preview.tsx) about itself

/** A frame that opens the preview: it lifts under the pointer, and holds a firmer ring while its preview is open. */
const PRESSABLE =
  "cursor-pointer transition-shadow hover:shadow-[0_0_0_1px_var(--color-alpha-500),0_6px_16px_var(--color-alpha-100)] data-[previewing=true]:shadow-[0_0_0_1px_var(--color-alpha-700),0_6px_16px_var(--color-alpha-100)]";
/** An item's name, as the control that opens its preview. */
const NAME = cn("cursor-pointer rounded-sm text-left hover:underline", FOCUS);

const SOURCE_KIND: Record<ReportSource, string> = {
  calendar: "Event",
  gmail: "Email",
  reminder: "Reminder",
  todo: "To-do",
  web: "Page",
  thread: "Conversation",
  pistachio: "Note",
};

const OPEN_LABEL: Record<ReportSource, string> = {
  calendar: "Open in Calendar",
  gmail: "Open in Gmail",
  reminder: "Open",
  todo: "Open",
  web: "Open Page",
  thread: "Open",
  pistachio: "Open",
};

const PLAIN: Pick<PreviewItem, "byline" | "facts" | "status" | "note" | "meetingUrl" | "prompt" | "promptLabel" | "tick"> = {
  byline: null,
  facts: [],
  status: null,
  note: null,
  meetingUrl: null,
  prompt: null,
  promptLabel: "Ask your agent",
  tick: null,
};

function longDay(startsAt: string | null): string {
  const start = startsAt === null ? null : new Date(startsAt);
  return start === null || Number.isNaN(start.getTime()) ? "Today" : start.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function hostOf(url: string | null): string | null {
  try {
    return url === null ? null : new URL(url).host.replace(/^www\./u, "");
  } catch {
    return null;
  }
}

function schedulePreview(item: ScheduleItem, moment: ScheduleMoment, nowMs: number): PreviewItem {
  const range = item.endTime === null ? item.time : `${item.time} – ${item.endTime}`;
  const away = startsIn(item.startsAt, nowMs);
  const over = moment === "past";
  const status: PreviewItem["status"] =
    moment === "live"
      ? { title: "Happening now", detail: range, tone: "live" }
      : moment === "next"
        ? { title: "Up next", detail: away === "" ? range : `Starts ${away}`, tone: "next" }
        : over
          ? { title: "Finished", detail: range, tone: "done" }
          : moment === "allday"
            ? { title: "All day", detail: null, tone: "plain" }
            : { title: "Later today", detail: away === "" ? range : `Starts ${away}`, tone: "plain" };
  const call = isWebUrl(item.meetingUrl) ? hostOf(item.meetingUrl) : null;
  return {
    ...PLAIN,
    key: item.key,
    source: item.source,
    kind: SOURCE_KIND[item.source],
    title: item.title,
    cover: { kind: "date", startsAt: item.startsAt },
    facts: [
      { icon: "date", startsAt: item.startsAt, title: longDay(item.startsAt), detail: range },
      ...(item.location !== null ? [{ icon: MapPin, title: item.location, detail: call === null ? null : `Also on ${call}` }] : call !== null ? [{ icon: Video, title: "Video call", detail: call }] : []),
    ],
    status,
    url: item.url,
    openLabel: OPEN_LABEL[item.source],
    meetingUrl: over ? null : item.meetingUrl,
    prompt: over ? null : item.prompt,
    promptLabel: "Prep me",
  };
}

// ---------------------------------------------------------------------------
// Schedule

const MOMENT_DOT: Record<ScheduleMoment, string> = {
  past: "bg-gray-500",
  live: "bg-green-700",
  next: "bg-blue-700",
  later: "bg-gray-600",
  allday: "bg-gray-600",
};

function momentLine(item: ScheduleItem, moment: ScheduleMoment, nowMs: number): ReactNode {
  const range = item.endTime === null ? item.time : `${item.time} – ${item.endTime}`;
  if (moment === "live") return <><span className="font-medium text-green-900">Now</span> · {range}</>;
  if (moment === "next") {
    const away = startsIn(item.startsAt, nowMs);
    return <>{range}{away === "" ? null : <span className="text-blue-900"> · {away}</span>}</>;
  }
  return range;
}

function EventCard({ item, moment, nowMs }: { item: ScheduleItem; moment: ScheduleMoment; nowMs: number }) {
  const run = useRun();
  const preview = usePreviewable(schedulePreview(item, moment, nowMs));
  const Glyph = SOURCE_ICON[item.source];
  const joinable = isWebUrl(item.meetingUrl) && moment !== "past";
  return (
    <article
      {...preview.card}
      data-testid="report-event"
      data-moment={moment}
      className={cn("flex flex-col gap-2 @max-[451px]:gap-1", CARD, PRESSABLE, moment === "past" && "opacity-55")}
    >
      <div className={cn("flex min-w-0 items-center gap-2 text-gray-800 tabular-nums", CARD_LINE)}>
        <span className={cn("size-2 shrink-0 rounded-full", MOMENT_DOT[moment], moment === "live" && "animate-pulse-dot")} aria-hidden="true" />
        <span className="truncate">{momentLine(item, moment, nowMs)}</span>
        <Glyph className="ml-auto size-4 shrink-0 text-gray-600" strokeWidth={1.75} aria-hidden="true" />
      </div>
      <h3 className={cn("line-clamp-3 text-pretty", CARD_TITLE)}>
        <button type="button" aria-haspopup="dialog" className={NAME} onClick={preview.open}>
          {item.title}
        </button>
      </h3>
      {item.location === null ? null : (
        <p className={cn("flex min-w-0 items-center gap-2 text-gray-800", CARD_LINE)}>
          <MapPin className="size-4 shrink-0 text-gray-600" strokeWidth={1.75} aria-hidden="true" />
          <span className="truncate">{item.location}</span>
        </p>
      )}
      {item.prompt === null && !joinable ? null : (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {joinable ? (
            <button type="button" className={cn(CHIP, moment === "live" && "bg-gray-1000 text-background-100 hover:bg-gray-900")} onClick={() => run.open(item.meetingUrl)}>
              <Video className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              Join
            </button>
          ) : null}
          {item.prompt === null || moment === "past" ? null : (
            <button type="button" data-testid="report-prep" className={CHIP} onClick={() => run.ask(item.prompt)}>
              <Sparkles className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              Prep me
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function AgendaRow({ item, moment, nowMs }: { item: ScheduleItem; moment: ScheduleMoment; nowMs: number }) {
  const run = useRun();
  const preview = usePreviewable(schedulePreview(item, moment, nowMs));
  const away = moment === "next" ? startsIn(item.startsAt, nowMs) : "";
  return (
    <li {...preview.card} data-testid="report-event" data-moment={moment} className={cn("group/row flex min-w-0 cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-alpha-100 data-[previewing=true]:bg-alpha-200", moment === "past" && "opacity-55")}>
      <span className="w-[68px] shrink-0 text-[12.5px] text-gray-800 tabular-nums">{item.time}</span>
      <span className={cn("size-2 shrink-0 rounded-full", MOMENT_DOT[moment], moment === "live" && "animate-pulse-dot")} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <button type="button" aria-haspopup="dialog" className={cn("block max-w-full cursor-pointer truncate rounded-sm text-left text-[13.5px] font-medium text-gray-1000 hover:underline", FOCUS)} onClick={preview.open}>
          {item.title}
        </button>
        {item.location === null && away === "" ? null : <span className="block truncate text-[12px] text-gray-700">{[away, item.location ?? ""].filter((part) => part !== "").join(" · ")}</span>}
      </span>
      {isWebUrl(item.meetingUrl) && moment !== "past" ? (
        <button type="button" className={cn(CHIP, "h-6 px-2 text-[12px]")} onClick={() => run.open(item.meetingUrl)}>
          Join
        </button>
      ) : null}
      {item.prompt === null || moment === "past" ? null : (
        <button type="button" data-testid="report-prep" className={cn(CHIP, "h-6 px-2 text-[12px] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100")} onClick={() => run.ask(item.prompt)}>
          Prep me
        </button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Rows and cards

function Avatar({ name }: { name: string }) {
  const hue = hueOf(name);
  return (
    <span
      aria-hidden="true"
      className="grid size-10 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-gray-1000 @max-[651px]:size-9 @max-[651px]:text-[12.5px] @max-[451px]:size-8 @max-[451px]:text-[11.5px]"
      style={{ backgroundColor: `color-mix(in oklab, oklch(0.72 0.13 ${String(hue)}) 30%, var(--color-background-200))` }}
    >
      {initials(name)}
    </span>
  );
}

function MessageCard({ item }: { item: { key: string; from: string; subject: string; excerpt: string; time: string; unread: boolean; url: string; badge: string | null; prompt: string | null } }) {
  const run = useRun();
  const done = useTicked(item.key);
  const preview = usePreviewable({
    ...PLAIN,
    key: item.key,
    source: "gmail",
    kind: SOURCE_KIND.gmail,
    title: item.subject,
    cover: { kind: "person", name: item.from },
    facts: [{ icon: Mail, title: item.from, detail: item.unread ? `${item.time} · Unread` : item.time }],
    status: done ? { title: "Handled", detail: null, tone: "done" } : item.prompt === null ? { title: "For your information", detail: null, tone: "plain" } : { title: "Waiting on your reply", detail: null, tone: "next" },
    note: item.excerpt === "" ? null : { label: "Opening words", text: item.excerpt },
    url: item.url,
    openLabel: OPEN_LABEL.gmail,
    prompt: item.prompt,
    promptLabel: "Draft a reply",
    tick: { todo: "Mark handled", done: "Handled" },
  });
  return (
    <article {...preview.card} data-testid="report-message" className={cn("flex gap-3 @max-[451px]:gap-2.5", CARD, PRESSABLE, done && "opacity-55")}>
      <Avatar name={item.from} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2 text-[14px] leading-[21px] text-gray-800 @max-[451px]:text-[13px]">
          <span className="truncate font-medium text-gray-1000">{item.from}</span>
          {item.badge === null ? null : <span className="shrink-0 rounded-full bg-blue-100 px-1.5 text-[11px] leading-[18px] font-medium text-blue-900">{item.badge}</span>}
          <span className="ml-auto shrink-0 tabular-nums">{item.time}</span>
        </div>
        <h3 className={cn("line-clamp-2 text-[18px] leading-[1.3] font-medium tracking-[-0.01em] text-pretty text-gray-1000 @max-[651px]:text-[16px]", done && "line-through")}>
          <button type="button" aria-haspopup="dialog" className={NAME} onClick={preview.open}>
            {item.subject}
          </button>
        </h3>
        {item.excerpt === "" ? null : <p className="line-clamp-2 border-l-2 border-alpha-400 pl-2.5 text-[15px] leading-[1.45] text-gray-900 @max-[651px]:text-[14px]">{item.excerpt}</p>}
        <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
          {item.prompt === null ? null : (
            <button type="button" className={CHIP} onClick={() => run.ask(item.prompt)}>
              <Sparkles className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              Draft a reply
            </button>
          )}
          <button type="button" className={CHIP} onClick={() => run.open(item.url)}>
            Open
            <ArrowUpRight className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          </button>
          <span className="ml-auto flex items-center gap-2 text-[13px] text-gray-700">
            <span className="@max-[361px]:sr-only">{done ? "Handled" : "Mark handled"}</span>
            <Tick itemKey={item.key} label={`Mark "${item.subject}" handled`} />
          </span>
        </div>
      </div>
    </article>
  );
}

function SourceRow({ item, tickable }: { item: { key: string; source: ReportSource; title: string; detail: string; meta: string; url: string | null }; tickable: boolean }) {
  const done = useTicked(item.key);
  const aside = useContext(AsideContext);
  const Glyph = SOURCE_ICON[item.source];
  const web = item.source === "web" && isWebUrl(item.url);
  const preview = usePreviewable({
    ...PLAIN,
    key: item.key,
    source: item.source,
    kind: SOURCE_KIND[item.source],
    title: item.title,
    cover: web ? { kind: "site", url: item.url ?? "", host: item.detail === "" ? (hostOf(item.url) ?? "") : item.detail } : { kind: "glyph" },
    facts: item.detail === "" && item.meta === "" ? [] : [{ icon: Glyph, title: item.detail === "" ? item.meta : item.detail, detail: item.detail === "" || item.meta === "" ? null : item.meta }],
    url: item.url,
    openLabel: OPEN_LABEL[item.source],
    tick: tickable ? { todo: "Mark seen", done: "Seen" } : null,
  });
  return (
    <li {...preview.card} data-testid="report-row" className={cn("flex min-w-0 cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 transition-colors duration-100 hover:bg-alpha-100 data-[previewing=true]:bg-alpha-200", done && "opacity-55")}>
      <span className={cn(ICON_TILE, "size-9")}>
        {web ? <SiteIcon url={item.url ?? ""} faviconUrl={null} label={item.detail} className="size-5 rounded-[5px]" /> : <Glyph className="size-4" strokeWidth={1.75} aria-hidden="true" />}
      </span>
      <button type="button" aria-haspopup="dialog" className={cn("min-w-0 flex-1 cursor-pointer rounded-sm text-left", FOCUS)} onClick={preview.open}>
        <span className={cn("block font-medium text-gray-1000", aside ? "line-clamp-2 text-[14px] leading-snug" : "truncate", aside ? "" : "text-[16px] leading-6 @max-[651px]:text-[14px] @max-[651px]:leading-[21px]", done && "line-through")}>{item.title}</span>
        {item.detail === "" ? null : <span className={cn("block truncate text-gray-700", aside ? "text-[12.5px]" : "text-[14px] @max-[651px]:text-[13px]")}>{item.detail}</span>}
      </button>
      {item.meta === "" ? null : <span className={cn("shrink-0 text-gray-700 tabular-nums", aside ? "text-[12.5px]" : "text-[14px] @max-[651px]:text-[13px]")}>{item.meta}</span>}
      {tickable ? <Tick itemKey={item.key} label={`Mark "${item.title}" seen`} /> : null}
    </li>
  );
}

function ChecklistRow({ item }: { item: { key: string; text: string; detail: string | null; url: string | null } }) {
  const done = useTicked(item.key);
  const preview = usePreviewable({
    ...PLAIN,
    key: item.key,
    source: "todo",
    kind: SOURCE_KIND.todo,
    title: item.text,
    cover: { kind: "glyph" },
    facts: item.detail === null ? [] : [{ icon: Clock, title: item.detail, detail: null }],
    status: { title: done ? "Done" : "Not done yet", detail: null, tone: done ? "done" : "plain" },
    url: item.url,
    openLabel: OPEN_LABEL.todo,
    tick: { todo: "Mark done", done: "Done" },
  });
  return (
    <li {...preview.card} data-testid="report-todo" className="-mx-2 flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-100 hover:bg-alpha-100 data-[previewing=true]:bg-alpha-200">
      <span className="pt-px">
        <Tick itemKey={item.key} label={`Mark "${item.text}" done`} />
      </span>
      <button type="button" aria-haspopup="dialog" className={cn("min-w-0 flex-1 cursor-pointer rounded-sm text-left", FOCUS)} onClick={preview.open}>
        <span className={cn("block text-[14px] leading-snug text-gray-1000", done && "text-gray-700 line-through")}>{item.text}</span>
        {item.detail === null ? null : <span className="block truncate text-[12.5px] text-gray-700">{item.detail}</span>}
      </button>
    </li>
  );
}

function LinkCard({ item }: { item: { key: string; title: string; host: string; detail: string; meta: string; url: string } }) {
  const preview = usePreviewable({
    ...PLAIN,
    key: item.key,
    source: "web",
    kind: SOURCE_KIND.web,
    title: item.title,
    cover: { kind: "site", url: item.url, host: item.host },
    facts: [{ icon: Globe, title: item.host, detail: item.meta === "" ? null : item.meta }],
    note: item.detail === "" ? null : { label: "About this page", text: item.detail },
    url: item.url,
    openLabel: OPEN_LABEL.web,
  });
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      data-testid="report-link"
      data-preview-id={preview.card["data-preview-id"]}
      data-previewing={preview.active}
      className={cn("flex min-w-0 items-start gap-3 rounded-xl bg-background-100 p-3 text-left", RING, PRESSABLE, FOCUS)}
      onClick={preview.open}
    >
      <span className={cn(ICON_TILE, "size-10")}>
        <SiteIcon url={item.url} faviconUrl={null} label={item.host} className="size-5 rounded-[5px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 text-[16px] leading-[1.3] font-medium text-pretty text-gray-1000 @max-[651px]:text-[15px]">{item.title}</span>
        <span className="truncate text-[13px] text-gray-700">
          {item.host}
          {item.meta === "" ? "" : ` · ${item.meta}`}
        </span>
        {item.detail === "" ? null : <span className="mt-0.5 line-clamp-2 text-[14px] leading-[1.4] text-gray-900">{item.detail}</span>}
      </span>
    </button>
  );
}

/** In main the agenda is a card of its own; in the aside the panel already frames it. */
function AgendaRows({ children }: { children: ReactNode }) {
  const aside = useContext(AsideContext);
  return <ul className={cn("flex flex-col", aside ? "-mx-2" : cn("rounded-2xl bg-background-100 p-2", RING))}>{children}</ul>;
}

/** The aside's panel: a hairline border and no fill, so it sits back from the main column's cards. */
function SidePanel({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="flex min-w-0 flex-col gap-2 rounded-xl border border-alpha-400 px-4 pt-3.5 pb-4">
      <h2 className="text-[16px] leading-[1.3] font-semibold tracking-[-0.01em] text-gray-1000">{title}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------

export const { registry: reportRegistry, handlers: reportHandlers } = defineRegistry(reportCatalog, {
  components: {
    ReportPage: ({ props, slots }) => {
      const [wash] = TONE_WASH[props.tone];
      const tint = `color-mix(in oklab, ${wash} 13%, transparent)`;
      return (
        <ReportPreview>
          <div data-testid="report-page" data-tone={props.tone} className="relative">
            {/*
              The wash: the day's tint, solid behind whatever bar the page hangs above the report
              (`--report-bleed-top`, which the page sets to that bar's height) and gone 128px below it.
              A one-column pane has the cover edge to edge right under the bar, so it has no wash.
            */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 @max-[821px]:hidden"
              style={{
                top: "calc(-1 * var(--report-bleed-top, 0px))",
                height: "calc(var(--report-bleed-top, 0px) + 128px)",
                background: `linear-gradient(to bottom, ${tint} 0, ${tint} var(--report-bleed-top, 0px), transparent 100%)`,
              }}
            />
            {/* The header lays itself out: its cover is wider than the column, and at most widths wider than the page's gutters allow. */}
            <div className="relative">{slots?.["header"]}</div>
            <hr className="relative border-0 border-b border-alpha-300" />
            <div className={cn(COLUMN, "relative flex items-start gap-10 pt-6 pb-10 @max-[1001px]:gap-6 @max-[821px]:flex-col @max-[821px]:items-stretch @max-[821px]:gap-8 @max-[821px]:pt-5 @max-[451px]:gap-7 @max-[451px]:pt-4")}>
              <div data-testid="report-main" className="flex min-w-0 flex-1 flex-col gap-10 @max-[821px]:gap-8 @max-[451px]:gap-7">
                {slots?.["main"]}
              </div>
              {/* Beside main it is a 260px column that stays in view; under it, its panels pair up while there is room for two. */}
              <aside
                data-testid="report-aside"
                className="sticky top-4 flex w-[260px] shrink-0 flex-col gap-4 empty:hidden @max-[821px]:static @max-[821px]:grid @max-[821px]:w-auto @max-[821px]:grid-cols-2 @max-[821px]:items-start @max-[561px]:grid-cols-1 @max-[451px]:gap-3"
              >
                <AsideContext.Provider value>{slots?.["aside"]}</AsideContext.Provider>
              </aside>
            </div>
          </div>
        </ReportPreview>
      );
    },

    Masthead: ({ props }) => (
      <header data-testid="report-masthead">
        {/* The cover: 3.5:1 at every width. Wider than the column by 24px a side while the pane has room, edge to edge once it does not. */}
        <div className="mx-auto max-w-[960px] pt-2 @max-[1009px]:max-w-none @max-[1009px]:pt-0">
          <div
            aria-hidden="true"
            className="-mx-6 aspect-[3.5/1] rounded-2xl shadow-[inset_0_0_0_1px_var(--color-alpha-200)] @max-[1009px]:mx-0 @max-[1009px]:rounded-none @max-[1009px]:shadow-none"
            style={{ background: coverBackground(props.tone) }}
          />
        </div>
        <div className={COLUMN}>
          {/* The mark's tile hangs off the cover's lower edge: 96px (80, 72, 64) inside a ring of the page's own colour, the mark itself flush with the column. */}
          <div className="relative mb-5 -ml-1.5 size-[108px] -mt-[54px] rounded-[30%] bg-background-200 p-1.5 @max-[821px]:mb-4 @max-[821px]:-ml-1 @max-[821px]:size-[88px] @max-[821px]:-mt-[45px] @max-[821px]:p-1 @max-[651px]:size-20 @max-[651px]:-mt-[40px] @max-[451px]:-ml-[3px] @max-[451px]:size-[70px] @max-[451px]:-mt-7 @max-[451px]:p-[3px] [&>svg]:size-full">
            <PistachioMark size={48} />
          </div>
          <div className="mb-5 flex flex-col gap-2 @max-[821px]:mb-4">
            <h1 data-testid="report-title" className="text-[36px] leading-[1.2] font-semibold tracking-[-0.025em] text-balance text-gray-1000 @max-[821px]:text-[32px] @max-[651px]:text-[28px] @max-[451px]:text-[24px]">
              {props.title}
            </h1>
            <p className="flex min-w-0 items-center gap-2 text-[16px] leading-6 text-gray-800">
              <CalendarDays className="size-4 shrink-0 text-gray-700" strokeWidth={1.75} aria-hidden="true" />
              <span className="truncate">{props.kicker}</span>
            </p>
            <p data-testid="report-summary" className="max-w-[72ch] text-[16px] leading-6 text-pretty text-gray-900 @max-[451px]:text-[14px] @max-[451px]:leading-[21px]">
              {props.summary}
            </p>
            {props.stats.length === 0 ? null : (
              <dl className="mt-2 flex flex-wrap gap-x-8 gap-y-3 @max-[451px]:gap-x-6 @max-[361px]:grid @max-[361px]:grid-cols-2">
                {props.stats.map((stat) => (
                  <div key={stat.label} className="flex flex-col">
                    <dd className="text-[20px] leading-7 font-medium text-gray-1000 tabular-nums @max-[451px]:text-[18px] @max-[451px]:leading-6">{stat.value}</dd>
                    <dt className="text-[13px] text-gray-700">{stat.label}</dt>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      </header>
    ),

    FocusCard: ({ props }) => {
      const run = useRun();
      const Glyph = SOURCE_ICON[props.source];
      const preview = usePreviewable({
        ...PLAIN,
        key: "focus",
        source: props.source,
        kind: SOURCE_KIND[props.source],
        title: props.title,
        byline: props.eyebrow,
        cover: { kind: "glyph" },
        facts: [{ icon: Glyph, title: props.meta, detail: null }],
        note: { label: "Why this, why now", text: props.reason },
        url: props.url,
        openLabel: OPEN_LABEL[props.source],
        prompt: props.prompt,
        promptLabel: props.actionLabel,
      });
      return (
        <section
          data-preview-id={preview.card["data-preview-id"]}
          data-testid="report-focus"
          className="relative overflow-hidden rounded-2xl p-6 shadow-[0_0_0_1px_color-mix(in_oklab,var(--theme-accent)_28%,var(--color-alpha-300))] @max-[821px]:p-5 @max-[451px]:rounded-xl @max-[451px]:p-4"
          style={{ background: "color-mix(in oklab, var(--theme-accent) 7%, var(--color-background-100))" }}
        >
          <p className="flex items-center gap-1.5 text-[12px] font-semibold tracking-[0.07em] text-gray-900 uppercase">
            <Sparkles className="size-3.5" strokeWidth={2} aria-hidden="true" />
            {props.eyebrow}
          </p>
          <h2 className="mt-2 text-[28px] leading-[1.15] font-semibold tracking-[-0.03em] text-balance text-gray-1000 @max-[821px]:text-[24px] @max-[651px]:text-[22px] @max-[451px]:text-[20px]">
            <button type="button" aria-haspopup="dialog" className={NAME} onClick={preview.open}>
              {props.title}
            </button>
          </h2>
          <p className="mt-2 line-clamp-3 max-w-[60ch] text-[16px] leading-6 text-gray-900 @max-[651px]:text-[14px] @max-[651px]:leading-[21px]">{props.reason}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2 @max-[451px]:mt-3">
            <button
              type="button"
              data-testid="report-focus-action"
              className={cn("inline-flex h-9 cursor-pointer items-center gap-2 rounded-[10px] bg-gray-1000 px-3.5 text-[13.5px] font-medium text-background-100 transition-colors hover:bg-gray-900", FOCUS)}
              onClick={() => run.ask(props.prompt)}
            >
              <Sparkles className="size-4" strokeWidth={1.75} aria-hidden="true" />
              {props.actionLabel}
            </button>
            {isWebUrl(props.url) ? (
              <button type="button" className={cn(CHIP, "h-9 rounded-[10px] px-3 text-[13.5px]")} onClick={() => run.open(props.url)}>
                Open
                <ArrowUpRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
            ) : null}
            {/* Beside the buttons while it fits; a line of its own, under them, in a phone-sized pane. */}
            <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[13px] text-gray-800 tabular-nums @max-[451px]:ml-0 @max-[451px]:basis-full @max-[451px]:pt-1">
              <Glyph className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              <span className="truncate">{props.meta}</span>
            </span>
          </div>
        </section>
      );
    },

    Timeline: ({ props }) => {
      const now = useNow().getTime();
      const moments = scheduleMoments(props.groups.flatMap((group) => group.items), now);
      return (
        <section data-testid="report-timeline">
          <SectionHeading title={props.title} subtitle={props.subtitle} />
          {props.groups.length === 0 ? <Empty>Nothing on the calendar. The day is yours.</Empty> : null}
          {props.groups.map((group, index) => (
            <div key={group.label} className="relative pb-6 pl-6 last:pb-0 @max-[451px]:pb-4">
              <div aria-hidden="true" className={cn("absolute bottom-0 left-1 border-l-2 border-dashed border-alpha-400", index === 0 ? "top-3" : "top-0.5")} />
              <span aria-hidden="true" className="absolute top-2 left-px size-2 rounded-full bg-gray-600" />
              <div className="mb-3.5 flex h-6 items-baseline gap-1.5 text-[16px] leading-6 @max-[451px]:mb-2.5">
                <h3 className="font-medium whitespace-nowrap text-gray-1000">{group.label}</h3>
                <span className="truncate text-gray-700">{group.caption}</span>
              </div>
              <div className="flex flex-col gap-4 @max-[451px]:gap-3">
                {group.items.map((item) => (
                  <EventCard key={item.key} item={item} moment={moments.get(item.key) ?? "later"} nowMs={now} />
                ))}
              </div>
            </div>
          ))}
        </section>
      );
    },

    AgendaList: ({ props }) => {
      const now = useNow().getTime();
      const moments = scheduleMoments(props.items, now);
      return (
        <Block title={props.title} subtitle={props.subtitle} testId="report-agenda">
          {props.items.length === 0 ? (
            <Empty>Nothing on the calendar. The day is yours.</Empty>
          ) : (
            <AgendaRows>
              {props.items.map((item) => (
                <AgendaRow key={item.key} item={item} moment={moments.get(item.key) ?? "later"} nowMs={now} />
              ))}
            </AgendaRows>
          )}
        </Block>
      );
    },

    MessageCards: ({ props }) => (
      <section data-testid="report-messages">
        <SectionHeading title={props.title} subtitle={props.subtitle} />
        <div className="flex flex-col gap-4 @max-[451px]:gap-3">
          {props.items.map((item) => (
            <MessageCard key={item.key} item={item} />
          ))}
        </div>
      </section>
    ),

    SourceList: ({ props }) => (
      <Block title={props.title} subtitle={props.subtitle} icon={SECTION_ICON[props.icon]} testId="report-list">
        {props.items.length === 0 ? (
          <Empty>Nothing new here.</Empty>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {props.items.map((item) => (
              <SourceRow key={item.key} item={item} tickable={props.tickable} />
            ))}
          </ul>
        )}
      </Block>
    ),

    LinkCards: ({ props }) => (
      <section data-testid="report-links">
        <SectionHeading title={props.title} subtitle={props.subtitle} />
        {/* As many across as fit at 240px each: main's width is not the pane's, and main must not become a container — every step on this page is measured against the pane. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-4 @max-[451px]:gap-3">
          {props.items.map((item) => (
            <LinkCard key={item.key} item={item} />
          ))}
        </div>
      </section>
    ),

    Checklist: ({ props }) => (
      <SidePanel title={props.title} testId="report-checklist">
        {props.subtitle === null ? null : <p className="-mt-1 text-[12.5px] text-gray-700">{props.subtitle}</p>}
        {props.items.length === 0 ? (
          <Empty>Nothing on the list.</Empty>
        ) : (
          <ul className="flex flex-col">
            {props.items.map((item) => (
              <ChecklistRow key={item.key} item={item} />
            ))}
          </ul>
        )}
      </SidePanel>
    ),

    StatPanel: ({ props }) => (
      <SidePanel title={props.title} testId="report-stats">
        <dl className="grid grid-cols-3 gap-x-2 gap-y-3">
          {props.stats.map((stat) => (
            <div key={stat.label} className="flex min-w-0 flex-col">
              <dd className="text-[19px] leading-6 font-medium text-gray-1000 tabular-nums">{stat.value}</dd>
              <dt className="truncate text-[12.5px] text-gray-700">{stat.label}</dt>
            </div>
          ))}
        </dl>
        {props.footnote === null ? null : <p className="text-[12.5px] leading-snug text-gray-700">{props.footnote}</p>}
      </SidePanel>
    ),

    Notice: ({ props, emit }) => {
      const Glyph = props.tone === "warning" ? TriangleAlert : Info;
      return (
        <section data-testid="report-notice" className={cn("flex gap-2.5 rounded-xl border border-dashed px-3.5 py-3", props.tone === "warning" ? "border-amber-700" : "border-alpha-500")}>
          <Glyph className={cn("mt-0.5 size-4 shrink-0", props.tone === "warning" ? "text-amber-900" : "text-gray-700")} strokeWidth={1.75} aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-[13.5px] leading-snug font-medium text-gray-1000">{props.title}</h2>
            <p className="text-[12.5px] leading-snug text-gray-800">{props.text}</p>
            {props.actionLabel === null ? null : (
              <button type="button" className={cn(CHIP, "mt-1 w-fit")} onClick={() => emit("press")}>
                {props.actionLabel}
              </button>
            )}
          </div>
        </section>
      );
    },

    Prose: ({ props }) => (
      <section data-testid="report-prose">
        {props.title === null ? null : <SectionHeading title={props.title} subtitle={null} />}
        <p className="max-w-[64ch] text-[16px] leading-[1.55] text-pretty text-gray-900 @max-[451px]:text-[14px]">{props.text}</p>
      </section>
    ),
  },

  actions: {
    // Every source opens beside the report, never over it: the brief is what the person comes back to.
    open_url: async (params) => {
      if (params === undefined || !isWebUrl(params.url)) return;
      await useAppStore.getState().createTab(params.url);
    },
    // A fresh conversation holding the whole work order. A run already in
    // flight is never interrupted for it.
    ask_agent: async (params) => {
      if (params === undefined || params.prompt.trim() === "") return;
      const state = useAppStore.getState();
      const run = state.snapshot?.run ?? null;
      if (run !== null && !isTerminalStatus(run.status)) {
        state.setConsoleOpen(true);
        state.showNotice("Your agent is in the middle of something. Ask again once it has finished.");
        return;
      }
      if (run !== null) await state.newThread();
      state.setConsoleOpen(true);
      await state.startDelegation(params.prompt);
    },
    open_settings: async (params) => {
      const section = params?.section === "integrations" ? "integrations" : undefined;
      useAppStore.getState().openSettings(section);
      await Promise.resolve();
    },
  },
});
