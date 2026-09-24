/**
 * The shell socket (docs/web-browser-design.md §5): one WebSocket carrying an
 * RPC envelope over the `ShellApi` method names, the snapshot channels the
 * preload carries today, per-pane screencast frames, and input.
 *
 * THIS IS THE PROTOCOL, in the same spirit as `@pistachio/live-view`: the web
 * client, the host on the worker, and anything that ever relays between them
 * encode, decode and validate through the schemas here, and nobody
 * re-implements a parse. A frame shape that drifts between the two ends fails
 * silently — a dropped field is a dead button or a black pane, never an
 * exception — so the decoders answer `null` for anything unusable rather than
 * throwing, and a socket never dies of one bad frame.
 *
 * The method and channel names are not written out here: they come from
 * `SHELL_METHOD_NAMES` and `SHELL_EVENT_CHANNELS` in `./ipc.ts`, which the
 * compiler holds to the `ShellApi` interface itself.
 */

import { mirrorClientMessageSchema, mirrorServerMessageSchema, PANE_RENDERERS } from "@pistachio/dom-mirror/protocol";
import { liveFrameSchema, liveKeyEventSchema, liveMouseEventSchema } from "@pistachio/live-view";
import { z } from "zod";
import {
  SHELL_EVENT_CHANNELS,
  SHELL_METHOD_NAMES,
  type ShellEventMember,
  type ShellMethodName,
} from "./ipc.js";
import type { PageContextMenuParams } from "./page-context-menu.js";

/** The channel of an `on*` member of `ShellApi`, as `{t:'event'}` carries it. */
export type ShellEventChannelName = (typeof SHELL_EVENT_CHANNELS)[number]["channel"];

/** Which `on*` member a channel belongs to, for a transport that maps generically. */
export function shellEventMemberOf(channel: string): ShellEventMember | null {
  return SHELL_EVENT_CHANNELS.find((entry) => entry.channel === channel)?.member ?? null;
}


/* ------------------------------ StreamShellApi ---------------------------- */

/**
 * The web-only half of the surface (docs/web-browser-design.md §11).
 *
 * `ShellApi` is what a shell can ask of ANY host, and the desktop's
 * `PistachioApi` is exactly it plus `NativeSurfaceApi` — so a capability that
 * exists only because the page is a streamed pane in somebody's browser
 * cannot go in either without making the desktop's preload lie. Uploading a
 * file the person picked in THEIR browser, pasting from THEIR clipboard,
 * fetching a download over HTTP, or being told where the pointer was when
 * they right-clicked a pixel: none of those is a thing Electron main is ever
 * asked, because on the desktop Chromium does them itself.
 *
 * So they live here, beside the socket that carries them, and the socket's
 * `call.method` and `event.channel` are the union of both surfaces. A host
 * implements `ShellApi & StreamShellApi`; a client that has one is a
 * `StreamShellApi` too. The lists below are held to the interface by the same
 * exhaustiveness trick `ipc.ts` uses, so a member can never be added without
 * the transport learning to carry it.
 */

/** One file the person chose, as the pane hands it back. */
export interface StreamFile {
  name: string;
  /** MIME type as the person's browser reported it; "" when it could not say. */
  type: string;
  /** The bytes, base64. Every file of one request together is capped (§11). */
  base64: string;
}

/** Total bytes one `provideFiles` may carry, before base64 expansion. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** A page asked for files; the pane opens a native `<input type=file>` for it. */
export interface StreamFileRequest {
  requestId: string;
  tabId: string;
  multiple: boolean;
  /** The `accept` attribute, split — empty when the page accepts anything. */
  accept: string[];
}

/** The page put text on the clipboard; the pane mirrors it into the person's. */
export interface StreamClipboardCopy {
  tabId: string;
  text: string;
  /**
   * What the chrome says once the text is in the clipboard. Set when the
   * shell asked for the copy (⌘⇧C), whose result is otherwise invisible;
   * absent for a page's own ⌘C, which says nothing, as on the desktop.
   */
  notice?: string;
}

/**
 * What the pointer was over when the person right-clicked a streamed pane.
 * It is the same shape `page-context-menu`'s pure builder takes, reported by
 * the tab's init script — page-owned strings, so the host bounds them before
 * it forwards them.
 */
export type StreamContextTarget = PageContextMenuParams;

export interface StreamContextMenuEvent {
  tabId: string;
  /** Where in the pane's own CSS box, so the shell can place the menu. */
  x: number;
  y: number;
  target: StreamContextTarget;
}

