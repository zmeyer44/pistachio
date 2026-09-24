/**
 * The DOM mirror's wire protocol (docs/web-browser-design.md §16).
 *
 * The cloud browser keeps running the website — its JavaScript, its cookies,
 * its network — and the person's browser renders a synchronized COPY of the
 * document: the tree, the styles, the form state, the assets. What crosses
 * the shell socket is a snapshot of one frame's document once, then small
 * operations ("insert these nodes", "this text changed", "this field now
 * holds this value"), and, the other way, input that names a NODE rather
 * than a pixel.
 *
 * THIS IS THE PROTOCOL, in the same spirit as `@pistachio/live-view` and the
 * shell socket: the recorder inside the cloud page, the host on the worker,
 * and the renderer in the person's browser all speak the shapes here, and
 * every one of them is bounded by zod before it is believed. Everything in a
 * snapshot is page-owned — a site chose every tag, attribute and string — so
 * the schemas are the first line of the renderer's defence, and the renderer
 * itself the second (`./renderer`).
 *
 * Two identities hold a mirror together. A node id is a small integer the
 * recorder assigned when it first saw the node, stable for the node's life
 * in that document; `1` is always the document itself. An EPOCH is one
 * serialization of one frame: every patch names the epoch it applies to and
 * carries a sequence number, so a renderer that sees a gap knows to ask for
 * the document again rather than apply an operation to the wrong tree.
 */

import { liveKeyEventSchema } from "@pistachio/live-view";
import { z } from "zod";
import { mediaStateSchema, mediaActionSchema, mediaBatchSchema } from "./media-protocol.js";
export * from "./media-protocol.js";

/* --------------------------------- limits --------------------------------- */

/** The document node's id in every frame. */
export const DOCUMENT_NODE_ID = 1;

/** The main frame's token; child frames get a random one from the host. */
export const MAIN_FRAME = "main";

/** Longest single text node, attribute value, or serialized stylesheet. */
export const MAX_STRING_BYTES = 4 * 1024 * 1024;

/** Nodes one snapshot may carry before the recorder calls the page too large. */
export const MAX_SNAPSHOT_NODES = 150_000;

/** Operations one patch may carry; the recorder splits beyond it. */
export const MAX_PATCH_OPS = 20_000;

/** How deep a nested frame may be mirrored; deeper ones render as empty boxes. */
export const MAX_FRAME_DEPTH = 3;

/** A URL an attribute or a stylesheet may name (an image is a URL, not bytes). */
export const MAX_URL_LENGTH = 16 * 1024;

/** One asset's bytes; larger ones are not brokered and render as missing. */
export const MAX_ASSET_BYTES = 12 * 1024 * 1024;

/** One binary asset chunk on the socket. */
export const ASSET_CHUNK_BYTES = 256 * 1024;

/**
 * How an asset is named inside the mirrored document. The host rewrites every
 * `src`, `href`, `poster` and CSS `url()` it brokers to `pa-asset:<id>`, and
 * the renderer swaps that for a same-origin `blob:` URL once the bytes have
 * arrived — so the mirrored document never asks the network for anything.
 */
export const ASSET_SCHEME = "pa-asset:";

export function assetToken(id: string): string {
  return `${ASSET_SCHEME}${id}`;
}

/** The id inside an asset token, or null when the string is not one. */
export function assetIdOf(value: string): string | null {
  return value.startsWith(ASSET_SCHEME) ? value.slice(ASSET_SCHEME.length) : null;
}

/** Safe diagnostics: resource URLs, cookies and response bodies never cross here. */
export const assetFailureSchema = z.object({
  reason: z.enum(["pending", "source-http", "source-network", "capture", "too-large", "evicted", "unknown", "transport", "timeout", "queue"]),
  context: z.enum(["style", "font", "image", "media", "other"]).optional(),
  status: z.number().int().min(100).max(599).optional(),
});
export type AssetFailure = z.infer<typeof assetFailureSchema>;

