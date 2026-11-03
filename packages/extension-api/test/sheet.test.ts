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
});
