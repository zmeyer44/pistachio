/**
 * Something a web page hands to the agent console's composer from its
 * right-click menu — "Add Image to Chat", "Add Selection to Chat" — staged
 * exactly as a dropped file would be. Built in the main process (which can
 * read the image through the tab's own session) and consumed by the shell.
 */

export type ChatInsert =
  | {
      kind: "image";
      name: string;
      mediaType: string;
      /** data:<mediaType>;base64,… — the image's own bytes. */
      url: string;
    }
  | {
      kind: "selection";
      text: string;
      /** The page the words were selected on, for the message and the chip. */
      title: string;
      url: string;
    };

/**
 * Per-attachment ceiling. A data: URL rides inside every later request too —
 * the thread is re-sent per turn — so this stays deliberately modest.
 */
export const MAX_CHAT_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** What the vision path accepts across the model families we talk to. */
export const CHAT_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** A selection longer than this is cut before it reaches the composer. */
export const MAX_CHAT_SELECTION_CHARS = 16_000;

const MAX_NAME = 256;
const MAX_URL = 4096;

export function isChatInsert(value: unknown): value is ChatInsert {
  if (typeof value !== "object" || value === null) return false;
  const insert = value as Record<string, unknown>;
  const text = (field: unknown, max: number): field is string => typeof field === "string" && field.length <= max;
  if (insert["kind"] === "image") {
    return (
      text(insert["name"], MAX_NAME) &&
      typeof insert["mediaType"] === "string" &&
      CHAT_IMAGE_TYPES.has(insert["mediaType"]) &&
      typeof insert["url"] === "string" &&
      insert["url"].startsWith(`data:${insert["mediaType"]};base64,`) &&
      // base64 is 4/3 the size of the bytes; the prefix is a rounding error.
      insert["url"].length <= Math.ceil(MAX_CHAT_ATTACHMENT_BYTES / 3) * 4 + 64
    );
  }
  if (insert["kind"] === "selection") {
    return (
      typeof insert["text"] === "string" &&
      insert["text"].trim() !== "" &&
      insert["text"].length <= MAX_CHAT_SELECTION_CHARS &&
      text(insert["title"], MAX_NAME) &&
      text(insert["url"], MAX_URL)
    );
  }
  return false;
}
