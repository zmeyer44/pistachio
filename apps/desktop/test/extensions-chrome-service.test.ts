/**
 * Chrome extensions in the host (main/extensions/chrome/host.ts, docs/extensions.md §2, §4, §6.4, §7): the record,
 * verdict and status mapping, and the install flows — a store install by id, an unpacked folder, a launch update —
 * against a stand-in ChromeCompat and a stand-in download (no Electron, no network).
 */

import { folderLinksOut } from "../src/main/extensions/chrome/folder";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Session, WebContents } from "electron";
import type { ServiceBrowser } from "../src/main/extensions/browser-host";
import {
  ChromeHost,
  POPUP_ALIGNMENT,
  chromeIdFor,
  chromeRunsIn,
  chromeStatus,
  chromeWidened,
  type ChromeCompatPort,
  type ChromeStorePort,
} from "../src/main/extensions/chrome/host";
import { chromeSheet, type ChromeManifest } from "../src/main/extensions/chrome/verdict";
import { ExtensionRegistry, type ExtensionRecord } from "../src/main/extensions/registry";

const STORE_ID = "abcdefghijklmnopabcdefghijklmnop";
const DARK_READER = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const MINI: ChromeManifest = {
  manifest_version: 3,
  name: "Mini Action",
  version: "1.0.0",
  description: "A test extension.",
  icons: { "32": "icon32.png" },
  action: { default_title: "Mini Action", default_popup: "popup.html" },
  background: { service_worker: "background.js" },
  content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }],
  permissions: ["storage", "contextMenus"],
  host_permissions: ["http://127.0.0.1/*"],
};

const BLOCKER: ChromeManifest = {
  manifest_version: 3,
  name: "Super Ad Blocker",
  version: "2.0.0",
  permissions: ["declarativeNetRequest", "storage"],
  host_permissions: ["<all_urls>"],
  declarative_net_request: { rule_resources: [{ id: "easylist", enabled: true, path: "easylist.json" }] },
};

function folderWith(manifest: ChromeManifest): string {
  const dir = join(mkdtempSync(join(tmpdir(), "pistachio-chrome-host-")), "ext");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "icon32.png"), PNG_1PX);
  return dir;
}

function recordOf(extra: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: STORE_ID,
    kind: "chrome",
    source: { type: "webstore", cwsId: STORE_ID, version: "1.0.0" },
    enabled: true,
    profiles: ["work"],
    // Approved as MINI's sheet says (a grant naming another manifest never loads: the launch's regrant pauses it).
    grants: { capabilities: ["storage", "contextMenus"], hosts: ["http://127.0.0.1/*"], manifestHash: chromeSheet(MINI).manifestHash, at: 0 },
    pending: null,
    pinned: true,
    order: 0,
    agentAllowed: false,
    installedAt: 0,
    updatedAt: 0,
    verdict: { kind: "works" },
    ...extra,
  };
}

interface Rig {
  host: ChromeHost;
  registry: ExtensionRegistry;
  compat: ChromeCompatPort & EventEmitter & { loaded: Map<string, string> };
  store: { [K in keyof ChromeStorePort]: ReturnType<typeof vi.fn> };
  loadCompat: ReturnType<typeof vi.fn>;
  ses: Session & { clearStorageData: ReturnType<typeof vi.fn> };
  publish: ReturnType<typeof vi.fn>;
  notice: ReturnType<typeof vi.fn>;
  tab(id: number, tabId: string): WebContents;
}