/** A position to emulate for a site the person granted geolocation to. */
export interface StreamGeolocation {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export interface StreamShellApi {
  // ── Uploads ────────────────────────────────────────────────────────────
  /** A page opened a file picker; the pane answers with `provideFiles`. */
  onFileRequest(listener: (request: StreamFileRequest) => void): () => void;
  /** Hand the chosen bytes to the waiting `filechooser`; ≤ MAX_UPLOAD_BYTES in all. */
  provideFiles(requestId: string, files: StreamFile[]): Promise<void>;
  /** The person dismissed the picker. */
  cancelFileRequest(requestId: string): Promise<void>;
  // ── Clipboard ─────────────────────────────────────────────────────────
  /** A page copied or cut; the pane writes it with `navigator.clipboard`. */
  onClipboardCopy(listener: (copy: StreamClipboardCopy) => void): () => void;
  /** Type the person's clipboard into the focused field (`Input.insertText`). */
  pasteText(tabId: string, text: string): Promise<void>;
  // ── Downloads ─────────────────────────────────────────────────────────
  /**
   * A one-use, viewer-bound, 60-second URL for a finished download. The pane
   * opens it in a browser tab of its own; the bytes never travel the socket.
   */
  downloadUrl(downloadId: string): Promise<{ url: string }>;
  /** Print the tab to PDF; the result appears as a download. */
  printToPdf(tabId: string): Promise<void>;
  // ── Context menu ──────────────────────────────────────────────────────
  /** The tab's init script saw a `contextmenu`; the shell renders the menu. */
  onContextMenu(listener: (event: StreamContextMenuEvent) => void): () => void;
  // ── Geolocation ───────────────────────────────────────────────────────
  /** The person granted the site's prompt and gave the pane their position. */
  setGeolocation(tabId: string, position: StreamGeolocation): Promise<void>;
}

/** Every member of `StreamShellApi` that is a call rather than a subscription. */
export type StreamMethodName = Exclude<keyof StreamShellApi, `on${string}`>;

/** Every member of `StreamShellApi` that is a subscription. */
export type StreamEventMember = Extract<keyof StreamShellApi, `on${string}`>;

export interface StreamEventChannel {
  member: StreamEventMember;
  channel: `pistachio:${string}`;
}

function allStreamMethods<const L extends readonly StreamMethodName[]>(
  list: L,
  ...missing: [StreamMethodName] extends [L[number]] ? [] : [missing: Exclude<StreamMethodName, L[number]>]
): L {
  void missing;
  return list;
}

function allStreamEvents<const L extends readonly StreamEventChannel[]>(
  list: L,
  ...missing: [StreamEventMember] extends [L[number]["member"]]
    ? []
    : [missing: Exclude<StreamEventMember, L[number]["member"]>]
): L {
  void missing;
  return list;
}

export const STREAM_METHOD_NAMES = allStreamMethods([
  "provideFiles",
  "cancelFileRequest",
  "pasteText",
  "downloadUrl",
  "printToPdf",
  "setGeolocation",
]);

export const STREAM_EVENT_CHANNELS = allStreamEvents([
  { member: "onFileRequest", channel: "pistachio:file-request" },
  { member: "onClipboardCopy", channel: "pistachio:clipboard-copy" },
  { member: "onContextMenu", channel: "pistachio:context-menu" },
]);

/** The channel of an `on*` member of `StreamShellApi`. */
export type StreamEventChannelName = (typeof STREAM_EVENT_CHANNELS)[number]["channel"];

/** Every method the socket's `call` may name: both surfaces. */
export type SocketMethodName = ShellMethodName | StreamMethodName;

/** Every channel the socket's `event` may name: both surfaces. */
export type SocketEventChannelName = ShellEventChannelName | StreamEventChannelName;

export const SOCKET_METHOD_NAMES: readonly SocketMethodName[] = [
  ...SHELL_METHOD_NAMES,
  ...STREAM_METHOD_NAMES,
];

export const SOCKET_EVENT_CHANNELS: readonly { member: string; channel: SocketEventChannelName }[] = [
  ...SHELL_EVENT_CHANNELS,
  ...STREAM_EVENT_CHANNELS,
];

/** Which `on*` member of `StreamShellApi` a channel belongs to, if any. */
export function streamEventMemberOf(channel: string): StreamEventMember | null {
  return STREAM_EVENT_CHANNELS.find((entry) => entry.channel === channel)?.member ?? null;
}

const EVENT_CHANNEL_NAMES = [
  ...SHELL_EVENT_CHANNELS.map((entry) => entry.channel),
  ...STREAM_EVENT_CHANNELS.map((entry) => entry.channel),
] as unknown as readonly [SocketEventChannelName, ...SocketEventChannelName[]];

const METHOD_NAMES = [...SHELL_METHOD_NAMES, ...STREAM_METHOD_NAMES] as unknown as readonly [
  SocketMethodName,
  ...SocketMethodName[],
];

/* --------------------------------- pieces --------------------------------- */

/** Who may act in the session's tabs right now (W7). */
export const shellControlSchema = z.object({
  holder: z.enum(["human", "agent"]),
  generation: z.number().int().min(0),
});

export type ShellControl = z.infer<typeof shellControlSchema>;

/** Why one call was refused. `unsupported` is a member this host cannot answer. */
export const SHELL_REPLY_ERROR_CODES = [
  "unsupported",
  "invalid_args",
  "failed",
  "not_found",
  "ended",
] as const;

export type ShellReplyErrorCode = (typeof SHELL_REPLY_ERROR_CODES)[number];

/**
 * How the shell tells "this host cannot" apart from "that failed".
 *
 * A refused call arrives at the shell as an ordinary `Error`, and the shell
 * shows `error.message` — which is right, and not enough: W12 asks for an
 * affordance that is visibly UNAVAILABLE with its reason, not a red toast
 * that looks like something broke. A transport therefore tags the errors it
 * raises with the reply code, and the shell reads it back here without
 * importing anything from the transport.
 */
export const SHELL_REPLY_CODE: unique symbol = Symbol.for("pistachio.shell.reply-code");

export function shellReplyCodeOf(error: unknown): ShellReplyErrorCode | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<symbol, unknown>)[SHELL_REPLY_CODE];
  return typeof code === "string" && (SHELL_REPLY_ERROR_CODES as readonly string[]).includes(code)
    ? (code as ShellReplyErrorCode)
    : null;
}

