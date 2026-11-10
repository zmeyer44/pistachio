import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  chromeHostPatterns,
  chromeManifestHash,
  chromePatternCovers,
  chromeSheet,
  chromeVerdict,
  chromeWarnings,
  type ChromeManifest,
} from "../src/main/extensions/chrome/verdict";
import { CURATED_CHROME, curatedChrome, verdictFor } from "../src/main/extensions/chrome/curated";
import { isChromeExtensionId } from "../src/main/extensions/chrome/actions";

// Real manifests: each downloaded from the Chrome Web Store by id on 2026-10-30 (CRX → manifest.json), abridged to
// the keys the verdict and the sheet read (content-script lists shortened, file lists elided as "…"). uBlock Origin
// (MV2) is no longer served by the store; its manifest is uBlock's platform/chromium/manifest.json (1.58), and the
// side-panel-only one is Chrome's own sample (chrome-extensions-samples, cookbook.sidepanel-global).

const UBLOCK_ORIGIN: ChromeManifest = {
  manifest_version: 2,
  name: "uBlock Origin",
  short_name: "uBlock₀",
  version: "1.58.0",
  browser_action: { default_popup: "popup-fenix.html" },
  background: { page: "background.html" },
  commands: { "launch-element-zapper": {}, "launch-element-picker": {}, "launch-logger": {}, "open-dashboard": {}, "relax-blocking-mode": {}, "toggle-cosmetic-filtering": {}, "toggle-javascript": {} },
  content_scripts: [{ matches: ["http://*/*", "https://*/*"], js: ["…"] }],
  options_ui: { page: "dashboard.html" },
  permissions: ["alarms", "contextMenus", "privacy", "storage", "tabs", "unlimitedStorage", "webNavigation", "webRequest", "webRequestBlocking", "<all_urls>"],
  minimum_chrome_version: "93.0",
};

const UBO_LITE: ChromeManifest = {
  manifest_version: 3,
  name: "__MSG_extName__",
  short_name: "uBO Lite",
  version: "2026.1026.1812",
  permissions: ["activeTab", "alarms", "declarativeNetRequest", "offscreen", "scripting", "storage", "unlimitedStorage", "userScripts"],
  host_permissions: ["<all_urls>"],
  action: { default_popup: "popup.html" },
  background: { service_worker: "/js/background.js" },
  commands: { "enter-zapper-mode": {}, "enter-picker-mode": {} },
  options_page: "dashboard.html",
  declarative_net_request: { rule_resources: [{ id: "ublock-filters" }, { id: "easylist" }, { id: "easyprivacy" }] },
  minimum_chrome_version: "122.0",
};

const DARK_READER: ChromeManifest = {
  manifest_version: 3,
  name: "Dark Reader",
  version: "4.9.134",
  permissions: ["alarms", "fontSettings", "scripting", "storage"],
  optional_permissions: ["contextMenus"],
  host_permissions: ["*://*/*"],
  action: { default_popup: "ui/popup/index.html" },
  background: { service_worker: "background/index.js" },
  content_scripts: [{ matches: ["<all_urls>"], js: ["…"] }],
  commands: { toggle: {}, addSite: {}, switchEngine: {} },
  options_ui: { page: "ui/popup/index.html" },
  minimum_chrome_version: "106.0.0.0",
};

const GRAMMARLY: ChromeManifest = {
  manifest_version: 3,
  name: "Grammarly: AI Writing Assistant and Grammar Checker App",
  short_name: "Superhuman Go",
  version: "14.1343.0",
  permissions: ["scripting", "sidePanel", "tabs", "notifications", "cookies", "identity", "storage"],
  optional_permissions: ["nativeMessaging", "clipboardRead"],
  host_permissions: ["http://*/*", "https://*/*"],
  action: { default_popup: "src/popup.html" },
  background: { service_worker: "sw.js" },
  content_scripts: [
    { matches: ["<all_urls>"], js: ["…"], css: ["…"] },
    { matches: ["*://docs.google.com/*"], js: ["…"] },
  ],
  side_panel: { default_path: "src/sidePanel.html" },
  minimum_chrome_version: "98",
};