function rig(options: { downloads?: Record<string, { path: string; manifest: ChromeManifest; version: string }>; records?: ExtensionRecord[]; updates?: unknown[] } = {}): Rig {
  const userData = mkdtempSync(join(tmpdir(), "pistachio-chrome-reg-"));
  const registry = new ExtensionRegistry(userData);
  for (const record of options.records ?? []) registry.upsert(record);
  const ses = { clearStorageData: vi.fn(async () => undefined), getStoragePath: () => userData } as unknown as Rig["ses"];
  const attached = new Set<unknown>();
  const loaded = new Map<string, string>();
  const compat = Object.assign(new EventEmitter(), {
    loaded,
    attachSession: vi.fn(async (session: unknown) => void attached.add(session)),
    isAttached: (session: unknown) => attached.has(session),
    loadExtension: vi.fn(async (_session: unknown, path: string) => {
      const id = [...Object.entries(options.downloads ?? {})].find(([, download]) => download.path === path)?.[0] ?? chromeIdFor(path, {});
      loaded.set(id, path);
      return { id };
    }),
    unload: vi.fn((_session: unknown, id: string) => void loaded.delete(id)),
    addTab: vi.fn(),
    removeTab: vi.fn(),
    selectTab: vi.fn(),
    contextMenuItems: vi.fn(() => []),
    actions: vi.fn(async () => [...loaded.keys()].map((id) => ({ extensionId: id, title: "Mini Action", badge: "3", badgeColor: null, hasPopup: true, iconUrl: `crx://extension-icon/${id}/32/1?partition=p` }))),
    activate: vi.fn(),
    crxResponse: vi.fn(() => new Response(null, { status: 404 })),
    iconUrl: vi.fn((_session: unknown, id: string) => `crx://extension-icon/${id}/32/1`),
    notificationsToNotices: vi.fn(() => () => undefined),
  }) as unknown as Rig["compat"];
  const downloads = options.downloads ?? {};
  const store = {
    installById: vi.fn(async (cwsId: string) => {
      const download = downloads[cwsId];
      if (download === undefined) throw new Error("not in the store");
      return { cwsId, ...download };
    }),
    uninstallById: vi.fn(async () => undefined),
    readInstalledManifest: vi.fn(async (cwsId: string) => (downloads[cwsId] === undefined ? null : { cwsId, ...downloads[cwsId] })),
    checkUpdates: vi.fn(async () => options.updates ?? []),
  };
  const loadCompat = vi.fn(async () => compat);
  const browser = {
    activeProfileId: () => "work",
    profileIds: () => ["work"],
    activeTabId: () => "tab-1",
    createTab: vi.fn(async () => "tab-new"),
    navigate: vi.fn(async () => undefined),
  } as unknown as ServiceBrowser;
  const window = { isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }) };
  const publish = vi.fn();
  const notice = vi.fn();
  const host = new ChromeHost({
    registry,
    extensionsPath: join(userData, "Extensions", "chrome"),
    chromeVersion: "146.0.0.0",
    browser: () => browser,
    window: () => window as never,
    sessionOf: () => ses,
    notice,
    publish,
    log: () => undefined,
    loadCompat,
    store: store as unknown as ChromeStorePort,
  });
  const tab = (id: number, _tabId: string): WebContents =>
    ({ id, session: ses, isDestroyed: () => false, once: vi.fn(), on: vi.fn(), getURL: () => "https://example.com/", reload: vi.fn() }) as unknown as WebContents;
  return { host, registry, compat, store: store as Rig["store"], loadCompat, ses, publish, notice, tab };
}

