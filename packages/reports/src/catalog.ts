/**
 * The report catalog: every component a generated report may be made of.
 *
 * A report is a json-render spec, and this file is its whole vocabulary. The
 * components are *blocks* — a schedule, a stack of messages, a checklist — and
 * each takes its content as props. That is deliberate: the app fills the props
 * from source material (a calendar event, an email, a page the person read),
 * and the model that composes a report only ever decides WHICH blocks appear,
 * in WHICH presentation, and WHERE. It cannot write a prop, so it cannot invent
 * a meeting or reword an email.
 *
 * The React side (`shell-ui/components/reports/registry.tsx`) implements each
 * name here exactly once, which is what keeps every report in one visual style.
 */
import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

/** Where a piece of source material came from; picks the row's glyph. */
export const REPORT_SOURCES = ["calendar", "gmail", "reminder", "todo", "web", "thread", "pistachio"] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

/** The day's shape. Tints the masthead cover; never changes content. */
export const REPORT_TONES = ["clear", "busy", "focus", "quiet"] as const;
export type ReportTone = (typeof REPORT_TONES)[number];

export const REPORT_ICONS = [
  "calendar",
  "mail",
  "check",
  "bell",
  "book",
  "sparkles",
  "message",
  "clock",
  "chart",
] as const;
export type ReportIcon = (typeof REPORT_ICONS)[number];

const source = z.enum(REPORT_SOURCES);
const tone = z.enum(REPORT_TONES);
const icon = z.enum(REPORT_ICONS);

const stat = z.object({ label: z.string().max(40), value: z.string().max(24) });

/** One thing on the day's schedule: a calendar event or a reminder firing. */
export const scheduleItem = z.object({
  /** Stable across regenerations, so a tick survives them. */
  key: z.string().max(200),
  title: z.string().max(200),
  /** Already formatted for the reader's locale and zone ("9:30 AM", "All day"). */
  time: z.string().max(40),
  endTime: z.string().max(40).nullable(),
  /** RFC 3339 start, for the live/past state the page recomputes as the day moves. */
  startsAt: z.string().max(40).nullable(),
  endsAt: z.string().max(40).nullable(),
  allDay: z.boolean(),
  location: z.string().max(200).nullable(),
  meetingUrl: z.string().max(2000).nullable(),
  url: z.string().max(2000).nullable(),
  source,
  /** A full work order for the agent ("Prep me"); null when there is nothing to prepare. */
  prompt: z.string().max(4000).nullable(),
});
export type ScheduleItem = z.infer<typeof scheduleItem>;

const scheduleGroup = z.object({
  label: z.string().max(40),
  caption: z.string().max(80),
  items: z.array(scheduleItem).max(24),
});

export const messageItem = z.object({
  key: z.string().max(200),
  from: z.string().max(120),
  subject: z.string().max(200),
  /** The message's own opening words — source material, never a summary. */
  excerpt: z.string().max(400),
  time: z.string().max(40),
  unread: z.boolean(),
  url: z.string().max(2000),
  badge: z.string().max(24).nullable(),
  prompt: z.string().max(4000).nullable(),
});
export type MessageItem = z.infer<typeof messageItem>;

export const sourceItem = z.object({
  key: z.string().max(200),
  source,
  title: z.string().max(200),
  detail: z.string().max(240),
  meta: z.string().max(40),
  url: z.string().max(2000).nullable(),
});
export type SourceItem = z.infer<typeof sourceItem>;

export const linkItem = z.object({
  key: z.string().max(200),
  title: z.string().max(200),
  host: z.string().max(120),
  detail: z.string().max(240),
  meta: z.string().max(40),
  url: z.string().max(2000),
});
export type LinkItem = z.infer<typeof linkItem>;

export const checklistItem = z.object({
  key: z.string().max(200),
  text: z.string().max(240),
  detail: z.string().max(120).nullable(),
  url: z.string().max(2000).nullable(),
});
export type ChecklistItem = z.infer<typeof checklistItem>;

const heading = { title: z.string().max(60), subtitle: z.string().max(120).nullable() };

