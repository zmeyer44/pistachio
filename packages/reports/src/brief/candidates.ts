/**
 * From materials to candidates.
 *
 * A candidate is one finished block: a catalog component with its props
 * already filled from source material. Blocks that can be drawn more than one
 * way — the schedule as a timeline or as compact rows, mail as quoting cards or
 * as a list — are offered once per presentation under a shared `resource`, so
 * the composer picks at most one. The composer reads only `description`; it
 * never sees, and cannot change, the props.
 */
import type { Experimental_CompositionCandidate } from "@json-render/core";
import type { ChecklistItem, LinkItem, MessageItem, ReportTone, ScheduleItem, SourceItem } from "../catalog.js";
import { REPORT_LIMITS, type ReportSourceStatus } from "../contract.js";
import {
  briefTitle,
  clip,
  clockTime,
  dayPart,
  longDate,
  meetingMinutes,
  minutesBetween,
  senderName,
  sortEvents,
  type BriefEvent,
  type BriefMaterials,
  type BriefMessage,
  type DayPart,
} from "./materials.js";
import type { MailVerdict } from "./triage.js";

export type BriefSlot = "header" | "main" | "aside";

export interface BriefCandidate extends Experimental_CompositionCandidate {
  /** Where the built-in layout puts the block, and where the layout guard returns a misplaced one. */
  slot: BriefSlot;
  /** Reading order within the slot for the built-in layout. */
  order: number;
  /** The block has content for today; if the composer drops its whole group, the guard restores it. */
  essential: boolean;
}

export interface BriefDraft {
  title: string;
  tone: ReportTone;
  prompt: string;
  /** Shared with the composer as context: counts and the shape of the day, no message bodies. */
  context: Record<string, unknown>;
  candidates: BriefCandidate[];
  /** The spec's state: the headline (so a late-arriving written one can replace the template) and ticks. */
  state: { text: { headline: string }; ticks: Record<string, boolean> };
}

const HEADLINE = { $state: "/text/headline" } as unknown as string;

// ---------------------------------------------------------------------------
// Items

function eventItem(event: BriefEvent, materials: BriefMaterials): ScheduleItem {
  const day = longDate(new Date(materials.now), materials);
  const range = event.allDay ? "all day" : `${clockTime(new Date(event.start), materials)}–${clockTime(new Date(event.end), materials)}`;
  return {
    key: `event:${event.id}`,
    title: clip(event.title === "" ? "(No title)" : event.title, 200),
    time: event.allDay ? "All day" : clockTime(new Date(event.start), materials),
    endTime: event.allDay ? null : clockTime(new Date(event.end), materials),
    startsAt: event.allDay ? null : event.start,
    endsAt: event.allDay ? null : event.end,
    allDay: event.allDay,
    location: event.location === "" ? null : clip(event.location, 200),
    meetingUrl: event.meetingUrl,
    url: event.webUrl === "" ? null : event.webUrl,
    source: "calendar",
    prompt: event.allDay ? null : prepPrompt(event, range, day),
  };
}

/**
 * A work order, not a wish: it names the event, the day and where to look, so
 * the fresh conversation reads the sources itself instead of guessing.
 */
function prepPrompt(event: BriefEvent, range: string, day: string): string {
  return clip(
    [
      `Prep me for "${event.title}" (${range}, ${day}).`,
      "Where to look:",
      `- Google Calendar: the event "${event.title}" on ${day}${event.webUrl === "" ? "" : ` (${event.webUrl})`} — guests, description, attachments.`,
      `- Gmail: recent threads that mention "${event.title}" or come from its guests.`,
      "- Pages I have read about this recently, if you have access to my archive.",
      "Tell me who is in it, what it is about, what was last said, what is still open, and what I should bring. Keep it short and link every source.",
    ].join("\n"),
    4000,
  );
}

function replyPrompt(message: BriefMessage): string {
  return clip(
    [
      `Help me reply to ${senderName(message.from)} about "${message.subject}".`,
      "Where to look:",
      `- Gmail thread ${message.threadId} (${message.webUrl}).`,
      "Read the whole thread, tell me in two lines what they need from me, then draft a reply for my review. Do not send anything.",
    ].join("\n"),
    4000,
  );
}

