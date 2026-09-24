import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_WATCHTOWER_SETTINGS } from "@pistachio/shell-contracts/watchtower";
import type { ReportLocal } from "@pistachio/reports/contract";
import { BriefService, dayWindow, scriptedBriefMaterials, startOfLocalDay, type BriefServiceDeps } from "../src/main/brief-service";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const LOCAL: ReportLocal = {
  timezone: "America/New_York",
  locale: "en-US",
  name: "Zach",
  todos: [
    { id: "a", text: "Book flights", done: false, createdAt: 1 },
    { id: "b", text: "Already done", done: true, createdAt: 2 },
  ],
  recents: [{ url: "https://example.com/post", title: "A post", host: "example.com", atMs: NOW.getTime() - 3_600_000, visits: 2 }],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function service(overrides: Partial<BriefServiceDeps> = {}): { briefs: BriefService; dir: string; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-brief-"));
  dirs.push(dir);
  const calls: string[] = [];
  const briefs = new BriefService({
    userDataDir: dir,
    enrolled: () => true,
    calendar: (_space, from, to) => {
      calls.push(`calendar ${from} ${to}`);
      return Promise.resolve({
        status: "ok",
        connectable: false,
        accountLabel: "zach@example.com",
        events: [{ id: "e1", title: "Design review", start: "2026-09-21T13:30:00.000Z", end: "2026-09-21T14:00:00.000Z", allDay: false, location: "", meetingUrl: null, webUrl: "https://calendar.google.com/e1" }],
      });
    },
    mail: () => {
      calls.push("mail");
      return Promise.resolve({ status: "not_connected", connectable: true, accountLabel: null, messages: [] });
    },
    reminders: () => ({ reminders: [], occurrences: [] }),
    watchtower: { settings: () => DEFAULT_WATCHTOWER_SETTINGS, request: () => Promise.reject(new Error("off")) },
    threads: () => [],
    decide: () => null,
    write: () => null,
    now: () => NOW,
    ...overrides,
  });
  return { briefs, dir, calls };
}

describe("BriefService", () => {
  it("asks the calendar for the reader's own day, not UTC's", () => {
    expect(dayWindow(NOW, "America/New_York")).toEqual({ from: "2026-09-21T04:00:00.000Z", to: "2026-09-22T04:00:00.000Z" });
    expect(dayWindow(NOW, "Asia/Tokyo")).toEqual({ from: "2026-09-20T15:00:00.000Z", to: "2026-09-21T15:00:00.000Z" });
  });

  it("bounds the day at exact local midnights whatever the second it is asked", () => {
    // 08:07:30.123 in New York: the bounds must not inherit the 07:30.123, or tomorrow's midnight events slip into today.
    expect(dayWindow(new Date("2026-09-21T12:07:30.123Z"), "America/New_York")).toEqual({ from: "2026-09-21T04:00:00.000Z", to: "2026-09-22T04:00:00.000Z" });
    // One second before midnight, and midnight itself, are different days.
    expect(dayWindow(new Date("2026-09-22T03:59:59.999Z"), "America/New_York").to).toBe("2026-09-22T04:00:00.000Z");
    expect(dayWindow(new Date("2026-09-22T04:00:00.000Z"), "America/New_York").from).toBe("2026-09-22T04:00:00.000Z");
    // A zone off the hour.
    expect(dayWindow(new Date("2026-09-21T12:07:30.123Z"), "Asia/Kolkata")).toEqual({ from: "2026-09-20T18:30:00.000Z", to: "2026-09-21T18:30:00.000Z" });
  });

  it("gives a day its true length when the clocks change", () => {
    // Spring forward in New York, 8 March 2026: 23 hours. Asked in the afternoon, after the jump.
    expect(dayWindow(new Date("2026-03-08T19:20:10.500Z"), "America/New_York")).toEqual({ from: "2026-03-08T05:00:00.000Z", to: "2026-03-09T04:00:00.000Z" });
    // Fall back, 1 November 2026: 25 hours.
    expect(dayWindow(new Date("2026-11-01T18:20:10.500Z"), "America/New_York")).toEqual({ from: "2026-11-01T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z" });
    // Asked inside the repeated hour itself.
    expect(dayWindow(new Date("2026-11-01T05:30:00.000Z"), "America/New_York").from).toBe("2026-11-01T04:00:00.000Z");
    expect(startOfLocalDay(Date.parse("2026-03-08T04:30:00.000Z"), "America/New_York")).toBe(Date.parse("2026-03-07T05:00:00.000Z"));
  });

  it("sorts the day before cutting it off: calendars answer one after another, not in order", async () => {
    const event = (id: string, start: string) => ({ id, title: id, start, end: start, allDay: false, location: "", meetingUrl: null, webUrl: "" });
    const { briefs } = service({
      calendar: () => Promise.resolve({ status: "ok", connectable: false, accountLabel: "a@example.com", events: [event("afternoon", "2026-09-21T19:00:00.000Z"), event("morning", "2026-09-21T12:30:00.000Z")] }),
    });
    expect((await briefs.gather("space", LOCAL, NOW)).events.map((entry) => entry.id)).toEqual(["morning", "afternoon"]);
  });

  it("gathers each source on its own and says how each one answered", async () => {
    const { briefs } = service();
    const materials = await briefs.gather("space", LOCAL, NOW);
    expect(materials.events).toHaveLength(1);
    expect(materials.todos.map((todo) => todo.id)).toEqual(["a"]);
    // The archive is off, so the home page's recents stand in for reading — and none of it may be described to a model.
    expect(materials.pages.map((page) => page.url)).toEqual(["https://example.com/post"]);
    expect(materials.pagesShareable).toBe(false);
    expect(Object.fromEntries(materials.sources.map((source) => [source.source, source.state]))).toEqual({
      calendar: "ok",
      gmail: "not_connected",
      reminders: "empty",
      todos: "ok",
      watchtower: "off",
      threads: "empty",
    });
  });

  it("builds a brief when a source throws", async () => {
    const { briefs } = service({ calendar: () => Promise.reject(new Error("offline")) });
    const answer = await briefs.handle({ type: "generate", spaceId: "space", local: LOCAL });
    expect(answer.report?.sources.find((source) => source.source === "calendar")?.state).toBe("unreachable");
    expect(answer.report?.title).toBe("The Monday Brief");
  });

  it("stores one brief per Space per day, privately, and reads it back", async () => {
    const { briefs, dir } = service();
    const made = await briefs.handle({ type: "generate", spaceId: "work/1", local: LOCAL });
    expect(made.report?.date).toBe("2026-09-21");
    expect(made.report?.builtWith.composer).toBe("default");
    // The brief, and beside it the materials the shell sent, kept for a morning with no window open.
    const files = readdirSync(join(dir, "briefs")).sort();
    expect(files).toEqual(["local.json", "work%2F1__2026-09-21.json"]);
    for (const file of files) expect(statSync(join(dir, "briefs", file)).mode & 0o077).toBe(0);

    const read = await briefs.handle({ type: "get", spaceId: "work/1", date: "2026-09-21" });
    expect(read.report?.id).toBe(made.report?.id);
    expect(read.archive).toEqual([{ date: "2026-09-21", title: "The Monday Brief" }]);
    expect((await briefs.handle({ type: "get", spaceId: "other", date: "2026-09-21" })).report).toBeNull();
  });

  it("keeps ticks across a regeneration and refuses any other state", async () => {
    const { briefs } = service();
    await briefs.handle({ type: "generate", spaceId: "space", local: LOCAL });
    await briefs.handle({
      type: "state",
      spaceId: "space",
      date: "2026-09-21",
      changes: [
        { path: "/ticks/event:e1", value: true },
        { path: "/text/headline", value: true },
      ],
    });
    const again = await briefs.handle({ type: "generate", spaceId: "space", local: LOCAL });
    const state = again.report?.spec.state as { ticks: Record<string, boolean>; text: { headline: unknown } };
    expect(state.ticks).toEqual({ "event:e1": true });
    expect(typeof state.text.headline).toBe("string");
  });

  it("will not hand back a stored brief that no longer passes the catalog", async () => {
    const { briefs, dir } = service();
    await briefs.handle({ type: "generate", spaceId: "space", local: LOCAL });
    writeFileSync(join(dir, "briefs", "space__2026-09-21.json"), JSON.stringify({ kind: "daily_brief", spaceId: "space", date: "2026-09-21", spec: { root: "x", elements: { x: { type: "Script", props: {}, children: [] } } } }));
    expect((await briefs.handle({ type: "get", spaceId: "space", date: "2026-09-21" })).report).toBeNull();
  });

  it("joins a second request to the generation already running", async () => {
    const { briefs, calls } = service();
    const [first, second] = await Promise.all([briefs.generate("space", LOCAL), briefs.generate("space", LOCAL)]);
    expect(first).toBe(second);
    expect(calls.filter((call) => call === "mail")).toHaveLength(1);
    expect(briefs.generating("space")).toBe(false);
  });

  it("makes a brief without a shell from the materials one last sent, and reports every brief it files", async () => {
    const made: string[] = [];
    const { briefs } = service({ onGenerated: (record) => made.push(record.id) });
    // Before any shell has asked: no to-dos to go on, still a brief.
    const bare = await briefs.generateFromLastLocal("space");
    expect(JSON.stringify(bare.spec)).not.toContain("Book flights");
    await briefs.handle({ type: "generate", spaceId: "space", local: LOCAL });
    const later = await briefs.generateFromLastLocal("space");
    expect(JSON.stringify(later.spec)).toContain("Book flights");
    expect(made).toHaveLength(3);
    expect(briefs.has("space", "2026-09-21")).toBe(true);
    expect(briefs.has("space", "2026-09-20")).toBe(false);
  });

  it("rejects a malformed request", async () => {
    await expect(service().briefs.handle({ type: "get", spaceId: "space", date: "today" })).rejects.toThrow();
    await expect(service().briefs.handle({ type: "delete" })).rejects.toThrow();
  });

  it("takes scripted materials only under e2e", () => {
    const script = JSON.stringify({ events: [] });
    expect(scriptedBriefMaterials({ PISTACHIO_BRIEF_SCRIPT: script })).toBeNull();
    expect(scriptedBriefMaterials({ PISTACHIO_E2E: "1", PISTACHIO_BRIEF_SCRIPT: script })).toEqual({ events: [] });
    expect(scriptedBriefMaterials({ PISTACHIO_E2E: "1", PISTACHIO_BRIEF_SCRIPT: "not json" })).toBeNull();
  });
});
