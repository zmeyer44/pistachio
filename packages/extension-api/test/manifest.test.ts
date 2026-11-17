import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { manifestFiles, parseManifest, validateManifest, widenedAsks, type PistachioManifest } from "../src/manifest.js";
import { manifestJsonSchemaText } from "../src/schema.js";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

/** docs/extensions.md §3, verbatim. */
const RECORDER = {
  api: 1,
  id: "com.pistachio.recorder",
  name: "Recorder",
  version: "1.0.0",
  description: "Record a window, then polish it: zoom that follows your clicks, a smooth cursor, backgrounds, MP4 or GIF.",
  icon: "icon.svg",
  permissions: ["capture:tab", "input:events", "desk", "tabs:read", "files:data", "notifications", "clipboard:write", "power"],
  worker: { type: "web", main: "worker.ts" },
  panel: { file: "panel.html", width: 360 },
  pages: { editor: { file: "editor.html", title: "Recorder" } },
  bar: { commands: [{ name: "record", description: "Record the window in use", arg: { hint: "window | desk" }, run: { event: true } }] },
  contextMenus: [{ id: "record-window", title: "Record this window", contexts: ["window"] }],
  commands: [{ id: "toggle", title: "Start or stop recording", key: "Cmd+Shift+6" }],
  settings: [{ key: "fps", title: "Frame rate", type: "enum", options: ["30", "60"], default: "60" }],
};

const MINIMAL = { api: 1, id: "dev.zach.minimal", name: "Minimal", version: "0.1.0" };

function issuesOf(value: unknown): { path: string; message: string }[] {
  const result = validateManifest(value);
  return result.ok ? [] : result.issues;
}

