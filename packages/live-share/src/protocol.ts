/**
 * The live-share room protocol (docs/live-share.md §3, §4): the topics, who
 * may send each, every body's schema, the palette and the bounds.
 *
 * Pure: no livekit-client, no DOM. Electron main, the live-host renderer and
 * the guest page all import it, so a body one side sends is exactly what the
 * other side's schema accepts. Every inbound message goes through
 * `decodeMessage`, which checks the sender's role before it reads a byte of
 * the body, then the size, then the shape; anything that fails is `null`,
 * never a throw — a peer cannot crash a receiver with a bad packet.
 */

import { z } from "zod";

export const LIVE_PROTOCOL_VERSION = 1;

/** Who a participant is in the room; set by control in the token's metadata. */
export type LiveRole = "host" | "guest";

/** Who sent a message: a participant's role, or the server (control through LiveKit's API). */
export type LiveSenderRole = LiveRole | "server";

/** The host's identity in the room (§3): one per room, a second connection replacing the first. */
export const HOST_IDENTITY = "host";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** A display name's length after `sanitizeName`, in characters (code points). */
export const MAX_NAME_LENGTH = 40;
export const MAX_CHAT_LENGTH = 2000;
/** One `insertText` input event (a paste or an IME commit). */
export const MAX_INSERT_TEXT_LENGTH = 2000;
/** Point pairs in one `begin` / `add` ink message. */
export const MAX_INK_PAIRS_PER_MESSAGE = 64;
/**
 * Point pairs in one stroke. A longer gesture continues as a fresh stroke
 * (`InkRecorder` does it seamlessly), which keeps a board — and so a sync —
 * bounded: 400 strokes of 1000 pairs, on the ink's 1/10000 grid (`InkBoard`
 * keeps no finer point), are at most ~5.7 MB of JSON.
 */
export const MAX_STROKE_PAIRS = 1000;
/** Strokes the host's board holds; the oldest go first. */
export const MAX_STROKES = 400;
/** Chat messages the host keeps for the share and sends in a sync. */
export const MAX_CHAT_HISTORY = 200;
/** Windows in one desk frame. */
export const MAX_DESK_WINDOWS = 64;
/** Guests in one `lv.guests` list: past control's eight (`LIVE_MAX_GUESTS`, configurable), with room to spare. */
export const MAX_LISTED_GUESTS = 64;
/** A window title in a desk frame. */
export const MAX_WINDOW_TITLE_LENGTH = 300;
/** A favicon in a desk frame: an https: URL or a data:image/ URL, in characters. */
export const MAX_FAVICON_LENGTH = 4096;
/** Wheel deltas, CSS px each way. */
export const MAX_WHEEL_DELTA = 2000;
/** A body larger than this goes as a LiveKit text stream instead of a data packet (§4). */
export const PACKET_LIMIT_BYTES = 12 * 1024;

// ---------------------------------------------------------------------------
// Palette and reactions
// ---------------------------------------------------------------------------

/**
 * Cursor and name-pill colours, host first; guests take the next free one in
 * join order (§3). Mid-tone, saturated, distinct hues that carry white text
 * and stand out on both a dark and a light page.
 */
export const LIVE_COLORS = [
  "#3E63DD", // indigo — the host
  "#E54D2E", // tomato
  "#46A758", // grass
  "#F76B15", // orange
  "#8E4EC6", // purple
  "#D6409F", // pink
  "#12A594", // teal
  "#AD7F58", // bronze
] as const;

/** The host's colour, and the fallback for a participant whose metadata is unreadable. */
export const HOST_COLOR = LIVE_COLORS[0];

export const LIVE_REACTIONS = ["👍", "👏", "😂", "❤️", "🎉", "😮", "🤔", "🙌"] as const;
export type LiveReaction = (typeof LIVE_REACTIONS)[number];

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

// C0 and C1 controls, and the bidi embeddings, overrides and isolates that
// can make a name read as something else in a list of names.
// eslint-disable-next-line no-control-regex
const NAME_STRIP = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * A display name as people see it: trimmed, control and bidi-override
 * characters removed, runs of whitespace made one space, 1–40 characters.
 * `null` when nothing is left or it is too long — a caller asks again rather
 * than showing a silently cut name.
 */
