/**
 * A Word document (.docx) read for its editor (docs/desk-documents.md §3):
 * the body as the editor's JSON (json.ts), each node naming the element it
 * came from, the look resolved to CSS (styles.ts), and the lists and the
 * page it is laid out on.
 *
 * What the editor can change is text: the text of runs, new paragraphs,
 * paragraphs and runs taken away. Everything else the document holds is
 * kept as it was — shown, but not edited: fields (page numbers,
 * cross-references), footnote numbers, symbols, charts and shapes, tables
 * of contents and other content controls, equations, and paragraphs with
 * tracked changes (editing one would silently accept them).
 */

import { mainPart, mediaTypeOf, readRels, type Rel } from "../opc.js";
import { attr, descendant, is, isElement, kid, kids, NS, parseXml, textOf, val, type Document, type Element } from "../xml.js";
import { DocumentError, readZip, zipText, type ZipEntries } from "../zip.js";
import { contentSignature, signature, type DocxBlock, type DocxCell, type DocxDoc, type DocxInline, type DocxLocked, type DocxLockedBlock, type DocxParagraph, type DocxRow, type DocxTable, type DocxText } from "./json.js";
import { readNumbering, type ListLevels } from "./numbering.js";
import { DocxStyles, paraCss, px, readParaProps, readRunProps, readThemeFonts, runCss, type RunProps } from "./styles.js";

const W = NS.w;

/** What the document was read from: written back into, every save of an editing session (write.ts). */
export interface DocxSource {
  entries: ZipEntries;
  /** The document part (`word/document.xml`), and its text as read. */
  part: string;
  xml: string;
}

export interface DocxPage {
  /** In px (a twip is 1/15 px). */
  width: number;
  margin: { top: number; right: number; bottom: number; left: number };
}

export interface DocxView {
  doc: DocxDoc;
  page: DocxPage;
  /** The document's own default text (its Normal style). */
  baseCss: string;
  /** Its lists' levels, for the editor to number paragraphs as it edits (ListCounter). */
  lists: ListLevels;
  /** Each list level's marker look: `${numId}:${ilvl}` → CSS. */
  markerCss: Record<string, string>;
  /** Pictures by their part: the part's media type. */
  media: Record<string, string>;
  /** How many things are shown but not editable. */
  locked: number;
}

/**
 * Every element of the body in document order, and each one's place in
 * that order: its key. The same text read again gives the same keys, so a
 * key in the editor finds its element in a fresh read of the part (write.ts).
 */
export function indexBody(body: Element): { order: Element[]; keyOf: Map<Element, number> } {
  const order: Element[] = [];
  const keyOf = new Map<Element, number>();
  const visit = (el: Element): void => {
    for (let node = el.firstChild; node !== null; node = node.nextSibling) {
      if (!isElement(node)) continue;
      keyOf.set(node, order.length);
      order.push(node);
      visit(node);
    }
  };
  visit(body);
  return { order, keyOf };
}

export function documentBody(doc: Document): Element {
  const root = doc.documentElement;
  const body = root === null || !is(root, W, "document") ? null : kid(root, W, "body");
  if (body === null) throw new DocumentError("the file is not a Word document");
  return body;
}

interface Ctx {
  keyOf: Map<Element, number>;
  styles: DocxStyles;
  lists: ListLevels;
  rels: Map<string, Rel>;
  entries: ZipEntries;
  media: Record<string, string>;
  locked: number;
  footnotes: number;
}

function keyOf(ctx: Ctx, el: Element): number {
  const key = ctx.keyOf.get(el);
  if (key === undefined) throw new DocumentError("the document changed while it was read");
  return key;
}

/* -------------------------------- the text -------------------------------- */