/** Whether this host answers that member at all. The message says why not. */
export function isShellUnsupported(error: unknown): boolean {
  return shellReplyCodeOf(error) === "unsupported";
}

/**
 * The header the download route wants the viewer's own key in. It is a
 * header rather than a query parameter for the reason every bearer is: a URL
 * reaches `performance.getEntries()`, the browser's history, and every proxy
 * in between, and a download URL is handed to the person's own browser.
 */
export const DOWNLOAD_KEY_HEADER = "x-pistachio-download-key";

/**
 * The most arguments one `call` may carry. No `ShellApi` member takes more,
 * and a frame that claims to is not a call this host will make sense of.
 */
export const MAX_CALL_ARGS = 8;

/** Why the socket itself is refused or ended. */
export const SHELL_ERROR_CODES = [
  "unauthorized",
  "not_found",
  "ended",
  "space_key_required",
  "lease_lost",
] as const;

export type ShellErrorCode = (typeof SHELL_ERROR_CODES)[number];

/* ------------------------------ server frames ----------------------------- */

/**
 * Server → client. `challenge` comes first and nothing else follows until the
 * viewer proves the Space key: the host holds the person's signed-in sessions
 * and no state leaves before that proof (§5), exactly as the live view does.
 */
/** Live device coordination, distinct from human/agent control. */
export const linkedStateSchema = z.object({
  enabled: z.boolean(),
  generation: z.number().int().nonnegative(),
  controller: z.string().nullable(),
  viewers: z.array(z.string()),
});
export type LinkedState = z.infer<typeof linkedStateSchema>;
export const linkedCursorSchema = z.object({
  tabId: z.string(), viewerId: z.string(),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
}).nullable();
export type LinkedCursor = z.infer<typeof linkedCursorSchema>;

