/** A scope, a runtime and a browser of stand-ins, for the extension tests (no Electron). */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { validateManifest, type PistachioManifest } from "@pistachio/extension-api/manifest";
import { DataFiles } from "../src/main/extensions/data-files";
import { Ledger } from "../src/main/extensions/ledger";
import type { CallContext, ExtensionNotesHost, ExtensionRuntime } from "../src/main/extensions/methods";
import type { ExtensionRecord } from "../src/main/extensions/registry";
import { ExtensionScope, type ExtensionBrowserHost } from "../src/main/extensions/scope";
import { ExtensionStorage } from "../src/main/extensions/storage";

export const EXTENSION_ID = "dev.test.harness";

export function manifestOf(extra: Record<string, unknown> = {}): PistachioManifest {
  const result = validateManifest({ api: 1, id: EXTENSION_ID, name: "Harness", version: "1.0.0", ...extra });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.manifest;
}

export function recordOf(grants: { capabilities: string[]; hosts?: string[] } | null, extra: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: EXTENSION_ID,
    kind: "pistachio",
    source: { type: "dev", path: "/dev/harness" },
    enabled: true,
    profiles: "all",
    grants: grants === null ? null : { capabilities: grants.capabilities, hosts: grants.hosts ?? [], manifestHash: "hash", at: 0 },
    pending: null,
    pinned: true,
    order: 0,
    agentAllowed: false,
    installedAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

export function tabOf(id: string, url: string, profile = "profile-a", extra: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
  return {
    id,
    spaceId: profile,
    title: `Tab ${id}`,
    url,
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    kind: "human",
    runId: null,
    anchorId: null,
    lifecycle: "live",
    lastActiveAt: 0,
    unlisted: false,
    ...extra,
  };
}

export function fakeBrowser(tabs: BrowserTabInfo[]): ExtensionBrowserHost & { tabsList: BrowserTabInfo[] } {
  const groups = (profileId: string): TabGroupInfo[] => [
    { id: `space-${profileId}`, title: "Work", color: "blue", tabIds: tabs.filter((tab) => tab.spaceId === profileId).map((tab) => tab.id), origin: "manual", open: false, createdAt: 0 },
  ];
  return {
    tabsList: tabs,
    activeProfileId: () => "profile-a",
    profileIds: () => ["profile-a", "profile-b"],
    tabs: () => tabs,
    tab: (tabId) => tabs.find((tab) => tab.id === tabId) ?? null,
    activeTabId: () => tabs[0]?.id ?? null,
    spaces: groups,
    currentSpaceId: (profileId) => `space-${profileId}`,
    createTab: vi.fn(async () => "new-tab"),
    navigate: vi.fn(async () => undefined),
    showTab: vi.fn(async () => undefined),
    closeTab: vi.fn(async () => undefined),
    inspect: vi.fn(async (tabId: string) => ({ title: "Page", url: tabs.find((tab) => tab.id === tabId)?.url ?? "", text: "the page's words", controls: [] })),
    screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    desk: (_profileId, spaceId) => ({ spaceId, stage: { width: 100, height: 100 }, windows: [] }),
  };
}

export interface Harness {
  scope: ExtensionScope;
  runtime: ExtensionRuntime & {
    fetch: ReturnType<typeof vi.fn>;
    storageChanged: ReturnType<typeof vi.fn>;
    captureSources: ReturnType<typeof vi.fn>;
    captureArm: ReturnType<typeof vi.fn>;
    captureHold: ReturnType<typeof vi.fn>;
    inputSubscribe: ReturnType<typeof vi.fn>;
    agentAsk: ReturnType<typeof vi.fn>;
  };
  ledger: Ledger;
  ctx(context?: CallContext["context"]): CallContext;
  setNow(ms: number): void;
  notes: ExtensionNotesHost & { edit: ReturnType<typeof vi.fn> };
  browser: ReturnType<typeof fakeBrowser>;
  dataRoot: string;
}

export function harness(options: { manifest?: PistachioManifest; record?: ExtensionRecord; tabs?: BrowserTabInfo[]; stored?: Record<string, unknown> } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-ext-harness-"));
  const manifest = options.manifest ?? manifestOf();
  const record = options.record ?? recordOf(null);
  const browser = fakeBrowser(options.tabs ?? []);
  const ledger = new Ledger(join(dir, "ledger.ndjson"));
  let now = 1_000_000;
  const scope = new ExtensionScope(EXTENSION_ID, { record: () => record, manifest: () => manifest, browser: () => browser, ledger, now: () => now });
  const notes = {
    list: () => [{ id: "n1", title: "One", updatedAt: "2026-10-30T00:00:00.000Z" }],
    search: () => [],
    get: (id: string) => (id === "n1" ? { id: "n1", title: "One", markdown: "# One" } : null),
    create: () => ({ id: "n2" }),
    edit: vi.fn(),
  };
  const dataRoot = join(dir, "data");
  const runtime = {
    manifest: () => manifest,
    info: (ctx: CallContext) => ({ id: EXTENSION_ID, manifest: manifest as never, context: ctx.context, page: ctx.page, timeOrigin: 0 }),
    storage: new ExtensionStorage(join(dir, "storage.json")),
    data: new DataFiles(dataRoot),
    storageChanged: vi.fn(),
    storedSettings: () => (options.stored ?? {}) as never,
    sendMessage: vi.fn(async () => undefined),
    connect: vi.fn(async () => ({ portId: 1 })),
    keepAlive: vi.fn(() => 1),
    release: vi.fn(),
    done: vi.fn(),
    log: vi.fn(),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    openPage: vi.fn(async () => "page-tab"),
    toast: vi.fn(),
    setBadge: vi.fn(),
    setStatus: vi.fn(),
    preferredSize: vi.fn(),
    pick: vi.fn(async () => []),
    save: vi.fn(async () => null),
    owned: () => null,
    reveal: vi.fn(),
    startDrag: vi.fn(),
    clipboardWrite: vi.fn(),
    clipboardReadText: () => "clipboard",
    notify: vi.fn(),
    fetch: vi.fn(async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("hi") })),
    notes: () => notes,
    preventSleep: vi.fn(() => 1),
    releaseSleep: vi.fn(),
    subscribe: vi.fn(() => 7),
    unsubscribe: vi.fn(),
    captureSources: vi.fn(async (_ctx: CallContext, sources: unknown[]) => sources),
    captureArm: vi.fn(async () => ({ width: 1600, height: 1200 })),
    captureHold: vi.fn(() => 11),
    captureRelease: vi.fn(),
    inputSubscribe: vi.fn(() => 21),
    inputStop: vi.fn(),
    agentAsk: vi.fn(async () => undefined),
  };
  return {
    scope,
    runtime: runtime as unknown as Harness["runtime"],
    ledger,
    ctx: (context = "worker") => ({ extensionId: EXTENSION_ID, context, page: null, senderId: 1 }),
    setNow: (ms) => {
      now = ms;
    },
    notes,
    browser,
    dataRoot,
  };
}