/** What an element shows as text: its runs' text, tabs and breaks, deleted text left out; paragraphs a line each. */
export function visibleText(el: Element): string {
  const lines: string[] = [];
  let line = "";
  const walk = (node: Element): void => {
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      if (!isElement(child)) continue;
      if (is(child, W, "t")) line += textOf(child);
      else if (is(child, W, "tab") || is(child, W, "ptab")) line += "\t";
      else if (is(child, W, "br") || is(child, W, "cr")) line += "\n";
      else if (is(child, W, "noBreakHyphen")) line += "‑";
      else if (is(child, W, "delText") || is(child, W, "instrText") || is(child, W, "del") || is(child, W, "rPr") || is(child, W, "pPr")) continue;
      else if (is(child, W, "p")) {
        walk(child);
        lines.push(line);
        line = "";
      } else walk(child);
    }
  };
  if (is(el, W, "p")) {
    walk(el);
    lines.push(line);
  } else {
    walk(el);
    if (line !== "") lines.push(line);
  }
  return lines.join("\n");
}

/* ------------------------------- the blocks ------------------------------- */

function lockedBlock(el: Element, ctx: Ctx, label: string, css = ""): DocxLockedBlock {
  ctx.locked += 1;
  return { type: "docxLockedBlock", attrs: { key: keyOf(ctx, el), text: visibleText(el), css, label } };
}

function blocksIn(container: Element, ctx: Ctx): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  for (const child of kids(container)) {
    if (is(child, W, "p")) blocks.push(paragraph(child, ctx));
    else if (is(child, W, "tbl")) blocks.push(table(child, ctx));
    else if (is(child, W, "sdt")) blocks.push(lockedBlock(child, ctx, contentControlLabel(child)));
    else if (is(child, W, "customXml") || is(child, NS.mc, "AlternateContent")) blocks.push(lockedBlock(child, ctx, "Content"));
    else if (is(child, W, "altChunk")) blocks.push(lockedBlock(child, ctx, "Embedded content"));
    // Section properties, bookmarks, proofing and comment marks carry nothing to show.
  }
  return blocks;
}

function contentControlLabel(sdt: Element): string {
  const gallery = val(descendant(kid(sdt, W, "sdtPr"), W, "docPartObj"), W, "docPartGallery");
  if (gallery !== null && /contents/i.test(gallery)) return "Table of contents";
  return "Content control";
}

/** Tracked changes, or an equation, somewhere in the paragraph: it is shown, not edited. */
function lockReason(p: Element): string | null {
  // (A revision of the paragraph mark itself, in its properties, is kept with them.)
  for (const el of kids(p).filter((child) => !is(child, W, "pPr")).flatMap((child) => [child, ...descendantsOf(child)])) {
    const name = el.localName;
    if (name === "oMath" || name === "oMathPara") return "Equation";
    if (is(el, W, "ins") || is(el, W, "del") || is(el, W, "moveFrom") || is(el, W, "moveTo")) return "Tracked changes";
  }
  return null;
}

function* descendantsOf(el: Element): Generator<Element> {
  for (let node = el.firstChild; node !== null; node = node.nextSibling) {
    if (!isElement(node)) continue;
    yield node;
    yield* descendantsOf(node);
  }
}

function paragraph(p: Element, ctx: Ctx): DocxParagraph | DocxLockedBlock {
  const pPr = kid(p, W, "pPr");
  const style = ctx.styles.paragraph(val(pPr, W, "pStyle"));
  const direct = readParaProps(pPr);
  const numId = direct.numId ?? style.para.numId ?? null;
  const ilvl = direct.ilvl ?? style.para.ilvl ?? 0;
  const level = numId === null || numId === "0" ? undefined : ctx.lists[`${numId}:${String(ilvl)}`];
  // A list level's indents sit between the style's and the paragraph's own.
  const para = { ...style.para, ...(level?.para ?? {}), ...direct };
  const mark: RunProps = { ...style.run, ...readRunProps(kid(pPr, W, "rPr"), ctx.styles.fonts) };
  const css = [paraCss(para), runCss(mark)].filter((part) => part !== "").join(";");
  const reason = lockReason(p);
  if (reason !== null) return lockedBlock(p, ctx, reason, css);
  const content = inlinesIn(p, ctx, style.run);
  if (content === null) return lockedBlock(p, ctx, "Fields", css);
  const outline = para.outline;
  return {
    type: "docxParagraph",
    attrs: {
      key: keyOf(ctx, p),
      sig: contentSignature(content),
      css,
      role: outline !== undefined && outline < 6 ? `h${String(outline + 1)}` : "p",
      numId: level === undefined ? null : numId,
      ilvl,
    },
    ...(content.length === 0 ? {} : { content }),
  };
}