/* --------------------------------- nodes ---------------------------------- */

const nodeId = z.number().int().min(1);
const bounded = z.string().max(MAX_STRING_BYTES);

/** Attribute names as the DOM reports them; the renderer filters the values. */
const attributes = z.record(z.string().max(512), bounded);

export interface MirrorElement {
  t: "e";
  id: number;
  /** `localName`, lower case for HTML. */
  tag: string;
  /** Namespace: absent for HTML, `svg` or `math` otherwise. */
  ns?: "svg" | "math";
  a?: Record<string, string>;
  /** Light-DOM children. Absent for `style`, `script`, `noscript`, `template`, `iframe`. */
  c?: MirrorNode[];
  /** The element's open shadow root, when it has one. */
  sh?: MirrorNode[];
  /** Constructed stylesheets adopted by that shadow root, serialized. */
  shs?: string[];
  /** The live `value` of a form control when it differs from its attribute. */
  v?: string;
  /** `checked` for a checkbox or radio. */
  ck?: boolean;
  /** `[scrollLeft, scrollTop]` when either is not zero. */
  sc?: [number, number];
  /** A 2D canvas's current pixels as a data URL. */
  cv?: string;
  /** A `style` or `link[rel=stylesheet]` element's rules, serialized from the CSSOM. */
  css?: string;
}

export interface MirrorText {
  t: "t";
  id: number;
  s: string;
}

export interface MirrorComment {
  t: "c";
  id: number;
  s: string;
}

export interface MirrorDoctype {
  t: "d";
  id: number;
  name: string;
}

export interface MirrorCdata {
  t: "cd";
  id: number;
  s: string;
}

export interface MirrorDocument {
  t: "doc";
  id: number;
  c: MirrorNode[];
  /** `document.adoptedStyleSheets`, serialized. */
  adopted?: string[];
  /** The document's own scroll position, when not at the origin. */
  sc?: [number, number];
}

export type MirrorNode = MirrorElement | MirrorText | MirrorComment | MirrorDoctype | MirrorCdata | MirrorDocument;

export const mirrorNodeSchema: z.ZodType<MirrorNode> = z.lazy(() =>
  z.union([
    z.object({
      t: z.literal("e"),
      id: nodeId,
      tag: z.string().min(1).max(256),
      ns: z.enum(["svg", "math"]).optional(),
      a: attributes.optional(),
      c: z.array(mirrorNodeSchema).optional(),
      sh: z.array(mirrorNodeSchema).optional(),
      shs: z.array(bounded).optional(),
      v: bounded.optional(),
      ck: z.boolean().optional(),
      sc: z.tuple([z.number(), z.number()]).optional(),
      cv: bounded.optional(),
      css: bounded.optional(),
    }),
    z.object({ t: z.literal("t"), id: nodeId, s: bounded }),
    z.object({ t: z.literal("c"), id: nodeId, s: bounded }),
    z.object({ t: z.literal("d"), id: nodeId, name: z.string().max(256) }),
    z.object({ t: z.literal("cd"), id: nodeId, s: bounded }),
    z.object({
      t: z.literal("doc"),
      id: nodeId,
      c: z.array(mirrorNodeSchema),
      adopted: z.array(bounded).optional(),
      sc: z.tuple([z.number(), z.number()]).optional(),
    }),
  ]),
);

/* ---------------------------------- ops ----------------------------------- */