describe("the record, its verdict and its status", () => {
  it("names a folder as Chromium does: its key's hash, else its path's, spelled a–p", () => {
    const byPath = chromeIdFor("/Users/z/ext/mini", {});
    expect(byPath).toMatch(/^[a-p]{32}$/);
    expect(chromeIdFor("/Users/z/ext/mini", {})).toBe(byPath);
    expect(chromeIdFor("/Users/z/ext/other", {})).not.toBe(byPath);
    // A key decides wherever the folder is.
    const key = Buffer.from("a public key, as DER").toString("base64");
    expect(chromeIdFor("/a", { key })).toBe(chromeIdFor("/b", { key }));
    expect(chromeIdFor("/a", { key })).not.toBe(chromeIdFor("/a", {}));
  });

  it("asks everything the first time, nothing when the same, only what is new when it widens", () => {
    expect(chromeWidened(null, MINI)).toEqual({ manifestHash: chromeSheet(MINI).manifestHash, widened: ["storage", "contextMenus"], hosts: ["http://127.0.0.1/*"] });
    const grants = { capabilities: ["storage", "contextMenus"], hosts: ["*://127.0.0.1/*"], manifestHash: "old", at: 0 };
    expect(chromeWidened(grants, MINI)).toBeNull();
    expect(chromeWidened(grants, { ...MINI, permissions: ["storage"] })).toBeNull();
    const wider = chromeWidened(grants, { ...MINI, permissions: ["storage", "contextMenus", "tabs"], host_permissions: ["http://127.0.0.1/*", "https://github.com/*"] });
    expect(wider?.widened).toEqual(["tabs"]);
    expect(wider?.hosts).toEqual(["https://github.com/*"]);
  });

  it("maps a record to its status", () => {
    const facts = { failed: false, enabledHere: true, loadedHere: true };
    expect(chromeStatus(recordOf({ verdict: { kind: "wont", reason: "no" } }), facts)).toBe("incompatible");
    expect(chromeStatus(recordOf(), { ...facts, failed: true })).toBe("error");
    expect(chromeStatus(recordOf({ grants: null }), facts)).toBe("needs-approval");
    expect(chromeStatus(recordOf({ pending: { manifestHash: "n", widened: ["tabs"], hosts: [] } }), facts)).toBe("paused");
    expect(chromeStatus(recordOf({ enabled: false }), facts)).toBe("off");
    expect(chromeStatus(recordOf(), { ...facts, enabledHere: false })).toBe("off");
    expect(chromeStatus(recordOf(), facts)).toBe("running");
    expect(chromeStatus(recordOf(), { ...facts, loadedHere: false })).toBe("idle");
  });

  it("runs only approved, on, unpaused, compatible records, in their Profiles", () => {
    expect(chromeRunsIn(recordOf(), "work")).toBe(true);
    expect(chromeRunsIn(recordOf(), "home")).toBe(false);
    expect(chromeRunsIn(recordOf({ profiles: "all" }), "home")).toBe(true);
    expect(chromeRunsIn(recordOf({ grants: null }), "work")).toBe(false);
    expect(chromeRunsIn(recordOf({ verdict: { kind: "wont", reason: "no" } }), "work")).toBe(false);
    expect(chromeRunsIn(recordOf({ pending: { manifestHash: "n", widened: [], hosts: ["https://x.example/*"] } }), "work")).toBe(false);
  });

  it("keeps a Chrome record's verdict across a restart, and gives a Pistachio one none", () => {
    const userData = mkdtempSync(join(tmpdir(), "pistachio-chrome-reg-"));
    const registry = new ExtensionRegistry(userData);
    registry.upsert(recordOf({ verdict: { kind: "partly", notes: ["Its keyboard shortcut isn't available yet."] } }));
    registry.upsert({ ...registry.fresh("dev.z.thing", "pistachio", { type: "dev", path: "/x" }), verdict: { kind: "works" } });
    const again = new ExtensionRegistry(userData);
    expect(again.get(STORE_ID)?.verdict).toEqual({ kind: "partly", notes: ["Its keyboard shortcut isn't available yet."] });
    expect(again.get("dev.z.thing")).not.toHaveProperty("verdict");
  });
});