export function sanitizeName(raw: string): string | null {
  const name = raw.replace(NAME_STRIP, "").replace(/\s+/g, " ").trim();
  const length = [...name].length;
  if (length === 0 || length > MAX_NAME_LENGTH) return null;
  return name;
}

/**
 * Whose Mac it is, read off the name macOS gives it ("Zach's MacBook Pro" →
 * "Zach"): the name guests know the host by, or `null` where the Mac's name
 * names nobody (the share is then shown by its space alone).
 */
export function hostNameFrom(computerName: string): string | null {
  const match = /^\s*(.+?)['’]s\s/u.exec(computerName);
  return match === null ? null : sanitizeName(match[1]!);
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** 0..1 of the host's stage (or of a window's page box, for input). */
const unitSchema = z.number().min(0).max(1);
/** Stage CSS px: generous bounds, so a frame from a huge display still parses but garbage does not. */
const pxSchema = z.number().min(-100_000).max(100_000);
const lengthSchema = z.number().min(0).max(100_000);
/** A window id: the tab id, or "file:<id>" for a document. */
const windowIdSchema = z.string().min(1).max(200);
/** A participant identity: `host` or `g_<requestId>` (§3). */
const identitySchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const rectSchema = z.object({ x: pxSchema, y: pxSchema, w: lengthSchema, h: lengthSchema });
/** Stage CSS px. */
export type Rect = z.infer<typeof rectSchema>;

export const participantMetadataSchema = z.object({
  role: z.enum(["host", "guest"]),
  color: colorSchema,
});
/** What control puts in a participant's token metadata (§3); never set by the participant. */
export type LiveParticipantMetadata = z.infer<typeof participantMetadataSchema>;

/** A participant's metadata, or null when it is missing or not ours. */
export function parseParticipantMetadata(raw: string | undefined | null): LiveParticipantMetadata | null {
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    const parsed = participantMetadataSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// lv.desk
// ---------------------------------------------------------------------------

const faviconSchema = z
  .string()
  .max(MAX_FAVICON_LENGTH)
  .refine((url) => url.startsWith("https:") || url.startsWith("data:image/"), "favicon must be https: or data:image/");

export const liveWindowSchema = z.object({
  /** The tab id, or "file:<id>" for a document. */
  id: windowIdSchema,
  /** page: its own track; shell: drawn by the shell (§6.6). */
  kind: z.enum(["page", "shell"]),
  title: z.string().max(MAX_WINDOW_TITLE_LENGTH),
  /** "github.com" — never the full URL. */
  origin: z.string().max(253).nullable(),
  /** An https: or data:image/ URL ≤ 4 KB, else null. */
  favicon: faviconSchema.nullable(),
  /** The window's frame, in stage CSS px. */
  frame: rectSchema,
  /** Its page box, in stage CSS px (the same space as `frame`, not relative to it), inside the frame. */
  page: rectSchema,
  /** The window in use on the host. */
  focused: z.boolean(),
  minimized: z.boolean(),
  /** Guests may use it (and the host is present). */
  controllable: z.boolean(),
  /** "win:<id>" while streamed. */
  track: z.string().max(210).nullable(),
  /** Its picture is the last one, not live (shell kind while away). */
  paused: z.boolean(),
});
export type LiveWindow = z.infer<typeof liveWindowSchema>;

export const liveDeskFrameSchema = z.object({
  v: z.literal(LIVE_PROTOCOL_VERSION),
  /** Increases per frame; a receiver drops one older than what it has. */
  seq: z.number().int().min(0),
  /** The host's stage, CSS px. */
  stage: z.object({ w: z.number().positive().max(100_000), h: z.number().positive().max(100_000) }),
  /** The host is on this space (and the window is up). */
  hostPresent: z.boolean(),
  /**
   * The host's *Guests can draw* (§1 the Live card). Optional so a frame
   * without it still parses; absent means on, the card's default.
   */
  guestsCanDraw: z.boolean().optional(),
  space: z.object({ title: z.string().max(MAX_WINDOW_TITLE_LENGTH), color: colorSchema }),
  /** Bottom to top. */
  windows: z.array(liveWindowSchema).max(MAX_DESK_WINDOWS),
});
export type LiveDeskFrame = z.infer<typeof liveDeskFrameSchema>;

// ---------------------------------------------------------------------------
// lv.cursor
// ---------------------------------------------------------------------------

export const LIVE_TOOLS = ["pointer", "pen", "highlighter", "laser"] as const;
export type LiveTool = (typeof LIVE_TOOLS)[number];

export const liveCursorSchema = z.union([
  z.object({ x: unitSchema, y: unitSchema, tool: z.enum(LIVE_TOOLS), down: z.boolean().optional() }),
  z.object({ hidden: z.literal(true) }),
]);
/** A pointer at stage-normalized `x, y`, or hidden (left the stage, the host away). */
export type LiveCursor = z.infer<typeof liveCursorSchema>;

// ---------------------------------------------------------------------------
// lv.ink
// ---------------------------------------------------------------------------

export const INK_TOOLS = ["pen", "highlighter", "laser"] as const;
export type InkTool = (typeof INK_TOOLS)[number];

/** `<identity>:<n>`: the owner is in the id (§4). */
const strokeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}:\d{1,9}$/);
/** Stroke width as a fraction of the stage's width, so it scales with the stage it is drawn on. */
const strokeSizeSchema = z.number().positive().max(0.1);