export const mirrorOpSchema = z.discriminatedUnion("o", [
  /** Insert `n` under `p` (into its shadow root when `sh`), before sibling `b` (or at the end). An `n.id` already present is replaced. */
  z.object({ o: z.literal("add"), p: nodeId, b: nodeId.nullable(), n: mirrorNodeSchema, sh: z.boolean().optional() }),
  z.object({ o: z.literal("rm"), id: nodeId }),
  /** `v: null` removes the attribute. */
  z.object({ o: z.literal("attr"), id: nodeId, k: z.string().max(512), v: bounded.nullable() }),
  z.object({ o: z.literal("txt"), id: nodeId, s: bounded }),
  z.object({ o: z.literal("val"), id: nodeId, v: bounded }),
  z.object({ o: z.literal("chk"), id: nodeId, v: z.boolean() }),
  /** `id` is the document (1) or a scrolling element. */
  z.object({ o: z.literal("scroll"), id: nodeId, x: z.number(), y: z.number() }),
  /** A `style`/`link` element's rules changed (text or CSSOM). */
  z.object({ o: z.literal("css"), id: nodeId, s: bounded }),
  /** The adopted stylesheets of the document (1) or of a shadow host changed. */
  z.object({ o: z.literal("adopted"), id: nodeId, s: z.array(bounded) }),
  /** A shadow root appeared on an existing element. */
  z.object({ o: z.literal("shadow"), id: nodeId, c: z.array(mirrorNodeSchema), s: z.array(bounded).optional() }),
  z.object({ o: z.literal("canvas"), id: nodeId, u: bounded }),
  z.object({ o: z.literal("focus"), id: nodeId.nullable() }),
  z.object({ o: z.literal("title"), s: z.string().max(4096) }),
  z.object({ o: z.literal("url"), s: z.string().max(MAX_URL_LENGTH) }),
]);

export type MirrorOp = z.infer<typeof mirrorOpSchema>;

/* ------------------------------ frame → host ------------------------------ */

/**
 * What the recorder inside one frame reports to the host through its
 * binding. The host stamps the frame token, the epoch and the sequence on
 * the way out; the recorder knows neither (it does not know which frame it
 * is, and it must not be able to forge a sequence).
 */
export const UNSUITABLE_REASONS = ["webgl", "video", "plugin", "frame", "editor", "password", "asset", "too_large", "error"] as const;

export type UnsuitableReason = (typeof UNSUITABLE_REASONS)[number];

export const recorderReportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    documentId: z.string().max(128).optional(),
    epoch: z.number().int().optional(),
    url: z.string().max(MAX_URL_LENGTH),
    base: z.string().max(MAX_URL_LENGTH),
    title: z.string().max(4096),
    root: mirrorNodeSchema,
    focus: nodeId.nullable(),
    width: z.number(),
    height: z.number(),
    nodes: z.number().int().min(0),
  }),
  z.object({ kind: z.literal("patch"), documentId: z.string().max(128).optional(), epoch: z.number().int().optional(), ops: z.array(mirrorOpSchema).max(MAX_PATCH_OPS) }),
  z.object({ kind: z.literal("unsuitable"), documentId: z.string().max(128).optional(), epoch: z.number().int().optional(), reason: z.enum(UNSUITABLE_REASONS), detail: z.string().max(512).optional() }),
  /** A `blob:` resource the page holds in memory, extracted by the recorder. */
  z.object({
    kind: z.literal("blob"),
    documentId: z.string().max(128).optional(),
    epoch: z.number().int().optional(),
    url: z.string().max(MAX_URL_LENGTH),
    type: z.string().max(256),
    base64: z.string().max(Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 4),
  }),
]);

export type RecorderReport = z.infer<typeof recorderReportSchema>;

/* ------------------------------ host → viewer ----------------------------- */

const frameToken = z.string().min(1).max(64);