/* ------------------------------- the inlines ------------------------------ */

function fieldDepth(run: Element): number {
  let depth = 0;
  for (const fld of kids(run, W, "fldChar")) {
    const type = attr(fld, W, "fldCharType");
    if (type === "begin") depth += 1;
    else if (type === "end") depth -= 1;
  }
  return depth;
}

/**
 * The inlines of a paragraph, or of a wrapper in one (a hyperlink, a smart
 * tag): null when the paragraph holds something that cannot be kept apart
 * from its text (a field begun in one wrapper and ended in another).
 */
function inlinesIn(container: Element, ctx: Ctx, paraRun: RunProps): DocxInline[] | null {
  const out: DocxInline[] = [];
  const children = kids(container);
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (is(child, W, "r")) {
      const depth = fieldDepth(child);
      if (depth > 0) {
        // A field, begun here: every run to its end is one piece, kept as it was.
        const runs = [child];
        let open = depth;
        while (open > 0 && index + 1 < children.length) {
          index += 1;
          const next = children[index]!;
          runs.push(next);
          if (is(next, W, "r")) open += fieldDepth(next);
        }
        if (open > 0) return null;
        out.push(lockedField(runs, ctx, paraRun));
        continue;
      }
      if (depth < 0) return null;
      out.push(...runInlines(child, ctx, paraRun));
    } else if (is(child, W, "hyperlink") || is(child, W, "smartTag") || is(child, W, "customXml") || is(child, W, "dir") || is(child, W, "bdo")) {
      const inner = inlinesIn(child, ctx, paraRun);
      if (inner === null) return null;
      out.push(...inner);
    } else if (is(child, W, "fldSimple")) {
      out.push(locked([child], ctx, visibleText(child), runCss(paraRun), "Field"));
    } else if (is(child, W, "sdt")) {
      out.push(locked([child], ctx, visibleText(child), runCss(paraRun), "Content control"));
    } else if (is(child, NS.mc, "AlternateContent")) {
      const fallback = kid(child, NS.mc, "Fallback");
      out.push(locked([child], ctx, fallback === null ? "" : visibleText(fallback), runCss(paraRun), "Content"));
    }
    // Bookmarks, proofing marks, comment ranges and permissions show nothing.
  }
  return mergeText(out);
}

function locked(els: Element[], ctx: Ctx, text: string, css: string, label: string): DocxLocked {
  ctx.locked += 1;
  return { type: "docxLocked", attrs: { keys: els.map((el) => String(keyOf(ctx, el))).join(" "), text, css, label } };
}

function lockedField(runs: Element[], ctx: Ctx, paraRun: RunProps): DocxLocked {
  // What the field shows: the runs between its separator and its end.
  let shown = "";
  let inResult = false;
  let depth = 0;
  for (const run of runs) {
    for (const child of kids(run)) {
      if (is(child, W, "fldChar")) {
        const type = attr(child, W, "fldCharType");
        if (type === "begin") depth += 1;
        else if (type === "separate" && depth === 1) inResult = true;
        else if (type === "end") {
          depth -= 1;
          if (depth === 0) inResult = false;
        }
      } else if (inResult && is(child, W, "t")) shown += textOf(child);
      else if (inResult && is(child, W, "tab")) shown += "\t";
    }
  }
  const first = runs.find((run) => is(run, W, "r"));
  const css = first === undefined ? runCss(paraRun) : runCss(runProps(first, ctx, paraRun));
  return locked(runs, ctx, shown, css, "Field");
}

function runProps(run: Element, ctx: Ctx, paraRun: RunProps): RunProps {
  const rPr = kid(run, W, "rPr");
  return { ...paraRun, ...ctx.styles.character(val(rPr, W, "rStyle")), ...readRunProps(rPr, ctx.styles.fonts) };
}