/** A flat `[x, y, x, y, …]` of stage-normalized points. */
function pointsSchema(maxPairs: number, minPairs: number) {
  return z
    .array(unitSchema)
    .min(minPairs * 2)
    .max(maxPairs * 2)
    .refine((pts) => pts.length % 2 === 0, "points come in pairs");
}

export const liveInkSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("begin"),
    id: strokeIdSchema,
    tool: z.enum(INK_TOOLS),
    color: colorSchema,
    size: strokeSizeSchema,
    pts: pointsSchema(MAX_INK_PAIRS_PER_MESSAGE, 1),
  }),
  z.object({ op: z.literal("add"), id: strokeIdSchema, pts: pointsSchema(MAX_INK_PAIRS_PER_MESSAGE, 1) }),
  z.object({ op: z.literal("end"), id: strokeIdSchema }),
  z.object({ op: z.literal("erase"), id: strokeIdSchema }),
  z.object({ op: z.literal("clear"), scope: z.enum(["mine", "all"]) }),
]);
export type LiveInkOp = z.infer<typeof liveInkSchema>;

export const liveStrokeSchema = z.object({
  id: strokeIdSchema,
  tool: z.enum(INK_TOOLS),
  color: colorSchema,
  size: strokeSizeSchema,
  pts: pointsSchema(MAX_STROKE_PAIRS, 1),
  /** Its owner has lifted the pen; an unfinished stroke still takes `add`s after a sync. */
  done: z.boolean(),
});
/** A stroke as the board holds it and a sync carries it. */
export type LiveStroke = z.infer<typeof liveStrokeSchema>;

/** The owner of a stroke id (`<identity>:<n>`), or null for a malformed id. */
export function strokeOwner(id: string): string | null {
  const colon = id.lastIndexOf(":");
  return colon > 0 ? id.slice(0, colon) : null;
}

// ---------------------------------------------------------------------------
// lv.ping, lv.react, lv.chat
// ---------------------------------------------------------------------------

export const livePingSchema = z.object({ x: unitSchema, y: unitSchema });
export type LivePing = z.infer<typeof livePingSchema>;

export const liveReactSchema = z.object({ emoji: z.enum(LIVE_REACTIONS) });
export type LiveReact = z.infer<typeof liveReactSchema>;

const chatIdSchema = z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/);
const chatTextSchema = z
  .string()
  .max(MAX_CHAT_LENGTH)
  .refine((text) => text.trim().length > 0, "chat text is empty");

export const liveChatSchema = z.object({ id: chatIdSchema, text: chatTextSchema });
export type LiveChat = z.infer<typeof liveChatSchema>;

