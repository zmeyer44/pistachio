/**
 * XML for Office parts, the same in main and in the shell: xmldom, so what
 * is read and what is written back is one implementation's reading, tested
 * under node exactly as it runs.
 *
 * Office's namespaces come in two editions (transitional, and ISO strict
 * with its own URIs); elements and attributes are matched by their local
 * name within the edition's namespaces, whichever the file uses.
 */

import { DOMParser, XMLSerializer, type Document, type Element, type Node } from "@xmldom/xmldom";
import { DocumentError } from "./zip.js";

export type { Document, Element, Node };

export const NS = {
  /** WordprocessingML: transitional, and strict. */
  w: ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"],
  /** SpreadsheetML. */
  x: ["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"],
  /** Relationships from inside a part (r:id, r:embed). */
  r: ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"],
  /** A package's relationship parts (`_rels/*.rels`). */
  rels: ["http://schemas.openxmlformats.org/package/2006/relationships"],
  /** DrawingML: pictures, and the drawings that hold them. */
  a: ["http://schemas.openxmlformats.org/drawingml/2006/main", "http://purl.oclc.org/ooxml/drawingml/main"],
  wp: ["http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing"],
  mc: ["http://schemas.openxmlformats.org/markup-compatibility/2006"],
} as const;

export type Namespace = readonly string[];

const XML_NS = "http://www.w3.org/XML/1998/namespace";

export function parseXml(text: string): Document {
  // Office parts never declare a document type; one that does is not an Office part, and its entities are not expanded here.
  if (/<!DOCTYPE/i.test(text.slice(0, 2_048))) throw new DocumentError("the file is not a readable Office document");
  try {
    return new DOMParser({ locator: false, onError: (level) => {
      if (level === "fatalError") throw new DocumentError("the file is not a readable Office document");
    } }).parseFromString(text, "text/xml");
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError("the file is not a readable Office document");
  }
}

export function serializeXml(doc: Document): string {
  return new XMLSerializer().serializeToString(doc);
}

export function isElement(node: Node | null | undefined): node is Element {
  return node !== null && node !== undefined && node.nodeType === 1;
}

/** `el` is `local` in one of `ns`'s namespaces. (An element known to be one is not narrowed away when it is not.) */
export function is(el: Element, ns: Namespace, local: string): boolean;
export function is(el: Node | null | undefined, ns: Namespace, local: string): el is Element;
export function is(el: Node | null | undefined, ns: Namespace, local: string): boolean {
  return isElement(el) && el.localName === local && ns.includes(el.namespaceURI ?? "");
}

export function inNs(el: Node | null | undefined, ns: Namespace): el is Element {
  return isElement(el) && ns.includes(el.namespaceURI ?? "");
}

/** The element children of `el`, or only those that are `local` in `ns`. */
export function kids(el: Element | Document, ns?: Namespace, local?: string): Element[] {
  const found: Element[] = [];
  for (let node = el.firstChild; node !== null; node = node.nextSibling) {
    if (!isElement(node)) continue;
    if (ns !== undefined && local !== undefined && !is(node, ns, local)) continue;
    found.push(node);
  }
  return found;
}

export function kid(el: Element | Document | null | undefined, ns: Namespace, local: string): Element | null {
  if (el === null || el === undefined) return null;
  for (let node = el.firstChild; node !== null; node = node.nextSibling) if (is(node, ns, local)) return node;
  return null;
}

/** The first descendant that is `local` in `ns`, depth first. */
export function descendant(el: Element | null | undefined, ns: Namespace, local: string): Element | null {
  if (el === null || el === undefined) return null;
  for (let node = el.firstChild; node !== null; node = node.nextSibling) {
    if (!isElement(node)) continue;
    if (is(node, ns, local)) return node;
    const deeper = descendant(node, ns, local);
    if (deeper !== null) return deeper;
  }
  return null;
}

export function descendants(el: Element | Document, ns: Namespace, local: string, into: Element[] = []): Element[] {
  for (let node = el.firstChild; node !== null; node = node.nextSibling) {
    if (!isElement(node)) continue;
    if (is(node, ns, local)) into.push(node);
    descendants(node, ns, local, into);
  }
  return into;
}

/** An attribute by local name in one of `ns`'s namespaces — or, with `ns` null, one with no namespace. */
export function attr(el: Element | null | undefined, ns: Namespace | null, local: string): string | null {
  if (el === null || el === undefined) return null;
  const attributes = el.attributes;
  for (let index = 0; index < attributes.length; index += 1) {
    const attribute = attributes.item(index);
    if (attribute === null || attribute.localName !== local) continue;
    if (ns === null ? attribute.namespaceURI === null || attribute.namespaceURI === "" : ns.includes(attribute.namespaceURI ?? "")) return attribute.value;
  }
  return null;
}

/** A child's `val` attribute: `<w:jc w:val="center"/>` — the way Word says most things. */
export function val(el: Element | null | undefined, ns: Namespace, local: string): string | null {
  const found = kid(el, ns, local);
  return found === null ? null : attr(found, ns, "val");
}

/**
 * An on/off property (`<w:b/>`, `<w:b w:val="0"/>`): true or false when
 * it is there, null when it is not (and inherits).
 */
export function toggle(el: Element | null | undefined, ns: Namespace, local: string): boolean | null {
  const found = kid(el, ns, local);
  if (found === null) return null;
  const value = attr(found, ns, "val");
  return value === null || !(value === "0" || value === "false" || value === "off" || value === "none");
}

/** An element in the same namespace (and with the same prefix) as `like`. */
export function create(doc: Document, like: Element, local: string): Element {
  const prefix = like.prefix;
  return doc.createElementNS(like.namespaceURI ?? NS.w[0], prefix === null || prefix === "" ? local : `${prefix}:${local}`);
}

/** `xml:space="preserve"`, so leading and trailing spaces in a text element are kept. */
export function preserveSpace(el: Element): void {
  el.setAttributeNS(XML_NS, "xml:space", "preserve");
}

export function textOf(el: Element | null | undefined): string {
  return el?.textContent ?? "";
}