describe("the manifest schema", () => {
  it.each(["panel", "bar-command", "agent-tool"])("accepts the %s template", (name) => {
    const result = parseManifest(read(`../templates/${name}/pistachio.json`));
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it.each(["hello-panel", "bar-tool"])("accepts the %s e2e fixture", (name) => {
    const result = parseManifest(read(`../../../apps/desktop/e2e/fixtures/extensions/${name}/pistachio.json`));
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("names only files that exist in each template", () => {
    for (const name of ["panel", "bar-command", "agent-tool"]) {
      const result = parseManifest(read(`../templates/${name}/pistachio.json`));
      if (!result.ok) throw new Error(name);
      for (const file of manifestFiles(result.manifest)) expect(() => read(`../templates/${name}/${file}`), `${name}/${file}`).not.toThrow();
    }
  });

  it("accepts the Recorder's manifest from the spec", () => {
    expect(issuesOf(RECORDER)).toEqual([]);
  });

  it("accepts spaces:write, the one capability that changes spaces, and refuses a spelling of it that is not one", () => {
    expect(issuesOf({ ...MINIMAL, permissions: ["spaces:write"] })).toEqual([]);
    expect(issuesOf({ ...MINIMAL, permissions: ["spaces:read"] }).map((issue) => issue.path.split(".")[0])).toContain("permissions");
    // The dev folder's schema says so too: an editor accepts it as the agent types it.
    expect(JSON.parse(read("../schema/pistachio-extension.schema.json")).properties.permissions.items.enum).toContain("spaces:write");
  });

  it("refuses an id that is not reverse-DNS and lowercase", () => {
    for (const id of ["recorder", "Dev.zach.inbox", "dev..zach", "dev.zach.inbox/x", "-dev.zach"]) {
      expect(issuesOf({ ...MINIMAL, id }).map((issue) => issue.path), id).toContain("id");
    }
  });

  it("refuses a path that leaves the folder", () => {
    for (const file of ["../panel.html", "ui/../../panel.html", "/Users/zach/panel.html", ".pistachio/status.json"]) {
      expect(issuesOf({ ...MINIMAL, panel: { file } }).map((issue) => issue.path), file).toContain("panel.file");
    }
    expect(issuesOf({ ...MINIMAL, icon: "../icon.svg" }).map((issue) => issue.path)).toContain("icon");
    expect(issuesOf({ ...MINIMAL, panel: { file: "ui/panel.html" } })).toEqual([]);
  });

  it("refuses a tool without agent:tools, and says what to add", () => {
    const tool = { name: "word_count", description: "Count words", input: { type: "object" }, effect: "read" };
    const issues = issuesOf({ ...MINIMAL, worker: { type: "web", main: "worker.js" }, tools: [tool] });
    expect(issues).toEqual([{ path: "permissions", message: 'tools need "agent:tools" in permissions' }]);
    expect(issuesOf({ ...MINIMAL, worker: { type: "web", main: "worker.js" }, permissions: ["agent:tools"], tools: [tool] })).toEqual([]);
  });

  it("refuses an event command without a worker, but not a prompt command", () => {
    const event = { name: "prs", description: "Pull requests", run: { event: true } };
    const issues = issuesOf({ ...MINIMAL, bar: { commands: [event] } });
    expect(issues.map((issue) => issue.path)).toEqual(["worker"]);
    expect(issues[0]?.message).toContain('"worker": { "type": "web", "main": "worker.js" }');
    expect(issuesOf({ ...MINIMAL, bar: { commands: [{ ...event, run: { prompt: "Summarize {page.url}" } }] } })).toEqual([]);
  });

  it("refuses unknown keys, unknown capabilities, a node worker and a bad host", () => {
    expect(issuesOf({ ...MINIMAL, permisions: [] }).length).toBeGreaterThan(0);
    expect(issuesOf({ ...MINIMAL, permissions: ["cookies"] }).map((issue) => issue.path)).toContain("permissions.0");
    expect(issuesOf({ ...MINIMAL, worker: { type: "node", main: "worker.js" } }).map((issue) => issue.path)).toContain("worker.type");
    expect(issuesOf({ ...MINIMAL, hosts: ["api.github.com"] }).map((issue) => issue.path)).toContain("hosts.0");
    expect(issuesOf({ ...MINIMAL, hosts: ["https://api.github.com/*", "*://*.example.com/*", "<all_urls>"] })).toEqual([]);
  });

  it("accepts the guide's Game day: a window trigger, the worker it wakes, the command that gives it a space", () => {
    const result = validateManifest({
      api: 1,
      id: "dev.example.game-day",
      name: "Game day",
      version: "1.0.0",
      description: "Keeps a space away except Sundays, 8 AM to 11 PM.",
      permissions: ["spaces:write"],
      worker: { type: "web", main: "worker.js" },
      triggers: [{ id: "sunday", during: { days: ["sun"], from: "08:00", to: "23:00" } }],
      bar: { commands: [{ name: "gameday", description: "Show this space only on Sundays", run: { event: true } }] },
    });
    expect(result.ok ? [] : result.issues).toEqual([]);
    expect(result.ok ? result.manifest.triggers : null).toEqual([{ id: "sunday", during: { days: ["sun"], from: "08:00", to: "23:00" } }]);
  });

  it("accepts the guide's Game day with a stadium: an item in a space's menu, a mark and a theme for the space it is chosen in", () => {
    const stadium = {
      api: 1,
      id: "dev.example.game-day-stadium",
      name: "Game day",
      version: "1.0.0",
      description: "A stadium behind a space, and a mark on it, on Sundays from 8 AM to 11 PM.",
      permissions: ["spaces:mark", "theme"],
      worker: { type: "web", main: "worker.js" },
      triggers: [{ id: "sunday", during: { days: ["sun"], from: "08:00", to: "23:00" } }],
      contextMenus: [{ id: "here", title: "Game day here", contexts: ["space"] }],
    };
    const result = validateManifest(stadium);
    expect(result.ok ? [] : result.issues).toEqual([]);
    expect(result.ok ? result.manifest.contextMenus : null).toEqual([{ id: "here", title: "Game day here", contexts: ["space"] }]);
    // A menu item wakes the worker, in a space's menu as on a page: without one it is refused, at `worker`.
    const { worker: _worker, triggers: _triggers, ...bare } = stadium;
    expect(issuesOf(bare).map((issue) => issue.path)).toEqual(["worker"]);
    // Beside the other contexts; one it does not know is refused at its place.
    expect(issuesOf({ ...stadium, contextMenus: [{ id: "here", title: "Game day here", contexts: ["space", "window", "page"] }] })).toEqual([]);
    expect(issuesOf({ ...stadium, contextMenus: [{ id: "here", title: "Game day here", contexts: ["rail"] }] }).map((issue) => issue.path)).toEqual(["contextMenus.0.contexts.0"]);
    expect(issuesOf({ ...MINIMAL, permissions: ["spaces:mark", "theme"] })).toEqual([]);
    expect(issuesOf({ ...MINIMAL, permissions: ["theme:write"] }).map((issue) => issue.path)).toEqual(["permissions.0"]);
  });

  it("refuses a trigger without a worker, a trigger twice, and a window of no length — each at its place", () => {
    const paths = (value: unknown): string[] => issuesOf(value).map((issue) => issue.path);
    expect(paths({ ...MINIMAL, triggers: [{ id: "x", at: { time: "09:00" } }] })).toEqual(["worker"]);
    const worker = { type: "web", main: "worker.js" };
    expect(paths({ ...MINIMAL, worker, triggers: [{ id: "x", at: { time: "09:00" } }, { id: "x", at: { time: "10:00" } }] })).toEqual(["triggers.1.id"]);
    expect(paths({ ...MINIMAL, worker, triggers: [{ id: "x", during: { from: "09:00", to: "09:00" } }] })).toEqual(["triggers.0.during.to"]);
  });

  it("says when pistachio.json is not JSON", () => {
    const result = parseManifest("{ api: 1 }");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toMatch(/^pistachio\.json is not valid JSON/);
  });
});

describe("widenedAsks", () => {
  const manifest = (permissions: string[], hosts: string[]): PistachioManifest => {
    const result = validateManifest({ ...MINIMAL, permissions, hosts });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.manifest;
  };

  it("names what a newer manifest asks beyond the grant", () => {
    const grant = { capabilities: ["tabs:read"], hosts: ["https://api.github.com/*"] };
    expect(widenedAsks(grant, manifest(["tabs:read", "notes:write"], ["https://api.github.com/*", "https://gitlab.com/*"]))).toEqual({
      capabilities: ["notes:write"],
      hosts: ["https://gitlab.com/*"],
    });
  });

  it("is empty when the manifest asks the same or less", () => {
    const grant = { capabilities: ["tabs:read", "tabs:write"], hosts: ["https://api.github.com/*"] };
    expect(widenedAsks(grant, manifest(["tabs:write", "tabs:read"], []))).toEqual({ capabilities: [], hosts: [] });
  });
});

describe("the checked-in JSON Schema", () => {
  it("is what the zod schema generates (run `pnpm --filter @pistachio/extension-api schema`)", () => {
    expect(read("../schema/pistachio-extension.schema.json")).toBe(manifestJsonSchemaText());
  });

  it("is strict at the top and says a host's shape", () => {
    const schema = JSON.parse(manifestJsonSchemaText()) as { additionalProperties: unknown; required: string[]; properties: { hosts: { items: { anyOf: unknown[] } } } };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["api", "id", "name", "version"]);
    expect(schema.properties.hosts.items.anyOf).toHaveLength(2);
  });
});