function messageTime(message: BriefMessage, materials: BriefMaterials): string {
  if (message.date === null) return "";
  const at = new Date(message.date);
  if (Number.isNaN(at.getTime())) return "";
  const hours = minutesBetween(at, new Date(materials.now)) / 60;
  return hours < 20 ? clockTime(at, materials) : new Intl.DateTimeFormat(materials.locale, { month: "short", day: "numeric", timeZone: materials.timezone }).format(at);
}

function messageItem(message: BriefMessage, materials: BriefMaterials, badge: string | null, withPrompt: boolean): MessageItem {
  return {
    key: `mail:${message.id}`,
    from: clip(senderName(message.from), 120),
    subject: clip(message.subject === "" ? "(No subject)" : message.subject, 200),
    excerpt: clip(message.snippet, 400),
    time: messageTime(message, materials),
    unread: message.unread,
    url: message.webUrl,
    badge,
    prompt: withPrompt ? replyPrompt(message) : null,
  };
}

function messageRow(message: BriefMessage, materials: BriefMaterials): SourceItem {
  return {
    key: `mail:${message.id}`,
    source: "gmail",
    title: clip(message.subject === "" ? "(No subject)" : message.subject, 200),
    detail: clip(`${senderName(message.from)} — ${message.snippet}`, 240),
    meta: messageTime(message, materials),
    url: message.webUrl,
  };
}