const BITWARDEN: ChromeManifest = {
  manifest_version: 3,
  name: "__MSG_extName__",
  short_name: "Bitwarden",
  version: "2026.10.1",
  permissions: [
    "activeTab", "alarms", "clipboardRead", "clipboardWrite", "contextMenus", "idle", "offscreen", "scripting", "sidePanel", "storage", "tabs",
    "unlimitedStorage", "webNavigation", "webRequest", "webRequestAuthProvider", "notifications",
  ],
  optional_permissions: ["nativeMessaging", "privacy"],
  host_permissions: ["https://*/*", "http://*/*"],
  action: { default_popup: "popup/index.html" },
  background: { service_worker: "background.js" },
  content_scripts: [{ matches: ["*://*/*", "file:///*"], js: ["…"] }],
  side_panel: { default_path: "sidepanel-disabled.html" },
  commands: { _execute_action: {}, autofill_login: {}, autofill_card: {}, autofill_identity: {}, generate_password: {}, lock_vault: {} },
  minimum_chrome_version: "134.0",
};

const ONE_PASSWORD: ChromeManifest = {
  manifest_version: 3,
  name: "__MSG_extName__",
  short_name: "1Password",
  version: "8.12.42.36",
  permissions: [
    "alarms", "contextMenus", "downloads", "idle", "management", "nativeMessaging", "notifications", "privacy", "scripting", "storage", "tabs",
    "webNavigation", "webRequest", "webRequestAuthProvider", "declarativeNetRequestWithHostAccess",
  ],
  host_permissions: ["<all_urls>"],
  action: { default_popup: "popup/index.html" },
  background: { service_worker: "background/background.js" },
  content_scripts: [{ matches: ["<all_urls>"], js: ["…"] }, { matches: ["https://*.1password.com/*"], js: ["…"] }],
  commands: { _execute_action: {}, lock: {} },
  declarative_net_request: { rule_resources: [{ id: "ruleset_1" }] },
  minimum_chrome_version: "140",
};

const REACT_DEVTOOLS: ChromeManifest = {
  manifest_version: 3,
  name: "React Developer Tools",
  version: "8.0.0",
  permissions: ["scripting", "storage", "tabs"],
  optional_permissions: ["clipboardWrite"],
  host_permissions: ["<all_urls>"],
  action: { default_popup: "popups/disabled.html" },
  background: { service_worker: "build/background.js" },
  content_scripts: [{ matches: ["<all_urls>"], js: ["…"] }],
  devtools_page: "main.html",
  minimum_chrome_version: "114",
};

const SIDE_PANEL_ONLY: ChromeManifest = {
  manifest_version: 3,
  name: "Global side panel",
  version: "1.0",
  description: "Sidepanel declared only in the manifest visible to all sites",
  side_panel: { default_path: "sidepanel.html" },
  permissions: ["sidePanel"],
};

const MOMENTUM: ChromeManifest = {
  manifest_version: 3,
  name: "Momentum",
  short_name: "Momentum",
  version: "2.27.9",
  permissions: ["offscreen", "unlimitedStorage", "idle"],
  optional_permissions: ["bookmarks", "tabs", "sessions", "topSites", "favicon", "scripting", "alarms", "notifications", "tabGroups", "search"],
  optional_host_permissions: ["file:///*", "*://*/*"],
  action: {},
  background: { service_worker: "serviceWorker.js" },
  content_scripts: [{ matches: ["https://*.momentumdash.com/*"], js: ["…"] }],
  chrome_url_overrides: { newtab: "index.html" },
};

