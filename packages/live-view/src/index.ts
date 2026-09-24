/**
 * The live view's wire protocol and arithmetic (docs/cloud-sync-design.md §8.5).
 *
 * THIS IS THE PROTOCOL. Both clients and the runner encode, decode and
 * validate through the schemas here — nobody re-implements a parse. Three
 * parties speak this (desktop main, the web run page, the runner, and the
 * runner again as a gateway), and a frame shape that drifts between them
 * fails silently: a dropped field is a black screen or a click in the wrong
 * place, never an exception.
 *
 * The arithmetic below is the other half of that: turning a pointer or key
 * event over the screencast image into an input frame. A click that lands
 * 30px off is not an exception either, it is a different button.
 */

import { z } from "zod";

/* --------------------------------- frames --------------------------------- */

export const frameMetadataSchema = z.object({
  deviceWidth: z.number(),
  deviceHeight: z.number(),
  pageScaleFactor: z.number(),
  scrollOffsetX: z.number(),
  scrollOffsetY: z.number(),
});

/** Where the screencast frame says the cloud page's viewport is. */
export type FrameMetadata = z.infer<typeof frameMetadataSchema>;

export const liveFrameSchema = z.object({
  /** base64 JPEG. */
  data: z.string(),
  width: z.number(),
  height: z.number(),
  metadata: frameMetadataSchema,
});

/** One screencast frame as the runner sends it: base64 JPEG and its geometry. */
export type LiveFrame = z.infer<typeof liveFrameSchema>;

export const liveTabInfoSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  title: z.string(),
  url: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  kind: z.enum(["human", "agent"]),
});

/** A tab the cloud browser reports over the live view. */
export type LiveTabInfo = z.infer<typeof liveTabInfoSchema>;

export const LIVE_ERROR_CODES = ["unauthorized", "not_found", "ended", "space_key_required"] as const;

/**
 * Server → client. `challenge` comes first and nothing else follows until the
 * viewer answers it: the runner holds the run's Space key and makes the
 * viewer prove it holds the same one before any pixel of the person's
 * signed-in sessions goes out.
 */
export const liveServerFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("challenge"), spaceId: z.string(), nonce: z.string() }),
  liveFrameSchema.extend({ t: z.literal("frame") }),
  z.object({ t: z.literal("tabs"), tabs: z.array(liveTabInfoSchema), activeTabId: z.string().nullable() }),
  z.object({ t: z.literal("status"), status: z.string(), control: z.enum(["agent", "human"]) }),
  z.object({ t: z.literal("error"), code: z.enum(LIVE_ERROR_CODES), message: z.string() }),
]);

export type LiveServerFrame = z.infer<typeof liveServerFrameSchema>;

export const liveMouseEventSchema = z.object({
  kind: z.literal("mouse"),
  type: z.enum(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
  x: z.number(),
  y: z.number(),
  button: z.enum(["left", "middle", "right", "none"]),
  clickCount: z.number().int().min(0),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  modifiers: z.number().int().min(0),
});

export const liveKeyEventSchema = z.object({
  kind: z.literal("key"),
  type: z.enum(["keyDown", "keyUp", "char"]),
  key: z.string(),
  code: z.string(),
  text: z.string().optional(),
  windowsVirtualKeyCode: z.number().int().optional(),
  modifiers: z.number().int().min(0),
});

/**
 * Client → server. The runner forwards `input` to `Input.dispatch*` only
 * while `control === 'human'`, and drops it otherwise — a viewer who has not
 * taken control cannot touch the page, whichever client they use.
 */
export const liveClientFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("auth"), proof: z.string() }),
  z.object({
    t: z.literal("input"),
    event: z.discriminatedUnion("kind", [liveMouseEventSchema, liveKeyEventSchema]),
  }),
  z.object({ t: z.literal("focus"), tabId: z.string().min(1) }),
]);

export type LiveClientFrame = z.infer<typeof liveClientFrameSchema>;

/** Every client→server frame except the ones that carry the person's input. */
export type LiveInput = Extract<LiveClientFrame, { t: "input" } | { t: "focus" }>;