export const reportCatalog = defineCatalog(schema, {
  components: {
    ReportPage: {
      props: z.object({ tone }),
      slots: ["header", "main", "aside"],
      description:
        "The page every report sits in: a header band, a wide main column and a narrow aside column beside it.",
    },
    Masthead: {
      props: z.object({
        title: z.string().max(60),
        kicker: z.string().max(80),
        /** One line reading the shape of the day. The only generated sentence most reports carry. */
        summary: z.string().max(240),
        tone,
        stats: z.array(stat).max(4),
      }),
      slots: [],
      description: "The report's title band: name, date, a one-line summary and a few counts. Belongs in the header.",
    },
    FocusCard: {
      props: z.object({
        eyebrow: z.string().max(40),
        title: z.string().max(200),
        reason: z.string().max(240),
        source,
        meta: z.string().max(120),
        url: z.string().max(2000).nullable(),
        actionLabel: z.string().max(24),
        prompt: z.string().max(4000),
      }),
      slots: [],
      description: "One highlighted item: the single thing most worth doing, with a button that hands it to the agent.",
    },
    Timeline: {
      props: z.object({ ...heading, groups: z.array(scheduleGroup).max(4) }),
      slots: [],
      description:
        "A schedule drawn as a vertical timeline of roomy cards grouped by part of day. Best when there are a handful of events worth reading about. Needs the wide main column.",
    },
    AgendaList: {
      props: z.object({ ...heading, items: z.array(scheduleItem).max(24) }),
      slots: [],
      description:
        "A schedule drawn as compact one-line rows. Best for a light day, a very long day, or the narrow aside column.",
    },
    MessageCards: {
      props: z.object({ ...heading, items: z.array(messageItem).max(8) }),
      slots: [],
      description:
        "Messages as cards that quote each message's opening lines. Best for a few messages that deserve reading. Needs the wide main column.",
    },
    SourceList: {
      props: z.object({ ...heading, icon, tickable: z.boolean(), items: z.array(sourceItem).max(12) }),
      slots: [],
      description: "A compact list of one-line rows, each linking to its source. Fits either column.",
    },
    LinkCards: {
      props: z.object({ ...heading, items: z.array(linkItem).max(8) }),
      slots: [],
      description: "Web pages as a two-column grid of site cards. Needs the wide main column.",
    },
    Checklist: {
      props: z.object({ ...heading, items: z.array(checklistItem).max(12) }),
      slots: [],
      description: "Things to do, each with a checkbox. Fits either column.",
    },
    StatPanel: {
      props: z.object({ title: z.string().max(60), stats: z.array(stat).max(6), footnote: z.string().max(160).nullable() }),
      slots: [],
      description: "A small panel of numbers. Belongs in the narrow aside column.",
    },
    Notice: {
      props: z.object({
        tone: z.enum(["info", "warning"]),
        title: z.string().max(80),
        text: z.string().max(240),
        actionLabel: z.string().max(32).nullable(),
      }),
      slots: [],
      events: ["press"],
      description: "A short note about the report itself, such as a source that is not connected. Belongs in the aside column.",
    },
    Prose: {
      props: z.object({ title: z.string().max(60).nullable(), text: z.string().max(800) }),
      slots: [],
      description: "A short paragraph of written text.",
    },
  },
  actions: {
    open_url: {
      params: z.object({ url: z.string().max(2000) }),
      description: "Open a source — an email, an event, a page — in a new tab.",
    },
    ask_agent: {
      params: z.object({ prompt: z.string().max(4000) }),
      description: "Hand the agent a prepared work order in a fresh conversation.",
    },
    open_settings: {
      params: z.object({ section: z.string().max(40) }),
      description: "Open a settings section, for example to connect a source.",
    },
  },
});

export type ReportCatalog = typeof reportCatalog;
export type ReportComponentName = keyof ReportCatalog["data"]["components"];

/** Components too wide for the 260px aside column; the composer's layout guard moves them to main. */
export const WIDE_COMPONENTS: ReadonlySet<string> = new Set(["Timeline", "MessageCards", "LinkCards", "FocusCard"]);
/** The only components allowed in the header band. */
export const HEADER_COMPONENTS: ReadonlySet<string> = new Set(["Masthead"]);
