/**
 * Reassembling brokered assets on the viewer side (docs/web-browser-design.md §16.3).
 *
 * Bytes arrive in binary socket frames, one chunk each, in no promised order
 * and interleaved with other assets. This keeps the partial ones until the
 * last byte lands and hands back the whole; it is pure so a Node test can
 * feed it chunks.
 */

import { decodeAssetChunk, type AssetChunkHeader } from "./protocol.js";

export interface AssembledAsset {
  tabId: string;
  id: string;
  type: string;
  bytes: Uint8Array;
}

/** Whether an asset's bytes are a stylesheet the renderer must treat as text with tokens. */
export function isStylesheetType(type: string): boolean {
  return type.split(";")[0]?.trim().toLowerCase() === "text/css";
}

export class AssetAssembler {
  readonly #partial = new Map<string, { header: AssetChunkHeader; buffer: Uint8Array; received: number }>();

  /** Feed one binary frame; the asset comes back once it is whole. */
  receive(data: ArrayBuffer | Uint8Array): AssembledAsset | null {
    const chunk = decodeAssetChunk(data);
    if (chunk === null) return null;
    const { header, bytes } = chunk;
    const key = `${header.tabId} ${header.id}`;
    if (header.total === bytes.byteLength && header.offset === 0) {
      this.#partial.delete(key);
      return { tabId: header.tabId, id: header.id, type: header.type, bytes };
    }
    let entry = this.#partial.get(key);
    if (entry === undefined || entry.header.total !== header.total) {
      entry = { header, buffer: new Uint8Array(header.total), received: 0 };
      this.#partial.set(key, entry);
    }
    entry.buffer.set(bytes, header.offset);
    entry.received += bytes.byteLength;
    if (entry.received < header.total) return null;
    this.#partial.delete(key);
    return { tabId: header.tabId, id: header.id, type: header.type, bytes: entry.buffer };
  }

  /** Forget everything in flight for a tab (its pane went away). */
  forget(tabId: string): void {
    for (const key of [...this.#partial.keys()]) if (key.startsWith(`${tabId} `)) this.#partial.delete(key);
  }

  get inFlight(): number {
    return this.#partial.size;
  }
}
