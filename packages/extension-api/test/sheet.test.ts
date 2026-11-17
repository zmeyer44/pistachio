import { describe, expect, it } from "vitest";
import { CAPABILITY_INFO, type Capability } from "../src/capabilities.js";
import { validateManifest, type PistachioManifest } from "../src/manifest.js";
import { hostsInWords, manifestHash, sheetFor } from "../src/sheet.js";

const parse = (value: unknown): PistachioManifest => {
  const result = validateManifest(value);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.manifest;
};

const BASE = { api: 1, id: "dev.zach.gh-inbox", name: "GitHub inbox", version: "1.0.0" };

describe("sheetFor", () => {
  it("lists what the extension adds, from the manifest alone", () => {
    const sheet = sheetFor(
      parse({
        ...BASE,
        permissions: ["agent:tools"],
        worker: { type: "web", main: "worker.js" },
        panel: { file: "panel.html" },
        pages: { inbox: { file: "inbox.html", title: "Inbox" } },
        bar: { commands: [{ name: "prs", description: "Pull requests", run: { event: true } }] },
        tools: [{ name: "list_prs", description: "List open pull requests", input: { type: "object" }, effect: "read" }],
        contextMenus: [{ id: "file-issue", title: "File an issue", contexts: ["selection"] }],
        commands: [{ id: "open", title: "Open the inbox", key: "Cmd+Shift+I" }],
      }),
    );
    expect(sheet.adds).toEqual([
      "a panel on the Ledge",
      "/prs in the Bar",
      "a window of its own",
      "an item in the right-click menu",
      "a tool the agent can call",
      "the shortcut Cmd Shift I",
    ]);
  });

  it("orders its lines broadest first: critical, high, medium, low", () => {
    const sheet = sheetFor(parse({ ...BASE, permissions: ["notifications", "tabs:read", "notes:write", "power"], hosts: ["<all_urls>"] }));
    expect(sheet.can.map((line) => line.tier)).toEqual(["critical", "high", "medium", "low", "low"]);
    expect(sheet.can[0]?.text).toBe("Can talk to every site on the web.");
    expect(sheet.can[1]?.text).toBe(CAPABILITY_INFO["notes:write"].line);
  });

  it("uses only the fixed sentences, with the hosts in words", () => {
    const sheet = sheetFor(parse({ ...BASE, permissions: ["pages:read", "tabs:read"], hosts: ["https://api.github.com/*", "https://github.com/*"] }));
    expect(sheet.can).toEqual([
      { tier: "high", text: "Can read pages on api.github.com and github.com." },
      { tier: "medium", text: CAPABILITY_INFO["tabs:read"].line },
      { tier: "medium", text: "Talks to api.github.com and github.com." },
    ]);
    for (const capability of Object.keys(CAPABILITY_INFO) as Capability[]) expect(CAPABILITY_INFO[capability].line).toMatch(/\.$/);
  });

  it("says what spaces:write does in the sheet's own sentence, among the medium lines", () => {
    const sheet = sheetFor(parse({ ...BASE, permissions: ["spaces:write", "notes:write", "notifications"] }));
    expect(sheet.can).toEqual([
      { tier: "high", text: CAPABILITY_INFO["notes:write"].line },
      { tier: "medium", text: "Sends spaces away and brings them back." },
      { tier: "low", text: CAPABILITY_INFO.notifications.line },
    ]);
    // Asking for it is a wider manifest: the approval names another hash, and the extension waits on the person.
    expect(manifestHash(parse({ ...BASE, permissions: ["spaces:write"] }))).not.toBe(manifestHash(parse({ ...BASE })));
  });

  it("says what the shell draws for it in the sheet's own sentences: a theme among the medium lines, a mark among the low", () => {
    const sheet = sheetFor(parse({ ...BASE, permissions: ["spaces:mark", "theme", "notes:write"] }));
    expect(sheet.can).toEqual([
      { tier: "high", text: CAPABILITY_INFO["notes:write"].line },
      { tier: "medium", text: "Changes the backdrop and accent colour of your spaces." },
      { tier: "low", text: "Puts a small mark on the spaces you ran it in." },
    ]);
    expect(CAPABILITY_INFO.theme.tier).toBe("medium");
    expect(CAPABILITY_INFO["spaces:mark"].tier).toBe("low");
    expect(sheet.declares).toEqual(["permission spaces:mark", "permission theme", "permission notes:write"]);
    // Asking for either is a wider manifest: another hash, and the extension waits on the person.
    expect(manifestHash(parse({ ...BASE, permissions: ["theme"] }))).not.toBe(manifestHash(parse({ ...BASE })));
    expect(manifestHash(parse({ ...BASE, permissions: ["spaces:mark"] }))).not.toBe(manifestHash(parse({ ...BASE, permissions: ["theme"] })));
  });

  it("counts an item in a space's menu among the right-click items it adds", () => {
    const worker = { type: "web", main: "worker.js" };
    const sheet = sheetFor(parse({ ...BASE, worker, contextMenus: [{ id: "here", title: "Game day here", contexts: ["space"] }] }));
    expect(sheet.adds).toEqual(["an item in the right-click menu"]);
  });

  it("counts an item in a tab's menu the same way", () => {
    const worker = { type: "web", main: "worker.js" };
    const sheet = sheetFor(parse({ ...BASE, worker, contextMenus: [{ id: "save", title: "Save for later", contexts: ["tab"] }, { id: "here", title: "Here", contexts: ["space", "tab"] }] }));
    expect(sheet.adds).toEqual(["2 items in the right-click menu"]);
  });

  it("says the places it fills with rows, in the shell's words, and an approval names them", () => {
    expect(sheetFor(parse({ ...BASE, band: true })).adds).toEqual(["a strip beside the Bar"]);
    expect(sheetFor(parse({ ...BASE, sidebar: true, band: true, panel: { file: "panel.html" } })).adds).toEqual(["a panel on the Ledge", "a strip beside the Bar", "a section in the sidebar"]);
    // A place is no capability: nothing is added to what it can do.
    expect(sheetFor(parse({ ...BASE, band: true })).can).toEqual([]);
    const plain = manifestHash(parse({ ...BASE }));
    expect(manifestHash(parse({ ...BASE, band: true }))).not.toBe(plain);
    expect(manifestHash(parse({ ...BASE, sidebar: true }))).not.toBe(manifestHash(parse({ ...BASE, band: true })));
    // One that declares none hashes as it did before there were places: nobody is asked again for nothing.
    expect(plain).toBe(manifestHash(parse({ ...BASE, description: "the same asks" })));
  });

  it("declares every permission, host and tool in full", () => {
    const sheet = sheetFor(
      parse({
        ...BASE,
        permissions: ["agent:tools"],
        hosts: ["https://api.github.com/*"],
        worker: { type: "web", main: "worker.js" },
        tools: [{ name: "close_pr", description: "Close a pull request", input: { type: "object" }, effect: "write" }],
      }),
    );
    expect(sheet.declares).toEqual(["permission agent:tools", "host https://api.github.com/*", "tool close_pr (write): Close a pull request"]);
  });
});

