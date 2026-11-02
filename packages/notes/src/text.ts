/**
 * A note as the words in it: what a reader would see rather than what was
 * typed — `**bold**` is one word, a link is its text, a picture is its alt,
 * a widget is nothing at all.
 */

import type { JSONContent } from "@tiptap/core";
import { htmlToJson } from "./dom.js";

/** Blocks whose contents are not prose: nothing in them is said or counted. */
const SILENT = new Set(["htmlBlock", "embed", "codeBlock", "horizontalRule"]);

function words(node: JSONContent, out: string[]): void {
  switch (node.type) {
    case "text":
      out.push(node.text ?? "");
      return;
    case "hardBreak":
      out.push(" ");
      return;
    case "image":
      out.push(String(node.attrs?.["alt"] ?? ""), " ");
      return;
    default:
      if (SILENT.has(node.type ?? "")) return;
      for (const child of node.content ?? []) words(child, out);
      // A block ends a word.
      if (node.type !== "doc" && node.type !== "text") out.push(" ");
  }
}

/** The document's prose, whitespace collapsed. */
export function jsonToPlainText(doc: JSONContent): string {
  const out: string[] = [];
  words(doc, out);
  return out.join("").replace(/\s+/gu, " ").trim();
}

/** A note's HTML as the words in it. */
export function noteToPlainText(html: string): string {
  return html.trim() === "" ? "" : jsonToPlainText(htmlToJson(html));
}

/** How long the note is, in words — the library's "412 words". */
export function noteWordCount(html: string): number {
  const text = noteToPlainText(html);
  return text === "" ? 0 : text.split(" ").length;
}
