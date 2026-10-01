/**
 * A Word document's edited text, written back into the file it came from
 * (docs/desk-documents.md §3). The body is rebuilt from the editor's JSON
 * over a fresh reading of the original part, in which every key finds its
 * element again (read.ts `indexBody`):
 *
 * - a paragraph or table whose content is what it was when read is the
 *   original element, untouched — its bookmarks, comments and revision ids
 *   with it;
 * - an edited paragraph keeps its properties, and each run of text keeps
 *   the properties of the run it came from (text typed where there was no
 *   run takes the paragraph mark's), inside the hyperlink it was in;
 * - a paragraph split in two is two paragraphs with the same properties (a
 *   section break goes with the last of them), and the copy is given no
 *   paragraph id of its own, which Word assigns;
 * - what the editor does not edit (fields, pictures, symbols, content
 *   controls) is the original element, or a copy of it where it appears twice;
 * - what was taken out is gone.
 *
 * Every other part of the file — styles, headers, pictures, comments — is
 * the bytes it was.
 */

import { create, is, isElement, kid, kids, NS, parseXml, preserveSpace, serializeXml, type Document, type Element } from "../xml.js";
import { textBytes, writeZip } from "../zip.js";
import { contentSignature, signature, type DocxBlock, type DocxDoc, type DocxInline, type DocxParagraph, type DocxTable } from "./json.js";
import { documentBody, indexBody, type DocxSource } from "./read.js";

const W = NS.w;
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
/** What a paragraph mark's run properties may hold that a new run must not: the mark's own revision marks. */
const MARK_ONLY = new Set(["ins", "del", "moveFrom", "moveTo", "rPrChange"]);

class Writer {
  readonly #doc: Document;
  readonly #order: Element[];
  readonly #keyOf: Map<Element, number>;
  /** Each element's nearest hyperlink in its paragraph, as the file had it. */
  readonly #links = new Map<Element, Element | null>();
  /** Elements already placed in the new body, as themselves: another use is a copy. */
  readonly #used = new Set<number>();
  /** How many paragraphs name each key (a paragraph split in two), and how many have been written. */
  readonly #count = new Map<number, number>();
  readonly #written = new Map<number, number>();

  constructor(doc: Document, body: Element, content: readonly DocxBlock[]) {
    this.#doc = doc;
    const { order, keyOf } = indexBody(body);
    this.#order = order;
    this.#keyOf = keyOf;
    const link = (el: Element, current: Element | null): void => {
      for (const child of kids(el)) {
        const here = is(child, W, "p") ? null : is(child, W, "hyperlink") ? child : current;
        this.#links.set(child, here);
        link(child, here);
      }
    };
    link(body, null);
    const countIn = (blocks: readonly DocxBlock[]): void => {
      for (const block of blocks) {
        if (block.type === "docxParagraph" && block.attrs.key !== null) this.#count.set(block.attrs.key, (this.#count.get(block.attrs.key) ?? 0) + 1);
        if (block.type === "docxTable") for (const row of block.content) for (const cell of row.content) countIn(cell.content);
      }
    };
    countIn(content);
  }

