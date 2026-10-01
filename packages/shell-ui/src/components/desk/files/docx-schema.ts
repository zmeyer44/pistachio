/**
 * The document viewer's editor (docs/desk-documents.md §2): a ProseMirror
 * schema whose nodes and marks are the JSON @pistachio/documents reads a
 * Word document into, so an edit made here is written back into the file in
 * place (saveDocx). Every node that came from the file keeps its `key`
 * through edits — ProseMirror copies a paragraph's attributes to both halves
 * when it splits one — and a key pasted from another document, which would
 * name the wrong element, is dropped (`docId`).
 *
 * What can be edited is text. Pictures, fields, symbols and the blocks the
 * file keeps as they are (a table of contents, tracked changes) are atoms:
 * shown, selectable and deletable, never edited inside.
 */

import { Extension, Mark, Node, mergeAttributes, type AnyExtension } from "@tiptap/core";
import { Gapcursor, UndoRedo } from "@tiptap/extensions";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ListCounter, type ListLevels } from "@pistachio/documents";

export interface DocxEditorOptions {
  /** This document, opened: keys in pasted HTML from another are not this one's. */
  docId: string;
  /** Each picture part, as a URL the page can load. */
  media: Record<string, string>;
  lists: ListLevels;
  markerCss: Record<string, string>;
}

function numberOrNull(value: string | null): number | null {
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

/** Attributes that only hold for this document: read back from pasted HTML only when it came from it. */
function ownAttribute<T>(docId: string, attribute: string, html: string, fallback: T, read: (value: string | null) => T, write: (value: T) => Record<string, string | undefined>) {
  return {
    default: fallback,
    keepOnSplit: true,
    parseHTML: (el: HTMLElement): T => (el.closest("[data-docx-doc]")?.getAttribute("data-docx-doc") === docId ? read(el.getAttribute(html)) : fallback),
    renderHTML: (attrs: Record<string, unknown>): Record<string, string | undefined> => write(attrs[attribute] as T),
  };
}

function docAttributes(docId: string) {
  return {
    key: ownAttribute<number | null>(docId, "key", "data-docx-key", null, numberOrNull, (key) => (key === null ? {} : { "data-docx-key": String(key), "data-docx-doc": docId })),
    sig: ownAttribute(docId, "sig", "data-docx-sig", "", (value) => value ?? "", (sig) => (sig === "" ? {} : { "data-docx-sig": sig })),
    css: ownAttribute(docId, "css", "data-docx-css", "", (value) => value ?? "", (css) => (css === "" ? {} : { style: css, "data-docx-css": css })),
  };
}

const DocxDocument = Node.create({ name: "doc", topNode: true, content: "block+" });
const DocxText = Node.create({ name: "text", group: "inline" });

function paragraph(docId: string) {
  return Node.create({
    name: "docxParagraph",
    group: "block",
    content: "inline*",
    priority: 1000,
    addAttributes() {
      return {
        ...docAttributes(docId),
        role: { default: "p", keepOnSplit: true, parseHTML: (el: HTMLElement) => (/^H[1-6]$/.test(el.tagName) ? el.tagName.toLowerCase() : "p"), renderHTML: () => ({}) },
        numId: ownAttribute<string | null>(docId, "numId", "data-docx-num", null, (value) => value, (numId) => (numId === null ? {} : { "data-docx-num": numId })),
        ilvl: ownAttribute(docId, "ilvl", "data-docx-level", 0, (value) => Number(value ?? "0") || 0, (ilvl) => ({ "data-docx-level": String(ilvl) })),
      };
    },
    parseHTML() {
      return [{ tag: "p" }, { tag: "h1" }, { tag: "h2" }, { tag: "h3" }, { tag: "h4" }, { tag: "h5" }, { tag: "h6" }, { tag: "li" }, { tag: "div", priority: 10 }];
    },
    renderHTML({ node, HTMLAttributes }) {
      const role = typeof node.attrs["role"] === "string" && /^h[1-6]$/.test(node.attrs["role"]) ? node.attrs["role"] : "p";
      return [role, mergeAttributes(HTMLAttributes, { class: "docx-p" }), 0];
    },
  });
}

function run(docId: string) {
  return Mark.create({
    name: "docxRun",
    inclusive: true,
    addAttributes() {
      const { key, css } = docAttributes(docId);
      return { key, css };
    },
    parseHTML() {
      return [{ tag: "span[data-docx-run]" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["span", mergeAttributes({ "data-docx-run": "" }, HTMLAttributes), 0];
    },
  });
}

const DocxBreak = Node.create({
  name: "docxBreak",
  group: "inline",
  inline: true,
  selectable: false,
  parseHTML() {
    return [{ tag: "br" }];
  },
  renderHTML() {
    return ["br"];
  },
  addKeyboardShortcuts() {
    return { "Shift-Enter": () => this.editor.commands.insertContent({ type: "docxBreak" }) };
  },
});

function image(docId: string, media: Record<string, string>) {
  return Node.create({
    name: "docxImage",
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
      return {
        key: { default: 0 },
        src: { default: "" },
        width: { default: 0 },
        height: { default: 0 },
        alt: { default: "" },
      };
    },
    parseHTML() {
      return [
        {
          tag: "img[data-docx-key]",
          getAttrs: (el: HTMLElement) =>
            el.getAttribute("data-docx-doc") === docId
              ? { key: numberOrNull(el.getAttribute("data-docx-key")) ?? 0, src: el.getAttribute("data-docx-src") ?? "", width: Number(el.getAttribute("width")) || 0, height: Number(el.getAttribute("height")) || 0, alt: el.getAttribute("alt") ?? "" }
              : false,
        },
      ];
    },
    renderHTML({ node }) {
      const { key, src, width, height, alt } = node.attrs as { key: number; src: string; width: number; height: number; alt: string };
      return [
        "img",
        {
          src: media[src] ?? "",
          alt,
          width: String(width),
          height: String(height),
          class: "docx-image",
          style: `width:${String(width)}px;aspect-ratio:${String(width)} / ${String(Math.max(1, height))}`,
          draggable: "false",
          "data-docx-key": String(key),
          "data-docx-src": src,
          "data-docx-doc": docId,
        },
      ];
    },
  });
}

/** What a kept part says when it has no text of its own. */
function lockedText(label: string, text: string): string {
  if (text !== "") return text;
  if (label === "Picture" || label === "Drawing" || label === "Object") return `[${label.toLowerCase()}]`;
  return "";
}

const DocxLocked = Node.create({
  name: "docxLocked",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { keys: { default: "" }, text: { default: "" }, css: { default: "" }, label: { default: "" } };
  },
  renderHTML({ node }) {
    const { text, css, label } = node.attrs as { text: string; css: string; label: string };
    if (label === "Page break") return ["span", { class: "docx-page-break", contenteditable: "false", title: "Page break" }];
    return ["span", { class: "docx-locked", contenteditable: "false", title: `${label} — kept as it is`, style: css, "data-label": label }, lockedText(label, text)];
  },
});

const DocxLockedBlock = Node.create({
  name: "docxLockedBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { key: { default: 0 }, text: { default: "" }, css: { default: "" }, label: { default: "" } };
  },
  renderHTML({ node }) {
    const { text, css, label } = node.attrs as { text: string; css: string; label: string };
    return ["div", { class: "docx-locked-block", contenteditable: "false", title: `${label} — kept as it is, not editable here`, style: css, "data-label": label }, text === "" ? label : text];
  },
});

