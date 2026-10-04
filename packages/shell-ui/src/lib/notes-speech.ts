/**
 * A note as prose to be spoken: the editor's `…` menu's Read aloud
 * (components/notes/NoteEditor.tsx). Its title, then its body the way the
 * reader speaks an article (shell-contracts reader.ts, readerSpeechText):
 * headings and list items their own sentences, so the voice pauses at each;
 * quotes as their paragraphs; a table row by row. Code, pictures and rules
 * are dropped — a synthesizer reading a code block aloud is noise — and so
 * is every bit of markdown's own punctuation, since this reads the document
 * the markdown stands for, not the markdown.
 */

import type { JSONContent } from "@tiptap/core";
import { markdownToDoc } from "./notes-markdown";

export function noteSpeechText(title: string, markdown: string): string {
  const parts: string[] = [];
  const heading = clean(title);
  if (heading !== "") parts.push(sentence(heading));
  speakBlocks(markdownToDoc(markdown).content ?? [], parts);
  return parts.filter((part) => part !== "").join("\n\n");
}

function speakBlocks(blocks: readonly JSONContent[], parts: string[]): void {
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        parts.push(sentence(inline(block)));
        break;
      case "paragraph":
        parts.push(inline(block));
        break;
      case "bulletList":
      case "orderedList":
      case "taskList":
        for (const item of block.content ?? []) speakItem(item, parts);
        break;
      case "blockquote":
        speakBlocks(block.content ?? [], parts);
        break;
      case "table":
        for (const row of block.content ?? []) parts.push(sentence((row.content ?? []).map(inline).filter((cell) => cell !== "").join(", ")));
        break;
      default:
        // codeBlock, image, horizontalRule: nothing to say.
        break;
    }
  }
}

/** A list item: its own text a sentence, then any list nested in it. */
function speakItem(item: JSONContent, parts: string[]): void {
  const children = item.content ?? [];
  const text = children.filter((child) => child.type === "paragraph").map(inline).join(" ");
  parts.push(sentence(clean(text)));
  speakBlocks(children.filter((child) => child.type !== "paragraph"), parts);
}

/** A block's words: its text, whatever marks it wears, line breaks as spaces. */
function inline(node: JSONContent): string {
  const words: string[] = [];
  const walk = (child: JSONContent): void => {
    if (child.type === "text") words.push(child.text ?? "");
    else if (child.type === "hardBreak") words.push(" ");
    else for (const grandchild of child.content ?? []) walk(grandchild);
  };
  walk(node);
  return clean(words.join(""));
}

function clean(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** End a fragment with a stop so the voice does not run it into the next line. */
function sentence(text: string): string {
  return text === "" || /[.!?:;]$/u.test(text) ? text : `${text}.`;
}