const TEXT_PARTS = new Set(["t", "tab", "cr", "noBreakHyphen", "softHyphen", "rPr", "lastRenderedPageBreak"]);

function runInlines(run: Element, ctx: Ctx, paraRun: RunProps): DocxInline[] {
  const props = runProps(run, ctx, paraRun);
  const css = runCss(props);
  let plain = true;
  let drawing: Element | null = null;
  let hasText = false;
  for (const child of kids(run)) {
    if (!is(child, W, child.localName ?? "")) {
      plain = false;
      continue;
    }
    const name = child.localName ?? "";
    if (TEXT_PARTS.has(name)) {
      if (name === "t" || name === "tab") hasText = true;
      continue;
    }
    if (name === "br") {
      const type = attr(child, W, "type");
      if (type === null || type === "textWrapping") continue;
      plain = false;
      continue;
    }
    if (name === "drawing") {
      drawing = child;
      continue;
    }
    plain = false;
  }
  if (props.hidden === true) return [locked([run], ctx, visibleText(run), css, "Hidden text")];
  if (drawing !== null && plain && !hasText) {
    const image = picture(run, drawing, ctx);
    if (image !== null) return [image];
  }
  if (drawing !== null || !plain) return [locked([run], ctx, lockedRunText(run, drawing), css, lockedRunLabel(run, drawing, ctx))];
  const key = keyOf(ctx, run);
  const mark = { type: "docxRun" as const, attrs: { key, css } };
  const out: DocxInline[] = [];
  let text = "";
  const flush = (): void => {
    if (text !== "") out.push({ type: "text", text, marks: [mark] });
    text = "";
  };
  for (const child of kids(run)) {
    const name = child.localName ?? "";
    if (name === "t") text += textOf(child);
    else if (name === "tab") text += "\t";
    else if (name === "noBreakHyphen") text += "‑";
    else if (name === "softHyphen") text += "­";
    else if (name === "br" || name === "cr") {
      flush();
      out.push({ type: "docxBreak", marks: [mark] });
    }
  }
  flush();
  return out;
}

function lockedRunText(run: Element, drawing: Element | null): string {
  if (drawing !== null) {
    const box = descendant(drawing, W, "txbxContent");
    return box === null ? "" : visibleText(box);
  }
  const sym = kid(run, W, "sym");
  if (sym !== null) {
    const code = parseInt(attr(sym, W, "char") ?? "", 16);
    return Number.isFinite(code) ? (code >= 0xf000 ? "•" : String.fromCodePoint(code)) : "";
  }
  return visibleText(run);
}

function lockedRunLabel(run: Element, drawing: Element | null, ctx: Ctx): string {
  if (drawing !== null) return descendant(drawing, W, "txbxContent") !== null ? "Text box" : descendant(drawing, NS.a, "graphicData") !== null ? "Drawing" : "Picture";
  if (kid(run, W, "footnoteReference") !== null || kid(run, W, "endnoteReference") !== null) {
    ctx.footnotes += 1;
    return `Note ${String(ctx.footnotes)}`;
  }
  const br = kid(run, W, "br");
  if (br !== null && attr(br, W, "type") === "page") return "Page break";
  if (kid(run, W, "pict") !== null || kid(run, W, "object") !== null) return "Object";
  if (kid(run, W, "sym") !== null) return "Symbol";
  return "Kept as it is";
}

function picture(run: Element, drawing: Element, ctx: Ctx): DocxInline | null {
  const blip = descendant(drawing, NS.a, "blip");
  const embed = attr(blip, NS.r, "embed");
  const rel = embed === null ? undefined : ctx.rels.get(embed);
  if (rel === undefined || rel.external || !ctx.entries.has(rel.target)) return null;
  const extent = descendant(drawing, NS.wp, "extent");
  const emu = (value: string | null): number => Math.max(1, Math.round((Number(value) || 0) / 9_525));
  const docPr = descendant(drawing, NS.wp, "docPr");
  ctx.media[rel.target] = mediaTypeOf(rel.target);
  return {
    type: "docxImage",
    attrs: {
      key: keyOf(ctx, run),
      src: rel.target,
      width: emu(attr(extent, null, "cx")),
      height: emu(attr(extent, null, "cy")),
      alt: attr(docPr, null, "descr") ?? attr(docPr, null, "title") ?? "",
    },
  };
}

