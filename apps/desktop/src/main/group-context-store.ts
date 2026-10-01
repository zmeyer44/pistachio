/**
 * The tab groups' contexts (docs/desk-agent.md §3): each group's files and
 * facts, the things a person drops on its desk's Stack for the task the
 * group is for, and the facts the agent saves there.
 *
 * Kept the way notes are (note-store.ts): the index in
 * `<userData>/group-context.json`, read once and rewritten whole on every
 * change, and each file's bytes apart in `<userData>/group-blobs/<id>`, named
 * by the first 24 hex of their SHA-256, so a new fact re-seals a few
 * kilobytes rather than every file. Owner-only permissions throughout: these
 * are bookings and boarding passes.
 *
 * Two subscriptions, as with notes: `onChange` carries every context's view
 * to the renderer, `onRecordChange` names what a LOCAL write touched for the
 * workspace-sync lane, and a record that arrived through `applyRemote` is
 * never reported — that would hand the other device its own write back.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { docxText, xlsxText } from "@pistachio/documents";
import { MAX_CHAT_ATTACHMENT_BYTES } from "@pistachio/shell-contracts/chat-insert";
import {
  DOC_MEDIA_TYPE,
  DOCX_MEDIA_TYPE,
  groupContextMediaTypeOf,
  isGroupBlobId,
  isGroupContextMediaType,
  isTextMediaType,
  sanitizeGroupContext,
  XLSX_MEDIA_TYPE,
  MAX_GROUP_BLOB_BYTES,
  MAX_GROUP_CONTEXT_ITEMS,
  MAX_GROUP_FILE_BYTES,
  MAX_GROUP_TEXT_CHARS,
  type GroupBlob,
  type GroupContext,
  type GroupContextAuthor,
  type GroupContextFile,
  type GroupContextItem,
  type GroupContextMediaType,
  type GroupContextText,
  type GroupContextView,
  type GroupFileContent,
  type GroupFileForMessage,
  type GroupFileWrite,
  type GroupFileWriteResult,
} from "@pistachio/shell-contracts/desk-agent";
import type { GroupBlobRecord, GroupContextRecord } from "@pistachio/sync-protocol";
import { noDocumentConverter, type DocumentConverter } from "./document-convert";

/** The two registers a context's life is spread over (`group-context:`, `group-blob:`). */
export type GroupContextRecordKind = "groupContext" | "groupBlob";

/** What the index remembers about one stored file; the bytes are its own file. */
interface BlobMeta {
  id: string;
  mediaType: GroupContextMediaType;
  byteLength: number;
  createdAt: string;
}

interface GroupContextDocument {
  version: 1;
  contexts: GroupContext[];
  blobs: BlobMeta[];
}

