/**
 * Extensions and the agent, main's side (docs/extensions.md §6.2 "Agent tools"
 * and "Approving", §8; src/main/extensions/agent.ts and the service's agent
 * section): which declared tools a turn may have, one tool call through the
 * service to a worker and back (the real runtime, `pistachio.agent.onToolCall`,
 * over a stand-in for the worker's view), the author turn's draft folders and
 * everything their tools refuse, and an approved folder the author turn writes
 * to landing paused. Electron is faked: a view's contents is an object whose
 * `send` reaches the runtime, and whose calls come back through `service.call`.
 */

import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPistachio, type PistachioWire } from "@pistachio/extension-api/runtime";
import type { ExtEventMessage } from "@pistachio/extension-api/wire";
import type { ExtensionInfo } from "@pistachio/shell-contracts/extensions";
import { extensionToolName } from "@pistachio/agent-runtime";
import { agentToolSpecs, callAgentTool, DraftFolders, parseAuthorMarker, type AgentExtensionView } from "../src/main/extensions/agent";
import { ExtensionScope } from "../src/main/extensions/scope";
import { Ledger, type LedgerLine } from "../src/main/extensions/ledger";
import { EXTENSION_ID, manifestOf, recordOf } from "./extensions-harness";

/* ------------------------------ a fake Electron ------------------------------ */

interface FakeContents {
  id: number;
  mainFrame: { url: string };
  listener: ((message: ExtEventMessage) => void) | null;
  destroyed: boolean;
  isDestroyed(): boolean;
  on(): FakeContents;
  once(): FakeContents;
  setWindowOpenHandler(): void;
  loadURL(url: string): Promise<void>;
  send(channel: string, message: ExtEventMessage): void;
  reload(): void;
  close(): void;
}

const fake = vi.hoisted(() => ({
  nextId: 100,
  /** What a worker's page does once loaded: the test's stand-in for its `worker.js`. */
  boot: null as ((contents: FakeContents) => void) | null,
  /** What the service asked `app` to hear. */
  appListeners: [] as [string, (...args: never[]) => void][],
}));

vi.mock("electron", () => {
  const session = {
    protocol: { isProtocolHandled: () => false, handle: () => undefined, unhandle: () => undefined },
    webRequest: { onBeforeRequest: () => undefined },
    setProxy: vi.fn(async () => undefined),
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    setDisplayMediaRequestHandler: () => undefined,
    on: () => undefined,
    clearStorageData: async () => undefined,
    clearCache: async () => undefined,
  };
  class WebContentsView {
    readonly webContents: FakeContents;
    constructor() {
      const contents: FakeContents = {
        id: fake.nextId++,
        mainFrame: { url: "" },
        listener: null,
        destroyed: false,
        isDestroyed: () => contents.destroyed,
        on: () => contents,
        once: () => contents,
        setWindowOpenHandler: () => undefined,
        loadURL: async (url: string) => {
          contents.mainFrame.url = url;
          fake.boot?.(contents);
        },
        send: (_channel: string, message: ExtEventMessage) => contents.listener?.(message),
        reload: () => undefined,
        close: () => {
          contents.destroyed = true;
        },
      };
      this.webContents = contents;
    }
    setBounds(): void {}
  }
  class BaseWindow {
    excludedFromShownWindowsMenu = false;
    contentView = { addChildView: () => undefined };
    destroy(): void {}
    isDestroyed(): boolean {
      return false;
    }
  }
  return {
    app: { getPath: () => tmpdir(), on: (event: string, listener: (...args: never[]) => void) => fake.appListeners.push([event, listener]) },
    clipboard: {},
    dialog: {},
    MessageChannelMain: class {},
    nativeImage: {},
    Notification: class {
      static isSupported(): boolean {
        return false;
      }
    },
    powerSaveBlocker: { start: () => 0, stop: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false },
    session: { fromPartition: () => session, defaultSession: session },
    shell: {},
    BaseWindow,
    WebContentsView,
  };
});

// (Imported after the mock: the service and its views are Electron's.)
const { ExtensionService, SEALED_PROXY } = await import("../src/main/extensions/service");
const { session: mockedSession } = await import("electron");
type Service = InstanceType<typeof ExtensionService>;

const REPO = resolve(__dirname, "..", "..", "..");
const services: Service[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  fake.boot = null;
  fake.appListeners.length = 0;
});