/** Adjacent text of the same run is one text node, as the editor keeps it. */
function mergeText(inlines: DocxInline[]): DocxInline[] {
  const out: DocxInline[] = [];
  for (const inline of inlines) {
    const last = out[out.length - 1];
    if (inline.type === "text" && last?.type === "text" && last.marks?.[0]?.attrs.key === inline.marks?.[0]?.attrs.key) {
      out[out.length - 1] = { ...last, text: last.text + inline.text } satisfies DocxText;
      continue;
    }
    out.push(inline);
  }
  return out;
}

/* -------------------------------- the tables ------------------------------- */

const BORDERLESS = new Set(["nil", "none"]);

function drawsBorders(borders: Element | null): boolean {
  if (borders === null) return false;
  return kids(borders).some((edge) => !BORDERLESS.has(attr(edge, W, "val") ?? "nil"));
}

function table(tbl: Element, ctx: Ctx): DocxTable | DocxLockedBlock {
  const tblPr = kid(tbl, W, "tblPr");
  // Rows wrapped in content controls, or other rows that are not plain rows: shown, kept.
  if (kids(tbl).some((child) => !is(child, W, "tr") && !is(child, W, "tblPr") && !is(child, W, "tblGrid") && !is(child, W, "bookmarkStart") && !is(child, W, "bookmarkEnd"))) {
    return lockedBlock(tbl, ctx, "Table");
  }
  const grid = kids(kid(tbl, W, "tblGrid") ?? tbl, W, "gridCol").map((col) => px(Number(attr(col, W, "w")) || 0));
  const bordered = drawsBorders(kid(tblPr, W, "tblBorders") ?? ctx.styles.tableBorders(val(tblPr, W, "tblStyle")));
  const rows: DocxRow[] = [];
  for (const tr of kids(tbl, W, "tr")) {
    if (kids(tr).some((child) => !is(child, W, "tc") && !is(child, W, "trPr") && !is(child, W, "tblPrEx") && !is(child, W, "bookmarkStart") && !is(child, W, "bookmarkEnd"))) {
      return lockedBlock(tbl, ctx, "Table");
    }
    const cells: DocxCell[] = [];
    let column = 0;
    for (const tc of kids(tr, W, "tc")) {
      const tcPr = kid(tc, W, "tcPr");
      const span = Math.max(1, Number(val(tcPr, W, "gridSpan") ?? "1") || 1);
      const merge = kid(tcPr, W, "vMerge");
      const continued = merge !== null && attr(merge, W, "val") !== "restart";
      const width = grid.slice(column, column + span).reduce((sum, value) => sum + value, 0);
      column += span;
      const fill = attr(kid(tcPr, W, "shd"), W, "fill");
      const align = val(tcPr, W, "vAlign");
      const css = [
        width > 0 ? `width:${String(width)}px` : "",
        bordered ? "border:1px solid #9a9a9a" : "",
        bordered && continued ? "border-top-color:transparent" : "",
        fill !== null && /^[0-9a-f]{6}$/i.test(fill) ? `background-color:#${fill}` : "",
        align === "center" ? "vertical-align:middle" : align === "bottom" ? "vertical-align:bottom" : "vertical-align:top",
        "padding:2px 7px",
      ].filter((part) => part !== "");
      const content = blocksIn(tc, ctx);
      cells.push({ type: "docxCell", attrs: { key: keyOf(ctx, tc), colspan: span, css: css.join(";") }, content: content.length === 0 ? [emptyParagraph()] : content });
    }
    if (cells.length > 0) rows.push({ type: "docxRow", attrs: { key: keyOf(ctx, tr), css: "" }, content: cells });
  }
  if (rows.length === 0) return lockedBlock(tbl, ctx, "Table");
  const jc = val(tblPr, W, "jc");
  const css = ["border-collapse:collapse", "table-layout:fixed", jc === "center" ? "margin:6px auto" : "margin:6px 0"].join(";");
  const node: DocxTable = { type: "docxTable", attrs: { key: keyOf(ctx, tbl), sig: "", css }, content: rows };
  node.attrs.sig = tableSignature(node);
  return node;
}