/** A chat message as the host keeps it: stamped with who sent it and when it arrived. */
export const liveChatEntrySchema = z.object({
  id: chatIdSchema,
  from: identitySchema,
  name: z.string().min(1).max(MAX_NAME_LENGTH * 2),
  color: colorSchema,
  text: chatTextSchema,
  /** Epoch ms, the host's clock. */
  at: z.number().int().min(0),
});
export type LiveChatEntry = z.infer<typeof liveChatEntrySchema>;

// ---------------------------------------------------------------------------
// lv.input
// ---------------------------------------------------------------------------

export const LIVE_MODIFIERS = ["shift", "control", "alt", "meta"] as const;
export type LiveModifier = (typeof LIVE_MODIFIERS)[number];
const modifiersSchema = z.array(z.enum(LIVE_MODIFIERS)).max(LIVE_MODIFIERS.length);

const mouseSchema = {
  /** 0..1 of the window's page box. */
  x: unitSchema,
  y: unitSchema,
  /** The button pressed or released; for a move, the one held (if any). */
  button: z.enum(["left", "middle", "right"]).optional(),
  /** DOM `buttons`: which are held down (1 left, 2 right, 4 middle). */
  buttons: z.number().int().min(0).max(7),
  clickCount: z.number().int().min(0).max(3),
  modifiers: modifiersSchema,
};

/** DOM `key` values are short ("a", "ArrowUp", "AudioVolumeMute"); 32 covers every named key. */
const keySchema = z.string().min(1).max(32);
const codeSchema = z.string().max(32);

/**
 * One typed character: the text a DOM `keypress` would carry — a single
 * grapheme, or "\r" for Enter (Chromium inserts a line break and submits a
 * form on the char event, not on the key down).
 */
const charTextSchema = z
  .string()
  .min(1)
  .max(16)
  .refine((text) => text === "\r" || (isOneGrapheme(text) && !/\p{Cc}/u.test(text)), "char is one grapheme");

/**
 * The modifiers a typed character carries: Shift alone, so Shift+Enter
 * breaks a line where Enter starts a paragraph, and a keypress handler reads
 * `shiftKey`. Never ⌥ — on a char it eats ⌥↵'s line break and makes a form
 * submit a download of the host's (probed, Electron 43) — nor ⌘ or Ctrl.
 */
const charModifiersSchema = z.array(z.literal("shift")).max(1);

export const liveInputEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mouseMove"), ...mouseSchema }),
  z.object({ type: z.literal("mouseDown"), ...mouseSchema }),
  z.object({ type: z.literal("mouseUp"), ...mouseSchema }),
  z.object({
    type: z.literal("wheel"),
    x: unitSchema,
    y: unitSchema,
    /** DOM WheelEvent deltas in CSS px (positive dy scrolls down), clamped ±2000. */
    dx: z.number().min(-MAX_WHEEL_DELTA).max(MAX_WHEEL_DELTA),
    dy: z.number().min(-MAX_WHEEL_DELTA).max(MAX_WHEEL_DELTA),
    modifiers: modifiersSchema,
  }),
  z.object({
    type: z.literal("keyDown"),
    key: keySchema,
    code: codeSchema,
    modifiers: modifiersSchema,
    repeat: z.boolean().optional(),
  }),
  z.object({ type: z.literal("keyUp"), key: keySchema, code: codeSchema, modifiers: modifiersSchema }),
  z.object({ type: z.literal("char"), text: charTextSchema, modifiers: charModifiersSchema.optional() }),
  z.object({ type: z.literal("insertText"), text: z.string().min(1).max(MAX_INSERT_TEXT_LENGTH) }),
]);
/** A page-normalized pointer or key event from a guest (§4 Input). */
export type LiveInputEvent = z.infer<typeof liveInputEventSchema>;

export const liveInputSchema = z.object({ w: windowIdSchema, e: liveInputEventSchema });
export type LiveInput = z.infer<typeof liveInputSchema>;

// ---------------------------------------------------------------------------
// lv.hello, lv.sync, lv.guests, lv.ask, lv.grant, lv.refused, lv.knock
// ---------------------------------------------------------------------------

export const liveHelloSchema = z.object({});
export type LiveHello = z.infer<typeof liveHelloSchema>;

