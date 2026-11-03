/**
 * EXT_METHODS (docs/extensions.md §4, "The wire"): main's one dispatch table
 * for `pistachio-ext:call`. Every method the API names has a row — a method in
 * `ExtMethodMap` with none does not compile — and every row says what it
 * needs (a capability, nothing, or a judgement of its arguments: a host, a
 * gesture grant), how its arguments are checked (a zod schema, the shapes of
 * `@pistachio/extension-api/src/api-types.ts`), and how it runs: through the
 * extension's `ExtensionScope` for anything of the browser's, and through its
 * `ExtensionRuntime` (the service) for the rest. A call is answered an
 * `ExtReply`; nothing thrown here crosses IPC.
 *
 * Order of a call: a capability the row names (before the arguments are
 * read, so a refusal never depends on them), the arguments, a judgement of
 * them (`needs` as a function, or `gate` after a capability), the method's
 * rate limit, then the run.
 */

import { z } from "zod";
import {
  ExtError,
  isExtEvent,
  isExtMethod,
  type ExtCaptureSource,
  type ExtContext,
  type ExtInputEventKind,
  type ExtErrorCode,
  type ExtEvent,
  type ExtMethod,
  type ExtMethodArgs,
  type ExtMethodResult,
  type ExtReply,
  type ExtRuntimeInfo,
  type ExtStatus,
  type ExtToast,
  type Json,
} from "@pistachio/extension-api";
import { EXT_ERROR_CODES } from "@pistachio/extension-api/wire";
import type { Capability } from "@pistachio/extension-api/capabilities";
import type { PistachioManifest } from "@pistachio/extension-api/manifest";
import { INPUT_EVENT_KINDS } from "./input";
import { ExtensionScope, permissionDenied } from "./scope";
import type { DataFiles } from "./data-files";
import { ledgerAddress } from "./ledger";
import { StorageQuotaError, type ExtensionStorage, type StorageChanges } from "./storage";

/** Who is calling: written by main when it made the view, never read from the message. */
export interface CallContext {
  extensionId: string;
  context: ExtContext;
  /** The page's declared name, for a page context. */
  page: string | null;
  /** The calling view's webContents id. */
  senderId: number;
}

/** The person's notes as an extension reaches them (main/note-store.ts, NoteToolHost's shape). */
export interface ExtensionNotesHost {
  list(): { id: string; title: string; updatedAt: string }[];
  search(query: string, limit: number): { id: string; title: string; updatedAt: string }[];
  get(id: string): { id: string; title: string; markdown: string } | null;
  create(input: { title: string; markdown: string }): { id: string };
  /** The agent's structural edit (`@pistachio/notes` applyNoteEdit), so a widget in the note is never flattened. */
  edit(id: string, edit: { mode: "replace" | "append" | "replace_section"; markdown: string; section?: string }): void;
}

