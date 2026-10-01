/**
 * A Word document as its editor holds it (docs/desk-documents.md §3): the
 * JSON of a ProseMirror document whose nodes and marks the shell's document
 * viewer defines by these names. Every node that came from the file names
 * the element it came from (`key`, its place in the body read in order),
 * so what the person edited can be written back into the file in place.
 */

/** A run's look, and the run it came from (null for text typed where there was none). */
export interface DocxRunMark {
  type: "docxRun";
  attrs: { key: number | null; css: string };
}

export interface DocxText {
  type: "text";
  text: string;
  marks?: DocxRunMark[];
}

/** A line break inside a run (`w:br`, `w:cr`). */
export interface DocxBreak {
  type: "docxBreak";
  marks?: DocxRunMark[];
}

/** A picture: its run, the zip part that holds it, and its size in px. */
export interface DocxImage {
  type: "docxImage";
  attrs: { key: number; src: string; width: number; height: number; alt: string };
}

/**
 * Runs the editor shows but does not edit — a field (a page number, a
 * cross-reference), a footnote's number, a symbol, a chart — kept in the
 * file exactly as they were: `keys` are their elements, space-separated.
 */
export interface DocxLocked {
  type: "docxLocked";
  attrs: { keys: string; text: string; css: string; label: string };
}

export type DocxInline = DocxText | DocxBreak | DocxImage | DocxLocked;

export interface DocxParagraph {
  type: "docxParagraph";
  attrs: {
    key: number | null;
    /** What the paragraph held when it was read (signature): unchanged, it is written back as it was. */
    sig: string;
    css: string;
    /** "p", or "h1"…"h6" for a heading. */
    role: string;
    /** Its list, and level in it: the editor numbers it (ListCounter). */
    numId: string | null;
    ilvl: number;
  };
  content?: DocxInline[];
}

/** A block the editor shows as text but does not edit (a table of contents, a paragraph with tracked changes, an equation). */
export interface DocxLockedBlock {
  type: "docxLockedBlock";
  attrs: { key: number; text: string; css: string; label: string };
}

export interface DocxCell {
  type: "docxCell";
  attrs: { key: number | null; colspan: number; css: string };
  content: DocxBlock[];
}

export interface DocxRow {
  type: "docxRow";
  attrs: { key: number | null; css: string };
  content: DocxCell[];
}

export interface DocxTable {
  type: "docxTable";
  attrs: { key: number | null; sig: string; css: string };
  content: DocxRow[];
}

export type DocxBlock = DocxParagraph | DocxTable | DocxLockedBlock;

export interface DocxDoc {
  type: "doc";
  content: DocxBlock[];
}

/** What a node holds, as a short string: the same content, the same signature. Ignores attributes that only draw it. */
export function signature(node: DocxBlock | DocxRow | DocxCell | DocxInline): string {
  return hash(shape(node));
}

function shape(node: DocxBlock | DocxRow | DocxCell | DocxInline): string {
  switch (node.type) {
    case "text":
      return `t${String(node.marks?.[0]?.attrs.key ?? "_")}:${JSON.stringify(node.text)}`;
    case "docxBreak":
      return `b${String(node.marks?.[0]?.attrs.key ?? "_")}`;
    case "docxImage":
      return `i${String(node.attrs.key)}`;
    case "docxLocked":
      return `l${node.attrs.keys}`;
    case "docxLockedBlock":
      return `L${String(node.attrs.key)}`;
    case "docxParagraph":
      return `P${String(node.attrs.key)}[${(node.content ?? []).map(shape).join(",")}]`;
    case "docxTable":
      return `T${String(node.attrs.key)}[${node.content.map(shape).join(",")}]`;
    case "docxRow":
      return `R${String(node.attrs.key)}[${node.content.map(shape).join(",")}]`;
    case "docxCell":
      return `C${String(node.attrs.key)}:${String(node.attrs.colspan)}[${node.content.map(shape).join(",")}]`;
  }
}

/** Two FNV-1a hashes with different seeds: 64 bits, enough that an edit never looks like no edit. */
function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995) ^ (b >>> 13);
  }
  return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${String(text.length)}`;
}

/** A paragraph's content signature, over its content alone (its key and look aside). */
export function contentSignature(content: readonly DocxInline[] | undefined): string {
  return hash((content ?? []).map(shape).join(","));
}
