/**
 * The Open Packaging Conventions every Office file follows: a part names
 * the parts it uses (its styles, its sheets, its pictures) by relationship,
 * in a `_rels/<part>.rels` beside it.
 */

import { attr, kids, NS, parseXml } from "./xml.js";
import { resolvePartPath, zipText, type ZipEntries } from "./zip.js";

export interface Rel {
  id: string;
  type: string;
  /** The part it names, as a path in the zip; "" for a target outside the file (a web link). */
  target: string;
  external: boolean;
}

/** A part's relationships (`""` for the package's own). */
export function readRels(entries: ZipEntries, part: string): Rel[] {
  const dir = part.split("/").slice(0, -1).join("/");
  const name = part.split("/").pop() ?? "";
  const text = zipText(entries, `${dir === "" ? "" : `${dir}/`}_rels/${name}.rels`);
  if (text === null) return [];
  const root = parseXml(text).documentElement;
  if (root === null) return [];
  return kids(root, NS.rels, "Relationship").map((rel) => {
    const external = attr(rel, null, "TargetMode") === "External";
    return {
      id: attr(rel, null, "Id") ?? "",
      type: attr(rel, null, "Type") ?? "",
      target: external ? "" : resolvePartPath(part, attr(rel, null, "Target") ?? ""),
      external,
    };
  });
}

/** The package's main part (the workbook, the document), as its root relationships name it. */
export function mainPart(entries: ZipEntries, fallback: string): string {
  const root = readRels(entries, "").find((rel) => rel.type.endsWith("/officeDocument"));
  return root !== undefined && root.target !== "" && entries.has(root.target) ? root.target : fallback;
}

/** A picture part's media type, by its extension. */
export function mediaTypeOf(path: string): string {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    webp: "image/webp",
    svg: "image/svg+xml",
    tif: "image/tiff",
    tiff: "image/tiff",
    emf: "image/emf",
    wmf: "image/wmf",
  };
  return types[extension] ?? "application/octet-stream";
}
