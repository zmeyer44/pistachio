/**
 * HTML in and out of a note's document without a browser (docs/notes.md §2).
 *
 * The desktop's main process derives a note's markdown from its HTML on every
 * save, the cloud worker publishes notes, and the agent edits them: none of
 * those has a `document`. zeed-dom is the small virtual DOM TipTap itself used
 * for server rendering, and ProseMirror's own parser and serializer run over
 * it unchanged, so a note parsed here is the note the editor would show.
 *
 * Every function takes an optional schema: a mounted editor has its own
 * schema instance, and nodes from different instances cannot be mixed.
 */

import type { JSONContent } from "@tiptap/core";
import { DOMParser as PMDOMParser, DOMSerializer, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { createHTMLDocument, parseHTML, VElement } from "zeed-dom";
import { noteSchema } from "./schema.js";

/* ---------------------- what zeed-dom's element lacks ---------------------- */

// The parse rules TipTap's own extensions ship reach for three things a real
// element has and zeed-dom's does not: `closest()` (the table reads a cell's
// column width off its table), an iterable `classList` (the code block reads
// its language off `<code class="language-…">`), and a `setAttribute` that
// writes a boolean as the string a browser would (`data-checked="false"`,
// which zeed-dom drops). Patched once, on the prototype: this module is the
// only place in the workspace that touches zeed-dom.

interface ElementLike {
  nodeType: number;
  parentElement: ElementLike | null;
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: unknown): void;
}

const proto = VElement.prototype as unknown as ElementLike & { closest?: (selector: string) => ElementLike | null; classList: object };

if (typeof proto.closest !== "function") {
  Object.defineProperty(proto, "closest", {
    configurable: true,
    writable: true,
    value(this: ElementLike, selector: string): ElementLike | null {
      if (this.matches(selector)) return this;
      for (let element = this.parentElement; element !== null && element.nodeType === 1; element = element.parentElement) {
        if (element.matches(selector)) return element;
      }
      return null;
    },
  });
}

const classList = Object.getOwnPropertyDescriptor(proto, "classList");
if (classList?.get !== undefined) {
  const read = classList.get;
  Object.defineProperty(proto, "classList", {
    configurable: true,
    get(this: ElementLike): object {
      const names = (this.getAttribute("class") ?? "").trim().split(/\s+/u).filter((name) => name !== "");
      return Object.assign(read.call(this) as object, { length: names.length, [Symbol.iterator]: () => names[Symbol.iterator]() });
    },
  });
}

// `element.style.cssText = …`: ProseMirror's serializer writes a `style`
// attribute through it; zeed-dom's style object has no such setter, so a
// table cell's alignment would silently go nowhere.
const style = Object.getOwnPropertyDescriptor(proto, "style");
if (style?.get !== undefined) {
  const read = style.get;
  Object.defineProperty(proto, "style", {
    configurable: true,
    get(this: ElementLike): object {
      const styles = read.call(this) as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(styles, "cssText")) {
        Object.defineProperty(styles, "cssText", {
          configurable: true,
          get: () => this.getAttribute("style") ?? "",
          set: (value: unknown) => this.setAttribute("style", value),
        });
      }
      return styles;
    },
  });
}

const setAttribute = proto.setAttribute;
proto.setAttribute = function (this: ElementLike, name: string, value: unknown): void {
  setAttribute.call(this, name, value === null || value === undefined ? value : String(value));
};

/** Parses canonical HTML into a document node. Anything outside the schema is dropped. */
/**
 * Runs of spaces in a note's text are the note's own: ProseMirror's parser
 * would collapse them, and a structural edit or a reopening would then
 * change text nobody touched. Newlines between blocks are still nothing —
 * only `"full"` would make them text.
 */
const WHITESPACE_KEPT = { preserveWhitespace: true } as const;

export function htmlToDoc(html: string, schema: Schema = noteSchema()): PMNode {
  const dom = parseHTML(html) as unknown as Node;
  return PMDOMParser.fromSchema(schema).parse(dom, WHITESPACE_KEPT);
}

export function docToHtml(doc: PMNode): string {
  const document = createHTMLDocument() as unknown as Document;
  const fragment = DOMSerializer.fromSchema(doc.type.schema).serializeFragment(doc.content, { document }) as unknown as { render(): string };
  return fragment.render();
}

/**
 * Cleans markdown parser output: drops empty text nodes (ProseMirror rejects
 * them), turns soft line breaks into spaces outside code (the editor renders a
 * literal newline as a line break) and clamps heading levels.
 */
function normalizeParsedJSON(node: JSONContent, inCode = false): JSONContent {
  // The schema has three heading levels; deeper ones become H3 (they would
  // otherwise render as H1).
  if (node.type === "heading" && Number(node.attrs?.["level"]) > 3) node = { ...node, attrs: { ...node.attrs, level: 3 } };
  if (node.type === "text") {
    const isCode = inCode || node.marks?.some((m) => m.type === "code") === true;
    return isCode || node.text === undefined || node.text === "" ? node : { ...node, text: node.text.replace(/[ \t]*\n[ \t]*/gu, " ") };
  }
  if (!node.content) return node;
  const childInCode = inCode || node.type === "codeBlock";
  return {
    ...node,
    content: node.content
      .filter((child) => child.type !== "text" || (child.text !== undefined && child.text !== ""))
      .map((child) => normalizeParsedJSON(child, childInCode)),
  };
}

/**
 * Builds a valid document from JSON. Content that does not fit the schema is
 * round-tripped through the DOM parser, which repairs structure.
 */
export function jsonToDoc(json: JSONContent, schema: Schema = noteSchema()): PMNode {
  const doc = schema.nodeFromJSON(normalizeParsedJSON(json));
  try {
    doc.check();
    return doc;
  } catch {
    return htmlToDoc(docToHtml(doc), schema);
  }
}

/** Canonical HTML → the editor's JSON. */
export function htmlToJson(html: string): JSONContent {
  return htmlToDoc(html).toJSON() as JSONContent;
}

/** The editor's JSON → canonical HTML. */
export function jsonToHtml(json: JSONContent): string {
  return docToHtml(jsonToDoc(json));
}

/**
 * HTML as the editor would keep it: parsed and serialised once, so two
 * spellings of the same document settle on one.
 */
export function normalizeNoteHtml(html: string): string {
  return html.trim() === "" ? "" : docToHtml(htmlToDoc(html));
}
