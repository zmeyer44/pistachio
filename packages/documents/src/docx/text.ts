/**
 * A Word document as the agent reads it (docs/desk-documents.md §3): its
 * text as markdown — headings, list items with their markers, tables as
 * tables — and what cannot be edited, as it shows.
 */

import type { DocxBlock, DocxInline } from "./json.js";
import { ListCounter } from "./numbering.js";
import { openDocx } from "./read.js";

function inlineText(content: readonly DocxInline[] | undefined): string {
  return (content ?? [])
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "docxBreak":
          return "\n";
        case "docxImage":
          return node.attrs.alt === "" ? "[picture]" : `[picture: ${node.attrs.alt}]`;
        case "docxLocked":
          return node.attrs.text;
      }
    })
    .join("");
}

export function docxText(bytes: Uint8Array, maxChars: number): string {
  const { view } = openDocx(bytes);
  const counter = new ListCounter(view.lists);
  const lines: string[] = [];
  const write = (blocks: readonly DocxBlock[], inCell: boolean): string[] => {
    const out: string[] = [];
    for (const block of blocks) {
      if (block.type === "docxParagraph") {
        const text = inlineText(block.content);
        const marker = counter.next(block.attrs.numId, block.attrs.ilvl);
        const heading = !inCell && /^h[1-6]$/.test(block.attrs.role) ? `${"#".repeat(Number(block.attrs.role.slice(1)))} ` : "";
        const indent = marker === null ? "" : "  ".repeat(block.attrs.ilvl);
        out.push(`${heading}${indent}${marker === null ? "" : `${marker === "•" ? "-" : marker} `}${text}`);
      } else if (block.type === "docxLockedBlock") out.push(block.attrs.text);
      else {
        for (const row of block.content) {
          const cells = row.content.map((cell) => write(cell.content, true).join(" ").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " "));
          out.push(`| ${cells.join(" | ")} |`);
        }
      }
    }
    return out;
  };
  lines.push(...write(view.doc.content, false));
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[… cut at ${String(maxChars)} characters]` : text;
}