export function emptyParagraph(): DocxParagraph {
  return { type: "docxParagraph", attrs: { key: null, sig: contentSignature([]), css: "", role: "p", numId: null, ilvl: 0 } };
}

/** A table's signature: its rows, cells and what each cell holds (its paragraphs by their keys and content). */
export function tableSignature(node: DocxTable): string {
  return signature(node);
}

/* ------------------------------- the document ------------------------------ */

function relsMap(rels: Rel[]): Map<string, Rel> {
  return new Map(rels.map((rel) => [rel.id, rel]));
}

function pageOf(body: Element): DocxPage {
  const sectPr = kids(body, W, "sectPr").at(-1) ?? null;
  const size = kid(sectPr, W, "pgSz");
  const margin = kid(sectPr, W, "pgMar");
  const twipsOf = (el: Element | null, name: string, fallback: number): number => {
    const value = Number(attr(el, W, name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    width: px(twipsOf(size, "w", 12_240)),
    margin: {
      top: px(twipsOf(margin, "top", 1_440)),
      right: px(twipsOf(margin, "right", 1_440)),
      bottom: px(twipsOf(margin, "bottom", 1_440)),
      left: px(twipsOf(margin, "left", 1_440)),
    },
  };
}

function partDoc(entries: ZipEntries, part: string | undefined): Document | null {
  if (part === undefined) return null;
  const text = zipText(entries, part);
  return text === null ? null : parseXml(text);
}

export function openDocx(bytes: Uint8Array): { source: DocxSource; view: DocxView } {
  const entries = readZip(bytes);
  const part = mainPart(entries, "word/document.xml");
  const xml = zipText(entries, part);
  if (xml === null) throw new DocumentError("the file is not a Word document");
  const body = documentBody(parseXml(xml));
  const rels = readRels(entries, part);
  const theme = partDoc(entries, rels.find((rel) => rel.type.endsWith("/theme"))?.target);
  const fonts = readThemeFonts(theme);
  const styles = new DocxStyles(partDoc(entries, rels.find((rel) => rel.type.endsWith("/styles"))?.target), fonts);
  const lists = readNumbering(partDoc(entries, rels.find((rel) => rel.type.endsWith("/numbering"))?.target), fonts);
  const ctx: Ctx = { keyOf: indexBody(body).keyOf, styles, lists, rels: relsMap(rels), entries, media: {}, locked: 0, footnotes: 0 };
  const content = blocksIn(body, ctx);
  const base = styles.paragraph(null);
  const markerCss: Record<string, string> = {};
  for (const [key, level] of Object.entries(lists)) {
    // Bullets drawn by symbol fonts are drawn as the characters they stand for, in the text's own font.
    const run = level.format === "bullet" ? { ...level.run, font: undefined } : level.run;
    markerCss[key] = runCss(run);
  }
  return {
    source: { entries, part, xml },
    view: {
      doc: { type: "doc", content: content.length === 0 ? [emptyParagraph()] : content },
      page: pageOf(body),
      baseCss: [runCss(base.run), paraCss({ ...base.para, before: 0, after: 0 })].filter((part) => part !== "").join(";"),
      lists,
      markerCss,
      media: ctx.media,
      locked: ctx.locked,
    },
  };
}

/** Every picture the document shows, from its parts. */
export function docxMedia(source: DocxSource, view: DocxView): Array<{ path: string; mediaType: string; bytes: Uint8Array }> {
  return Object.entries(view.media).flatMap(([path, mediaType]) => {
    const bytes = source.entries.get(path);
    return bytes === undefined ? [] : [{ path, mediaType, bytes }];
  });
}