describe("what runs by itself", () => {
  const WORKER = { worker: { type: "web", main: "worker.js" } };

  it("says each trigger in the shell's words, from the declared data alone, in the manifest's order", () => {
    const sheet = sheetFor(
      parse({
        ...BASE,
        ...WORKER,
        permissions: ["spaces:write"],
        triggers: [
          { id: "sunday", during: { days: ["sun"], from: "08:00", to: "23:00" } },
          { id: "standup", at: { days: ["mon", "tue", "wed", "thu", "fri"], time: "09:00" } },
        ],
      }),
    );
    expect(sheet.runs).toEqual(["Sundays 8:00 AM–11:00 PM", "Weekdays at 9:00 AM"]);
    // A trigger is no capability: it adds no line of its own to what the extension can do.
    expect(sheet.can).toEqual([{ tier: "medium", text: CAPABILITY_INFO["spaces:write"].line }]);
    expect(sheet.declares).toEqual(["permission spaces:write", "trigger sunday: Sundays 8:00 AM–11:00 PM", "trigger standup: Weekdays at 9:00 AM"]);
  });

  it("says nothing for an extension that only runs when the person runs it", () => {
    expect(sheetFor(parse({ ...BASE, permissions: ["tabs:read"] })).runs).toEqual([]);
    expect(sheetFor(parse({ ...BASE, ...WORKER, triggers: [] })).runs).toEqual([]);
  });
});