export const liveGrantSchema = z.object({
  w: windowIdSchema,
  /** Who is using window `w` now, or null for nobody. */
  user: identitySchema.nullable(),
});
export type LiveGrant = z.infer<typeof liveGrantSchema>;

export const liveSyncSchema = z.object({
  desk: liveDeskFrameSchema.nullable(),
  strokes: z.array(liveStrokeSchema).max(MAX_STROKES),
  chat: z.array(liveChatEntrySchema).max(MAX_CHAT_HISTORY),
  /** Who is using which window now, so a guest who joins late sees the outlines' names. */
  grants: z.array(liveGrantSchema.extend({ user: identitySchema })).max(MAX_DESK_WINDOWS),
});
/** The room as it is, sent by the host to one guest (on `lv.hello` or when they join). */
export type LiveSync = z.infer<typeof liveSyncSchema>;

export const liveGuestsSchema = z.object({ guests: z.array(identitySchema).max(MAX_LISTED_GUESTS) });
/**
 * The guests the host lets in now, sent to them on every change and as each
 * says hello: whom each of them lets see and hear it, and hears (§4).
 */
export type LiveGuests = z.infer<typeof liveGuestsSchema>;

export const liveAskSchema = z.object({ w: windowIdSchema });
export type LiveAsk = z.infer<typeof liveAskSchema>;

/** The host said no to this guest's ask to use window `w` (sent to that guest alone). */
export const liveRefusedSchema = z.object({ w: windowIdSchema });
export type LiveRefused = z.infer<typeof liveRefusedSchema>;

export const liveKnockSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().min(1).max(MAX_NAME_LENGTH * 2),
});
/** Someone asks to join (sent by control through LiveKit's server API). */
export type LiveKnock = z.infer<typeof liveKnockSchema>;

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

interface LiveTopicSpec {
  /** Reliable (ordered, retransmitted) or lossy. */
  reliable: boolean;
  /** Which senders a receiver acts on. */
  from: readonly LiveSenderRole[];
  /**
   * Whom it goes to, whoever sends it and whomever they name: the host, for
   * what §4 addresses to the host alone. A guest's input above all — the
   * keys of a password the page's picture masks — is no other guest's to read.
   */
  to?: "host";
  /** The largest body a receiver reads, in bytes (characters for a text stream). */
  maxBytes: number;
}

/** The §4 table. */
export const LIVE_TOPICS = {
  "lv.desk": { reliable: true, from: ["host"], maxBytes: 512 * 1024 },
  "lv.cursor": { reliable: false, from: ["host", "guest"], maxBytes: 256 },
  "lv.ink": { reliable: true, from: ["host", "guest"], maxBytes: 4 * 1024 },
  "lv.ping": { reliable: true, from: ["host", "guest"], maxBytes: 256 },
  "lv.react": { reliable: true, from: ["host", "guest"], maxBytes: 256 },
  "lv.chat": { reliable: true, from: ["host", "guest"], maxBytes: 12 * 1024 },
  "lv.hello": { reliable: true, from: ["guest"], to: "host", maxBytes: 256 },
  // A full board (~5.7 MB), 200 chat messages and a desk frame; the host cuts a sync to it, the oldest strokes first.
  "lv.sync": { reliable: true, from: ["host"], maxBytes: 8 * 1024 * 1024 },
  "lv.guests": { reliable: true, from: ["host"], maxBytes: 8 * 1024 },
  "lv.input": { reliable: true, from: ["guest"], to: "host", maxBytes: 12 * 1024 },
  "lv.ask": { reliable: true, from: ["guest"], to: "host", maxBytes: 512 },
  "lv.grant": { reliable: true, from: ["host"], maxBytes: 512 },
  "lv.refused": { reliable: true, from: ["host"], maxBytes: 512 },
  "lv.knock": { reliable: true, from: ["server"], to: "host", maxBytes: 1024 },
} as const satisfies Record<string, LiveTopicSpec>;

export type LiveTopic = keyof typeof LIVE_TOPICS;

