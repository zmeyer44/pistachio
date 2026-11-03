import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DevWatcher, watchedPath, writeGeneratedFiles } from "../src/main/extensions/watch";
import { StatusWriter } from "../src/main/extensions/status";
import { isCrashLoop } from "../src/main/extensions/web-worker";

// (The worker module is Electron-facing; its crash rule is pure.)
vi.mock("electron", () => ({ BaseWindow: class {}, WebContentsView: class {} }));

const MANIFEST = JSON.stringify({ api: 1, id: "dev.test.watch", name: "Watch", version: "1.0.0" });

describe("the dev folder", () => {
  it("ignores our status files, node_modules, .git and dotfiles", () => {
    expect(watchedPath("worker.js")).toBe(true);
    expect(watchedPath("src/panel.ts")).toBe(true);
    expect(watchedPath(".pistachio/status.json")).toBe(false);
    expect(watchedPath("node_modules/x/index.js")).toBe(false);
    expect(watchedPath(".git/HEAD")).toBe(false);
    expect(watchedPath("src/.DS_Store")).toBe(false);
  });

  it("writes the generated files, a placeholder for a missing source, and CLAUDE.md only once", () => {
    const api = mkdtempSync(join(tmpdir(), "pistachio-ext-api-"));
    writeFileSync(join(api, "AGENTS.md"), "# The API\n");
    writeFileSync(join(api, "pistachio.d.ts"), "declare const pistachio: unknown;\n");
    const folder = join(mkdtempSync(join(tmpdir(), "pistachio-ext-dev-")), "Extensions");
    const missing = writeGeneratedFiles(folder, api);
    expect(missing.sort()).toEqual(["schema/pistachio-extension.schema.json", "skill/SKILL.md"]);
    expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).toBe("# The API\n");
    expect(readFileSync(join(folder, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(readFileSync(join(folder, ".pistachio", "pistachio.d.ts"), "utf8")).toContain("pistachio");
    expect(readFileSync(join(folder, ".pistachio", "pistachio-extension.schema.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(folder, ".claude", "skills", "pistachio-extension", "SKILL.md"))).toBe(true);
    writeFileSync(join(folder, "CLAUDE.md"), "mine");
    writeGeneratedFiles(folder, api);
    expect(readFileSync(join(folder, "CLAUDE.md"), "utf8")).toBe("mine");
  });

  it("finds a folder that comes to hold a pistachio.json, and folds a burst of writes into one change", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pistachio-ext-watch-"));
    mkdirSync(join(parent, "early"));
    writeFileSync(join(parent, "early", "pistachio.json"), MANIFEST);
    const events: string[] = [];
    const watcher = new DevWatcher(
      {
        found: (folder) => events.push(`found ${folder.slice(parent.length + 1)}`),
        changed: (folder) => events.push(`changed ${folder.slice(parent.length + 1)}`),
        gone: (folder) => events.push(`gone ${folder.slice(parent.length + 1)}`),
      },
      { debounceMs: 40 },
    );
    try {
      watcher.watchParent(parent);
      expect(events).toEqual(["found early"]);
      mkdirSync(join(parent, "late"));
      writeFileSync(join(parent, "late", "pistachio.json"), MANIFEST);
      // (macOS's recursive watch reports nothing written before it comes live, a moment after `watch` returns and
      // longer under load — a full-suite run lost the folder's first writes: its files are written on, as an agent
      // writes them, until it is found.)
      let write = 0;
      await expect
        .poll(
          () => {
            if (!events.includes("found late")) writeFileSync(join(parent, "late", "worker.js"), String((write += 1)));
            return events;
          },
          { timeout: 5000, interval: 100 },
        )
        .toContain("found late");
      const before = events.length;
      for (let i = 0; i < 5; i += 1) writeFileSync(join(parent, "early", "worker.js"), String(i));
      writeFileSync(join(parent, "early", ".pistachio-status"), "ignored");
      // (`late`'s last write may still settle as a change of its own: only `early`'s are counted.)
      await expect.poll(() => events.slice(before).filter((event) => event.endsWith(" early")), { timeout: 3000 }).toEqual(["changed early"]);
    } finally {
      watcher.dispose();
    }
  });
});

describe("status back to the folder", () => {
  it("rewrites status.json and appends to log.ndjson in .pistachio/", () => {
    const folder = mkdtempSync(join(tmpdir(), "pistachio-ext-status-"));
    const status = new StatusWriter(folder, "dev.test.watch");
    status.update({ state: "needs-approval", manifestErrors: [] });
    status.log({ at: 1, context: "worker", level: "error", message: "boom" });
    status.runtimeError({ context: "worker", message: "boom", at: 1 });
    const written = JSON.parse(readFileSync(join(folder, ".pistachio", "status.json"), "utf8")) as { state: string; runtimeErrors: unknown[] };
    expect(written.state).toBe("needs-approval");
    expect(written.runtimeErrors).toHaveLength(1);
    expect(readFileSync(join(folder, ".pistachio", "log.ndjson"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(status.lines()).toHaveLength(1);
  });
});

describe("the worker", () => {
  it("is in a crash loop at three crashes inside a minute", () => {
    expect(isCrashLoop([0, 10_000], 20_000)).toBe(false);
    expect(isCrashLoop([0, 10_000, 20_000], 20_000)).toBe(true);
    expect(isCrashLoop([0, 10_000, 70_001], 70_001)).toBe(false);
  });
});