/** Everything a row needs that is not the browser's: the service, per extension. */
export interface ExtensionRuntime {
  manifest(): PistachioManifest;
  info(ctx: CallContext): ExtRuntimeInfo;
  storage: ExtensionStorage;
  data: DataFiles;
  storageChanged(changes: StorageChanges): void;
  /** The person's values for the declared settings (not yet merged with defaults), secrets opened. */
  storedSettings(): Record<string, Json>;
  sendMessage(ctx: CallContext, message: Json): Promise<Json | undefined>;
  connect(ctx: CallContext, name: string, target: "worker" | { page: string }): Promise<{ portId: number }>;
  keepAlive(ctx: CallContext, reason: string): number;
  release(holdId: number): void;
  done(ctx: CallContext, id: number, value: Json | undefined, error: string | undefined): void;
  log(ctx: CallContext, level: "info" | "warn" | "error", message: string, data?: Json): void;
  openPanel(ctx: CallContext): void;
  closePanel(): void;
  openPage(ctx: CallContext, name: string, query: string | undefined, place: { profileId: string; space: string }): Promise<string>;
  toast(toast: ExtToast): void;
  setBadge(text: string | null): void;
  setStatus(status: ExtStatus | null): void;
  preferredSize(ctx: CallContext, width: number, height: number): void;
  pick(options: { accept?: string[]; multiple?: boolean }): Promise<string[]>;
  save(bytes: Uint8Array | null, dataPath: string | null, suggestedName: string, folder: "downloads" | "screenshots" | "ask"): Promise<string | null>;
  /** A path this extension may hand the Finder or the clipboard: a data file, or one it saved. Null otherwise. */
  owned(path: string): string | null;
  reveal(path: string): void;
  startDrag(ctx: CallContext, path: string): void;
  clipboardWrite(content: { text?: string; html?: string; imagePng?: Uint8Array; filePath?: string }): void;
  clipboardReadText(): string;
  notify(notification: { title: string; body?: string; action?: { id: string; title: string } }): void;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array | string | null }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  notes(): ExtensionNotesHost | null;
  preventSleep(ctx: CallContext): number;
  releaseSleep(holdId: number): void;
  subscribe(ctx: CallContext, event: ExtEvent, filter: Json | undefined): number;
  unsubscribe(ctx: CallContext, subscriptionId: number): void;
  /** The desk's capturable windows with their stills; from the panel, each is granted while it stays open. */
  captureSources(ctx: CallContext, sources: ExtCaptureSource[]): Promise<ExtCaptureSource[]>;
  /** Arm the worker's session for one getDisplayMedia of the tab (woken and held meanwhile); answers the size to ask for. */
  captureArm(ctx: CallContext, tabId: string, options: { audio: boolean; scale: 1 | 2; frameRate: 30 | 60 }): Promise<{ width: number; height: number }>;
  captureHold(ctx: CallContext, tabId: string): number;
  captureRelease(holdId: number): void;
  inputSubscribe(ctx: CallContext, tabId: string, kinds: ExtInputEventKind[] | null): number;
  inputStop(ctx: CallContext, subscriptionId: number): void;
  /** Fill a space's Bar with the prompt for the person to send (agent.ask). */
  agentAsk(prompt: string, place: { profileId: string; space: string }): Promise<void>;
}

/** What a row asks before it runs: a capability, nothing, or a judgement (null passes; a sentence refuses). */
export type Needs<A> = Capability | null | ((scope: ExtensionScope, args: A, ctx: CallContext) => string | null);

export interface MethodSpec<M extends ExtMethod> {
  needs: Needs<ExtMethodArgs<M>>;
  /** A judgement of the arguments after the capability `needs` names (a sentence refuses; a throw keeps its code). */
  gate?: (scope: ExtensionScope, args: ExtMethodArgs<M>, ctx: CallContext) => string | null;
  input: z.ZodType;
  run(scope: ExtensionScope, ctx: CallContext, args: ExtMethodArgs<M>, runtime: ExtensionRuntime): Promise<ExtMethodResult<M>> | ExtMethodResult<M>;
}

export type MethodTable = { [M in ExtMethod]: MethodSpec<M> };

/* ------------------------------- schemas ------------------------------- */

const json = z.json();
const empty = z.union([z.object({}).strict(), z.undefined(), z.null()]).transform(() => ({}));
const id = z.string().min(1).max(200);
const int = z.number().int().nonnegative();
// (Titles up to 60 characters: an action may name what it acts on.)
const action = z.object({ id: z.string().min(1).max(64), title: z.string().min(1).max(60) });

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]" || ArrayBuffer.isView(value);
}

const bytes = z.custom<ArrayBuffer>(isBinary, "bytes (an ArrayBuffer or a typed array)");

/** The bytes of an ArrayBuffer or a typed array, as a Uint8Array over the same memory. */
export function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}

/** A standalone ArrayBuffer holding these bytes (what goes back over the wire). */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

/* --------------------------- settings' values --------------------------- */

/** A declared setting's value in force: the person's, else its default; secrets only where asked for. */
export function settingValues(manifest: PistachioManifest, stored: Record<string, Json>, includeSecrets: boolean): Record<string, Json> {
  const values: Record<string, Json> = {};
  for (const setting of manifest.settings ?? []) {
    if (setting.type === "secret" && !includeSecrets) continue;
    const value = stored[setting.key];
    if (value !== undefined) values[setting.key] = value;
    else if (setting.type !== "secret" && setting.default !== undefined) values[setting.key] = setting.default;
  }
  return values;
}

/* --------------------------------- events -------------------------------- */