export const shellServerFrameSchema = z.union([
  z.object({ t: z.literal("linked"), state: linkedStateSchema }),
  z.object({ t: z.literal("cursor"), cursor: linkedCursorSchema }),
  z.object({ t: z.literal("challenge"), spaceId: z.string(), nonce: z.string() }),
  z.object({
    t: z.literal("ready"),
    sessionId: z.string(),
    control: shellControlSchema,
    viewerId: z.string().optional(),
    linked: linkedStateSchema.optional(),
    /**
     * This viewer's own download key (§11). A minted download URL is bound to
     * it, and the plain HTTP route wants it back in `DOWNLOAD_KEY_HEADER` —
     * so a URL that leaves this browser tab, into a log or a chat message,
     * opens nothing. Absent from a host that predates the binding.
     */
    downloadKey: z.string().optional(),
  }),
  z.object({
    t: z.literal("reply"),
    id: z.string(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    t: z.literal("reply"),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({ code: z.enum(SHELL_REPLY_ERROR_CODES), message: z.string() }),
  }),
  z.object({
    t: z.literal("event"),
    channel: z.enum(EVENT_CHANNEL_NAMES),
    payload: z.unknown(),
  }),
  liveFrameSchema.extend({ t: z.literal("frame"), tabId: z.string().min(1) }),
  /**
   * The DOM mirror's channel (docs/web-browser-design.md §16): one tab's
   * document, then its changes, for a pane that asked to be painted as a
   * document rather than as pixels. The bytes of the assets it names travel
   * as BINARY socket frames beside these (`encodeAssetChunk`), never inside
   * them, so a font does not sit in front of a patch.
   */
  z.object({ t: z.literal("mirror"), tabId: z.string().min(1), msg: mirrorServerMessageSchema }),
  z.object({
    t: z.literal("control"),
    holder: z.enum(["human", "agent"]),
    generation: z.number().int().min(0),
  }),
  z.object({
    t: z.literal("error"),
    code: z.enum(SHELL_ERROR_CODES),
    message: z.string(),
  }),
]);

export type ShellServerFrame = z.infer<typeof shellServerFrameSchema>;

/* ------------------------------ client frames ----------------------------- */

/**
 * Client → server. `call` is the RPC envelope over `ShellApi`: the method must
 * be one this build knows, the argument list is bounded here
 * (`MAX_CALL_ARGS`), and each member re-validates its own arguments the way
 * it does over IPC — `isSidebarCommand`, `sanitizeSettings`,
 * `sanitizeOnboardingCompletion` and their siblings — because the host must
 * treat a socket exactly as suspiciously as it treats a page. A member this
 * host does not implement is answered `unsupported` rather than by closing
 * the socket. `input` carries the control generation it was issued under, and
 * the host drops anything older (W7).
 */
export const shellClientFrameSchema = z.union([
  z.object({ t: z.literal("link"), action: z.enum(["enable", "disable", "take-control"]), generation: z.number().int().nonnegative() }),
  z.object({ t: z.literal("auth"), proof: z.string() }),
  z.object({
    t: z.literal("call"),
    id: z.string(),
    method: z.enum(METHOD_NAMES),
    args: z.array(z.unknown()).max(MAX_CALL_ARGS),
    viewGeneration: z.number().int().nonnegative().optional(),
  }),
  z.object({
    t: z.literal("pane"),
    tabId: z.string().min(1),
    width: z.number(),
    height: z.number(),
    dpr: z.number(),
    visible: z.boolean(),
    /**
     * How this pane wants the tab painted (§16): `pixels` is the screencast,
     * `dom` the live document mirror. Absent means pixels, which is what a
     * client that predates the mirror asks for without knowing it.
     */
    renderer: z.enum(PANE_RENDERERS).optional(),
    hybridMedia: z.boolean().optional(),
  }),
  z.object({
    t: z.literal("input"),
    tabId: z.string().min(1),
    generation: z.number().int().min(0),
    viewGeneration: z.number().int().nonnegative().optional(),
    event: z.discriminatedUnion("kind", [liveMouseEventSchema, liveKeyEventSchema]),
  }),
  /**
   * The mirror's own input and flow control (§16): a click that names a node,
   * an edit of a field, a scroll, an acknowledgement, a request for the
   * document again. Fenced by the control generation exactly as `input` is.
   */
  z.object({
    t: z.literal("mirror"),
    tabId: z.string().min(1),
    generation: z.number().int().min(0),
    viewGeneration: z.number().int().nonnegative().optional(),
    msg: mirrorClientMessageSchema,
  }),
]);

export type ShellClientFrame = z.infer<typeof shellClientFrameSchema>;

/* -------------------------------- the wire -------------------------------- */

function decode<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  raw: unknown,
): T | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(value);
  return result.success && result.data !== undefined ? result.data : null;
}

/** JSON for the wire. Typed so a caller cannot send a shape the peer will drop. */
export function encodeShellServerFrame(frame: ShellServerFrame): string {
  return JSON.stringify(frame);
}

export function encodeShellClientFrame(frame: ShellClientFrame): string {
  return JSON.stringify(frame);
}

/** Text that is not JSON, JSON that is not a frame, and a frame this build
 * does not know are the same thing to a reader — something unusable arrived. */
export function decodeShellServerFrame(raw: unknown): ShellServerFrame | null {
  return decode<ShellServerFrame>(shellServerFrameSchema, raw);
}

export function decodeShellClientFrame(raw: unknown): ShellClientFrame | null {
  return decode<ShellClientFrame>(shellClientFrameSchema, raw);
}