function table(docId: string) {
  return Node.create({
    name: "docxTable",
    group: "block",
    content: "docxRow+",
    isolating: true,
    addAttributes() {
      return docAttributes(docId);
    },
    renderHTML({ HTMLAttributes }) {
      return ["table", mergeAttributes(HTMLAttributes, { class: "docx-table" }), ["tbody", 0]];
    },
  });
}

function row(docId: string) {
  return Node.create({
    name: "docxRow",
    content: "docxCell+",
    addAttributes() {
      const { key, css } = docAttributes(docId);
      return { key, css };
    },
    renderHTML({ HTMLAttributes }) {
      return ["tr", HTMLAttributes, 0];
    },
  });
}

function cell(docId: string) {
  return Node.create({
    name: "docxCell",
    content: "block+",
    isolating: true,
    addAttributes() {
      const { key, css } = docAttributes(docId);
      return {
        key,
        css,
        colspan: { default: 1, renderHTML: (attrs: Record<string, unknown>) => (attrs["colspan"] === 1 ? {} : { colspan: String(attrs["colspan"]) }) },
      };
    },
    renderHTML({ HTMLAttributes }) {
      return ["td", HTMLAttributes, 0];
    },
  });
}

const markersKey = new PluginKey<DecorationSet>("docxMarkers");

/** Each list paragraph's marker ("3.", "b)", "•"), counted afresh as the document changes, in the paragraph's hanging indent. */
function markers(lists: ListLevels, markerCss: Record<string, string>) {
  const build = (doc: ProseMirrorNode): DecorationSet => {
    const counter = new ListCounter(lists);
    const decorations: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name !== "docxParagraph") return node.type.name !== "docxLockedBlock";
      const numId = node.attrs["numId"] as string | null;
      const ilvl = node.attrs["ilvl"] as number;
      const marker = counter.next(numId, ilvl);
      if (marker !== null && marker !== "") {
        const css = markerCss[`${numId ?? ""}:${String(ilvl)}`] ?? "";
        decorations.push(
          Decoration.widget(
            pos + 1,
            () => {
              const span = document.createElement("span");
              span.className = "docx-marker";
              span.contentEditable = "false";
              span.setAttribute("style", css);
              span.textContent = marker;
              return span;
            },
            { side: -1, key: `${marker}|${css}`, ignoreSelection: true },
          ),
        );
      }
      return false;
    });
    return DecorationSet.create(doc, decorations);
  };
  return Extension.create({
    name: "docxMarkers",
    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: markersKey,
          state: {
            init: (_, state) => build(state.doc),
            apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
          },
          props: {
            decorations: (state) => markersKey.getState(state),
          },
        }),
      ];
    },
  });
}

export function docxExtensions(options: DocxEditorOptions): AnyExtension[] {
  return [
    DocxDocument,
    DocxText,
    paragraph(options.docId),
    run(options.docId),
    DocxBreak,
    image(options.docId, options.media),
    DocxLocked,
    DocxLockedBlock,
    table(options.docId),
    row(options.docId),
    cell(options.docId),
    markers(options.lists, options.markerCss),
    UndoRedo,
    Gapcursor,
  ];
}
