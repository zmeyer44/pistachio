/**
 * Files dropped onto the agent console, staged for the NEXT message.
 *
 * Three kinds, split by how they reach the agent:
 *  - "image" and "pdf" travel as AgentAttachments (data: URLs) so the model
 *    sees the actual pixels or document through the provider's vision path,
 *    and the thread can render them back.
 *  - "text" is decoded here and folded into the message body as a fenced
 *    block — every model reads text, and the transcript then shows exactly
 *    what was sent rather than a name the reader has to trust.
 */

import type { AgentAttachment } from "@pistachio/protocol";
import {
  CHAT_IMAGE_TYPES as IMAGE_TYPES,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_SELECTION_CHARS,
  type ChatInsert,
} from "@pistachio/shell-contracts/chat-insert";

export interface ComposerAttachment {
  id: string;
  /** The file's name — or, for a selection, the title of the page it came from. */
  name: string;
  mediaType: string;
  /**
   * data: URL for image/pdf; the page's address for a selection; empty for
   * text (its contents ride in `text`).
   */
  url: string;
  kind: "image" | "pdf" | "text" | "selection";
  text?: string;
}

/**
 * Per-file ceiling. A data: URL rides inside every later request too — the
 * thread is re-sent per turn — so this stays deliberately modest.
 */
export const MAX_ATTACHMENT_BYTES = MAX_CHAT_ATTACHMENT_BYTES;
export const MAX_COMPOSER_ATTACHMENTS = 6;
/** A dropped text file longer than this is truncated into the message. */
const MAX_TEXT_ATTACHMENT_CHARS = MAX_CHAT_SELECTION_CHARS;

/**
 * Code-ish and prose-ish extensions, accepted even when the OS reports no
 * usable MIME type — plain files often arrive with an empty `type`.
 */
const TEXT_FILE_RE =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cc|cpp|sh|zsh|toml|ini|cfg|conf|log|sql|diff|patch)$/i;

export type AttachmentResult =
  | { ok: true; attachment: ComposerAttachment }
  | { ok: false; reason: string };

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

/** Classify and read one dropped file; refusals carry a display-ready reason. */
export async function readComposerAttachment(file: File): Promise<AttachmentResult> {
  const name = file.name === "" ? "file" : file.name;
  if (file.size === 0) return { ok: false, reason: `${name} is empty` };
  if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: `${name} is over 4 MB` };
  const id = crypto.randomUUID();
  const mediaType = file.type;
  if (IMAGE_TYPES.has(mediaType)) {
    return { ok: true, attachment: { id, name, mediaType, url: await fileToDataUrl(file), kind: "image" } };
  }
  if (mediaType === "application/pdf" || /\.pdf$/i.test(name)) {
    return {
      ok: true,
      attachment: {
        id,
        name,
        mediaType: "application/pdf",
        url: await fileToDataUrl(file),
        kind: "pdf",
      },
    };
  }
  if (mediaType.startsWith("text/") || mediaType === "application/json" || TEXT_FILE_RE.test(name)) {
    return {
      ok: true,
      attachment: { id, name, mediaType: "text/plain", url: "", kind: "text", text: await file.text() },
    };
  }
  return { ok: false, reason: `${name}: only images, PDFs, and text files can be attached` };
}

function fenced(text: string): string {
  const clamped =
    text.length > MAX_TEXT_ATTACHMENT_CHARS
      ? `${text.slice(0, MAX_TEXT_ATTACHMENT_CHARS)}\n… (truncated)`
      : text;
  // ```` fence so a file containing ``` cannot break out of the block.
  return `\`\`\`\`\n${clamped}\n\`\`\`\``;
}

/** The fenced block a sent message carries for one dropped text file. */
export function formatAttachmentText(name: string, text: string): string {
  return `Attached file “${name}”:\n${fenced(text)}`;
}

/** The fenced block a sent message carries for words selected on a page. */
export function formatSelectionText(title: string, url: string, text: string): string {
  const source = title.trim() === "" ? url : `${title.trim()} (${url})`;
  return `Selected on ${source}:\n${fenced(text)}`;
}

/** What a page's right-click menu handed over, staged like a dropped file. */
export function composerAttachmentFromInsert(insert: ChatInsert): ComposerAttachment {
  const id = crypto.randomUUID();
  if (insert.kind === "image") {
    return { id, name: insert.name, mediaType: insert.mediaType, url: insert.url, kind: "image" };
  }
  return { id, name: insert.title, mediaType: "text/plain", url: insert.url, kind: "selection", text: insert.text };
}

/** The words a selection chip shows: its first line, shortened. */
export function selectionChipLabel(text: string, limit = 40): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

/** What a staged file becomes on the wire. Text never makes the trip — it rode in the body. */
export function toAgentAttachments(staged: ComposerAttachment[]): AgentAttachment[] {
  return staged
    .filter((file) => file.kind === "image" || file.kind === "pdf")
    .map(({ id, name, mediaType, url }) => ({ id, name, mediaType, url }));
}