/** What subscribing to each event needs. */
export const EVENT_NEEDS: Record<ExtEvent, Capability | null> = {
  "storage.changed": null,
  "settings.changed": null,
  "tabs.created": "tabs:read",
  "tabs.updated": "tabs:read",
  "tabs.removed": "tabs:read",
  "tabs.activated": "tabs:read",
  "spaces.currentChanged": "tabs:read",
  "desk.changed": "desk",
  "input.event": "input:events",
  "capture.ended": "capture:tab",
  "runtime.message": null,
  "runtime.connect": null,
};

/** capture.tab arms the worker's own session: a page or the panel has none to arm (and no stream would reach it). */
function workerOnly(method: string, ctx: CallContext): void {
  if (ctx.context !== "worker") throw new ExtError("INVALID_ARGUMENT", `${method} works in the worker: send the worker a message (runtime.sendMessage) and capture there`);
}

const needsDataFiles = (scope: ExtensionScope): string | null => (scope.can("files:data") ? null : `this needs "files:data" in pistachio.json → permissions`);

/* --------------------------------- table --------------------------------- */

export const EXT_METHODS = {
  /* ------------------------------ runtime ------------------------------ */
  "runtime.info": { needs: null, input: empty, run: (_scope, ctx, _args, runtime) => runtime.info(ctx) },
  "runtime.sendMessage": {
    needs: null,
    input: z.object({ message: json }),
    run: (_scope, ctx, args, runtime) => runtime.sendMessage(ctx, args.message),
  },
  "runtime.connect": {
    needs: null,
    input: z.object({ name: z.string().max(100), target: z.union([z.literal("worker"), z.object({ page: z.string().min(1).max(40) })]) }),
    run: (_scope, ctx, args, runtime) => runtime.connect(ctx, args.name, args.target),
  },
  "runtime.keepAlive": {
    needs: null,
    input: z.object({ reason: z.string().min(1).max(200) }),
    run: (_scope, ctx, args, runtime) => ({ holdId: runtime.keepAlive(ctx, args.reason) }),
  },
  "runtime.release": {
    needs: null,
    input: z.object({ holdId: int }),
    run: (_scope, _ctx, args, runtime) => {
      runtime.release(args.holdId);
      return null;
    },
  },
  "runtime.done": {
    needs: null,
    input: z.object({ id: int, v: json.optional(), error: z.string().max(4000).optional() }),
    run: (_scope, ctx, args, runtime) => {
      runtime.done(ctx, args.id, args.v, args.error);
      return null;
    },
  },
  "runtime.log": {
    needs: null,
    input: z.object({ level: z.enum(["info", "warn", "error"]), message: z.string().max(20_000), data: json.optional() }),
    run: (_scope, ctx, args, runtime) => {
      runtime.log(ctx, args.level, args.message, args.data);
      return null;
    },
  },

  /* ------------------------------ storage ------------------------------ */
  "storage.get": {
    needs: null,
    input: z.object({ keys: z.array(z.string().max(512)).max(1000).nullable() }),
    run: (_scope, _ctx, args, runtime) => runtime.storage.get(args.keys),
  },
  "storage.set": {
    needs: null,
    input: z.object({ items: z.record(z.string().max(512), json) }),
    run: (_scope, _ctx, args, runtime) => {
      let changes: StorageChanges;
      try {
        changes = runtime.storage.set(args.items);
      } catch (error) {
        if (error instanceof StorageQuotaError) throw new ExtError("INVALID_ARGUMENT", error.message);
        throw error;
      }
      if (Object.keys(changes).length > 0) runtime.storageChanged(changes);
      return null;
    },
  },
  "storage.remove": {
    needs: null,
    input: z.object({ keys: z.array(z.string().max(512)).max(1000) }),
    run: (_scope, _ctx, args, runtime) => {
      const changes = runtime.storage.remove(args.keys);
      if (Object.keys(changes).length > 0) runtime.storageChanged(changes);
      return null;
    },
  },

  /* ------------------------------ settings ------------------------------ */
  "settings.get": {
    needs: null,
    input: z.object({ key: z.string().max(64).nullable() }),
    run: (_scope, ctx, args, runtime) => {
      const manifest = runtime.manifest();
      const declared = (manifest.settings ?? []).find((setting) => setting.key === args.key);
      if (args.key !== null && declared === undefined) throw new ExtError("NOT_FOUND", `no setting "${args.key}" is declared in pistachio.json → settings`);
      if (declared?.type === "secret" && ctx.context !== "worker") throw new ExtError("PERMISSION_DENIED", `"${args.key}" is a secret: read it in the worker`);
      const values = settingValues(manifest, runtime.storedSettings(), ctx.context === "worker");
      if (args.key === null) return values;
      return Object.hasOwn(values, args.key) ? { [args.key]: values[args.key]! } : {};
    },
  },

  /* --------------------------------- ui --------------------------------- */
  "ui.openPanel": {
    needs: null,
    input: empty,
    run: (_scope, ctx, _args, runtime) => {
      if (runtime.manifest().panel === undefined) throw new ExtError("NOT_FOUND", 'this extension has no panel: add "panel": { "file": "panel.html" } to pistachio.json');
      runtime.openPanel(ctx);
      return null;
    },
  },
  "ui.closePanel": {
    needs: null,
    input: empty,
    run: (_scope, _ctx, _args, runtime) => {
      runtime.closePanel();
      return null;
    },
  },
  "ui.openPage": {
    needs: null,
    input: z.object({ name: z.string().min(1).max(40), query: z.string().max(2000).optional(), space: z.string().max(200).optional() }),
    run: async (scope, ctx, args, runtime) => {
      if (runtime.manifest().pages?.[args.name] === undefined) throw new ExtError("NOT_FOUND", `no page "${args.name}" is declared in pistachio.json → pages`);
      return { tabId: await runtime.openPage(ctx, args.name, args.query, scope.pagePlace(args.space)) };
    },
  },
  "ui.toast": {
    needs: null,
    input: z.object({ title: z.string().min(1).max(120), body: z.string().max(400).optional(), action: action.optional() }),
    run: (_scope, _ctx, args, runtime) => {
      runtime.toast(args);
      return null;
    },
  },
  "ui.setBadge": {
    needs: null,
    input: z.object({ text: z.string().max(4).nullable() }),
    run: (_scope, _ctx, args, runtime) => {
      runtime.setBadge(args.text === "" ? null : args.text);
      return null;
    },
  },
  "ui.setStatus": {
    needs: null,
    input: z.object({ status: z.object({ text: z.string().min(1).max(80), actions: z.array(action).max(3).optional() }).nullable() }),
    run: (_scope, _ctx, args, runtime) => {
      runtime.setStatus(args.status);
      return null;
    },
  },
  "ui.preferredSize": {
    needs: null,
    input: z.object({ width: z.number().nonnegative().max(10_000), height: z.number().nonnegative().max(10_000) }),
    run: (_scope, ctx, args, runtime) => {
      runtime.preferredSize(ctx, args.width, args.height);
      return null;
    },
  },

  /* ------------------------- tabs, spaces, desk ------------------------- */
  "tabs.query": {
    needs: "tabs:read",
    input: z.object({ spaceId: z.string().max(200).optional(), active: z.boolean().optional(), url: z.string().max(500).optional() }),
    run: (scope, _ctx, args) => scope.tabs.query(args),
  },
  "tabs.get": { needs: "tabs:read", input: z.object({ id }), run: (scope, _ctx, args) => scope.tabs.get(args.id) },
  "tabs.create": {
    needs: "tabs:write",
    input: z.object({ url: z.string().min(1).max(8192), space: z.string().max(200).optional(), show: z.boolean().optional() }),
    run: (scope, _ctx, args) => scope.tabs.create(args),
  },
  "tabs.navigate": {
    needs: "tabs:write",
    input: z.object({ id, url: z.string().min(1).max(8192) }),
    run: async (scope, _ctx, args) => {
      await scope.tabs.navigate(args.id, args.url);
      return null;
    },
  },
  "tabs.show": {
    needs: "tabs:write",
    input: z.object({ id }),
    run: async (scope, _ctx, args) => {
      await scope.tabs.show(args.id);
      return null;
    },
  },
  "tabs.close": {
    needs: "tabs:write",
    input: z.object({ id }),
    run: async (scope, _ctx, args) => {
      await scope.tabs.close(args.id);
      return null;
    },
  },
  "spaces.list": { needs: "tabs:read", input: empty, run: (scope) => scope.spaces.list() },
  "spaces.current": { needs: "tabs:read", input: empty, run: (scope) => scope.spaces.current() },
  "desk.state": {
    needs: "desk",
    input: z.object({ spaceId: z.string().max(200).optional() }),
    run: (scope, _ctx, args) => scope.desk.state(args.spaceId),
  },
  "pages.read": {
    needs: (scope, args) => scope.pageReadRefusal(args.tabId),
    input: z.object({ tabId: id, format: z.enum(["text", "markdown", "elements"]) }),
    run: async (scope, _ctx, args) => ({ text: await scope.pages.read(args.tabId, args.format) }),
  },
  "pages.screenshot": {
    needs: (scope, args) => scope.pageReadRefusal(args.tabId),
    input: z.object({ tabId: id }),
    run: async (scope, _ctx, args) => ({ png: toArrayBuffer(await scope.pages.screenshot(args.tabId)) }),
  },

  /* --------------------------- capture, input --------------------------- */
  "capture.sources": {
    needs: "capture:tab",
    input: empty,
    run: (scope, ctx, _args, runtime) => runtime.captureSources(ctx, scope.captureSources()),
  },
  "capture.arm": {
    needs: "capture:tab",
    input: z.object({ tabId: id, audio: z.boolean(), scale: z.union([z.literal(1), z.literal(2)]), frameRate: z.union([z.literal(30), z.literal(60)]) }),
    gate: (scope, args, ctx) => {
      workerOnly("capture.tab", ctx);
      return scope.captureRefusal("capture.tab", args.tabId);
    },
    run: (scope, ctx, args, runtime) => {
      scope.visibleTab(args.tabId);
      return runtime.captureArm(ctx, args.tabId, { audio: args.audio, scale: args.scale, frameRate: args.frameRate });
    },
  },
  "capture.hold": {
    needs: "capture:tab",
    input: z.object({ tabId: id }),
    gate: (scope, args) => scope.captureRefusal("capture.hold", args.tabId),
    run: (scope, ctx, args, runtime) => {
      scope.visibleTab(args.tabId);
      return { holdId: runtime.captureHold(ctx, args.tabId) };
    },
  },
  "capture.release": {
    needs: "capture:tab",
    input: z.object({ holdId: int }),
    run: (_scope, _ctx, args, runtime) => {
      runtime.captureRelease(args.holdId);
      return null;
    },
  },
  "input.subscribe": {
    needs: "input:events",
    input: z.object({ tabId: id, kinds: z.array(z.enum(INPUT_EVENT_KINDS as [ExtInputEventKind, ...ExtInputEventKind[]])).max(INPUT_EVENT_KINDS.length).nullable() }),
    gate: (scope, args) => scope.captureRefusal("input.subscribe", args.tabId),
    run: (scope, ctx, args, runtime) => {
      scope.visibleTab(args.tabId);
      return { subscriptionId: runtime.inputSubscribe(ctx, args.tabId, args.kinds) };
    },
  },
  "input.stop": {
    needs: "input:events",
    input: z.object({ subscriptionId: int }),
    run: (_scope, ctx, args, runtime) => {
      runtime.inputStop(ctx, args.subscriptionId);
      return null;
    },
  },

  /* -------------------------------- files -------------------------------- */
  "files.pick": {
    needs: null,
    input: z.object({ accept: z.array(z.string().max(100)).max(50).optional(), multiple: z.boolean().optional() }),
    run: async (_scope, _ctx, args, runtime) => ({ paths: await runtime.pick(args) }),
  },
  "files.save": {
    needs: (scope, args) => (args.dataPath === null ? null : needsDataFiles(scope)),
    input: z.object({
      data: bytes.nullable(),
      dataPath: z.string().max(1024).nullable(),
      suggestedName: z.string().min(1).max(255),
      folder: z.enum(["downloads", "screenshots", "ask"]),
    }),
    run: async (_scope, _ctx, args, runtime) => {
      if ((args.data === null) === (args.dataPath === null)) throw new ExtError("INVALID_ARGUMENT", "files.save takes bytes or a data path, one of them");
      const dataPath = args.dataPath === null ? null : runtime.data.existing(args.dataPath);
      return { path: await runtime.save(args.data === null ? null : toBytes(args.data), dataPath, args.suggestedName, args.folder) };
    },
  },
  "files.reveal": {
    needs: null,
    input: z.object({ path: z.string().min(1).max(4096) }),
    run: (_scope, _ctx, args, runtime) => {
      const owned = runtime.owned(args.path);
      if (owned === null) throw new ExtError("PERMISSION_DENIED", "files.reveal shows a file this extension saved or keeps in its data folder");
      runtime.reveal(owned);
      return null;
    },
  },
  "files.data.open": {
    needs: "files:data",
    input: z.object({ path: z.string().min(1).max(1024), append: z.boolean() }),
    run: async (_scope, ctx, args, runtime) => ({ handle: await runtime.data.open(args.path, args.append, ctx.senderId) }),
  },
  "files.data.write": {
    needs: "files:data",
    input: z.object({ handle: int.nullable(), path: z.string().min(1).max(1024).nullable(), chunk: bytes }),
    run: async (_scope, _ctx, args, runtime) => {
      await runtime.data.write(args.handle, args.path, toBytes(args.chunk));
      return null;
    },
  },
  "files.data.close": {
    needs: "files:data",
    input: z.object({ handle: int, abort: z.boolean() }),
    run: async (_scope, _ctx, args, runtime) => {
      await runtime.data.close(args.handle, args.abort);
      return null;
    },
  },
  "files.data.read": {
    needs: "files:data",
    input: z.object({ path: z.string().min(1).max(1024), start: int.optional(), end: int.optional() }),
    run: async (_scope, _ctx, args, runtime) => ({ bytes: toArrayBuffer(await runtime.data.read(args.path, args.start, args.end)) }),
  },
  "files.data.list": {
    needs: "files:data",
    input: z.object({ dir: z.string().max(1024) }),
    run: (_scope, _ctx, args, runtime) => runtime.data.list(args.dir),
  },
  "files.data.remove": {
    needs: "files:data",
    input: z.object({ path: z.string().min(1).max(1024) }),
    run: async (_scope, _ctx, args, runtime) => {
      await runtime.data.remove(args.path);
      return null;
    },
  },
  "files.data.freeSpace": { needs: "files:data", input: empty, run: (_scope, _ctx, _args, runtime) => ({ bytes: runtime.data.freeSpace() }) },
  "files.startDrag": {
    needs: "files:data",
    input: z.object({ dataPath: z.string().min(1).max(1024) }),
    run: (_scope, ctx, args, runtime) => {
      runtime.startDrag(ctx, runtime.data.existing(args.dataPath));
      return null;
    },
  },

  /* ---------------------- clipboard, notifications ---------------------- */
  "clipboard.write": {
    needs: "clipboard:write",
    input: z.object({ text: z.string().max(10_000_000).optional(), html: z.string().max(10_000_000).optional(), imagePng: bytes.optional(), filePath: z.string().max(4096).optional() }),
    run: (_scope, _ctx, args, runtime) => {
      const filePath = args.filePath === undefined ? undefined : runtime.owned(args.filePath);
      if (filePath === null) throw new ExtError("PERMISSION_DENIED", "clipboard.write takes a file this extension saved or keeps in its data folder");
      runtime.clipboardWrite({
        ...(args.text === undefined ? {} : { text: args.text }),
        ...(args.html === undefined ? {} : { html: args.html }),
        ...(args.imagePng === undefined ? {} : { imagePng: toBytes(args.imagePng) }),
        ...(filePath === undefined ? {} : { filePath }),
      });
      return null;
    },
  },
  "clipboard.readText": {
    needs: "clipboard:read",
    input: empty,
    run: (scope, _ctx, _args, runtime) => {
      if (!scope.recentGesture()) throw new ExtError("PERMISSION_DENIED", "clipboard.readText works within five seconds of the person using the extension (a click, a key, a command)");
      return { text: runtime.clipboardReadText() };
    },
  },
  "notifications.show": {
    needs: "notifications",
    input: z.object({ title: z.string().min(1).max(120), body: z.string().max(400).optional(), action: action.optional() }),
    run: (_scope, _ctx, args, runtime) => {
      runtime.notify(args);
      return null;
    },
  },

  /* --------------------------------- net --------------------------------- */
  "net.fetch": {
    needs: (scope, args) => {
      if (!/^https?:\/\//i.test(args.url)) return "net.fetch fetches http(s) addresses";
      if (scope.hostAllowed(args.url)) return null;
      const { host } = ledgerAddress(args.url);
      return `net.fetch needs a host matching ${host === "" ? args.url : host} in pistachio.json → hosts (like "https://${host || "api.example.com"}/*"), approved by the person`;
    },
    input: z.object({
      url: z.string().min(1).max(8192),
      method: z.string().regex(/^[A-Za-z]{1,16}$/).optional(),
      headers: z.record(z.string().max(256), z.string().max(16_384)).optional(),
      body: z.union([bytes, z.string().max(50_000_000)]).optional(),
    }),
    run: async (scope, _ctx, args, runtime) => {
      const method = (args.method ?? "GET").toUpperCase();
      const body = args.body === undefined ? null : typeof args.body === "string" ? args.body : toBytes(args.body);
      const { host, path } = ledgerAddress(args.url);
      const sent = body === null ? 0 : typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
      let response: { status: number; headers: Record<string, string>; body: Uint8Array };
      try {
        response = await runtime.fetch(args.url, { method, headers: args.headers ?? {}, body });
      } catch (error) {
        scope.ledger.record({ at: Date.now(), method, host, path, status: null, sent, received: 0, ...(error instanceof ExtError && error.code === "PERMISSION_DENIED" ? { refused: "redirect" } : {}) });
        // (A redirect to a host it was not granted is the runtime's refusal, said as such.)
        if (error instanceof ExtError) throw error;
        throw new ExtError("UNAVAILABLE", `net.fetch could not reach ${host}: ${error instanceof Error ? error.message : String(error)}`);
      }
      scope.ledger.record({ at: Date.now(), method, host, path, status: response.status, sent, received: response.body.byteLength });
      return { status: response.status, headers: response.headers, body: Buffer.from(response.body).toString("base64") };
    },
  },

  /* -------------------------------- notes -------------------------------- */
  "notes.list": {
    needs: "notes:read",
    input: empty,
    run: (_scope, _ctx, _args, runtime) => requireNotes(runtime).list().map(noteSummary),
  },
  "notes.search": {
    needs: "notes:read",
    input: z.object({ query: z.string().max(300), limit: z.number().int().min(1).max(50).optional() }),
    run: (_scope, _ctx, args, runtime) => requireNotes(runtime).search(args.query, args.limit ?? 8).map(noteSummary),
  },
  "notes.read": {
    needs: "notes:read",
    input: z.object({ id }),
    run: (_scope, _ctx, args, runtime) => {
      const note = requireNotes(runtime).get(args.id);
      if (note === null) throw new ExtError("NOT_FOUND", `no note ${args.id}; notes.list shows what exists`);
      return note;
    },
  },
  "notes.create": {
    needs: "notes:write",
    input: z.object({ title: z.string().max(200), markdown: z.string().max(1_000_000) }),
    run: (_scope, _ctx, args, runtime) => requireNotes(runtime).create(args),
  },
  "notes.update": {
    needs: "notes:write",
    input: z
      .object({ id, mode: z.enum(["replace", "append", "section"]), markdown: z.string().max(1_000_000), section: z.string().max(200).optional() })
      .refine((value) => value.mode !== "section" || (value.section !== undefined && value.section.trim() !== ""), { message: 'mode "section" names the heading to replace in `section`' }),
    run: (_scope, _ctx, args, runtime) => {
      const notes = requireNotes(runtime);
      if (notes.get(args.id) === null) throw new ExtError("NOT_FOUND", `no note ${args.id}; notes.list shows what exists`);
      try {
        notes.edit(args.id, {
          mode: args.mode === "section" ? "replace_section" : args.mode,
          markdown: args.markdown,
          ...(args.section === undefined ? {} : { section: args.section }),
        });
      } catch (error) {
        throw new ExtError("INVALID_ARGUMENT", error instanceof Error ? error.message : String(error));
      }
      return null;
    },
  },

  /* -------------------------------- agent -------------------------------- */
  "agent.ask": {
    needs: "agent:ask",
    input: z.object({ prompt: z.string().min(1).max(8000), spaceId: z.string().max(200).optional() }),
    run: async (scope, _ctx, args, runtime) => {
      if (args.prompt.trim() === "") throw new ExtError("INVALID_ARGUMENT", "agent.ask takes a prompt with words in it");
      await runtime.agentAsk(args.prompt, scope.pagePlace(args.spaceId));
      return null;
    },
  },

  /* -------------------------------- power -------------------------------- */
  "power.preventSleep": { needs: "power", input: empty, run: (_scope, ctx, _args, runtime) => ({ holdId: runtime.preventSleep(ctx) }) },
  "power.release": {
    needs: "power",
    input: z.object({ holdId: int }),
    run: (_scope, _ctx, args, runtime) => {
      runtime.releaseSleep(args.holdId);
      return null;
    },
  },

  /* -------------------------------- events -------------------------------- */
  "events.on": {
    needs: (scope, args) => {
      if (!isExtEvent(args.event)) return null; // INVALID_ARGUMENT, said by the run.
      const capability = EVENT_NEEDS[args.event];
      return capability === null || scope.can(capability) ? null : `subscribing to ${args.event} needs "${capability}" in pistachio.json → permissions`;
    },
    input: z.object({ event: z.string().max(64), filter: json.optional() }),
    run: (_scope, ctx, args, runtime) => {
      if (!isExtEvent(args.event)) throw new ExtError("INVALID_ARGUMENT", `no event "${args.event}"`);
      return { subscriptionId: runtime.subscribe(ctx, args.event, args.filter) };
    },
  },
  "events.off": {
    needs: null,
    input: z.object({ subscriptionId: int }),
    run: (_scope, ctx, args, runtime) => {
      runtime.unsubscribe(ctx, args.subscriptionId);
      return null;
    },
  },
} satisfies MethodTable;

function requireNotes(runtime: ExtensionRuntime): ExtensionNotesHost {
  const notes = runtime.notes();
  if (notes === null) throw new ExtError("UNAVAILABLE", "notes are not ready");
  return notes;
}

function noteSummary(note: { id: string; title: string; updatedAt: string }): { id: string; title: string; updatedAt: number } {
  const at = Date.parse(note.updatedAt);
  return { id: note.id, title: note.title, updatedAt: Number.isFinite(at) ? at : 0 };
}

/* ------------------------------ dispatching ------------------------------ */

function isCode(value: unknown): value is ExtErrorCode {
  return typeof value === "string" && (EXT_ERROR_CODES as readonly string[]).includes(value);
}

/** An ExtReply for anything thrown: an ExtError keeps its code; anything else is UNAVAILABLE with its message. */
export function replyOf(error: unknown): ExtReply {
  if (error instanceof ExtError || (error instanceof Error && isCode((error as { code?: unknown }).code))) {
    return { ok: false, code: (error as ExtError).code, message: error.message };
  }
  return { ok: false, code: "UNAVAILABLE", message: error instanceof Error ? error.message : String(error) };
}

function issueOf(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "the arguments are not what it takes";
  const path = issue.path.map((part) => String(part)).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/** Run one call: needs, arguments, judgement, limit, run. Never throws. */
export async function dispatch(method: unknown, args: unknown, scope: ExtensionScope, ctx: CallContext, runtime: ExtensionRuntime, table: MethodTable = EXT_METHODS): Promise<ExtReply> {
  try {
    if (!isExtMethod(method)) throw new ExtError("INVALID_ARGUMENT", `no method "${String(method)}" in the Pistachio API`);
    const spec = table[method] as MethodSpec<ExtMethod>;
    if (typeof spec.needs === "string" && !scope.can(spec.needs)) throw permissionDenied(method, spec.needs);
    const parsed = spec.input.safeParse(args === undefined || args === null ? {} : args);
    if (!parsed.success) throw new ExtError("INVALID_ARGUMENT", `${method}: ${issueOf(parsed.error)}`);
    const input = parsed.data as ExtMethodArgs<ExtMethod>;
    const judge = typeof spec.needs === "function" ? spec.needs : spec.gate;
    if (judge !== undefined) {
      const refusal = (judge as (scope: ExtensionScope, args: unknown, ctx: CallContext) => string | null)(scope, input, ctx);
      if (refusal !== null) {
        if (method === "net.fetch") {
          const { host, path } = ledgerAddress((input as ExtMethodArgs<"net.fetch">).url);
          scope.ledger.record({ at: Date.now(), method: ((input as ExtMethodArgs<"net.fetch">).method ?? "GET").toUpperCase(), host, path, status: null, sent: 0, received: 0, refused: "host" });
        }
        throw new ExtError("PERMISSION_DENIED", refusal);
      }
    }
    if (!scope.take(method)) throw new ExtError("RATE_LIMITED", `${method} is limited to a number of calls a minute: wait a moment and try again`);
    const value = await spec.run(scope, ctx, input, runtime);
    return { ok: true, v: value };
  } catch (error) {
    return replyOf(error);
  }
}