export const mirrorServerMessageSchema = z.discriminatedUnion("k", [
  z.object({ k: z.literal("editorFocused"), epoch: z.number().int().min(1), id: nodeId, ok: z.boolean() }),
  z.object({
    k: z.literal("snapshot"),
    frame: frameToken,
    epoch: z.number().int().min(1),
    /** The seq the first following patch continues from; a late joiner is not at 0. */
    seq: z.number().int().min(0),
    /** Where a child frame lives: the parent frame and its `iframe` node. Absent for the main frame. */
    host: z.object({ frame: frameToken, id: nodeId }).optional(),
    url: z.string().max(MAX_URL_LENGTH),
    title: z.string().max(4096),
    root: mirrorNodeSchema,
    focus: nodeId.nullable(),
    width: z.number(),
    height: z.number(),
  }),
  z.object({
    k: z.literal("patch"),
    frame: frameToken,
    epoch: z.number().int().min(1),
    seq: z.number().int().min(1),
    ops: z.array(mirrorOpSchema).max(MAX_PATCH_OPS),
  }),
  /** A child frame navigated away or was removed. */
  z.object({ k: z.literal("frameGone"), frame: frameToken }),
  /** The cloud applied this viewer's edit `rev` to node `id`. */
  z.object({ k: z.literal("edited"), frame: frameToken, epoch: z.number().int().min(1), seq: z.number().int().min(0), id: nodeId, rev: z.number().int().min(0), v: bounded }),
  z.object({ k: z.literal("scrolled"), frame: frameToken, epoch: z.number().int().min(1), id: nodeId, rev: z.number().int().min(0) }),
  z.object({ k: z.literal("media"), frame: frameToken, epoch: z.number().int().min(1), items: z.array(mediaStateSchema).max(32) }),
  z.object({ k: z.literal("mediaData"), frame: frameToken, epoch: z.number().int().min(1), batch: mediaBatchSchema }),
  z.object({ k: z.literal("mediaAck"), frame: frameToken, epoch: z.number().int().min(1), id: nodeId, rev: z.number().int().nonnegative(), ok: z.boolean() }),
  /** This page cannot be mirrored faithfully; the pane should fall back to pixels. */
  z.object({ k: z.literal("unsuitable"), reason: z.enum(UNSUITABLE_REASONS), detail: z.string().max(512).optional() }),
  z.object({ k: z.literal("assetReady"), id: z.string().max(128) }),
  /** An asset the document names could not be brokered; the renderer stops waiting for it. */
  z.object({ k: z.literal("assetMissing"), id: z.string().max(128), failure: assetFailureSchema.optional() }),
  /** The mirror stopped (tab gone, or the host let go); a new `attach` starts it again. */
  z.object({ k: z.literal("stopped") }),
]);

export type MirrorServerMessage = z.infer<typeof mirrorServerMessageSchema>;

/* ------------------------------ viewer → host ----------------------------- */

const fraction = z.number().min(-1).max(2);

export const MIRROR_POINTER_TYPES = ["mousePressed", "mouseReleased", "mouseMoved"] as const;

