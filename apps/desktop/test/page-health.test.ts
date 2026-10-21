import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CRASH_RELOAD_WINDOW_MS,
  CrashReloads,
  crashKind,
  DRAG_HOVER_GRACE_MS,
  DRAG_HOVER_SPAN_MS,
  DragWatch,
  PageHealthLog,
  pageSite,
  readPageDragReport,
} from "../src/main/page-health";

describe("crashKind", () => {
  it("reads running out of memory as memory, everything else as a crash", () => {
    expect(crashKind("oom")).toBe("memory");
    expect(crashKind("memory-eviction")).toBe("memory");
    expect(crashKind("crashed")).toBe("crashed");
    expect(crashKind("killed")).toBe("crashed");
    expect(crashKind("abnormal-exit")).toBe("crashed");
  });
});

describe("CrashReloads", () => {
  it("reloads a page that dies once, but not one that dies again soon after", () => {
    const reloads = new CrashReloads();
    expect(reloads.take("tab-1", 0)).toBe(true);
    expect(reloads.take("tab-1", CRASH_RELOAD_WINDOW_MS - 1)).toBe(false);
    expect(reloads.take("tab-2", 10)).toBe(true);
  });

  it("reloads it again once the window has passed since the last reload", () => {
    const reloads = new CrashReloads();
    expect(reloads.take("tab-1", 0)).toBe(true);
    expect(reloads.take("tab-1", 1000)).toBe(false);
    // The refused one did not count: the window runs from the reload.
    expect(reloads.take("tab-1", CRASH_RELOAD_WINDOW_MS)).toBe(true);
  });
});

describe("DragWatch", () => {
  const at = { x: 40, y: 50 };

  it("says nothing of a page with no drag", () => {
    const watch = new DragWatch();
    expect(watch.stuck(1, "mouseDown", 0)).toBeNull();
    expect(watch.stuck(1, "mouseMove", 10_000)).toBeNull();
  });

  it("takes a press reaching a dragging page as the drag over", () => {
    const watch = new DragWatch();
    watch.started(1, at, 1000);
    expect(watch.stuck(1, "mouseDown", 1001)).toEqual({ since: 1000, point: at });
    // Nothing is cleared by asking: the caller ends the drag, then forgets it.
    expect(watch.drag(1)).toEqual({ since: 1000, point: at });
  });

  it("takes moves only well after the drag began, and only once they keep coming", () => {
    const watch = new DragWatch();
    watch.started(1, at, 0);
    // The first moves after a press may come before the OS's drag begins.
    expect(watch.stuck(1, "mouseMove", DRAG_HOVER_GRACE_MS - 1)).toBeNull();
    // One stray move is not the pointer moving over the page.
    expect(watch.stuck(1, "mouseMove", DRAG_HOVER_GRACE_MS)).toBeNull();
    expect(watch.stuck(1, "mouseMove", DRAG_HOVER_GRACE_MS + DRAG_HOVER_SPAN_MS - 1)).toBeNull();
    expect(watch.stuck(1, "mouseMove", DRAG_HOVER_GRACE_MS + DRAG_HOVER_SPAN_MS)).toEqual({ since: 0, point: at });
  });

  it("ignores other events, and forgets a drag that ended", () => {
    const watch = new DragWatch();
    watch.started(1, at, 0);
    expect(watch.stuck(1, "mouseWheel", 10_000)).toBeNull();
    expect(watch.stuck(1, "mouseUp", 10_000)).toBeNull();
    watch.ended(1);
    expect(watch.stuck(1, "mouseDown", 10_000)).toBeNull();
    expect(watch.drag(1)).toBeNull();
  });

  it("keeps each page's drag apart", () => {
    const watch = new DragWatch();
    watch.started(1, at, 0);
    watch.started(2, { x: 1, y: 2 }, 5);
    watch.forget(1);
    expect(watch.stuck(1, "mouseDown", 10)).toBeNull();
    expect(watch.stuck(2, "mouseDown", 10)).toEqual({ since: 5, point: { x: 1, y: 2 } });
  });
});

describe("readPageDragReport", () => {
  it("reads a drag's start with its point, and its end", () => {
    expect(readPageDragReport({ dragging: true, x: 3, y: 4 })).toEqual({ dragging: true, point: { x: 3, y: 4 } });
    expect(readPageDragReport({ dragging: false })).toEqual({ dragging: false });
  });

  it("refuses anything else", () => {
    expect(readPageDragReport(null)).toBeNull();
    expect(readPageDragReport("drag")).toBeNull();
    expect(readPageDragReport({ dragging: true })).toBeNull();
    expect(readPageDragReport({ dragging: true, x: Number.NaN, y: 1 })).toBeNull();
    expect(readPageDragReport({ dragging: "yes", x: 1, y: 1 })).toBeNull();
  });
});

describe("pageSite", () => {
  it("names a web page by its host alone, anything else by its scheme", () => {
    expect(pageSite("https://mail.example.com/inbox?id=7#x")).toBe("mail.example.com");
    expect(pageSite("http://127.0.0.1:8080/a")).toBe("127.0.0.1:8080");
    expect(pageSite("file:///Users/someone/doc.pdf")).toBe("file");
    expect(pageSite("not a url")).toBe("");
  });
});

describe("PageHealthLog", () => {
  it("writes one JSON line an event, in order", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pistachio-page-health-")), "logs");
    const log = new PageHealthLog(dir);
    void log.record({ event: "unresponsive", site: "a.example" }, new Date("2026-10-21T10:00:00.000Z"));
    await log.record({ event: "responsive", site: "a.example", afterMs: 1200 }, new Date("2026-10-21T10:00:01.200Z"));
    const lines = readFileSync(log.path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([
      { at: "2026-10-21T10:00:00.000Z", event: "unresponsive", site: "a.example" },
      { at: "2026-10-21T10:00:01.200Z", event: "responsive", site: "a.example", afterMs: 1200 },
    ]);
  });

  it("moves a full log aside and begins again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pistachio-page-health-"));
    const log = new PageHealthLog(dir, 200);
    for (let i = 0; i < 4; i++) await log.record({ event: "crashed", site: `site-${i}.example`, reason: "oom", exitCode: 0, shown: true, reloaded: true });
    expect(existsSync(join(dir, "page-health.1.log"))).toBe(true);
    const current = readFileSync(log.path, "utf8");
    expect(current.length).toBeLessThanOrEqual(200);
    expect(current).toContain("site-3.example");
  });
});
