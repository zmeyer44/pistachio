import type { BriefMaterials } from "../src/brief/materials.js";

/** A Monday with three meetings, mixed mail, to-dos and some reading. 08:00 in New York. */
export function monday(overrides: Partial<BriefMaterials> = {}): BriefMaterials {
  return {
    now: "2026-09-21T12:00:00.000Z",
    timezone: "America/New_York",
    locale: "en-US",
    name: "Zach",
    events: [
      { id: "e0", title: "Company offsite", start: "2026-09-21", end: "2026-09-22", allDay: true, location: "", meetingUrl: null, webUrl: "https://calendar.google.com/e0" },
      { id: "e1", title: "Design review", start: "2026-09-21T13:30:00.000Z", end: "2026-09-21T14:00:00.000Z", allDay: false, location: "Room 4", meetingUrl: "https://meet.google.com/abc", webUrl: "https://calendar.google.com/e1" },
      { id: "e2", title: "1:1 with Dana", start: "2026-09-21T18:00:00.000Z", end: "2026-09-21T18:30:00.000Z", allDay: false, location: "", meetingUrl: null, webUrl: "https://calendar.google.com/e2" },
      { id: "e3", title: "Investor dinner", start: "2026-09-21T23:00:00.000Z", end: "2026-09-22T01:00:00.000Z", allDay: false, location: "Lilia", meetingUrl: null, webUrl: "https://calendar.google.com/e3" },
    ],
    messages: [
      { id: "m1", threadId: "t1", from: "Dana Whitfield <dana@example.com>", subject: "Q4 budget — need your call", snippet: "Can you confirm the headcount number before Wednesday? Finance is waiting on it.", date: "2026-09-21T11:12:00.000Z", unread: true, labels: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_PERSONAL"], webUrl: "https://mail.google.com/mail/u/0/#all/m1" },
      { id: "m2", threadId: "t2", from: "GitHub <notifications@github.com>", subject: "[pistachio] PR #16 merged", snippet: "Merged #16 into main.", date: "2026-09-21T10:00:00.000Z", unread: true, labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"], webUrl: "https://mail.google.com/mail/u/0/#all/m2" },
      { id: "m3", threadId: "t3", from: "Shoes Weekly <news@shoes.example>", subject: "40% off everything", snippet: "This week only.", date: "2026-09-21T09:00:00.000Z", unread: true, labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], webUrl: "https://mail.google.com/mail/u/0/#all/m3" },
    ],
    reminders: [
      { id: "r1", title: "Send the deck", at: "2026-09-21T20:00:00.000Z", state: "upcoming" },
      { id: "r2", title: "Water the plants", at: "2026-09-21T02:00:00.000Z", state: "missed" },
    ],
    todos: [
      { id: "a", text: "Book flights to Lisbon", createdAt: Date.parse("2026-09-15T12:00:00.000Z") },
      { id: "b", text: "Review the launch checklist", createdAt: Date.parse("2026-09-20T12:00:00.000Z") },
    ],
    pages: [
      { url: "https://example.com/local-first", title: "Local-first software", host: "example.com", visitedAt: Date.parse("2026-09-20T22:00:00.000Z"), snippet: "You own your data, in spite of the cloud.", kind: "article" },
    ],
    threads: [{ id: "th1", title: "Compare flight prices", updatedAt: "2026-09-20T21:00:00.000Z", status: "Finished" }],
    sources: [
      { source: "calendar", state: "ok", connectable: true, accountLabel: "zach@example.com", count: 4 },
      { source: "gmail", state: "ok", connectable: true, accountLabel: "zach@example.com", count: 3 },
    ],
    pagesShareable: false,
    ...overrides,
  };
}