function makeService(): { service: Service; devFolder: string; userData: string; settings: { developerMode: boolean; devFolder: string | null } } {
  const root = mkdtempSync(join(tmpdir(), "pistachio-ext-agent-"));
  const userData = join(root, "userData");
  const devFolder = join(root, "Extensions");
  mkdirSync(userData, { recursive: true });
  const settings = { developerMode: false, devFolder: devFolder as string | null };
  const service = new ExtensionService({
    userDataDir: userData,
    homeDir: root,
    isPackaged: false,
    // (The API's folder — AGENTS.md — is found beside the app's, as in development.)
    appPath: join(REPO, "apps", "desktop"),
    resourcesPath: root,
    preload: "/nowhere/extension.cjs",
    settings: () => settings,
    setSettings: (patch) => Object.assign(settings, patch),
    onSettingsChange: () => () => undefined,
    notes: () => null,
    screenshotFolder: async () => root,
  });
  services.push(service);
  // A worker's page runs the real runtime over a wire whose calls come back through the service, as its preload's would.
  fake.boot = (contents) => {
    const event = { sender: contents, senderFrame: contents.mainFrame };
    const wire: PistachioWire = {
      call: (method, args) => service.call(event as never, method, args),
      onEvent: (fn) => {
        contents.listener = fn;
        return () => {
          contents.listener = null;
        };
      },
      log: (level, message, data) => void service.call(event as never, "runtime.log", { level, message, ...(data === undefined ? {} : { data }) }),
    };
    const pistachio = buildPistachio({ install: false, wire });
    if (pistachio === null) throw new Error("no runtime");
    // The worker's code (worker.js of the fixture below).
    pistachio.agent.onToolCall("word_count", async (input: { text: string }, ctx) => {
      ctx.progress("Counting");
      if (input.text === "boom") throw new Error("the text went boom");
      return { words: input.text.trim().split(/\s+/).length, runId: ctx.runId };
    });
  };
  return { service, devFolder, userData, settings };
}