describe("hostsInWords", () => {
  it("names the sites", () => {
    expect(hostsInWords([])).toBe("no sites");
    expect(hostsInWords(["https://api.github.com/*"])).toBe("api.github.com");
    expect(hostsInWords(["https://api.github.com/*", "http://api.github.com/*"])).toBe("api.github.com");
    expect(hostsInWords(["https://a.com/*", "https://b.com/*"])).toBe("a.com and b.com");
    expect(hostsInWords(["https://a.com/*", "https://b.com/*", "https://c.com/*"])).toBe("a.com and 2 other sites");
    expect(hostsInWords(["*://*.example.com/*"])).toBe("every example.com site");
    expect(hostsInWords(["http://localhost:8080/*"])).toBe("localhost");
    expect(hostsInWords(["https://a.com/*", "<all_urls>"])).toBe("every site");
    expect(hostsInWords(["*://*/*"])).toBe("every site");
    expect(hostsInWords(["https://*:8443/*"])).toBe("every site");
  });

  it("tiers every spelling of every site as critical: *://*/* and https://*/* reach what <all_urls> does", () => {
    for (const pattern of ["*://*/*", "https://*/*", "http://*/", "*://*:8080/*"]) {
      const sheet = sheetFor(parse({ ...BASE, permissions: ["pages:read"], hosts: [pattern] }));
      expect(sheet.can, pattern).toEqual([
        { tier: "critical", text: "Can talk to every site on the web." },
        { tier: "high", text: "Can read pages on every site." },
      ]);
    }
    expect(sheetFor(parse({ ...BASE, hosts: ["*://*.example.com/*"] })).can).toEqual([{ tier: "medium", text: "Talks to every example.com site." }]);
  });
});

describe("manifestHash", () => {
  it("is stable across key order and list order", () => {
    const one = parse({ ...BASE, permissions: ["tabs:read", "notes:read"], hosts: ["https://a.com/*", "https://b.com/*"], panel: { file: "panel.html", width: 320 } });
    const two = parse({ panel: { width: 320, file: "panel.html" }, hosts: ["https://b.com/*", "https://a.com/*"], permissions: ["notes:read", "tabs:read"], version: "1.0.0", name: "GitHub inbox", id: BASE.id, api: 1 });
    expect(manifestHash(one)).toBe(manifestHash(two));
    expect(manifestHash(one)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes when what is asked or declared changes, not when the words do", () => {
    const base = parse({ ...BASE, permissions: ["tabs:read"] });
    expect(manifestHash(parse({ ...BASE, permissions: ["tabs:read", "tabs:write"] }))).not.toBe(manifestHash(base));
    expect(manifestHash(parse({ ...BASE, permissions: ["tabs:read"], description: "New words" }))).toBe(manifestHash(base));
  });

  it("is what it was before there were triggers, for a manifest that declares none", () => {
    // (The value an approval made before triggers existed holds: computed from sheet.ts as it was then.)
    expect(manifestHash(parse({ ...BASE, permissions: ["tabs:read"] }))).toBe("f192afb9686cd3cd04de08e2d7a09402");
    expect(manifestHash(parse({ ...BASE, permissions: ["tabs:read"], worker: { type: "web", main: "worker.js" }, triggers: [] }))).toBe(
      manifestHash(parse({ ...BASE, permissions: ["tabs:read"], worker: { type: "web", main: "worker.js" } })),
    );
  });

  it("names the triggers: another hash when one is added or its time changes, the same when only their order or their days' order does", () => {
    const withTriggers = (triggers: unknown[]): string => manifestHash(parse({ ...BASE, worker: { type: "web", main: "worker.js" }, triggers }));
    const sunday = { id: "sunday", during: { days: ["sun", "sat"], from: "08:00", to: "23:00" } };
    const standup = { id: "standup", at: { time: "09:00" } };
    const none = manifestHash(parse({ ...BASE, worker: { type: "web", main: "worker.js" } }));
    expect(withTriggers([sunday])).not.toBe(none);
    expect(withTriggers([sunday, standup])).not.toBe(withTriggers([sunday]));
    expect(withTriggers([{ ...sunday, during: { ...sunday.during, to: "23:30" } }])).not.toBe(withTriggers([sunday]));
    expect(withTriggers([standup, sunday])).toBe(withTriggers([sunday, standup]));
    expect(withTriggers([{ ...sunday, during: { ...sunday.during, days: ["sat", "sun"] } }])).toBe(withTriggers([sunday]));
  });
});