const PART_LABEL: Record<DayPart, { label: string; caption: string }> = {
  allday: { label: "All day", caption: "Runs through the day" },
  morning: { label: "Morning", caption: "Before noon" },
  afternoon: { label: "Afternoon", caption: "Noon to five" },
  evening: { label: "Evening", caption: "After five" },
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function hoursLabel(minutes: number): string {
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? String(hours) : hours.toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// The draft

export function toneOf(materials: BriefMaterials, waiting: number): ReportTone {
  const timed = materials.events.filter((event) => !event.allDay);
  if (timed.length >= 5 || meetingMinutes(timed) >= 240) return "busy";
  if (timed.length === 0 && (materials.todos.length > 0 || waiting > 0)) return "focus";
  if (timed.length === 0 && materials.todos.length === 0 && waiting === 0) return "quiet";
  return "clear";
}

const TONE_WORDS: Record<ReportTone, string> = {
  busy: "a busy, meeting-heavy day",
  focus: "an open day with room for focused work",
  quiet: "a quiet day with little on it",
  clear: "an ordinary, balanced day",
};

/**
 * Reading order, stated in the request because that is the one place the
 * composer's ordering questions look. It follows the day: mail leads when the
 * calendar is empty, the schedule leads when it is full.
 */
export function readingOrder(tone: ReportTone): string {
  const main =
    tone === "focus" || tone === "quiet"
      ? "the focus card first, then email waiting on a reply, then the schedule, then new updates, then reading"
      : "the focus card first, then the schedule, then email waiting on a reply, then new updates, then reading";
  return `Reading order in the main column: ${main}. Reading order in the aside column: to-dos first, then reminders, then numbers, then agent conversations, then notices last.`;
}

/** The headline when no language model writes one: counts, in the order a person would say them. */
export function templateHeadline(materials: BriefMaterials, waiting: number): string {
  const now = new Date(materials.now);
  const timed = sortEvents(materials.events).filter((event) => !event.allDay);
  const live = timed.filter((event) => new Date(event.start).getTime() <= now.getTime() && new Date(event.end).getTime() > now.getTime());
  const ahead = timed.filter((event) => new Date(event.start).getTime() > now.getTime());
  const parts: string[] = [];
  if (live.length > 0) parts.push("In a meeting now");
  const first = ahead[0];
  if (first !== undefined) parts.push(`${plural(ahead.length, "meeting")} ahead, next at ${clockTime(new Date(first.start), materials)}`);
  else if (live.length === 0) parts.push(timed.length > 0 ? "Meetings are done for the day" : "Nothing on the calendar");
  if (waiting > 0) parts.push(`${plural(waiting, "email")} waiting on you`);
  if (materials.todos.length > 0) parts.push(`${plural(materials.todos.length, "to-do")} open`);
  return `${parts.join(" · ")}.`;
}

function notice(status: ReportSourceStatus): { title: string; text: string; tone: "info" | "warning"; label: string | null } | null {
  const name = status.source === "calendar" ? "Google Calendar" : status.source === "gmail" ? "Gmail" : null;
  if (name === null) return null;
  if (status.state === "reconnect_required")
    return { tone: "warning", title: `${name} needs reconnecting`, text: `Google stopped accepting the saved sign-in${status.accountLabel === null ? "" : ` for ${status.accountLabel}`}, so this brief has nothing from ${name}.`, label: "Reconnect" };
  if (status.state === "not_connected" && status.connectable)
    return { tone: "info", title: `Add ${name} to your brief`, text: status.source === "calendar" ? "Connect it and today's meetings appear here, each with a way to prepare." : "Connect it and the brief shows who is waiting on you.", label: "Connect" };
  if (status.state === "unreachable") return { tone: "warning", title: `${name} could not be reached`, text: "This brief was built without it. Refresh to try again.", label: null };
  return null;
}

export function buildBriefDraft(given: BriefMaterials, verdicts: ReadonlyMap<string, MailVerdict>): BriefDraft {
  // Sorted before the cap below, and before anything asks what comes next.
  const materials: BriefMaterials = { ...given, events: sortEvents(given.events) };
  const now = new Date(materials.now);
  const roleOf = (message: BriefMessage): MailVerdict["role"] => verdicts.get(message.id)?.role ?? "update";
  const waitingOn = materials.messages.filter((message) => roleOf(message) === "reply").slice(0, 8);
  const updates = materials.messages.filter((message) => roleOf(message) === "update").slice(0, 8);
  const tone = toneOf(materials, waitingOn.length);
  const title = briefTitle(now, materials);
  const kicker = longDate(now, materials);
  const candidates: BriefCandidate[] = [];

  candidates.push({
    id: "page",
    description: "The report page: header band, wide main column, narrow aside column.",
    element: { type: "ReportPage", props: { tone } },
    slot: "header",
    order: 0,
    essential: true,
  });

  // -- Masthead: one per tone; the day's measured shape comes first, so it is the default.
  const events = materials.events.slice(0, REPORT_LIMITS.events);
  const timed = events.filter((event) => !event.allDay);
  const stats = [
    { label: timed.length === 1 ? "Meeting" : "Meetings", value: String(timed.length) },
    ...(timed.length > 0 ? [{ label: "In meetings", value: hoursLabel(meetingMinutes(timed)) }] : []),
    ...(materials.sources.some((source) => source.source === "gmail" && source.state === "ok") ? [{ label: "Waiting on you", value: String(waitingOn.length) }] : []),
    { label: materials.todos.length === 1 ? "To-do" : "To-dos", value: String(materials.todos.length) },
  ].slice(0, 4);
  for (const option of [tone, ...(["clear", "busy", "focus", "quiet"] as const).filter((entry) => entry !== tone)])
    candidates.push({
      id: `masthead_${option}`,
      description: `Masthead "${title}" tinted for ${TONE_WORDS[option]}.`,
      element: { type: "Masthead", props: { title, kicker, summary: HEADLINE, tone: option, stats } },
      root: false,
      resource: "masthead",
      slot: "header",
      order: 0,
      essential: true,
    });

  // -- Focus: the single thing most worth doing. One candidate per contender.
  const upcoming = timed.filter((event) => new Date(event.start).getTime() > now.getTime());
  const focus: BriefCandidate[] = [];
  for (const message of waitingOn.slice(0, 2))
    focus.push({
      id: `focus_mail_${String(focus.length)}`,
      description: `Focus card: reply to ${senderName(message.from)}, who is waiting on the reader about "${clip(message.subject, 80)}".`,
      element: {
        type: "FocusCard",
        props: {
          eyebrow: "Push your work forward",
          title: clip(`Reply to ${senderName(message.from)}`, 200),
          reason: clip(message.subject === "" ? message.snippet : `“${message.subject}” — ${message.snippet}`, 240),
          source: "gmail",
          meta: clip(`${senderName(message.from)}${messageTime(message, materials) === "" ? "" : ` · ${messageTime(message, materials)}`}`, 120),
          url: message.webUrl,
          actionLabel: "Let’s do it",
          prompt: replyPrompt(message),
        },
      },
      root: false,
      resource: "focus",
      slot: "main",
      order: 1,
      essential: true,
    });
  const next = upcoming[0];
  if (next !== undefined) {
    const away = minutesBetween(now, new Date(next.start));
    const item = eventItem(next, materials);
    focus.push({
      id: "focus_meeting",
      description: `Focus card: prepare for the meeting "${clip(next.title, 80)}", which starts ${away < 90 ? `in ${String(away)} minutes` : `at ${item.time}`}.`,
      element: {
        type: "FocusCard",
        props: {
          eyebrow: "Push your work forward",
          title: clip(`Prepare for ${next.title}`, 200),
          reason: away < 90 ? `Starts in ${String(away)} minutes — the next thing on your calendar.` : `At ${item.time} — the next thing on your calendar.`,
          source: "calendar",
          meta: clip([`${item.time}${item.endTime === null ? "" : `–${item.endTime}`}`, item.location ?? ""].filter((part) => part !== "").join(" · "), 120),
          url: item.url,
          actionLabel: "Prep me",
          prompt: item.prompt ?? "",
        },
      },
      root: false,
      resource: "focus",
      slot: "main",
      order: 1,
      essential: true,
    });
  }
  const oldest = [...materials.todos].sort((a, b) => a.createdAt - b.createdAt)[0];
  if (oldest !== undefined) {
    const days = Math.floor((now.getTime() - oldest.createdAt) / 86_400_000);
    focus.push({
      id: "focus_todo",
      description: `Focus card: finish the reader's longest-open to-do, "${clip(oldest.text, 80)}"${days > 0 ? `, open for ${plural(days, "day")}` : ""}.`,
      element: {
        type: "FocusCard",
        props: {
          eyebrow: "Push your work forward",
          title: clip(oldest.text, 200),
          reason: days > 0 ? `On your list for ${plural(days, "day")} — the oldest thing still open.` : "The first thing on your list.",
          source: "todo",
          meta: "From your to-dos",
          url: null,
          actionLabel: "Let’s do it",
          prompt: clip(`Help me get this done today: "${oldest.text}".\nWhere to look:\n- My to-do list on the Pistachio home page, where this is written.\n- My open tabs and recent pages for anything related.\nStart by asking me the one thing you need to know, then propose the first concrete step.`, 4000),
        },
      },
      root: false,
      resource: "focus",
      slot: "main",
      order: 1,
      essential: true,
    });
  }
  // The built-in layout takes the first: a meeting inside the hour outranks mail, mail outranks the rest.
  const soon = next !== undefined && minutesBetween(now, new Date(next.start)) <= 60;
  focus.sort((a, b) => Number(b.id === "focus_meeting" && soon) - Number(a.id === "focus_meeting" && soon));
  candidates.push(...focus.slice(0, 4));

  // -- Schedule
  const calendar = materials.sources.find((source) => source.source === "calendar");
  const items: ScheduleItem[] = [
    ...events.map((event) => ({ item: eventItem(event, materials), at: event.allDay ? -1 : new Date(event.start).getTime(), part: dayPart(event, materials.timezone) })),
    ...materials.reminders
      .filter((reminder) => reminder.state === "upcoming")
      .slice(0, REPORT_LIMITS.reminders)
      .map((reminder) => ({
        item: {
          key: `reminder:${reminder.id}`,
          title: clip(reminder.title, 200),
          time: clockTime(new Date(reminder.at), materials),
          endTime: null,
          startsAt: reminder.at,
          endsAt: null,
          allDay: false,
          location: null,
          meetingUrl: null,
          url: null,
          source: "reminder" as const,
          prompt: null,
        },
        at: new Date(reminder.at).getTime(),
        part: dayPart({ start: reminder.at, allDay: false }, materials.timezone),
      })),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(0, 24)
    .map((entry) => entry.item);
  const partOf = new Map<string, DayPart>();
  for (const event of events) partOf.set(`event:${event.id}`, dayPart(event, materials.timezone));
  for (const reminder of materials.reminders) partOf.set(`reminder:${reminder.id}`, dayPart({ start: reminder.at, allDay: false }, materials.timezone));
  const scheduleShown = calendar?.state === "ok" || items.length > 0;
  if (scheduleShown) {
    const subtitle = items.length === 0 ? "Your calendar is clear today" : `${plural(items.length, "thing")} on today`;
    const groups = (["allday", "morning", "afternoon", "evening"] as const)
      .map((part) => ({ ...PART_LABEL[part], items: items.filter((item) => partOf.get(item.key) === part) }))
      .filter((group) => group.items.length > 0);
    const timeline: BriefCandidate = {
      id: "schedule_timeline",
      description: `Your day: the schedule (${subtitle.toLowerCase()}) as a timeline of roomy cards grouped by part of day.`,
      element: { type: "Timeline", props: { title: "Your day", subtitle, groups } },
      root: false,
      resource: "schedule",
      slot: "main",
      order: 2,
      essential: items.length > 0,
    };
    const agenda: BriefCandidate = {
      id: "schedule_agenda",
      description: `Your day: the schedule (${subtitle.toLowerCase()}) as compact one-line rows.`,
      element: { type: "AgendaList", props: { title: "Your day", subtitle, items } },
      root: false,
      resource: "schedule",
      slot: "main",
      order: 2,
      essential: items.length > 0,
    };
    candidates.push(...(items.length >= 1 && items.length <= 7 ? [timeline, agenda] : [agenda, timeline]));
  }

  // -- Mail
  if (waitingOn.length > 0) {
    const subtitle = `${plural(waitingOn.length, "person", "people")} waiting on a reply`;
    const cards: BriefCandidate = {
      id: "reply_cards",
      description: `Waiting on you: ${plural(waitingOn.length, "email")} that need a reply, as cards quoting each message's opening lines.`,
      element: { type: "MessageCards", props: { title: "Waiting on you", subtitle, items: waitingOn.map((message) => messageItem(message, materials, message.unread ? "Unread" : null, true)) } },
      root: false,
      resource: "mail_reply",
      slot: "main",
      order: 3,
      essential: true,
    };
    const rows: BriefCandidate = {
      id: "reply_rows",
      description: `Waiting on you: ${plural(waitingOn.length, "email")} that need a reply, as compact one-line rows.`,
      element: { type: "SourceList", props: { title: "Waiting on you", subtitle, icon: "mail", tickable: true, items: waitingOn.map((message) => messageRow(message, materials)) } },
      root: false,
      resource: "mail_reply",
      slot: "main",
      order: 3,
      essential: true,
    };
    candidates.push(...(waitingOn.length <= 4 ? [cards, rows] : [rows, cards]));
  }
  if (updates.length > 0) {
    const subtitle = "Moved without you";
    candidates.push(
      {
        id: "updates_rows",
        description: `New updates: ${plural(updates.length, "email")} worth knowing about but needing no reply, as compact rows.`,
        element: { type: "SourceList", props: { title: "New updates", subtitle, icon: "mail", tickable: true, items: updates.map((message) => messageRow(message, materials)) } },
        root: false,
        resource: "mail_updates",
        slot: "main",
        order: 4,
        essential: false,
      },
      {
        id: "updates_cards",
        description: `New updates: ${plural(updates.length, "email")} worth knowing about but needing no reply, as cards quoting each message.`,
        element: { type: "MessageCards", props: { title: "New updates", subtitle, items: updates.slice(0, 8).map((message) => messageItem(message, materials, null, false)) } },
        root: false,
        resource: "mail_updates",
        slot: "main",
        order: 4,
        essential: false,
      },
    );
  }

  // -- To-dos and reminders that fired
  const todos: ChecklistItem[] = materials.todos.slice(0, REPORT_LIMITS.todos).map((todo) => ({ key: `todo:${todo.id}`, text: clip(todo.text, 240), detail: null, url: null }));
  if (todos.length > 0)
    candidates.push({
      id: "todos",
      description: `Top to-dos: the reader's ${plural(todos.length, "open to-do")}, each with a checkbox.`,
      element: { type: "Checklist", props: { title: "Top to-dos", subtitle: null, items: todos } },
      root: false,
      slot: "aside",
      order: 1,
      essential: true,
    });
  const fired = materials.reminders.filter((reminder) => reminder.state !== "upcoming").slice(0, REPORT_LIMITS.reminders);
  if (fired.length > 0)
    candidates.push({
      id: "reminders",
      description: `Reminders: ${plural(fired.length, "reminder")} that already went off and has not been looked at.`,
      element: {
        type: "SourceList",
        props: {
          title: "Reminders",
          subtitle: "Went off while you were away",
          icon: "bell",
          tickable: true,
          items: fired.map((reminder) => ({ key: `reminder:${reminder.id}`, source: "reminder" as const, title: clip(reminder.title, 200), detail: reminder.state === "missed" ? "Missed" : "Not yet seen", meta: clockTime(new Date(reminder.at), materials), url: null })),
        },
      },
      root: false,
      slot: "aside",
      order: 2,
      essential: true,
    });

  // -- Reading
  const pages = materials.pages.slice(0, REPORT_LIMITS.pages);
  if (pages.length > 0) {
    const shown = materials.pagesShareable ? `, such as "${clip(pages[0]?.title ?? "", 60)}"` : "";
    const links: LinkItem[] = pages.slice(0, 8).map((page) => ({
      key: `page:${page.url}`.slice(0, 200),
      title: clip(page.title === "" ? page.host : page.title, 200),
      host: page.host,
      detail: clip(page.snippet, 240),
      meta: page.kind === "video" ? "Video" : page.kind === "article" ? "Article" : "Page",
      url: page.url,
    }));
    candidates.push(
      {
        id: "reading_cards",
        description: `Pick up where you left off: ${plural(pages.length, "page")} the reader was reading recently${shown}, as a grid of site cards.`,
        element: { type: "LinkCards", props: { title: "Pick up where you left off", subtitle: "From what you were reading", items: links } },
        root: false,
        resource: "reading",
        slot: "main",
        order: 5,
        essential: false,
      },
      {
        id: "reading_rows",
        description: `Pick up where you left off: ${plural(pages.length, "page")} the reader was reading recently${shown}, as compact rows.`,
        element: {
          type: "SourceList",
          props: { title: "Pick up where you left off", subtitle: "From what you were reading", icon: "book", tickable: false, items: links.map((link) => ({ key: link.key, source: "web" as const, title: link.title, detail: link.host, meta: link.meta, url: link.url })) },
        },
        root: false,
        resource: "reading",
        slot: "main",
        order: 5,
        essential: false,
      },
    );
  }

  // -- Agent conversations
  const threads = materials.threads.slice(0, REPORT_LIMITS.threads);
  if (threads.length > 0)
    candidates.push({
      id: "threads",
      description: `Recent agent conversations: ${plural(threads.length, "conversation")} the reader had with their browser agent.`,
      element: {
        type: "SourceList",
        props: {
          title: "With your agent",
          subtitle: "Recent conversations",
          icon: "message",
          tickable: false,
          items: threads.map((thread) => ({ key: `thread:${thread.id}`, source: "thread" as const, title: clip(thread.title, 200), detail: thread.status, meta: "", url: null })),
        },
      },
      root: false,
      slot: "aside",
      order: 4,
      essential: false,
    });

  // -- Numbers
  candidates.push({
    id: "numbers",
    description: "Today in numbers: a small panel counting meetings, hours in meetings, email and to-dos.",
    element: {
      type: "StatPanel",
      props: {
        title: "Today in numbers",
        stats: [
          { label: "Meetings", value: String(timed.length) },
          { label: "In meetings", value: hoursLabel(meetingMinutes(timed)) },
          { label: "New mail", value: String(materials.messages.length) },
          { label: "Waiting", value: String(waitingOn.length) },
          { label: "To-dos", value: String(materials.todos.length) },
          { label: "Read", value: String(materials.pages.length) },
        ],
        footnote: null,
      },
    },
    root: false,
    slot: "aside",
    order: 3,
    essential: false,
  });

  // -- Notices about the brief's own sources
  for (const status of materials.sources) {
    const said = notice(status);
    if (said === null) continue;
    candidates.push({
      id: `notice_${status.source}`,
      description: `Notice: ${said.title}.`,
      element: {
        type: "Notice",
        props: { tone: said.tone, title: said.title, text: said.text, actionLabel: said.label },
        ...(said.label === null ? {} : { on: { press: { action: "open_settings", params: { section: "integrations" } } } }),
      },
      root: false,
      slot: "aside",
      order: 5,
      essential: true,
    });
  }

  return {
    title,
    tone,
    prompt: [
      `Compose today's daily brief for the reader: one calm page showing what is coming up on ${kicker}, made from their own calendar, email, to-dos and reading.`,
      readingOrder(tone),
    ].join(" "),
    context: {
      day: kicker,
      local_time: clockTime(now, materials),
      shape_of_day: TONE_WORDS[tone],
      meetings_today: timed.length,
      minutes_in_meetings: meetingMinutes(timed),
      minutes_until_next_meeting: next === undefined ? null : minutesBetween(now, new Date(next.start)),
      emails_waiting_on_reader: waitingOn.length,
      email_updates: updates.length,
      open_todos: materials.todos.length,
      pages_read_recently: materials.pages.length,
    },
    candidates,
    state: { text: { headline: templateHeadline(materials, waitingOn.length) }, ticks: {} },
  };
}