const LOOM: ChromeManifest = {
  manifest_version: 3,
  name: "Loom – Screen Recorder & Screen Capture",
  version: "5.5.214",
  permissions: ["system.memory", "activeTab", "alarms", "contextMenus", "cookies", "desktopCapture", "scripting", "storage", "system.cpu", "system.display", "tabCapture", "webNavigation", "webRequest"],
  host_permissions: ["<all_urls>"],
  action: { default_popup: "html/popup.html" },
  background: { service_worker: "js/sw.js" },
  commands: { _execute_action: {}, "cancel-recording": {}, "restart-recording": {}, "toggle-pause-recording": {} },
};

const SAVE_TO_DRIVE: ChromeManifest = {
  manifest_version: 3,
  name: "__MSG_CHROME_EXTENSION_NAME__",
  version: "3.0.9",
  permissions: ["contextMenus", "identity", "printerProvider", "notifications", "pageCapture", "storage", "tabs", "webRequest", "scripting"],
  host_permissions: ["<all_urls>"],
  action: {},
  background: { service_worker: "js/backgroundpagebootstrap.js" },
  options_page: "options.html",
  oauth2: { scopes: ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/userinfo.email"] },
};

const TAMPERMONKEY: ChromeManifest = {
  manifest_version: 3,
  name: "__MSG_extName__",
  short_name: "__MSG_extShortName__",
  version: "5.5.1",
  permissions: [
    "notifications", "unlimitedStorage", "tabs", "idle", "webNavigation", "webRequest", "webRequestBlocking", "storage", "contextMenus", "chrome://favicon/",
    "clipboardWrite", "cookies", "alarms", "declarativeNetRequestWithHostAccess", "scripting", "userScripts", "offscreen",
  ],
  optional_permissions: ["downloads"],
  host_permissions: ["<all_urls>"],
  action: { default_popup: "action.html" },
  background: { service_worker: "background.js" },
};

const NOTION_CLIPPER: ChromeManifest = {
  manifest_version: 3,
  name: "__MSG_webClipperExtension_name__",
  version: "0.2.20",
  permissions: ["activeTab", "storage", "cookies", "scripting"],
  host_permissions: ["https://*.notion.so/*", "https://*.notion.so/", "https://*.notion.com/*", "https://*.notion.com/"],
  action: { default_popup: "index.html" },
  background: { service_worker: "background.js" },
  commands: { _execute_action: {} },
};

describe("chromeVerdict (docs/extensions.md §6.4)", () => {
  it("refuses blockers with Shields' sentence: uBlock Origin (MV2, blocking webRequest) and uBO Lite (declarativeNetRequest)", () => {
    const shields = { kind: "wont", reason: "Shields already blocks ads and trackers here.", alternative: "Shields" };
    expect(chromeVerdict(UBLOCK_ORIGIN)).toEqual(shields);
    expect(chromeVerdict(UBO_LITE)).toEqual(shields);
  });

  it("refuses a blocking MV2 extension that is no blocker without naming Shields", () => {
    const verdict = chromeVerdict({ manifest_version: 2, name: "Header Rewriter", version: "1", permissions: ["webRequest", "webRequestBlocking", "<all_urls>"] });
    expect(verdict.kind).toBe("wont");
    expect(verdict).not.toHaveProperty("alternative");
  });

  it("refuses an extension whose only surface is the side panel", () => {
    expect(chromeVerdict(SIDE_PANEL_ONLY)).toEqual({ kind: "wont", reason: "It lives in Chrome's side panel, which Pistachio doesn't have yet." });
  });

  it("refuses screen recorders and points at the Recorder", () => {
    expect(chromeVerdict(LOOM)).toMatchObject({ kind: "wont", alternative: "Recorder" });
  });

  it("refuses Chrome's Google sign-in (identity with oauth2), the debugger and userScripts", () => {
    expect(chromeVerdict(SAVE_TO_DRIVE)).toEqual({ kind: "wont", reason: "It signs in with the Google account inside Chrome, which Pistachio doesn't have." });
    expect(chromeVerdict({ manifest_version: 3, name: "Agent", version: "1", permissions: ["debugger", "tabs"], action: {} }).kind).toBe("wont");
    expect(chromeVerdict(TAMPERMONKEY)).toMatchObject({ kind: "wont", reason: expect.stringContaining("userScripts") });
  });

  it("refuses an extension that needs a newer Chrome than Pistachio's", () => {
    expect(chromeVerdict(REACT_DEVTOOLS, { chromeVersion: "146.0.7444.0" })).toEqual({ kind: "works" });
    expect(chromeVerdict(REACT_DEVTOOLS, { chromeVersion: "100.0.0.0" })).toMatchObject({ kind: "wont", reason: expect.stringContaining("(114)") });
  });

  it("says React DevTools works", () => {
    expect(chromeVerdict(REACT_DEVTOOLS)).toEqual({ kind: "works" });
  });

  it("says Dark Reader partly works: its shortcuts and the font list, and its settings stay here", () => {
    const verdict = chromeVerdict(DARK_READER);
    expect(verdict.kind).toBe("partly");
    if (verdict.kind !== "partly") return;
    expect(verdict.notes).toContain("Its keyboard shortcuts aren't available yet.");
    expect(verdict.notes).toContain("It can't read your font settings here.");
    // alarms was measured present in Electron 43: no note for it.
    expect(verdict.notes.join(" ")).not.toMatch(/alarm/i);
    expect(verdict.notes.at(-1)).toBe("If it syncs its settings, they stay on this Mac.");
  });

  it("says Grammarly partly works: its side panel, and signing in from its pop-up", () => {
    const verdict = chromeVerdict(GRAMMARLY);
    expect(verdict.kind).toBe("partly");
    if (verdict.kind !== "partly") return;
    expect(verdict.notes).toContain("Its side panel doesn't open here yet; the rest of it works.");
    expect(verdict.notes.some((note) => note.startsWith("Signing in through its own pop-up"))).toBe(true);
  });

  it("does not refuse password managers for what isn't their core (offscreen, one DNR rule set, native messaging)", () => {
    const bitwarden = chromeVerdict(BITWARDEN);
    expect(bitwarden.kind).toBe("partly");
    if (bitwarden.kind === "partly") {
      expect(bitwarden.notes).toContain("Its side panel doesn't open here yet; the rest of it works.");
      expect(bitwarden.notes).toContain("Its keyboard shortcuts aren't available yet.");
    }
    const onePassword = chromeVerdict(ONE_PASSWORD);
    expect(onePassword.kind).toBe("partly");
    if (onePassword.kind === "partly") {
      expect(onePassword.notes).toContain("Connecting to its app on this Mac isn't available in Pistachio yet.");
      // declarativeNetRequest and offscreen were measured working in Electron 43: no note.
      expect(onePassword.notes.join(" ")).not.toMatch(/declarativeNetRequest|hidden page/);
      expect(onePassword.notes).toContain("It can't see or manage your downloads here.");
      // `lock` is a shortcut of its own; `_execute_action` is not.
      expect(onePassword.notes).toContain("Its keyboard shortcut isn't available yet.");
    }
  });

  it("says Momentum partly works: new tabs stay Pistachio's", () => {
    const verdict = chromeVerdict(MOMENTUM);
    expect(verdict.kind).toBe("partly");
    if (verdict.kind === "partly") expect(verdict.notes).toContain("New tabs keep opening Pistachio's home page.");
  });

  it("notes a Manifest V2 extension that isn't a blocker", () => {
    const verdict = chromeVerdict({ manifest_version: 2, name: "Old", version: "1", browser_action: {}, permissions: ["storage"] });
    expect(verdict.kind).toBe("partly");
    if (verdict.kind === "partly") expect(verdict.notes[0]).toContain("Manifest V2");
  });
});

describe("chromeSheet", () => {
  it("puts every site first, in red, and reads Chrome's other spellings of every site as every site", () => {
    for (const manifest of [DARK_READER, GRAMMARLY, ONE_PASSWORD, REACT_DEVTOOLS]) {
      expect(chromeSheet(manifest).can[0]).toEqual({ tier: "critical", text: "Read and change pages on every site" });
    }
  });

  it("names a few sites in words, as High", () => {
    expect(chromeSheet(NOTION_CLIPPER).can[0]).toEqual({ tier: "high", text: "Read and change pages on every notion.com site and every notion.so site" });
  });

  it("says activeTab plainly when that is all it reaches", () => {
    const sheet = chromeSheet({ manifest_version: 3, name: "Clip", version: "1", permissions: ["activeTab", "storage"], action: {} });
    expect(sheet.can[0]).toEqual({ tier: "low", text: "Read and change the page you're on when you click it" });
  });

  it("lines up cookies as High, tabs as Medium, storage and notifications as Low", () => {
    const can = chromeSheet(GRAMMARLY).can;
    expect(can).toContainEqual({ tier: "high", text: "Read and change your cookies on every site" });
    expect(can).toContainEqual({ tier: "medium", text: "See the titles and addresses of your tabs" });
    expect(can).toContainEqual({ tier: "low", text: "Keep data of its own" });
    expect(can).toContainEqual({ tier: "low", text: "Show notifications" });
    // Broadest first.
    const ranks = can.map((line) => ["critical", "high", "medium", "low"].indexOf(line.tier));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("buckets what reaches this Mac", () => {
    const mac = chromeWarnings(ONE_PASSWORD).filter((line) => line.bucket === "mac").map((line) => line.text);
    expect(mac).toEqual(expect.arrayContaining(["Talks to an app on this Mac", "Sees and manages your other extensions"]));
    // An optional permission is not asked for at install.
    expect(chromeWarnings(BITWARDEN).some((line) => line.text === "Talks to an app on this Mac")).toBe(false);
  });

  it("says what it adds", () => {
    expect(chromeSheet(DARK_READER).adds).toEqual(["a button on the Ledge with a popup", "3 keyboard shortcuts", "an options page"]);
    expect(chromeSheet(MOMENTUM).adds).toEqual(["a button on the Ledge", "a new tab page (Pistachio keeps its own)"]);
    expect(chromeSheet(GRAMMARLY).adds).toContain("a side panel (not in Pistachio yet)");
    expect(chromeSheet(REACT_DEVTOOLS).adds).toContain("a panel in the developer tools");
  });

  it("declares everything, optional ones included", () => {
    const declares = chromeSheet(BITWARDEN).declares;
    expect(declares).toContain("permission offscreen");
    expect(declares).toContain("host https://*/*");
    expect(declares).toContain("content scripts on *://*/*");
    expect(declares).toContain("optional permission nativeMessaging");
  });

  it("hashes permissions, hosts and version, in any order", () => {
    const hash = chromeManifestHash(DARK_READER);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(chromeManifestHash({ ...DARK_READER, permissions: [...DARK_READER.permissions!].reverse() })).toBe(hash);
    expect(chromeManifestHash({ ...DARK_READER, version: "4.9.135" })).not.toBe(hash);
    expect(chromeManifestHash({ ...DARK_READER, permissions: [...DARK_READER.permissions!, "cookies"] })).not.toBe(hash);
    expect(chromeManifestHash({ ...DARK_READER, content_scripts: [{ matches: ["https://bank.example/*"], js: ["x.js"] }] })).not.toBe(hash);
    expect(chromeSheet(DARK_READER).manifestHash).toBe(hash);
  });

  it("never counts local files or chrome:// pages as sites", () => {
    expect(chromeHostPatterns(BITWARDEN)).toEqual(["*://*/*", "http://*/*", "https://*/*"]);
    expect(chromeHostPatterns(TAMPERMONKEY)).toEqual(["<all_urls>"]);
  });
});

describe("chromePatternCovers (permissions.request's origins)", () => {
  it("covers what was declared and nothing wider", () => {
    expect(chromePatternCovers("*://*/*", "https://github.com/*")).toBe(true);
    expect(chromePatternCovers("<all_urls>", "https://github.com/*")).toBe(true);
    expect(chromePatternCovers("https://*.github.com/*", "https://api.github.com/*")).toBe(true);
    expect(chromePatternCovers("https://*.github.com/*", "https://github.com/*")).toBe(true);
    expect(chromePatternCovers("https://*.github.com/*", "https://evilgithub.com/*")).toBe(false);
    expect(chromePatternCovers("https://github.com/*", "*://github.com/*")).toBe(false);
    expect(chromePatternCovers("https://github.com/*", "https://*/*")).toBe(false);
    expect(chromePatternCovers("https://github.com/*", "<all_urls>")).toBe(false);
    expect(chromePatternCovers("*://*/*", "file:///*")).toBe(false);
  });
});

describe("the curated slice", () => {
  it("has valid, unique ids and a verdict that says why", () => {
    const ids = CURATED_CHROME.map((entry) => entry.cwsId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CURATED_CHROME.length).toBeGreaterThanOrEqual(25);
    for (const entry of CURATED_CHROME) {
      expect(isChromeExtensionId(entry.cwsId)).toBe(true);
      expect(entry.description.length).toBeLessThanOrEqual(80);
      if (entry.verdict.kind === "partly") expect(entry.verdict.notes.length).toBeGreaterThan(0);
      if (entry.verdict.kind === "wont") expect(entry.verdict.reason).toMatch(/\.$/);
    }
  });

  it("names each extension's logo among the shell's files — a PNG no larger than 128px — but for the two the store no longer serves", () => {
    const dir = fileURLToPath(new URL("../src/renderer/public/extension-icons/", import.meta.url));
    const files = new Set(readdirSync(dir));
    for (const entry of CURATED_CHROME) {
      if (entry.iconUrl === null) continue;
      expect(entry.iconUrl).toBe(`/extension-icons/${entry.cwsId}.png`);
      expect(files.has(`${entry.cwsId}.png`)).toBe(true);
      const png = readFileSync(join(dir, `${entry.cwsId}.png`));
      expect(png.readUInt32BE(0)).toBe(0x89504e47);
      expect(Math.max(png.readUInt32BE(16), png.readUInt32BE(20))).toBeLessThanOrEqual(128);
    }
    // Every file is some entry's (scripts/fetch-curated-icons.mjs writes them, one per id).
    const named = new Set(CURATED_CHROME.flatMap((entry) => (entry.iconUrl === null ? [] : [`${entry.cwsId}.png`])));
    expect([...files].filter((file) => !named.has(file))).toEqual([]);
    expect(CURATED_CHROME.filter((entry) => entry.iconUrl === null).map((entry) => entry.name)).toEqual(["Pocket", "uBlock Origin"]);
  });

  it("overrides the manifest's read where it knows better, and is overridden by a manifest that got worse", () => {
    expect(curatedChrome("nngceckbapebfimnlniiiahkandclblb")?.name).toBe("Bitwarden");
    const bitwarden = verdictFor("nngceckbapebfimnlniiiahkandclblb", BITWARDEN);
    expect(bitwarden.kind).toBe("partly");
    if (bitwarden.kind === "partly") expect(bitwarden.notes[0]).toContain("unlocking with the desktop app");
    // Dark Reader gains `debugger` in some later version: the curated ◐ no longer speaks for it.
    const worse = { ...DARK_READER, permissions: [...DARK_READER.permissions!, "debugger"] };
    expect(verdictFor("eimadpbcbfnmbkopoojfekhnkhdbieeh", worse).kind).toBe("wont");
    // Not curated: the manifest's read.
    expect(verdictFor("abcdefghijklmnopabcdefghijklmnop", REACT_DEVTOOLS)).toEqual({ kind: "works" });
  });
});