/**
 * Decode one frame off the wire, or null. Text that is not JSON, JSON that is
 * not a frame, and a frame this build does not know are the same thing to a
 * reader — something unusable arrived — and all three are dropped rather than
 * thrown, because a socket must not die of one bad frame.
 */
function decode<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }, raw: unknown): T | null {
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

export function decodeServerFrame(raw: unknown): LiveServerFrame | null {
  return decode<LiveServerFrame>(liveServerFrameSchema, raw);
}

export function decodeClientFrame(raw: unknown): LiveClientFrame | null {
  return decode<LiveClientFrame>(liveClientFrameSchema, raw);
}

/** JSON for the wire. Typed so a caller cannot send a shape the peer will drop. */
export function encodeServerFrame(frame: LiveServerFrame): string {
  return JSON.stringify(frame);
}

export function encodeClientFrame(frame: LiveClientFrame): string {
  return JSON.stringify(frame);
}

/* --------------------------------- dialling ------------------------------- */

/**
 * `https://runner.example` → `wss://runner.example/v1/live/<runId>?access_token=…`.
 *
 * The credential rides in the query because no WebSocket client — Electron
 * main's or a browser's — can set a header on the upgrade (§8.5). The runner
 * deletes it from `request.url` before anything can log the request line, and
 * control mints a one-minute ticket rather than handing over a device token.
 */
export function liveViewUrl(cloudBrowserUrl: string, runId: string, token: string): string {
  const base = cloudBrowserUrl.trim().replace(/\/+$/, "");
  const scheme = base.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  return `${scheme}/v1/live/${encodeURIComponent(runId)}?access_token=${encodeURIComponent(token)}`;
}

/** The rendered box of the screencast image, as `getBoundingClientRect` gives it. */
export interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A point in the cloud page's own CSS pixels. */
export interface LivePoint {
  x: number;
  y: number;
}

/**
 * §8.5's `x = offsetX * metadata.deviceWidth / width`, with `offsetX`
 * measured in the FRAME's pixels rather than the element's.
 *
 * The two are the same number whenever the image is painted at its natural
 * size, which is the case the spec writes down. The live view scales the
 * image to fit its pane, so the offset is converted into frame pixels first
 * (`clientX - left` is element CSS px; × width / box.width makes it frame
 * px) and the spec's expression then applies unchanged. Getting this wrong
 * is silent: the frames still look right, every click lands somewhere else.
 */
export function livePoint(frame: LiveFrame, box: FrameBox, clientX: number, clientY: number): LivePoint {
  return {
    x: axis(clientX - box.left, box.width, frame.width, frame.metadata.deviceWidth),
    y: axis(clientY - box.top, box.height, frame.height, frame.metadata.deviceHeight),
  };
}

function axis(offset: number, boxExtent: number, frameExtent: number, deviceExtent: number): number {
  if (!Number.isFinite(offset) || boxExtent <= 0 || frameExtent <= 0) return 0;
  const offsetInFrame = offset * (frameExtent / boxExtent);
  const value = (offsetInFrame * deviceExtent) / frameExtent;
  if (!Number.isFinite(value)) return 0;
  // Never point outside the page: a drag released past the image's edge
  // would otherwise dispatch a coordinate the renderer has no pixel for.
  const limit = deviceExtent > 0 ? deviceExtent : frameExtent;
  return Math.min(Math.max(0, Math.round(value * 100) / 100), limit);
}

/** The CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function liveModifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

export type LiveMouseType = "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
export type LiveMouseButton = "left" | "middle" | "right" | "none";

/** DOM `MouseEvent.button` as §8.5 names it; anything unexpected is "none". */
export function liveMouseButton(button: number, pressed = true): LiveMouseButton {
  if (!pressed) return "none";
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "none";
  }
}