  #element(key: number | null | undefined): Element | null {
    if (key === null || key === undefined) return null;
    return this.#order[key] ?? null;
  }

  /** An element and everything in it is not yet placed anywhere: it can be moved into the new body whole. */
  #free(el: Element): boolean {
    const key = this.#keyOf.get(el);
    if (key === undefined || this.#used.has(key)) return false;
    for (let node = el.firstChild; node !== null; node = node.nextSibling) if (isElement(node) && !this.#free(node)) return false;
    return true;
  }

  #take(el: Element): void {
    const key = this.#keyOf.get(el);
    if (key !== undefined) this.#used.add(key);
    for (let node = el.firstChild; node !== null; node = node.nextSibling) if (isElement(node)) this.#take(node);
  }

  /** The original, if it is free, else a copy of it. */
  #reuse(el: Element): Element {
    if (this.#free(el)) {
      this.#take(el);
      return el;
    }
    return el.cloneNode(true) as Element;
  }

  blocks(blocks: readonly DocxBlock[]): Element[] {
    const out: Element[] = [];
    for (const block of blocks) {
      if (block.type === "docxParagraph") out.push(this.#paragraph(block));
      else if (block.type === "docxTable") out.push(...this.#table(block));
      else if (block.type === "docxLockedBlock") {
        const el = this.#element(block.attrs.key);
        if (el !== null) out.push(this.#reuse(el));
      }
    }
    return out;
  }

  #paragraph(json: DocxParagraph): Element {
    const key = json.attrs.key;
    const original = this.#element(key);
    const occurrence = key === null ? 0 : (this.#written.get(key) ?? 0);
    const occurrences = key === null ? 1 : (this.#count.get(key) ?? 1);
    if (key !== null) this.#written.set(key, occurrence + 1);
    const sectionBreak = original !== null && kid(kid(original, W, "pPr"), W, "sectPr") !== null;
    // Untouched: the paragraph as it was (unless it was split, and its section break must move to the last piece).
    if (original !== null && occurrence === 0 && contentSignature(json.content) === json.attrs.sig && !(sectionBreak && occurrences > 1) && this.#free(original)) {
      this.#take(original);
      return original;
    }
    const p = original === null ? this.#doc.createElementNS(W[0], "w:p") : (original.cloneNode(false) as Element);
    if (original !== null && occurrence > 0) {
      p.removeAttributeNS(W14, "paraId");
      p.removeAttributeNS(W14, "textId");
    }
    const pPr = original === null ? null : kid(original, W, "pPr");
    if (pPr !== null) {
      const props = pPr.cloneNode(true) as Element;
      if (occurrence < occurrences - 1) for (const sect of kids(props, W, "sectPr")) props.removeChild(sect);
      p.appendChild(props);
    }
    this.#inlines(p, json.content ?? [], kid(pPr, W, "rPr"));
    return p;
  }

  #inlines(p: Element, content: readonly DocxInline[], markRPr: Element | null): void {
    let link: { from: Element; to: Element } | null = null;
    const place = (node: Element, origin: Element | null): void => {
      const from = origin === null ? null : (this.#links.get(origin) ?? null);
      if (from === null) {
        link = null;
        p.appendChild(node);
        return;
      }
      if (link?.from !== from) {
        link = { from, to: from.cloneNode(false) as Element };
        p.appendChild(link.to);
      }
      link.to.appendChild(node);
    };
    for (let index = 0; index < content.length; index += 1) {
      const node = content[index]!;
      if (node.type === "text" || node.type === "docxBreak") {
        const key = node.marks?.[0]?.attrs.key ?? null;
        const group = [node];
        while (index + 1 < content.length) {
          const next = content[index + 1]!;
          if ((next.type !== "text" && next.type !== "docxBreak") || (next.marks?.[0]?.attrs.key ?? null) !== key) break;
          group.push(next);
          index += 1;
        }
        const origin = this.#element(key);
        const run = origin !== null && is(origin, W, "r") ? this.#runLike(origin) : this.#newRun(p, markRPr);
        for (const part of group) {
          if (part.type === "docxBreak") run.appendChild(create(this.#doc, run, "br"));
          else this.#text(run, part.text);
        }
        place(run, origin !== null && is(origin, W, "r") ? origin : null);
        continue;
      }
      const keys = node.type === "docxImage" ? [node.attrs.key] : node.attrs.keys.split(" ").map(Number);
      for (const key of keys) {
        const el = this.#element(key);
        if (el !== null) place(this.#reuse(el), el);
      }
    }
  }

  /** A run with another run's properties and nothing else, for new text. */
  #runLike(origin: Element): Element {
    const run = origin.cloneNode(false) as Element;
    const rPr = kid(origin, W, "rPr");
    if (rPr !== null) run.appendChild(rPr.cloneNode(true));
    return run;
  }

  /** A run for text typed where there was none: the paragraph mark's look. */
  #newRun(p: Element, markRPr: Element | null): Element {
    const run = create(this.#doc, p, "r");
    if (markRPr !== null) {
      const rPr = create(this.#doc, p, "rPr");
      for (const child of kids(markRPr)) if (!MARK_ONLY.has(child.localName ?? "")) rPr.appendChild(child.cloneNode(true));
      if (rPr.firstChild !== null) run.appendChild(rPr);
    }
    return run;
  }

  /** Text into a run: tabs as tab elements, the rest in text elements that keep their spaces. */
  #text(run: Element, text: string): void {
    text.split("\t").forEach((part, index) => {
      if (index > 0) run.appendChild(create(this.#doc, run, "tab"));
      if (part === "") return;
      const t = create(this.#doc, run, "t");
      preserveSpace(t);
      t.appendChild(this.#doc.createTextNode(part));
      run.appendChild(t);
    });
  }

  #table(json: DocxTable): Element[] {
    const original = this.#element(json.attrs.key);
    // A table that did not come from the file (pasted in): its cells' contents, as paragraphs.
    if (original === null || !is(original, W, "tbl")) return json.content.flatMap((row) => row.content.flatMap((cell) => this.blocks(cell.content)));
    if (signature(json) === json.attrs.sig && this.#free(original)) {
      this.#take(original);
      return [original];
    }
    const tbl = original.cloneNode(false) as Element;
    for (const child of kids(original)) if (!is(child, W, "tr")) tbl.appendChild(child.cloneNode(true));
    for (const rowJson of json.content) {
      const row = this.#element(rowJson.attrs.key);
      const tr = row === null ? create(this.#doc, tbl, "tr") : (row.cloneNode(false) as Element);
      if (row !== null) for (const child of kids(row)) if (!is(child, W, "tc")) tr.appendChild(child.cloneNode(true));
      for (const cellJson of rowJson.content) {
        const cell = this.#element(cellJson.attrs.key);
        const tc = cell === null ? create(this.#doc, tbl, "tc") : (cell.cloneNode(false) as Element);
        const tcPr = kid(cell, W, "tcPr");
        if (tcPr !== null) tc.appendChild(tcPr.cloneNode(true));
        for (const el of this.blocks(cellJson.content)) tc.appendChild(el);
        // A cell ends with a paragraph (Word will not open one that does not).
        const last = kids(tc).at(-1);
        if (last === undefined || !is(last, W, "p")) tc.appendChild(create(this.#doc, tbl, "p"));
        tr.appendChild(tc);
      }
      if (kid(tr, W, "tc") !== null) tbl.appendChild(tr);
    }
    return kid(tbl, W, "tr") === null ? [] : [tbl];
  }
}

/** Pictures copied are given ids of their own: Word will not open a document whose drawings share one. */
function uniqueDrawingIds(doc: Document): void {
  const docPrs: Element[] = [];
  const walk = (el: Element): void => {
    for (const child of kids(el)) {
      if (is(child, NS.wp, "docPr")) docPrs.push(child);
      walk(child);
    }
  };
  if (doc.documentElement !== null) walk(doc.documentElement);
  const seen = new Set<string>();
  let next = docPrs.reduce((max, el) => Math.max(max, Number(el.getAttribute("id")) || 0), 0) + 1;
  for (const el of docPrs) {
    const id = el.getAttribute("id") ?? "";
    if (!seen.has(id)) {
      seen.add(id);
      continue;
    }
    el.setAttribute("id", String(next));
    seen.add(String(next));
    next += 1;
  }
}

/** The document with its body as the editor has it now, over the file it was read from. */
export function saveDocx(source: DocxSource, doc: DocxDoc): Uint8Array {
  const xml = parseXml(source.xml);
  const body = documentBody(xml);
  const blocks = new Writer(xml, body, doc.content).blocks(doc.content);
  const sectPr = kids(body, W, "sectPr").at(-1) ?? null;
  while (body.firstChild !== null) body.removeChild(body.firstChild);
  for (const el of blocks) body.appendChild(el);
  // A body with nothing in it still needs a paragraph.
  if (blocks.length === 0) body.appendChild(xml.createElementNS(W[0], "w:p"));
  if (sectPr !== null) body.appendChild(sectPr);
  uniqueDrawingIds(xml);
  const entries = new Map(source.entries);
  entries.set(source.part, textBytes(serializeXml(xml)));
  return writeZip(entries);
}
