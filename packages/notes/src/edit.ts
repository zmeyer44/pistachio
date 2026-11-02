/**
 * The one edit the agent may make without holding the whole document
 * (docs/notes.md §6): it names a mode and, for `replace_section`, the heading
 * to write under. It works on the document's blocks rather than on its
 * markdown, so a callout, a toggle, a widget or a table elsewhere in the note
 * is not re-serialised through markdown — and lost or flattened — just because
 * a line was added at the end.
 */

import type { JSONContent } from "@tiptap/core";
import { htmlToJson, jsonToHtml } from "./dom.js";
import { markdownToJson } from "./markdown.js";

export type NoteEditMode = "replace" | "append" | "prepend" | "replace_section";

export interface NoteEdit {
  mode: NoteEditMode;
  /** The new text, as markdown. */
  markdown: string;
  /** The heading `replace_section` writes under, matched case-insensitively. */
  section?: string;
}

export type NoteEditResult = { ok: true; html: string } | { ok: false; error: string };

function blockText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return " ";
  return (node.content ?? []).map(blockText).join("");
}

function isEmptyParagraph(node: JSONContent): boolean {
  return node.type === "paragraph" && (node.content?.length ?? 0) === 0;
}

/** A document with nothing in it but the editor's own empty line. */
function isBlank(blocks: readonly JSONContent[]): boolean {
  return blocks.every(isEmptyParagraph);
}

function headingLevel(node: JSONContent): number | null {
  if (node.type !== "heading") return null;
  const level = Number(node.attrs?.["level"]);
  return Number.isFinite(level) ? level : 1;
}

export function applyNoteEdit(html: string, edit: NoteEdit): NoteEditResult {
  const body = markdownToJson(edit.markdown).content ?? [];
  const current = html.trim() === "" ? [] : (htmlToJson(html).content ?? []);
  let next: JSONContent[];
  switch (edit.mode) {
    case "replace":
      next = body;
      break;
    case "append":
      next = isBlank(current) ? body : [...current, ...body];
      break;
    case "prepend":
      next = isBlank(current) ? body : [...body, ...current];
      break;
    case "replace_section": {
      const section = (edit.section ?? "").trim();
      if (section === "") return { ok: false, error: "replace_section needs the heading to write under" };
      const wanted = section.toLowerCase();
      const start = current.findIndex((block) => headingLevel(block) !== null && blockText(block).trim().toLowerCase() === wanted);
      if (start === -1) return { ok: false, error: `no section titled "${section}" in this note` };
      const level = headingLevel(current[start]!)!;
      let end = start + 1;
      while (end < current.length) {
        const found = headingLevel(current[end]!);
        if (found !== null && found <= level) break;
        end += 1;
      }
      next = [...current.slice(0, start + 1), ...body, ...current.slice(end)];
      break;
    }
  }
  if (isBlank(next)) return { ok: true, html: "" };
  return { ok: true, html: jsonToHtml({ type: "doc", content: next }) };
}