const BODY_SCHEMAS = {
  "lv.desk": liveDeskFrameSchema,
  "lv.cursor": liveCursorSchema,
  "lv.ink": liveInkSchema,
  "lv.ping": livePingSchema,
  "lv.react": liveReactSchema,
  "lv.chat": liveChatSchema,
  "lv.hello": liveHelloSchema,
  "lv.sync": liveSyncSchema,
  "lv.guests": liveGuestsSchema,
  "lv.input": liveInputSchema,
  "lv.ask": liveAskSchema,
  "lv.grant": liveGrantSchema,
  "lv.refused": liveRefusedSchema,
  "lv.knock": liveKnockSchema,
} as const satisfies Record<LiveTopic, z.ZodType>;

/** The body a topic carries. */
export type LiveBody<T extends LiveTopic> = z.infer<(typeof BODY_SCHEMAS)[T]>;

export function isLiveTopic(topic: string | undefined): topic is LiveTopic {
  return topic !== undefined && Object.hasOwn(LIVE_TOPICS, topic);
}

/** Whether a receiver acts on `topic` from a sender with this role (§4: checked before the body is read). */
export function senderAllowed(topic: LiveTopic, sender: LiveSenderRole): boolean {
  return (LIVE_TOPICS[topic].from as readonly LiveSenderRole[]).includes(sender);
}

/**
 * Whom a message on `topic` goes to: the host alone for a topic §4 addresses
 * to it, whomever the sender named (an empty list, which LiveKit reads as
 * everyone, included); otherwise those it names, or everyone (`undefined`).
 * A sender bound to `within` — a guest, to the host and the guests the host
 * lists (§4 `lv.guests`) — never reaches past it: a message for everyone
 * goes to `within`, and anyone named outside it is left out.
 */
export function destinationsOf(topic: LiveTopic, named: readonly string[] | undefined, within?: readonly string[]): string[] | undefined {
  if ((LIVE_TOPICS[topic] as LiveTopicSpec).to === "host") return [HOST_IDENTITY];
  if (within === undefined) return named === undefined ? undefined : [...named];
  return named === undefined ? [...within] : named.filter((identity) => within.includes(identity));
}

export class LiveProtocolError extends Error {
  override name = "LiveProtocolError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** A body as the JSON text that goes on the wire, after checking it against its schema. */
export function encodeText<T extends LiveTopic>(topic: T, body: LiveBody<T>): string {
  const parsed = BODY_SCHEMAS[topic].safeParse(body);
  if (!parsed.success) throw new LiveProtocolError(`invalid ${topic} body: ${parsed.error.message}`);
  return JSON.stringify(parsed.data);
}

/**
 * A body as UTF-8 JSON bytes for a data packet. Throws `LiveProtocolError`
 * when the body breaks its schema: a sender finds its bug here, not in a
 * silent drop on every receiver.
 */
export function encodeMessage<T extends LiveTopic>(topic: T, body: LiveBody<T>): Uint8Array {
  return encoder.encode(encodeText(topic, body));
}

/**
 * A received message's body, or null when the sender may not send this topic,
 * it is over the topic's size, or it is not valid JSON of the right shape.
 * Accepts the bytes of a data packet or the text of a text stream.
 */
export function decodeMessage<T extends LiveTopic>(
  topic: T,
  data: Uint8Array | string,
  sender: LiveSenderRole,
): LiveBody<T> | null {
  const spec = LIVE_TOPICS[topic] as LiveTopicSpec | undefined;
  if (spec === undefined || !senderAllowed(topic, sender)) return null;
  const size = typeof data === "string" ? data.length : data.byteLength;
  if (size > spec.maxBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(typeof data === "string" ? data : decoder.decode(data));
  } catch {
    return null;
  }
  const parsed = BODY_SCHEMAS[topic].safeParse(value);
  return parsed.success ? (parsed.data as LiveBody<T>) : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Whether `text` is exactly one user-perceived character. */
export function isOneGrapheme(text: string): boolean {
  if (text.length === 0) return false;
  if (graphemes === null) return [...text].length === 1;
  const iterator = graphemes.segment(text)[Symbol.iterator]();
  const first = iterator.next();
  return !first.done && first.value.segment.length === text.length;
}