const WORD_COUNTER = {
  api: 1,
  id: "dev.local.word-counter",
  name: "Word counter",
  version: "0.1.0",
  permissions: ["agent:tools"],
  worker: { type: "web", main: "worker.js" },
  tools: [{ name: "word_count", description: "Count the words in a text.", effect: "read", input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
};

function infoOf(service: Service, id: string): ExtensionInfo | undefined {
  return service.snapshot().extensions.find((extension) => extension.id === id);
}

async function approve(service: Service, id: string): Promise<void> {
  const info = infoOf(service, id);
  if (info?.pending === null || info?.pending === undefined) throw new Error(`${id} waits on nothing`);
  await service.request({ type: "approve", id, manifestHash: info.pending.manifestHash });
}

/* ------------------------------ which tools a turn has ------------------------------ */

function viewOf(options: { grants?: string[] | null; agentAllowed?: boolean; profiles?: "all" | string[]; runnable?: boolean; tools?: boolean } = {}): AgentExtensionView {
  const manifest = manifestOf(
    options.tools === false
      ? { permissions: ["agent:tools"] }
      : { permissions: ["agent:tools"], worker: { type: "web", main: "worker.js" }, tools: [{ name: "hello", description: "Say hello", input: { type: "object" }, effect: "read" }] },
  );
  const record = recordOf(options.grants === null ? null : { capabilities: options.grants ?? ["agent:tools"] }, { agentAllowed: options.agentAllowed ?? true, profiles: options.profiles ?? "all" });
  const scope = new ExtensionScope(EXTENSION_ID, { record: () => record, manifest: () => manifest, browser: () => null, ledger: new Ledger(join(tmpdir(), "unused-ledger.ndjson")) });
  return {
    id: EXTENSION_ID,
    manifest,
    runnable: options.runnable ?? true,
    agentAllowed: record.agentAllowed,
    can: (capability) => scope.can(capability),
    onIn: (profileId) => scope.onIn(profileId),
  };
}

describe("the tools a turn may have", () => {
  it("are an extension's that runs, is on in the run's Profile, holds agent:tools and was left Agent can use it", () => {
    expect(agentToolSpecs([viewOf()], "profile-a")).toEqual([
      { extensionId: EXTENSION_ID, extensionName: "Harness", name: "hello", description: "Say hello", input: { type: "object" }, effect: "read" },
    ]);
    // Another Profile's.
    expect(agentToolSpecs([viewOf({ profiles: ["profile-b"] })], "profile-a")).toEqual([]);
    expect(agentToolSpecs([viewOf({ profiles: ["profile-b"] })], "profile-b")).toHaveLength(1);
    // agent:tools asked for but not granted.
    expect(agentToolSpecs([viewOf({ grants: ["notifications"] })], "profile-a")).toEqual([]);
    // The person turned Agent can use it off.
    expect(agentToolSpecs([viewOf({ agentAllowed: false })], "profile-a")).toEqual([]);
    // Off, paused or waiting.
    expect(agentToolSpecs([viewOf({ runnable: false })], "profile-a")).toEqual([]);
    expect(agentToolSpecs([viewOf({ tools: false })], "profile-a")).toEqual([]);
  });

  it("refuse a call the person has since turned off, and write every input to the ledger first", async () => {
    const lines: LedgerLine[] = [];
    let allowed = true;
    const invoke = vi.fn(async () => ({ greeting: "hi" }));
    const deps = {
      find: () => ({ ...viewOf(), agentAllowed: allowed }),
      invoke,
      ledger: (_id: string, line: LedgerLine) => lines.push(line),
      now: () => 1_000,
    };
    const call = { runId: "run-1", spaceId: "space-1", profileId: "profile-a", signal: new AbortController().signal };
    await expect(callAgentTool(deps, EXTENSION_ID, "hello", { name: "Ada" }, call)).resolves.toEqual({ greeting: "hi" });
    expect(invoke).toHaveBeenCalledWith(EXTENSION_ID, "hello", { input: { name: "Ada" }, runId: "run-1", spaceId: "space-1" }, "profile-a");
    expect(lines).toEqual([{ at: 1_000, method: "TOOL", host: "agent", path: "/hello", status: null, sent: 14, received: 0, tool: { name: "hello", runId: "run-1", input: '{"name":"Ada"}' } }]);
    await expect(callAgentTool(deps, EXTENSION_ID, "goodbye", {}, call)).rejects.toThrow('NOT_FOUND: Harness declares no tool "goodbye"');
    allowed = false;
    await expect(callAgentTool(deps, EXTENSION_ID, "hello", {}, call)).rejects.toThrow('PERMISSION_DENIED: the person turned off "Agent can use it" for Harness');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------ one call, through the worker ------------------------------ */

describe("a tool call through the service", () => {
  it("reaches the worker's onToolCall and comes back: its answer, its progress, its ledger line", async () => {
    const { service, userData } = makeService();
    const folder = mkdtempSync(join(tmpdir(), "pistachio-ext-tool-"));
    writeFileSync(join(folder, "pistachio.json"), JSON.stringify(WORD_COUNTER));
    writeFileSync(join(folder, "worker.js"), "// the test's fake worker runs instead\n");
    await service.request({ type: "loadFolder", path: folder });
    // Waiting on the person: no tool yet.
    expect(infoOf(service, WORD_COUNTER.id)?.status).toBe("needs-approval");
    expect(service.agentTools("profile-a")).toEqual([]);
    await approve(service, WORD_COUNTER.id);
    const tools = service.agentTools("profile-a");
    expect(tools.map((tool) => [tool.extensionName, tool.name])).toEqual([["Word counter", "word_count"]]);
    expect(extensionToolName(tools[0]!.extensionId, tools[0]!.name)).toMatch(/^x_[0-9a-f]{6}_word_count$/);

    const progress = vi.fn();
    const signal = new AbortController().signal;
    const answer = await service.callTool(WORD_COUNTER.id, "word_count", { text: "one two three" }, { runId: "run-7", spaceId: "space-1", profileId: "profile-a", signal, progress });
    expect(answer).toEqual({ words: 3, runId: "run-7" });
    expect(progress).toHaveBeenCalledWith("Counting");
    const ledger = readFileSync(join(userData, "ExtensionData", WORD_COUNTER.id, "ledger.ndjson"), "utf8");
    expect(ledger).toContain('"tool":{"name":"word_count","runId":"run-7","input":"{\\"text\\":\\"one two three\\"}"}');

    // A handler that throws is a failed step with its sentence.
    await expect(service.callTool(WORD_COUNTER.id, "word_count", { text: "boom" }, { runId: "run-7", spaceId: null, profileId: "profile-a", signal })).rejects.toThrow("the text went boom");

    // The person turns Agent can use it off: gone from the next turn, refused mid-turn.
    await service.request({ type: "setAgentAllowed", id: WORD_COUNTER.id, allowed: false });
    expect(service.agentTools("profile-a")).toEqual([]);
    await expect(service.callTool(WORD_COUNTER.id, "word_count", { text: "x" }, { runId: "run-7", spaceId: null, profileId: "profile-a", signal })).rejects.toThrow("PERMISSION_DENIED");
  });

  it("refuses a secret setting on a Mac whose keychain it cannot use (this test's), rather than writing it in the clear", async () => {
    const { service, userData } = makeService();
    const folder = mkdtempSync(join(tmpdir(), "pistachio-ext-secret-"));
    writeFileSync(join(folder, "pistachio.json"), JSON.stringify({ ...WORD_COUNTER, settings: [{ key: "token", title: "API token", type: "secret" }] }));
    writeFileSync(join(folder, "worker.js"), "// the test's fake worker runs instead\n");
    await service.request({ type: "loadFolder", path: folder });
    await approve(service, WORD_COUNTER.id);
    await expect(service.request({ type: "setSetting", id: WORD_COUNTER.id, key: "token", value: "hunter2" })).rejects.toThrow(/keychain/);
    for (const name of readdirSync(userData, { recursive: true }) as string[]) {
      const full = join(userData, name);
      if (name.endsWith(".json") && statSync(full).isFile()) expect(readFileSync(full, "utf8")).not.toContain("hunter2");
    }
    // Clearing needs no keychain.
    await expect(service.request({ type: "setSetting", id: WORD_COUNTER.id, key: "token", value: null })).resolves.toMatchObject({ type: "ok" });
  });

  it("seals the extension's partition as it is made: a black-hole proxy, loopback included, and proxied UDP only on each view of it", async () => {
    const { service } = makeService();
    const ses = mockedSession.fromPartition("any");
    (ses.setProxy as unknown as ReturnType<typeof vi.fn>).mockClear();
    const folder = mkdtempSync(join(tmpdir(), "pistachio-ext-seal-"));
    writeFileSync(join(folder, "pistachio.json"), JSON.stringify(WORD_COUNTER));
    writeFileSync(join(folder, "worker.js"), "// the test's fake worker runs instead\n");
    await service.request({ type: "loadFolder", path: folder });
    await approve(service, WORD_COUNTER.id);
    // The partition is made (and sealed) as the extension comes on, before any view of it: the proxy is set with it.
    expect(ses.setProxy).toHaveBeenCalledWith(SEALED_PROXY);
    await service.callTool(WORD_COUNTER.id, "word_count", { text: "one" }, { runId: "run-8", spaceId: null, profileId: "profile-a", signal: new AbortController().signal });
    expect(SEALED_PROXY).toEqual({ mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:1", proxyBypassRules: "<-loopback>" });
    // Every view made on it — by whoever — runs WebRTC over proxied UDP alone; a view of another session is left alone.
    const created = fake.appListeners.filter(([event]) => event === "web-contents-created").map(([, listener]) => listener);
    expect(created.length).toBeGreaterThan(0);
    const sealed = { isDestroyed: () => false, session: ses, setWebRTCIPHandlingPolicy: vi.fn() };
    const other = { isDestroyed: () => false, session: { other: true }, setWebRTCIPHandlingPolicy: vi.fn() };
    for (const listener of created) (listener as (event: unknown, contents: unknown) => void)({}, sealed);
    for (const listener of created) (listener as (event: unknown, contents: unknown) => void)({}, other);
    expect(sealed.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith("disable_non_proxied_udp");
    expect(other.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled();
  });
});

/* ------------------------------ the author turn's reach ------------------------------ */

function draftOf(options: { beforeWrite?: (folder: string) => void } = {}) {
  const folder = join(mkdtempSync(join(tmpdir(), "pistachio-ext-draft-")), "word-counter");
  mkdirSync(folder);
  const drafts = new DraftFolders({ settleMs: 0, ...(options.beforeWrite === undefined ? {} : { beforeWrite: options.beforeWrite }) });
  const { slug, token } = drafts.add(folder);
  return { drafts, folder, slug, token };
}

describe("the author turn's draft folder", () => {
  it("is the turn's that carries the token the Bar was handed, once", async () => {
    const { drafts, slug, token } = draftOf();
    expect(slug).toBe("word-counter");
    await expect(drafts.write(slug, "worker.js", "x")).rejects.toThrow("is not a draft folder this turn may write");
    expect(drafts.claim(slug, "0".repeat(32))).toBeNull();
    expect(drafts.claim("other", token)).toBeNull();
    expect(drafts.claim(slug, token)).toMatchObject({ slug });
    expect(drafts.claim(slug, token)).toBeNull();
  });

  it("reads the Bar's marker, and only a well-formed one at the head", () => {
    const token = "0123456789abcdef0123456789abcdef";
    expect(parseAuthorMarker(`[pistachio:extension-author slug=word-counter token=${token}]\nBuild a Pistachio extension that counts words.`)).toEqual({
      slug: "word-counter",
      token,
      rest: "Build a Pistachio extension that counts words.",
    });
    expect(parseAuthorMarker(`Please: [pistachio:extension-author slug=word-counter token=${token}]`)).toBeNull();
    expect(parseAuthorMarker(`[pistachio:extension-author slug=../x token=${token}]`)).toBeNull();
    expect(parseAuthorMarker("[pistachio:extension-author slug=word-counter token=short]")).toBeNull();
  });

  it("writes files inside it, and refuses .., absolute paths, .pistachio/, symlinks, big files and <all_urls>", async () => {
    const before = vi.fn();
    const { drafts, folder, slug, token } = draftOf({ beforeWrite: before });
    drafts.claim(slug, token);
    await expect(drafts.write(slug, "pistachio.json", JSON.stringify(WORD_COUNTER))).resolves.toEqual({ path: "pistachio.json", bytes: JSON.stringify(WORD_COUNTER).length });
    await drafts.write(slug, "src/./count.js", "export const count = 1;\n");
    expect(readFileSync(join(folder, "src", "count.js"), "utf8")).toBe("export const count = 1;\n");
    expect(before).toHaveBeenCalledWith(folder);

    await expect(drafts.write(slug, "../escape.js", "x")).rejects.toThrow("climbs out");
    await expect(drafts.write(slug, "src/../../escape.js", "x")).rejects.toThrow("climbs out");
    await expect(drafts.write(slug, "/etc/hosts", "x")).rejects.toThrow("not relative");
    await expect(drafts.write(slug, "~/x.js", "x")).rejects.toThrow("not relative");
    await expect(drafts.write(slug, ".pistachio/status.json", "{}")).rejects.toThrow(".pistachio/ is Pistachio's own");
    await expect(drafts.write(slug, ".PISTACHIO/status.json", "{}")).rejects.toThrow(".pistachio/ is Pistachio's own");
    // What the watcher ignores would never reload: refused too.
    await expect(drafts.write(slug, "src/.env", "x")).rejects.toThrow("dotfiles");
    await expect(drafts.write(slug, "node_modules/lib/index.js", "x")).rejects.toThrow("node_modules is ignored");
    await expect(drafts.write(slug, "big.js", "x".repeat(256 * 1024 + 1))).rejects.toThrow("at most 256 KB");
    await expect(drafts.write(slug, "pistachio.json", JSON.stringify({ ...WORD_COUNTER, hosts: ["<all_urls>"] }))).rejects.toThrow('may not ask for "<all_urls>"');
    // (The Mac's file system is case-insensitive: PISTACHIO.JSON would replace the manifest.)
    await expect(drafts.write(slug, "PISTACHIO.JSON", JSON.stringify({ ...WORD_COUNTER, hosts: ["<all_urls>"] }))).rejects.toThrow('may not ask for "<all_urls>"');
    // Every site under another spelling is the same ask.
    await expect(drafts.write(slug, "pistachio.json", JSON.stringify({ ...WORD_COUNTER, hosts: ["https://api.example.com/*", "*://*/*"] }))).rejects.toThrow('may not ask for "<all_urls>"');
    // A link someone put in the folder is never written or read through.
    const outside = mkdtempSync(join(tmpdir(), "pistachio-ext-outside-"));
    symlinkSync(outside, join(folder, "out"));
    symlinkSync(join(outside, "target.js"), join(folder, "linked.js"));
    await expect(drafts.write(slug, "out/x.js", "x")).rejects.toThrow("symbolic link");
    await expect(drafts.write(slug, "linked.js", "x")).rejects.toThrow("symbolic link");
    await expect(drafts.read(slug, "out/x.js")).rejects.toThrow("symbolic link");

    // Reading: a file, or the listing without .pistachio/ and links.
    mkdirSync(join(folder, ".pistachio"));
    writeFileSync(join(folder, ".pistachio", "status.json"), JSON.stringify({ state: "needs-approval", manifestErrors: [], runtimeErrors: [] }));
    await expect(drafts.read(slug, "src/count.js")).resolves.toEqual({ path: "src/count.js", text: "export const count = 1;\n" });
    const listing = await drafts.read(slug, null);
    expect(listing.path).toBeNull();
    expect("files" in listing ? listing.files.map((file) => file.path) : []).toEqual(["pistachio.json", "src/count.js"]);
    await expect(drafts.read(slug, ".pistachio/status.json")).rejects.toThrow(".pistachio/ is Pistachio's own");
    expect(JSON.parse(await drafts.status(slug))).toMatchObject({ state: "needs-approval" });
  });
});

describe("an author turn in the service", () => {
  it("drafts a folder that shows only once it loads, and an approved one it writes to lands paused", async () => {
    const { service, devFolder } = makeService();
    const made = await service.request({ type: "draftFolder", name: "word counter" });
    expect(made).toMatchObject({ type: "folder", path: join(devFolder, "word-counter"), author: { slug: "word-counter" } });
    if (made.type !== "folder" || made.author === undefined) throw new Error("no draft");
    expect(service.authorGuide()).toContain("# Writing a Pistachio extension");
    const claim = service.claimDraft(made.author.slug, made.author.token);
    expect(claim).toEqual({ slug: "word-counter", folder: made.path });
    const host = service.authorHost;

    // Half written — a manifest naming a worker not there yet — it is no extension: the status file says what is missing.
    await host.write("word-counter", "pistachio.json", JSON.stringify(WORD_COUNTER, null, 2));
    // (The status file is the watcher's, written once the folder has been read: waited for, not read at once.)
    const half = await vi.waitFor(
      async () => {
        const status = JSON.parse(await host.status("word-counter")) as { state: string; manifestErrors?: { message: string }[] };
        expect(status.manifestErrors?.[0]?.message).toContain('"worker.js" is named in pistachio.json but is not a file');
        return status;
      },
      { timeout: 5_000 },
    );
    expect(half.state).toBeDefined();
    expect(infoOf(service, WORD_COUNTER.id)).toBeUndefined();

    // Whole: waiting on the person, never on.
    await host.write("word-counter", "worker.js", 'pistachio.agent.onToolCall("word_count", ({ text }) => ({ words: text.split(/\\s+/).length }));\n');
    await vi.waitFor(() => expect(infoOf(service, WORD_COUNTER.id)?.status).toBe("needs-approval"), { timeout: 5_000 });
    const loaded = JSON.parse(await host.status("word-counter")) as { state: string; manifestErrors: unknown[] };
    expect(loaded).toMatchObject({ state: "needs-approval", manifestErrors: [] });
    expect(service.agentTools("profile-a")).toEqual([]);

    // Not while the author turn is still writing it: the Ledge's icon shimmers, the sheet waits.
    service.setDrafting(made.path, true);
    expect(infoOf(service, WORD_COUNTER.id)?.drafting).toBe(true);
    await expect(approve(service, WORD_COUNTER.id)).rejects.toThrow("Pistachio is still writing it");
    service.setDrafting(made.path, false);
    expect(infoOf(service, WORD_COUNTER.id)?.drafting).toBeUndefined();
    // Approved (the turn waiting on the person's answer, say), it runs; the turn goes on and writes to it again:
    // paused, "Pistachio changed it", until approved again.
    await approve(service, WORD_COUNTER.id);
    expect(infoOf(service, WORD_COUNTER.id)?.status).not.toBe("paused");
    expect(service.agentTools("profile-a")).toHaveLength(1);
    await host.write("word-counter", "worker.js", 'pistachio.agent.onToolCall("word_count", () => ({ words: 0 }));\n');
    // Before the reload has read it, the old sheet approves nothing.
    await expect(approve(service, WORD_COUNTER.id)).rejects.toThrow("changed since this sheet was shown");
    const changed = infoOf(service, WORD_COUNTER.id);
    expect(changed?.status).toBe("paused");
    expect(changed?.pending?.changedByAgent).toBe(true);
    expect(service.agentTools("profile-a")).toEqual([]);
    // The watcher's reload of the same folder keeps it paused: a narrower or equal manifest is no way round.
    await new Promise((done) => setTimeout(done, 700));
    expect(infoOf(service, WORD_COUNTER.id)?.status).toBe("paused");
    expect(infoOf(service, WORD_COUNTER.id)?.pending?.changedByAgent).toBe(true);
    await approve(service, WORD_COUNTER.id);
    expect(infoOf(service, WORD_COUNTER.id)?.pending).toBeNull();
    expect(service.agentTools("profile-a")).toHaveLength(1);
  });
});