/**
 * The button held during a drag, from the DOM `buttons` BITMASK.
 *
 * `MouseEvent.button` names the button that CHANGED, and a pointermove
 * changes none — it reports -1, or 0 in engines that never learned to. Read
 * as a button name that is "left", which is why a drag has to come from
 * `buttons` instead: send `none` mid-drag and the page is told the pointer is
 * merely hovering, so the selection, the slider, and the drag-and-drop all
 * stop dead halfway.
 */
export function heldMouseButton(buttons: number): LiveMouseButton {
  if ((buttons & 1) !== 0) return "left";
  if ((buttons & 2) !== 0) return "right";
  if ((buttons & 4) !== 0) return "middle";
  return "none";
}

export interface LiveMouseOptions {
  type: LiveMouseType;
  point: LivePoint;
  button?: LiveMouseButton;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}

export function mouseInput(options: LiveMouseOptions): LiveInput {
  const { type, point, button = "none", clickCount = 0, modifiers = 0 } = options;
  return {
    t: "input",
    event: {
      kind: "mouse",
      type,
      x: point.x,
      y: point.y,
      button,
      clickCount,
      ...(options.deltaX === undefined ? {} : { deltaX: options.deltaX }),
      ...(options.deltaY === undefined ? {} : { deltaY: options.deltaY }),
      modifiers,
    },
  };
}

/**
 * Keys whose virtual key code the cloud page needs to act on them at all —
 * a keyDown with no code moves no caret. Printable characters derive theirs
 * from the character itself.
 */
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  CapsLock: 20,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
};

const PHYSICAL_KEY_CODES: Record<string, number> = {
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190,
  Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220,
  BracketRight: 221, Quote: 222,
};

export function virtualKeyCode(key: string, physicalCode?: string): number | undefined {
  const physical = physicalCode === undefined ? undefined : PHYSICAL_KEY_CODES[physicalCode];
  if (physical !== undefined) return physical;
  if (physicalCode && /^Digit[0-9]$/u.test(physicalCode)) return physicalCode.charCodeAt(5);
  const known = VIRTUAL_KEY_CODES[key];
  if (known !== undefined) return known;
  if ([...key].length !== 1) return undefined;
  return key.toUpperCase().codePointAt(0);
}

export interface LiveKeyEvent {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * The two named keys that still carry text into the page. CDP only raises a
 * `keypress` for a `keyDown` that has `text`, and a form with no submit
 * button submits on the *keypress* for Enter — so an Enter sent without
 * `"\r"` moves the caret nowhere and submits nothing, which is what S4 found
 * on the fixture's single-input form. Tab is the same story for the default
 * action that moves focus.
 */
const KEY_TEXT: Record<string, string> = {
  Enter: "\r",
  Tab: "\t",
};

/**
 * A key press for the cloud page. `text` rides only on a keyDown with no
 * command modifier — with one, the key is a shortcut and inserting its
 * letter would type into the page as well as run it — and only for a
 * printable character or one of the named keys above.
 */
export function keyInput(event: LiveKeyEvent, type: "keyDown" | "keyUp"): LiveInput | null {
  if (event.key === "") return null;
  const commanded = event.ctrlKey || event.metaKey;
  const named = KEY_TEXT[event.key];
  const text = [...event.key].length === 1 ? event.key : named;
  const code = virtualKeyCode(event.key, event.code);
  return {
    t: "input",
    event: {
      kind: "key",
      type,
      key: event.key,
      code: event.code,
      ...(type === "keyDown" && !commanded && text !== undefined ? { text } : {}),
      ...(code === undefined ? {} : { windowsVirtualKeyCode: code }),
      modifiers: liveModifiers(event),
    },
  };
}

/** The frame as an image source. Base64 only — nothing from the frame is parsed. */
export function frameSource(frame: LiveFrame): string {
  return `data:image/jpeg;base64,${frame.data}`;
}

/** The frame's aspect ratio for the CSS box, or the 1280×800 the runner opens with. */
export function frameAspectRatio(frame: LiveFrame | null): string {
  if (frame === null || frame.width <= 0 || frame.height <= 0) return "1280 / 800";
  return `${String(frame.width)} / ${String(frame.height)}`;
}