/** A file the agent reads as a file (an image, a PDF) is sent to the model only up to this size. */
export const MAX_AGENT_FILE_BYTES = 8 * 1024 * 1024;
/** Pictures the model looks at as they are; the others it is shown as a PNG. */
const MODEL_IMAGE_TYPES = new Set<string>(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Pictures the shell cannot draw either (Chromium decodes neither): their window shows a PNG. */
const UNDRAWN_IMAGE_TYPES = new Set<string>(["image/heic", "image/heif", "image/tiff"]);
/** How many conversions (a .doc as .docx, a picture as PNG) are kept, so a window reopened does not wait on one again. */
const CONVERSION_CACHE = 12;
/** A text file's text is handed to the model up to this many characters. */
const MAX_AGENT_TEXT_CHARS = 60_000;
/** How long a file no context names is kept before it is collected. */
export const DEFAULT_BLOB_SWEEP_MS = 24 * 60 * 60 * 1_000;

/** What the agent reads of one item: text, or a file it looks at. */
export type GroupContextReading =
  | { item: GroupContextItem; text: string }
  | { item: GroupContextFile; file: { dataUrl: string; mediaType: string; name: string } };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sanitizeBlobMeta(value: unknown): BlobMeta | null {
  const raw = asRecord(value);
  const byteLength = raw["byteLength"];
  if (!isGroupBlobId(raw["id"]) || !isGroupContextMediaType(raw["mediaType"]) || typeof byteLength !== "number" || !Number.isInteger(byteLength) || byteLength < 0) return null;
  return { id: raw["id"], mediaType: raw["mediaType"], byteLength, createdAt: typeof raw["createdAt"] === "string" ? raw["createdAt"] : new Date(0).toISOString() };
}

/** Field by field: the hub hands our own docs back constantly, and an echo must not look like a change. */
function sameContext(a: GroupContext, b: GroupContext): boolean {
  return a.groupId === b.groupId && a.title === b.title && a.updatedAt === b.updatedAt && JSON.stringify(a.items) === JSON.stringify(b.items);
}

/** A name a file can be opened under: no separators, nothing hidden. */
function safeFileName(name: string): string {
  const cleaned = [...name]
    .map((char) => (char === "/" || char === "\\" || char === ":" || char.charCodeAt(0) === 0 ? "_" : char))
    .join("")
    .replace(/^\.+/, "")
    .trim();
  return cleaned === "" ? "file" : cleaned.slice(0, 120);
}

export class GroupContextStore {
  readonly #path: string;
  readonly #blobsDir: string;
  readonly #now: () => Date;
  readonly #listeners = new Set<(contexts: GroupContextView[]) => void>();
  readonly #recordListeners = new Set<(kind: GroupContextRecordKind, id: string) => void>();
  readonly #convert: DocumentConverter;
  /** Conversions made lately, by the bytes they were made from and what they were made into. */
  readonly #converted = new Map<string, Promise<Buffer>>();
  #contexts: GroupContext[];
  #blobs: BlobMeta[];

  constructor(userDataDir: string, options: { now?: () => Date; convert?: DocumentConverter } = {}) {
    this.#path = join(userDataDir, "group-context.json");
    this.#blobsDir = join(userDataDir, "group-blobs");
    this.#now = options.now ?? (() => new Date());
    this.#convert = options.convert ?? noDocumentConverter();
    const document = this.#read();
    this.#contexts = document.contexts;
    this.#blobs = document.blobs;
  }

  /* ------------------------------ reading ------------------------------ */

  /** Every context this Mac holds, other Macs' groups included, each file saying whether its bytes are here. */
  list(): GroupContextView[] {
    const here = new Set(this.#blobs.map((blob) => blob.id));
    return this.#contexts.map((context) => ({
      groupId: context.groupId,
      title: context.title,
      updatedAt: context.updatedAt,
      items: context.items.map((item) => ({ ...structuredClone(item), here: item.kind !== "file" || here.has(item.blobId) })),
    }));
  }

  get(groupId: string): GroupContext | null {
    const context = this.#contexts.find((candidate) => candidate.groupId === groupId);
    return context === undefined ? null : structuredClone(context);
  }

  items(groupId: string): GroupContextItem[] {
    return this.get(groupId)?.items ?? [];
  }

  /**
   * One item as the agent reads it: a fact's text; a text file's, a Word
   * document's or a workbook's text; an image or a PDF to look at (a
   * picture the model cannot look at as it is, as a PNG).
   */
  async read(groupId: string, itemId: string): Promise<GroupContextReading> {
    const item = this.items(groupId).find((candidate) => candidate.id === itemId);
    if (item === undefined) throw new Error(`no item ${itemId} in this group's context; the desk block lists what is there`);
    if (item.kind !== "file") {
      const source = item.url === undefined ? "" : `\n(from ${item.title === undefined ? "" : `“${item.title}” `}${item.url})`;
      return { item, text: `${item.text}${source}` };
    }
    const bytes = this.#readBlob(item.blobId);
    if (bytes === null) throw new Error(`“${item.name}” was added on another Mac and is too large to sync here`);
    const cut = (text: string): string => (text.length > MAX_AGENT_TEXT_CHARS ? `${text.slice(0, MAX_AGENT_TEXT_CHARS)}\n[… cut at ${String(MAX_AGENT_TEXT_CHARS)} characters]` : text);
    if (isTextMediaType(item.mediaType) || item.mediaType === "image/svg+xml") return { item, text: cut(bytes.toString("utf8")) };
    try {
      if (item.mediaType === DOCX_MEDIA_TYPE) return { item, text: docxText(bytes, MAX_AGENT_TEXT_CHARS) };
      if (item.mediaType === XLSX_MEDIA_TYPE) return { item, text: xlsxText(bytes, MAX_AGENT_TEXT_CHARS) };
      if (item.mediaType === DOC_MEDIA_TYPE) return { item, text: cut(await this.#convert.docText(bytes)) };
    } catch {
      throw new Error(`“${item.name}” could not be read: it may be damaged, or protected by a password`);
    }
    let shown = bytes;
    let mediaType: string = item.mediaType;
    if (item.mediaType.startsWith("image/") && !MODEL_IMAGE_TYPES.has(item.mediaType)) {
      shown = await this.#conversion(item, "png");
      mediaType = "image/png";
    }
    if (shown.byteLength > MAX_AGENT_FILE_BYTES) throw new Error(`“${item.name}” is too large for the model to read (${String(Math.round(shown.byteLength / 1024 / 1024))} MB)`);
    return { item, file: { dataUrl: `data:${mediaType};base64,${shown.toString("base64")}`, mediaType, name: item.name } };
  }

  /** A conversion of a file's bytes (a .doc as .docx, a picture as PNG), made once and kept a while. */
  #conversion(item: GroupContextFile, into: "docx" | "png"): Promise<Buffer> {
    const key = `${item.blobId}:${into}`;
    const cached = this.#converted.get(key);
    if (cached !== undefined) {
      // Most recently used last.
      this.#converted.delete(key);
      this.#converted.set(key, cached);
      return cached;
    }
    const bytes = this.#readBlob(item.blobId);
    if (bytes === null) return Promise.reject(new Error(`“${item.name}” is not on this Mac`));
    const extension = item.name.toLowerCase().split(".").pop() ?? "";
    const made = into === "docx" ? this.#convert.docToDocx(bytes) : this.#convert.imageToPng(bytes, extension);
    this.#converted.set(key, made);
    made.catch(() => this.#converted.delete(key));
    while (this.#converted.size > CONVERSION_CACHE) this.#converted.delete(this.#converted.keys().next().value!);
    return made;
  }

  /**
   * A file's bytes for its window on the desk (docs/desk-documents.md), and
   * what the window draws instead when the shell cannot draw it: a .doc as
   * a .docx, a HEIC or TIFF picture as a PNG. Null when the bytes are not
   * on this Mac.
   */
  async fileContent(groupId: string, itemId: string): Promise<GroupFileContent | null> {
    const item = this.items(groupId).find((candidate): candidate is GroupContextFile => candidate.id === itemId && candidate.kind === "file");
    if (item === undefined) return null;
    const bytes = this.#readBlob(item.blobId);
    if (bytes === null) return null;
    const content: GroupFileContent = { itemId, blobId: item.blobId, name: item.name, mediaType: item.mediaType, bytes: new Uint8Array(bytes) };
    if (item.mediaType === DOC_MEDIA_TYPE) content.shown = { mediaType: DOCX_MEDIA_TYPE, bytes: new Uint8Array(await this.#conversion(item, "docx")) };
    else if (UNDRAWN_IMAGE_TYPES.has(item.mediaType)) content.shown = { mediaType: "image/png", bytes: new Uint8Array(await this.#conversion(item, "png")) };
    return content;
  }

  /**
   * A document edited in its window: its new bytes become the file, over
   * the version it was edited from — refused when the file has changed
   * since, unless the person chose to keep theirs (`force`). A .doc is
   * edited as a .docx and written back as a .doc. The version it replaces
   * goes once nothing names it, here and on the person's other Macs.
   */
  async writeFile(write: GroupFileWrite): Promise<GroupFileWriteResult> {
    const find = (): GroupContextFile | undefined =>
      this.#contexts.find((context) => context.groupId === write.groupId)?.items.find((candidate): candidate is GroupContextFile => candidate.id === write.itemId && candidate.kind === "file");
    const before = find();
    if (before === undefined) return { ok: false, reason: "gone", message: "That file is no longer in this desk's context" };
    if (write.force !== true && before.blobId !== write.baseBlobId) return { ok: false, reason: "changed", message: `“${before.name}” was changed elsewhere since it was opened` };
    let bytes: Buffer = Buffer.from(write.bytes);
    if (write.as === "docx") {
      if (before.mediaType === DOC_MEDIA_TYPE) {
        try {
          bytes = await this.#convert.docxToDoc(bytes);
        } catch {
          return { ok: false, reason: "failed", message: `“${before.name}” could not be written as a Word 97–2004 document` };
        }
      } else if (before.mediaType !== DOCX_MEDIA_TYPE) return { ok: false, reason: "failed", message: "Only a Word document can be written as one" };
    }
    if (bytes.byteLength > MAX_GROUP_FILE_BYTES) return { ok: false, reason: "too-large", message: `“${before.name}” would be larger than ${String(MAX_GROUP_FILE_BYTES / 1024 / 1024)} MB` };
    // Looked up again: the conversion took a moment, and the file may have gone or changed meanwhile.
    const item = find();
    if (item === undefined) return { ok: false, reason: "gone", message: "That file is no longer in this desk's context" };
    if (write.force !== true && item.blobId !== write.baseBlobId) return { ok: false, reason: "changed", message: `“${item.name}” was changed elsewhere since it was opened` };
    const context = this.#contexts.find((candidate) => candidate.groupId === write.groupId)!;
    const blobId = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
    const changed: Array<[GroupContextRecordKind, string]> = [];
    if (!this.#blobs.some((blob) => blob.id === blobId)) {
      this.#writeBlob(blobId, bytes);
      this.#blobs.push({ id: blobId, mediaType: item.mediaType, byteLength: bytes.byteLength, createdAt: this.#now().toISOString() });
      if (bytes.byteLength <= MAX_GROUP_BLOB_BYTES) changed.push(["groupBlob", blobId]);
    }
    const old = item.blobId;
    const oldLength = item.byteLength;
    item.blobId = blobId;
    item.byteLength = bytes.byteLength;
    item.editedAt = this.#now().toISOString();
    this.#touch(context);
    changed.push(["groupContext", write.groupId]);
    if (old !== blobId && !this.#referenced(old)) {
      this.#blobs = this.#blobs.filter((blob) => blob.id !== old);
      this.#removeBlob(old);
      if (oldLength <= MAX_GROUP_BLOB_BYTES) changed.unshift(["groupBlob", old]);
    }
    this.#commit(...changed);
    return { ok: true, item: structuredClone(item) };
  }

  /**
   * A file as a message carries it when the person @mentions it: its text
   * (a Word document's and a workbook's too), or the file for the model to
   * look at — too large to attach, a note that it is in the context.
   */
  async forMessage(groupId: string, itemId: string): Promise<GroupFileForMessage> {
    const item = this.items(groupId).find((candidate) => candidate.id === itemId);
    const name = item?.kind === "file" ? item.name : "that file";
    try {
      const reading = await this.read(groupId, itemId);
      if ("text" in reading) return { kind: "text", name, text: reading.text };
      if (reading.file.dataUrl.length > Math.ceil(MAX_CHAT_ATTACHMENT_BYTES / 3) * 4 + 64) return { kind: "reference", name, reason: "too large to attach" };
      return { kind: "file", name, mediaType: reading.file.mediaType, dataUrl: reading.file.dataUrl };
    } catch (error) {
      return { kind: "reference", name, reason: error instanceof Error ? error.message : "it could not be read" };
    }
  }

  /** A copy of a file under its own name, in a private temporary folder, for the Mac to open in its own app. */
  openablePath(groupId: string, itemId: string): string | null {
    const item = this.items(groupId).find((candidate) => candidate.id === itemId);
    if (item === undefined || item.kind !== "file") return null;
    const bytes = this.#readBlob(item.blobId);
    if (bytes === null) return null;
    const dir = join(tmpdir(), "pistachio-context", item.blobId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, safeFileName(item.name));
    writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  }

  /* ------------------------------ writing ------------------------------ */

  /**
   * Files dropped on the Stack. Each is kept if it is a kind the agent can
   * read and within MAX_GROUP_FILE_BYTES; the same bytes dropped twice are
   * one file. Returns what was added and what was not, and why.
   */
  addFiles(
    groupId: string,
    title: string,
    files: ReadonlyArray<{ name: string; mediaType: string; bytes: Buffer }>,
    addedBy: GroupContextAuthor = "person",
  ): { added: GroupContextFile[]; kept: GroupContextFile[]; rejected: Array<{ name: string; reason: string }> } {
    const context = this.#contextFor(groupId, title);
    const added: GroupContextFile[] = [];
    // What the drop comes to: the files added, and those already here (the same bytes dropped again).
    const kept: GroupContextFile[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    const blobsChanged: string[] = [];
    for (const file of files) {
      const mediaType = groupContextMediaTypeOf(file.name, file.mediaType);
      if (mediaType === null) {
        rejected.push({ name: file.name, reason: "Pistachio can open pictures, PDFs, text, Word and Excel files" });
        continue;
      }
      if (file.bytes.byteLength > MAX_GROUP_FILE_BYTES) {
        rejected.push({ name: file.name, reason: `larger than ${String(MAX_GROUP_FILE_BYTES / 1024 / 1024)} MB` });
        continue;
      }
      if (context.items.length >= MAX_GROUP_CONTEXT_ITEMS) {
        rejected.push({ name: file.name, reason: `the context already holds ${String(MAX_GROUP_CONTEXT_ITEMS)} things` });
        continue;
      }
      const blobId = createHash("sha256").update(file.bytes).digest("hex").slice(0, 24);
      if (!this.#blobs.some((blob) => blob.id === blobId)) {
        this.#writeBlob(blobId, file.bytes);
        this.#blobs.push({ id: blobId, mediaType, byteLength: file.bytes.byteLength, createdAt: this.#now().toISOString() });
        // Too large to sync, it stays on this Mac, and there is no register to write.
        if (file.bytes.byteLength <= MAX_GROUP_BLOB_BYTES) blobsChanged.push(blobId);
      }
      const existing = context.items.find((item): item is GroupContextFile => item.kind === "file" && item.blobId === blobId);
      if (existing !== undefined) {
        kept.push(existing);
        continue;
      }
      const item: GroupContextFile = {
        id: newItemId(),
        kind: "file",
        name: safeFileName(file.name),
        mediaType,
        byteLength: file.bytes.byteLength,
        blobId,
        addedAt: this.#now().toISOString(),
        addedBy,
      };
      context.items.push(item);
      added.push(item);
      kept.push(item);
    }
    if (added.length > 0 || blobsChanged.length > 0) {
      this.#touch(context);
      this.#commit(...blobsChanged.map((id): [GroupContextRecordKind, string] => ["groupBlob", id]), ["groupContext", groupId]);
    }
    return { added: structuredClone(added), kept: structuredClone(kept), rejected };
  }

  /** A fact, a snippet of a page, or a link. */
  addText(
    groupId: string,
    title: string,
    input: { kind: GroupContextText["kind"]; text: string; url?: string; title?: string },
    addedBy: GroupContextAuthor = "person",
  ): GroupContextText {
    const text = input.text.trim().slice(0, MAX_GROUP_TEXT_CHARS);
    if (text === "") throw new Error("nothing to save: the text is empty");
    const context = this.#contextFor(groupId, title);
    if (context.items.length >= MAX_GROUP_CONTEXT_ITEMS) throw new Error(`the group's context already holds ${String(MAX_GROUP_CONTEXT_ITEMS)} things; one must be removed first`);
    const item: GroupContextText = {
      id: newItemId(),
      kind: input.kind,
      text,
      ...(input.title === undefined || input.title.trim() === "" ? {} : { title: input.title.trim().slice(0, 300) }),
      ...(input.url === undefined || input.url === "" ? {} : { url: input.url.slice(0, 2_048) }),
      addedAt: this.#now().toISOString(),
      addedBy,
    };
    context.items.push(item);
    this.#touch(context);
    this.#commit(["groupContext", groupId]);
    return structuredClone(item);
  }

  remove(groupId: string, itemId: string): boolean {
    const context = this.#contexts.find((candidate) => candidate.groupId === groupId);
    if (context === undefined) return false;
    const item = context.items.find((candidate) => candidate.id === itemId);
    if (item === undefined) return false;
    context.items = context.items.filter((candidate) => candidate.id !== itemId);
    this.#touch(context);
    const changed: Array<[GroupContextRecordKind, string]> = [["groupContext", groupId]];
    // A file no context names any more goes, and so does its register everywhere.
    if (item.kind === "file" && !this.#referenced(item.blobId)) {
      this.#blobs = this.#blobs.filter((blob) => blob.id !== item.blobId);
      this.#removeBlob(item.blobId);
      if (item.byteLength <= MAX_GROUP_BLOB_BYTES) changed.unshift(["groupBlob", item.blobId]);
    }
    this.#commit(...changed);
    return true;
  }

  /**
   * Another group's context (a group from another Mac that is not on this
   * one) copied into this group's: its files and facts, not the group. The
   * two go their own ways afterwards. Returns how many items came over.
   */
  adopt(groupId: string, title: string, fromGroupId: string): number {
    const from = this.#contexts.find((candidate) => candidate.groupId === fromGroupId);
    if (from === undefined || fromGroupId === groupId) return 0;
    const context = this.#contextFor(groupId, title);
    let copied = 0;
    for (const item of from.items) {
      if (context.items.length >= MAX_GROUP_CONTEXT_ITEMS) break;
      if (item.kind === "file" && context.items.some((existing) => existing.kind === "file" && existing.blobId === item.blobId)) continue;
      context.items.push({ ...structuredClone(item), id: newItemId() });
      copied += 1;
    }
    if (copied > 0) {
      this.#touch(context);
      this.#commit(["groupContext", groupId]);
    }
    return copied;
  }

  onChange(listener: (contexts: GroupContextView[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Which record a LOCAL write touched, for the workspace-sync lane. */
  onRecordChange(listener: (kind: GroupContextRecordKind, id: string) => void): () => void {
    this.#recordListeners.add(listener);
    return () => this.#recordListeners.delete(listener);
  }

  /* -------------------------------- sync -------------------------------- */

  /** Every record of one kind, complete. A file larger than MAX_GROUP_BLOB_BYTES stays on this Mac. */
  syncAll(kind: "groupContext"): GroupContextRecord[];
  syncAll(kind: "groupBlob"): GroupBlobRecord[];
  syncAll(kind: GroupContextRecordKind): Array<GroupContextRecord | GroupBlobRecord>;
  syncAll(kind: GroupContextRecordKind): Array<GroupContextRecord | GroupBlobRecord> {
    if (kind === "groupContext") return structuredClone(this.#contexts);
    return this.#blobs.flatMap((meta) => {
      const blob = this.getBlob(meta.id);
      return blob === null ? [] : [blob];
    });
  }

  /** One record, for the sync lane to publish (null: gone, or not one that syncs). */
  syncGet(kind: GroupContextRecordKind, id: string): GroupContextRecord | GroupBlobRecord | null {
    return kind === "groupContext" ? this.get(id) : this.getBlob(id);
  }

  /** A file's bytes as its register holds them, or null when it is gone or too large to sync. */
  getBlob(id: string): GroupBlob | null {
    const meta = this.#blobs.find((blob) => blob.id === id);
    if (meta === undefined || meta.byteLength > MAX_GROUP_BLOB_BYTES) return null;
    const bytes = this.#readBlob(id);
    if (bytes === null) return null;
    return { ...meta, data: bytes.toString("base64") };
  }

  applyRemote(kind: "groupContext", value: unknown): GroupContextRecord | null;
  applyRemote(kind: "groupBlob", value: unknown): GroupBlobRecord | null;
  applyRemote(kind: GroupContextRecordKind, value: unknown): GroupContextRecord | GroupBlobRecord | null;
  applyRemote(kind: GroupContextRecordKind, value: unknown): GroupContextRecord | GroupBlobRecord | null {
    return kind === "groupContext" ? this.#applyRemoteContext(value) : this.#applyRemoteBlob(value);
  }

  /** Another device deleted it. */
  removeRemote(kind: GroupContextRecordKind, id: string): boolean {
    if (kind === "groupBlob") {
      const before = this.#blobs.length;
      this.#blobs = this.#blobs.filter((blob) => blob.id !== id);
      if (this.#blobs.length === before) return false;
      this.#removeBlob(id);
      this.#commit();
      return true;
    }
    const before = this.#contexts.length;
    this.#contexts = this.#contexts.filter((context) => context.groupId !== id);
    if (this.#contexts.length === before) return false;
    this.#commit();
    return true;
  }

  /** Files no context names, older than `olderThanMs`: gone from disk. Local only; their registers were tombstoned when the last item went. */
  sweepOrphanBlobs(olderThanMs = DEFAULT_BLOB_SWEEP_MS): number {
    const cutoff = this.#now().getTime() - olderThanMs;
    const orphans = this.#blobs.filter((blob) => !this.#referenced(blob.id) && Date.parse(blob.createdAt) < cutoff);
    if (orphans.length === 0) return 0;
    for (const blob of orphans) this.#removeBlob(blob.id);
    const gone = new Set(orphans.map((blob) => blob.id));
    this.#blobs = this.#blobs.filter((blob) => !gone.has(blob.id));
    this.#commit();
    return orphans.length;
  }

  /* ------------------------------ internals ----------------------------- */

  #applyRemoteContext(value: unknown): GroupContextRecord | null {
    const incoming = sanitizeGroupContext(value);
    if (incoming === null) return null;
    const index = this.#contexts.findIndex((context) => context.groupId === incoming.groupId);
    const current = index === -1 ? null : (this.#contexts[index] ?? null);
    if (current !== null && sameContext(current, incoming)) return structuredClone(incoming);
    if (index === -1) this.#contexts.push(incoming);
    else this.#contexts[index] = incoming;
    this.#commit();
    return structuredClone(incoming);
  }

  #applyRemoteBlob(value: unknown): GroupBlobRecord | null {
    const raw = asRecord(value);
    const meta = sanitizeBlobMeta(raw);
    if (meta === null || typeof raw["data"] !== "string" || meta.byteLength > MAX_GROUP_BLOB_BYTES) return null;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(raw["data"], "base64");
    } catch {
      return null;
    }
    // Content addressing is the whole guarantee of these registers: bytes
    // whose hash is not their key are somebody else's, and are not kept.
    if (bytes.byteLength !== meta.byteLength) return null;
    if (createHash("sha256").update(bytes).digest("hex").slice(0, 24) !== meta.id) return null;
    const index = this.#blobs.findIndex((blob) => blob.id === meta.id);
    if (index !== -1 && this.#readBlob(meta.id) !== null) return { ...meta, data: raw["data"] };
    try {
      this.#writeBlob(meta.id, bytes);
    } catch {
      return null;
    }
    if (index === -1) this.#blobs.push(meta);
    else this.#blobs[index] = meta;
    this.#commit();
    return { ...meta, data: raw["data"] };
  }

  #contextFor(groupId: string, title: string): GroupContext {
    let context = this.#contexts.find((candidate) => candidate.groupId === groupId);
    if (context === undefined) {
      context = { groupId, title, items: [], updatedAt: this.#now().toISOString() };
      this.#contexts.push(context);
    }
    if (title.trim() !== "") context.title = title.trim().slice(0, 300);
    return context;
  }

  #touch(context: GroupContext): void {
    context.updatedAt = this.#now().toISOString();
  }

  #referenced(blobId: string): boolean {
    return this.#contexts.some((context) => context.items.some((item) => item.kind === "file" && item.blobId === blobId));
  }

  #readBlob(id: string): Buffer | null {
    if (!isGroupBlobId(id)) return null;
    try {
      return readFileSync(join(this.#blobsDir, id));
    } catch {
      return null;
    }
  }

  #writeBlob(id: string, bytes: Buffer): void {
    mkdirSync(this.#blobsDir, { recursive: true, mode: 0o700 });
    const path = join(this.#blobsDir, id);
    writeFileSync(`${path}.tmp`, bytes, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  #removeBlob(id: string): void {
    if (!isGroupBlobId(id)) return;
    try {
      rmSync(join(this.#blobsDir, id), { force: true });
    } catch {
      // The bytes are named by the index, not the other way round.
    }
  }

  #read(): GroupContextDocument {
    try {
      const raw = asRecord(JSON.parse(readFileSync(this.#path, "utf8")));
      const contexts = Array.isArray(raw["contexts"]) ? (raw["contexts"] as unknown[]) : [];
      const blobs = Array.isArray(raw["blobs"]) ? (raw["blobs"] as unknown[]) : [];
      return {
        version: 1,
        contexts: contexts.flatMap((entry) => {
          const context = sanitizeGroupContext(entry);
          return context === null ? [] : [context];
        }),
        blobs: blobs.flatMap((entry) => {
          const meta = sanitizeBlobMeta(entry);
          return meta === null ? [] : [meta];
        }),
      };
    } catch {
      return { version: 1, contexts: [], blobs: [] };
    }
  }

  #write(): void {
    const document: GroupContextDocument = { version: 1, contexts: this.#contexts, blobs: this.#blobs };
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(`${this.#path}.tmp`, JSON.stringify(document), { mode: 0o600 });
    renameSync(`${this.#path}.tmp`, this.#path);
  }

  #commit(...changed: Array<[GroupContextRecordKind, string]>): void {
    this.#write();
    const views = this.list();
    for (const listener of this.#listeners) {
      try {
        listener(structuredClone(views));
      } catch (error) {
        console.error("[group-context] listener failed", error);
      }
    }
    for (const [kind, id] of changed) {
      for (const listener of this.#recordListeners) {
        try {
          listener(kind, id);
        } catch (error) {
          console.error("[group-context] record listener failed", error);
        }
      }
    }
  }
}

function newItemId(): string {
  return randomBytes(6).toString("hex");
}