describe("Chrome extensions in the host", () => {
  it("costs nothing with no Chrome extension: no libraries, no session touched", async () => {
    const { host, loadCompat, ses } = rig();
    host.start();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");
    host.tabAdded("tab-1", { id: 1, session: ses, isDestroyed: () => false, once: vi.fn(), on: vi.fn(), getURL: () => "" } as unknown as WebContents, "https://example.com/");
    expect(loadCompat).not.toHaveBeenCalled();
    expect(host.pendingInstall()).toBeNull();
  });

  it("refuses a folder that links out of itself, when added and at every load; a link inside is a file of the folder's", async () => {
    const outside = mkdtempSync(join(tmpdir(), "pistachio-chrome-outside-"));
    writeFileSync(join(outside, "secret.txt"), "the Mac's own");
    const linked = folderWith(MINI);
    symlinkSync(join(outside, "secret.txt"), join(linked, "linked.js"));
    expect(folderLinksOut(linked)).toBe("linked.js");
    const { host } = rig();
    host.start();
    await expect(host.loadUnpacked(linked)).rejects.toThrow(/links out of itself \(linked\.js\)/);
    // A link to nowhere could point anywhere tomorrow: refused the same.
    const dangling = folderWith(MINI);
    symlinkSync(join(dangling, "nowhere.js"), join(dangling, "gone.js"));
    expect(folderLinksOut(dangling)).toBe("gone.js");
    // A link inside: followed, as Electron follows it, and fine — each real directory once, so links to the folder
    // itself (a -> ., b -> .) are no maze.
    const inner = folderWith(MINI);
    writeFileSync(join(inner, "real.js"), "// fine");
    symlinkSync(join(inner, "real.js"), join(inner, "alias.js"));
    symlinkSync(".", join(inner, "a"));
    symlinkSync(".", join(inner, "b"));
    mkdirSync(join(inner, "sub"));
    symlinkSync("..", join(inner, "sub", "up"));
    const started = Date.now();
    expect(folderLinksOut(inner)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    // A folder approved earlier that gained a link: not loaded into the Profile, and its status says why.
    const path = folderWith(MINI);
    const id = chromeIdFor(path, MINI);
    const { host: later, registry: kept, compat, ses } = rig({ records: [recordOf({ id, source: { type: "unpacked", path }, profiles: ["work"] })] });
    symlinkSync(join(outside, "secret.txt"), join(path, "late.js"));
    later.start();
    await later.profileSession(ses, "work", "persist:pistachio-space-work");
    expect(compat.loadExtension).not.toHaveBeenCalled();
    expect(later.info(kept.get(id)!, "work").status).toBe("error");
  });

  it("runs installs one at a time: a second asked while the first downloads waits, then displaces the first's sheet and download", async () => {
    const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";
    const first = folderWith(MINI);
    const second = folderWith({ ...MINI, name: "Other Action" });
    const { host, store } = rig({ downloads: { [STORE_ID]: { path: first, manifest: MINI, version: "1.0.0" }, [OTHER]: { path: second, manifest: { ...MINI, name: "Other Action" }, version: "1.0.0" } } });
    host.start();
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const downloads = store.installById.getMockImplementation()!;
    store.installById.mockImplementation(async (cwsId: string, path: string) => {
      if (cwsId === STORE_ID) await slow;
      return downloads(cwsId, path);
    });
    const one = host.install(STORE_ID);
    const two = host.install(OTHER);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The second is not even asked of the store until the first is done.
    expect(store.installById).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([one, two]);
    expect(host.pendingInstall()?.cwsId).toBe(OTHER);
    expect(store.uninstallById).toHaveBeenCalledWith(STORE_ID, expect.any(String));
    expect(store.uninstallById).not.toHaveBeenCalledWith(OTHER, expect.any(String));
  });

  it("installs from the store by id: the downloaded manifest's sheet, approval records it and loads it in the Profile in front", async () => {
    const path = folderWith(MINI);
    const { host, registry, compat, store, ses } = rig({ downloads: { [STORE_ID]: { path, manifest: MINI, version: "1.0.0" } } });
    host.start();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");

    expect(await host.install(STORE_ID)).toEqual({ type: "verdict", verdict: { kind: "works" } });
    const pending = host.pendingInstall();
    expect(pending).toMatchObject({ cwsId: STORE_ID, name: "Mini Action", description: "A test extension.", verdict: { kind: "works" } });
    expect(pending?.iconUrl).toMatch(/^data:image\/png;base64,/);
    expect(pending?.sheet.can.map((line) => line.text)).toContain("Read and change pages on 127.0.0.1");
    expect(registry.get(STORE_ID)).toBeNull();

    await expect(host.approveInstall(STORE_ID, "not the sheet's")).rejects.toThrow("changed since this sheet was shown");
    await host.approveInstall(STORE_ID, pending!.sheet.manifestHash);
    const record = registry.get(STORE_ID)!;
    expect(record).toMatchObject({
      kind: "chrome",
      source: { type: "webstore", cwsId: STORE_ID, version: "1.0.0" },
      enabled: true,
      pinned: true,
      profiles: ["work"],
      pending: null,
      verdict: { kind: "works" },
      grants: { capabilities: ["storage", "contextMenus"], hosts: ["http://127.0.0.1/*"], manifestHash: pending!.sheet.manifestHash },
    });
    expect(host.pendingInstall()).toBeNull();
    expect(compat.attachSession).toHaveBeenCalledWith(ses, "work", "persist:pistachio-space-work");
    expect(compat.loadExtension).toHaveBeenCalledWith(ses, path);
    expect(store.uninstallById).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(host.info(record, "work")).toMatchObject({ status: "running", badge: "3", hasPanel: true, hasAction: true }));
    expect(host.info(record, "work").iconUrl).toMatch(/^crx:\/\/extension-icon\//);
    // In another Profile it is off, and shows the manifest's own icon.
    expect(host.info(record, "home")).toMatchObject({ status: "off", enabledHere: false });
    expect(host.info(record, "home").iconUrl).toMatch(/^data:/);
  });

  it("refuses a blocker with Shields' sentence and removes its download; Not now removes one waiting", async () => {
    const blocker = folderWith(BLOCKER);
    const mini = folderWith(MINI);
    const { host, registry, store } = rig({
      downloads: { [STORE_ID]: { path: blocker, manifest: BLOCKER, version: "2.0.0" }, ["ponmlkjihgfedcbaponmlkjihgfedcba"]: { path: mini, manifest: MINI, version: "1.0.0" } },
    });
    expect(await host.install(STORE_ID)).toEqual({ type: "verdict", verdict: { kind: "wont", reason: "Shields already blocks ads and trackers here.", alternative: "Shields" } });
    expect(store.uninstallById).toHaveBeenCalledWith(STORE_ID, expect.any(String));
    expect(host.pendingInstall()).toBeNull();
    expect(registry.get(STORE_ID)).toBeNull();

    await host.install("ponmlkjihgfedcbaponmlkjihgfedcba");
    expect(host.pendingInstall()?.cwsId).toBe("ponmlkjihgfedcbaponmlkjihgfedcba");
    await host.denyInstall("ponmlkjihgfedcbaponmlkjihgfedcba");
    expect(host.pendingInstall()).toBeNull();
    expect(store.uninstallById).toHaveBeenCalledWith("ponmlkjihgfedcbaponmlkjihgfedcba", expect.any(String));
    await expect(host.install("not an id")).rejects.toThrow("isn't a Chrome Web Store extension's id");
  });

  it("takes the curated verdict over the manifest's (measured beats inferred)", async () => {
    const path = folderWith({ ...MINI, name: "Dark Reader" });
    const { host } = rig({ downloads: { [DARK_READER]: { path, manifest: { ...MINI, name: "Dark Reader" }, version: "4.9.0" } } });
    const answer = await host.install(DARK_READER);
    expect(answer.type === "verdict" && answer.verdict.kind).toBe("partly");
  });

  it("loads an unpacked folder waiting on its sheet; approval turns it on in the Profile in front", async () => {
    const path = folderWith(MINI);
    const { host, registry, compat, ses } = rig();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");
    expect(await host.loadUnpacked(path)).toEqual({ type: "folder", path });
    const id = chromeIdFor(path, MINI);
    const waiting = registry.get(id)!;
    expect(waiting).toMatchObject({ kind: "chrome", source: { type: "unpacked", path }, enabled: false, grants: null, verdict: { kind: "works" } });
    const info = host.info(waiting, "work");
    expect(info).toMatchObject({ status: "needs-approval", name: "Mini Action", devPath: path });
    expect(info.pending?.manifestHash).toBe(chromeSheet(MINI).manifestHash);
    expect(compat.loadExtension).not.toHaveBeenCalled();

    await host.approve(id, chromeSheet(MINI).manifestHash);
    expect(registry.get(id)).toMatchObject({ enabled: true, profiles: ["work"], pending: null });
    expect(compat.loadExtension).toHaveBeenCalledWith(ses, path);

    // Off, then removed: out of the session, its storage cleared in every Profile.
    registry.update(id, { enabled: false });
    await host.sync();
    expect(compat.unload).toHaveBeenCalledWith(ses, id);
    await host.uninstall(id);
    expect(registry.get(id)).toBeNull();
    expect(ses.clearStorageData).toHaveBeenCalledWith({ origin: `chrome-extension://${id}` });
  });

  it("reads an unpacked folder afresh before it loads: one edited while off, or since its sheet, waits paused when it widened", async () => {
    const path = folderWith(MINI);
    const { host, registry, compat, ses } = rig();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");
    await host.loadUnpacked(path);
    const id = chromeIdFor(path, MINI);
    await host.approve(id, chromeSheet(MINI).manifestHash);
    expect(compat.loadExtension).toHaveBeenCalledTimes(1);
    // Off, then edited on disk to ask for `tabs`, then on again: the library would read the edited folder.
    registry.update(id, { enabled: false });
    await host.sync();
    writeFileSync(join(path, "manifest.json"), JSON.stringify({ ...MINI, permissions: ["storage", "contextMenus", "tabs"] }));
    registry.update(id, { enabled: true });
    await host.sync();
    expect(compat.loadExtension).toHaveBeenCalledTimes(1);
    expect(registry.get(id)).toMatchObject({ pending: { widened: ["tabs"], hosts: [] } });
    expect(host.info(registry.get(id)!, "work").status).toBe("paused");
    // Approved anew, it loads.
    await host.approve(id, chromeSheet({ ...MINI, permissions: ["storage", "contextMenus", "tabs"] }).manifestHash);
    expect(compat.loadExtension).toHaveBeenCalledTimes(2);
  });

  it("an update at launch that asks nothing new loads, its grant naming the new manifest", async () => {
    const same: ChromeManifest = { ...MINI, version: "1.0.1" };
    const newPath = folderWith(same);
    const record = recordOf({ grants: { capabilities: ["storage", "contextMenus"], hosts: ["http://127.0.0.1/*"], manifestHash: chromeSheet(MINI).manifestHash, at: 1 } });
    const { host, registry, compat, ses } = rig({
      records: [record],
      downloads: { [STORE_ID]: { path: newPath, manifest: same, version: "1.0.1" } },
      updates: [{ cwsId: STORE_ID, from: "1.0.0", to: "1.0.1", path: newPath, previousManifest: MINI, manifest: same }],
    });
    host.start();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");
    expect(registry.get(STORE_ID)).toMatchObject({ source: { version: "1.0.1" }, pending: null, grants: { manifestHash: chromeSheet(same).manifestHash } });
    expect(compat.loadExtension).toHaveBeenCalledWith(ses, newPath);
  });

  it("an update at launch that widens waits paused, unloaded", async () => {
    const widened: ChromeManifest = { ...MINI, version: "1.1.0", permissions: ["storage", "contextMenus", "tabs"] };
    const newPath = folderWith(widened);
    const record = recordOf({ grants: { capabilities: ["storage", "contextMenus"], hosts: ["http://127.0.0.1/*"], manifestHash: chromeSheet(MINI).manifestHash, at: 1 } });
    const { host, registry, compat, ses } = rig({
      records: [record],
      downloads: { [STORE_ID]: { path: newPath, manifest: widened, version: "1.1.0" } },
      updates: [{ cwsId: STORE_ID, from: "1.0.0", to: "1.1.0", path: newPath, previousManifest: MINI, manifest: widened }],
    });
    host.start();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");
    await host.sync();
    expect(registry.get(STORE_ID)).toMatchObject({ source: { type: "webstore", version: "1.1.0" }, pending: { widened: ["tabs"], hosts: [] } });
    expect(compat.loadExtension).not.toHaveBeenCalled();
    expect(host.info(registry.get(STORE_ID)!, "work").status).toBe("paused");
  });

  it("an unpacked folder that widened while Pistachio was closed waits paused at launch, unloaded", async () => {
    const path = folderWith(MINI);
    const id = chromeIdFor(path, MINI);
    const record = recordOf({ id, source: { type: "unpacked", path }, grants: { capabilities: ["storage", "contextMenus"], hosts: ["http://127.0.0.1/*"], manifestHash: chromeSheet(MINI).manifestHash, at: 1 } });
    // Edited while closed: it asks for `tabs` now.
    writeFileSync(join(path, "manifest.json"), JSON.stringify({ ...MINI, permissions: ["storage", "contextMenus", "tabs"] }));
    const { host, registry, compat, ses } = rig({ records: [record] });
    host.start();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");
    await host.sync();
    expect(registry.get(id)).toMatchObject({ pending: { widened: ["tabs"], hosts: [] } });
    expect(compat.loadExtension).not.toHaveBeenCalled();
    expect(host.info(registry.get(id)!, "work").status).toBe("paused");
  });

  it("an unpacked folder that changed without widening loads at launch, its grant naming the new manifest", async () => {
    const path = folderWith(MINI);
    const id = chromeIdFor(path, MINI);
    const record = recordOf({ id, source: { type: "unpacked", path }, grants: { capabilities: ["storage", "contextMenus"], hosts: ["http://127.0.0.1/*"], manifestHash: chromeSheet(MINI).manifestHash, at: 1 } });
    const same: ChromeManifest = { ...MINI, version: "1.0.1" };
    writeFileSync(join(path, "manifest.json"), JSON.stringify(same));
    const { host, registry, compat, ses } = rig({ records: [record] });
    host.start();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");
    expect(registry.get(id)).toMatchObject({ pending: null, grants: { manifestHash: chromeSheet(same).manifestHash, at: 1 } });
    expect(compat.loadExtension).toHaveBeenCalledWith(ses, path);
  });

  it("tells the library of the person's web pages alone, and follows a tab out of Pistachio's own surfaces and back", async () => {
    const path = folderWith(MINI);
    const { host, compat, ses } = rig({ records: [recordOf()], downloads: { [STORE_ID]: { path, manifest: MINI, version: "1.0.0" } } });
    host.start();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");
    // A tab made for notes (its view not yet loaded): no tab to the library.
    const notes = { id: 4, session: ses, isDestroyed: () => false, once: vi.fn(), on: vi.fn(), getURL: () => "" } as unknown as WebContents;
    host.tabAdded("tab-notes", notes, "pistachio://notes/");
    expect(compat.addTab).not.toHaveBeenCalledWith(ses, notes, expect.anything());
    const listener = (contents: WebContents, event: string) =>
      (contents.on as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([name]) => name === event)![1] as (...args: never[]) => void;
    // The person sends it to the web: a tab from the start of the load.
    (listener(notes, "did-start-navigation") as (details: unknown) => void)({ isMainFrame: true, isSameDocument: false, url: "https://example.org/" });
    expect(compat.addTab).toHaveBeenCalledWith(ses, notes, expect.anything());
    // A web tab, told of before its load; put in use before the load commits (its address still unknown), it stays told of.
    const web = { id: 5, session: ses, isDestroyed: () => false, once: vi.fn(), on: vi.fn(), getURL: () => "" } as unknown as WebContents;
    host.tabAdded("tab-web", web, "https://example.com/");
    expect(compat.addTab).toHaveBeenCalledWith(ses, web, expect.anything());
    host.tabSelected("tab-web", web);
    expect(compat.removeTab).not.toHaveBeenCalledWith(ses, web);
    // It goes to a terminal: no tab to the library (a subframe's or same-document navigation says nothing); back to the web, a tab again.
    (listener(web, "did-start-navigation") as (details: unknown) => void)({ isMainFrame: false, isSameDocument: false, url: "pistachio://terminal/abcdefabcdef" });
    expect(compat.removeTab).not.toHaveBeenCalledWith(ses, web);
    (listener(web, "did-navigate") as (event: unknown, url: string) => void)({}, "pistachio://terminal/abcdefabcdef");
    expect(compat.removeTab).toHaveBeenCalledWith(ses, web);
    (compat.addTab as ReturnType<typeof vi.fn>).mockClear();
    (listener(web, "did-navigate") as (event: unknown, url: string) => void)({}, "https://example.org/");
    expect(compat.addTab).toHaveBeenCalledWith(ses, web, expect.anything());
  });

  it("attaching to a Profile with tabs already open tells the library of the web pages alone, as they stand", async () => {
    const path = folderWith(MINI);
    const { host, compat, ses } = rig({ records: [recordOf()], downloads: { [STORE_ID]: { path, manifest: MINI, version: "1.0.0" } } });
    host.start();
    const page = (id: number) => ({ id, session: ses, isDestroyed: () => false, once: vi.fn(), on: vi.fn(), getURL: () => "" }) as unknown as WebContents;
    const listener = (contents: WebContents, event: string) =>
      (contents.on as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([name]) => name === event)![1] as (...args: never[]) => void;
    // Before any Chrome extension is on: a notes tab, a web tab, a tab made for the web that went to a terminal, and one made for notes that went to the web.
    const notes = page(1);
    host.tabAdded("tab-notes", notes, "pistachio://notes/");
    const web = page(2);
    host.tabAdded("tab-web", web, "https://example.com/");
    const terminal = page(3);
    host.tabAdded("tab-terminal", terminal, "https://example.com/");
    (listener(terminal, "did-navigate") as (event: unknown, url: string) => void)({}, "pistachio://terminal/abcdefabcdef");
    const left = page(4);
    host.tabAdded("tab-left", left, "pistachio://notes/");
    (listener(left, "did-start-navigation") as (details: unknown) => void)({ isMainFrame: true, isSameDocument: false, url: "https://example.org/" });
    expect(compat.addTab).not.toHaveBeenCalled();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");
    expect((compat.addTab as ReturnType<typeof vi.fn>).mock.calls.map(([, contents]) => (contents as WebContents).id).sort()).toEqual([2, 4]);
  });

  it("opens the popup at the icon, above it from its leading edge; a / command with no icon uses the last one", async () => {
    const path = folderWith(MINI);
    const { host, compat, ses, tab } = rig({ records: [recordOf()], downloads: { [STORE_ID]: { path, manifest: MINI, version: "1.0.0" } } });
    host.start();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");
    const contents = tab(7, "tab-1");
    host.tabSelected("tab-1", contents);
    expect(compat.selectTab).toHaveBeenCalledWith(ses, contents);
    const anchor = { x: 58, y: 860, width: 28, height: 28 };
    await host.activate(STORE_ID, "tab-1", anchor);
    expect(compat.activate).toHaveBeenLastCalledWith(ses, { extensionId: STORE_ID, tab: contents, anchorRect: anchor, alignment: POPUP_ALIGNMENT });
    await host.activate(STORE_ID, "tab-1", null);
    expect(compat.activate).toHaveBeenLastCalledWith(ses, expect.objectContaining({ anchorRect: anchor }));
    // Not on in this Profile: said, not run.
    await expect(host.activate("ponmlkjihgfedcbaponmlkjihgfedcba", null, null)).rejects.toThrow("no such extension");
    // No web page in use — none at all, or one of Pistachio's own pages, which is no tab to the library: the action
    // runs nowhere (the library would otherwise take its last web tab for the click).
    (compat.activate as ReturnType<typeof vi.fn>).mockClear();
    await expect(host.activate(STORE_ID, null, anchor)).rejects.toThrow(/works on a web page/);
    const notes = { id: 8, session: ses, isDestroyed: () => false, once: vi.fn(), on: vi.fn(), getURL: () => "pistachio://notes/" } as unknown as WebContents;
    host.tabAdded("tab-notes", notes, "pistachio://notes/");
    await expect(host.activate(STORE_ID, "tab-notes", anchor)).rejects.toThrow(/works on a web page/);
    expect(compat.activate).not.toHaveBeenCalled();
  });

  it("lets an extension open only web addresses in a tab, and send one only to the web", async () => {
    const path = folderWith(MINI);
    const { host, loadCompat, ses, tab } = rig({ records: [recordOf()], downloads: { [STORE_ID]: { path, manifest: MINI, version: "1.0.0" } } });
    host.start();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");
    const hooks = loadCompat.mock.calls[0]![0] as import("../src/main/extensions/chrome/compat").ChromeCompatHooks;
    await expect(hooks.createTab({ url: "chrome-extension://abc/options.html" }, "work")).rejects.toThrow("only web addresses");
    const contents = tab(9, "tab-9");
    host.tabAdded("tab-9", contents, "https://example.com/");
    await expect(hooks.navigateTab(contents, "pistachio://terminal/1")).rejects.toThrow("only to a web address");
    await expect(hooks.navigateTab(contents, "https://example.com/")).resolves.toBeUndefined();
    expect(await hooks.requestPermissions({ id: STORE_ID } as never, { permissions: [], origins: [] }, "work")).toBe(true);
  });

  it("grants a permissions.request within the approved sheet alone: an optional permission or host the sheet never showed is refused", async () => {
    const path = folderWith(MINI);
    const optional: ChromeManifest = { ...MINI, optional_permissions: ["cookies"], optional_host_permissions: ["<all_urls>"] };
    const { host, loadCompat, ses } = rig({ records: [recordOf()], downloads: { [STORE_ID]: { path, manifest: optional, version: "1.0.0" } } });
    host.start();
    await host.profileSession(ses, "work", "persist:pistachio-space-work");
    const hooks = loadCompat.mock.calls[0]![0] as import("../src/main/extensions/chrome/compat").ChromeCompatHooks;
    const extension = { id: STORE_ID, manifest: optional } as never;
    // What the sheet showed (MINI's grant): yes, a host under a pattern the grant covers included.
    expect(await hooks.requestPermissions(extension, { permissions: ["storage"], origins: ["http://127.0.0.1/*"] }, "work")).toBe(true);
    // Declared optional, never approved: no — cookies, every site, or one site beyond the grant.
    expect(await hooks.requestPermissions(extension, { permissions: ["cookies"], origins: [] }, "work")).toBe(false);
    expect(await hooks.requestPermissions(extension, { permissions: [], origins: ["<all_urls>"] }, "work")).toBe(false);
    expect(await hooks.requestPermissions(extension, { permissions: [], origins: ["https://github.com/*"] }, "work")).toBe(false);
    // An extension with no approval yet gets nothing.
    expect(await hooks.requestPermissions({ id: "ponmlkjihgfedcbaponmlkjihgfedcba" } as never, { permissions: [], origins: [] }, "work")).toBe(false);
  });
});