export const mirrorClientMessageSchema = z.discriminatedUnion("k", [
  z.object({ k: z.literal("focusEditor"), frame: frameToken, epoch: z.number().int().min(1), id: nodeId, point: z.object({ fx: z.number().min(0).max(1), fy: z.number().min(0).max(1), modifiers: z.number().int().min(0).max(15) }).optional() }),
  /** Start mirroring this tab into this viewer (or send the current document again). */
  z.object({ k: z.literal("attach") }),
  z.object({ k: z.literal("detach") }),
  /** The renderer applied everything up to `seq` of `epoch`. */
  z.object({ k: z.literal("ack"), frame: frameToken, epoch: z.number().int().min(1), seq: z.number().int().min(0) }),
  /** The renderer saw a gap; send the document again. */
  z.object({ k: z.literal("resync") }),
  /** Assets the renderer is still waiting for. */
  z.object({ k: z.literal("need"), transport: z.enum(["http", "socket"]).optional(), ids: z.array(z.string().max(128)).max(512) }),
  /**
   * A pointer event over a node. `fx`/`fy` are where inside the node's box
   * (0..1 across, 0..1 down), so the cloud can hit the same node whatever
   * its layout there says; `x`/`y` are the viewer's own viewport coordinates,
   * the fallback when the node is gone.
   */
  z.object({
    k: z.literal("pointer"),
    frame: frameToken,
    epoch: z.number().int().min(1),
    id: nodeId.nullable(),
    type: z.enum(MIRROR_POINTER_TYPES),
    fx: fraction,
    fy: fraction,
    x: z.number(),
    y: z.number(),
    button: z.enum(["none", "left", "middle", "right", "back", "forward"]),
    clickCount: z.number().int().min(0).max(8),
    modifiers: z.number().int().min(0).max(15),
  }),
  /** A key the viewer did not consume locally, addressed to the node that has focus there. */
  z.object({
    k: z.literal("key"),
    frame: frameToken,
    epoch: z.number().int().min(1),
    id: nodeId.nullable(),
    event: liveKeyEventSchema,
  }),
  z.object({ k: z.literal("media"), frame: frameToken, epoch: z.number().int().min(1), id: nodeId, rev: z.number().int().nonnegative(), command: mediaActionSchema }),
  /** An optimistic local edit of a text control: the whole value, and the caret. */
  z.object({
    k: z.literal("edit"),
    frame: frameToken,
    epoch: z.number().int().min(1),
    id: nodeId,
    rev: z.number().int().min(0),
    v: bounded,
    s: z.number().int().min(0).nullable(),
    e: z.number().int().min(0).nullable(),
    commit: z.boolean().optional(),
  }),
  /** The viewer scrolled a node (or the document, id 1) to here. */
  z.object({
    k: z.literal("scroll"),
    rev: z.number().int().min(0).default(0),
    frame: frameToken,
    epoch: z.number().int().min(1),
    id: nodeId,
    x: z.number(),
    y: z.number(),
  }),
]);

export type MirrorClientMessage = z.infer<typeof mirrorClientMessageSchema>;

/* ------------------------------ binary assets ----------------------------- */

/**
 * Assets travel as BINARY socket frames, beside the JSON ones, so a font does
 * not spend a third of its bytes on base64 and a stalled image never sits in
 * front of a patch. One frame is one chunk:
 *
 *   "PMA1" · u32 header length (little endian) · header JSON · bytes
 *
 * The header names the tab, the asset, its content type, this chunk's offset
 * and the asset's total size. A renderer that has every byte builds the
 * blob; one that is missing some asks with `need`.
 */
export const ASSET_MAGIC = "PMA1";

export const assetChunkHeaderSchema = z.object({
  tabId: z.string().min(1),
  id: z.string().min(1).max(128),
  type: z.string().max(256),
  offset: z.number().int().min(0),
  total: z.number().int().min(0).max(MAX_ASSET_BYTES),
});

export type AssetChunkHeader = z.infer<typeof assetChunkHeaderSchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeAssetChunk(header: AssetChunkHeader, bytes: Uint8Array): Uint8Array {
  const json = encoder.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + 4 + json.byteLength + bytes.byteLength);
  out.set(encoder.encode(ASSET_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, json.byteLength, true);
  out.set(json, 8);
  out.set(bytes, 8 + json.byteLength);
  return out;
}

/** Null for anything that is not a well-formed asset chunk; never throws. */
export function decodeAssetChunk(data: ArrayBuffer | Uint8Array): { header: AssetChunkHeader; bytes: Uint8Array } | null {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (view.byteLength < 8) return null;
  if (decoder.decode(view.subarray(0, 4)) !== ASSET_MAGIC) return null;
  const length = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(4, true);
  if (8 + length > view.byteLength) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(view.subarray(8, 8 + length)));
  } catch {
    return null;
  }
  const header = assetChunkHeaderSchema.safeParse(parsed);
  if (!header.success) return null;
  const bytes = view.subarray(8 + length);
  if (header.data.offset + bytes.byteLength > header.data.total) return null;
  return { header: header.data, bytes };
}

/* --------------------------------- pieces --------------------------------- */

/** What a pane asks the host to paint it with. */
export const PANE_RENDERERS = ["pixels", "dom"] as const;

export type PaneRenderer = (typeof PANE_RENDERERS)[number];
