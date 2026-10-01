import { describe, expect, it } from "vitest";
import {
  deskStateLines,
  DOC_MEDIA_TYPE,
  DOCX_MEDIA_TYPE,
  fileItemOf,
  fileViewerKind,
  fileWindowId,
  groupContextLines,
  groupContextMediaTypeOf,
  isDeskAgentState,
  isGroupFileWrite,
  sanitizeGroupContext,
  XLSX_MEDIA_TYPE,
  type DeskAgentState,
} from "../src/desk-agent.js";

describe("documents on the desk (docs/desk-documents.md)", () => {
  it("keeps a file by its extension first, what the drop reported after", () => {
    expect(groupContextMediaTypeOf("trip.docx", "")).toBe(DOCX_MEDIA_TYPE);
    expect(groupContextMediaTypeOf("OLD.DOC", "application/octet-stream")).toBe(DOC_MEDIA_TYPE);
    expect(groupContextMediaTypeOf("budget.xlsx", "")).toBe(XLSX_MEDIA_TYPE);
    expect(groupContextMediaTypeOf("photo.HEIC", "")).toBe("image/heic");
    expect(groupContextMediaTypeOf("notes.md", "text/plain")).toBe("text/markdown");
    expect(groupContextMediaTypeOf("scan", "image/jpg")).toBe("image/jpeg");
    expect(groupContextMediaTypeOf("song.mp3", "audio/mpeg")).toBeNull();
    expect(groupContextMediaTypeOf("archive.zip", "application/zip")).toBeNull();
  });

  it("has a viewer for every kind the Stack takes", () => {
    expect(fileViewerKind("text/markdown")).toBe("markdown");
    expect(fileViewerKind("application/json")).toBe("text");
    expect(fileViewerKind(DOC_MEDIA_TYPE)).toBe("document");
    expect(fileViewerKind("text/csv")).toBe("sheet");
    expect(fileViewerKind("image/tiff")).toBe("image");
    expect(fileViewerKind("application/pdf")).toBe("pdf");
    expect(fileViewerKind("audio/mpeg")).toBeNull();
  });

  it("names a document's window file: and its item", () => {
    expect(fileWindowId("0123456789ab")).toBe("file:0123456789ab");
    expect(fileItemOf("file:0123456789ab")).toBe("0123456789ab");
    expect(fileItemOf("5b0c2e8e-1f3c-4f53-9a55-3c3e2f1d9b10")).toBeNull();
  });

  it("tells the agent of document windows among the windows, and how to open a file", () => {
    const state: DeskAgentState = {
      groupId: "g1",
      title: "Lisbon",
      windows: [
        { tabId: "tab-1", kind: "tab", title: "Flight", url: "https://air.example/", box: { x: 0, y: 0, w: 50, h: 100 }, focused: false, masked: false },
        { tabId: "file:0123456789ab", kind: "file", title: "trip.docx", url: "", box: { x: 50, y: 0, w: 50, h: 100 }, focused: true, masked: false },
      ],
      docked: [],
    };
    expect(isDeskAgentState(state)).toBe(true);
    expect(isDeskAgentState({ ...state, windows: [{ ...state.windows[0], kind: "movie" }] })).toBe(false);
    expect(deskStateLines(state)).toEqual([
      "Desk: the tab group “Lisbon” (2 tabs).",
      "Windows, bottom to top (x y w h as % of the desk):",
      "- tab tab-1 “Flight” https://air.example/ — 0 0 50 100",
      "- document file:0123456789ab “trip.docx” — 50 0 50 100 — in use",
    ]);
    expect(groupContextLines([{ id: "0123456789ab", kind: "file", name: "trip.docx", mediaType: DOCX_MEDIA_TYPE, byteLength: 4_096, blobId: "a".repeat(24), addedAt: "", addedBy: "person" }])[0]).toContain(
      "a file opens on the desk as the document file:<its id>",
    );
  });

  it("checks a document's new bytes, and keeps when a file was last edited", () => {
    const write = { groupId: "g1", itemId: "0123456789ab", baseBlobId: "a".repeat(24), bytes: new Uint8Array([1, 2]) };
    expect(isGroupFileWrite(write)).toBe(true);
    expect(isGroupFileWrite({ ...write, as: "docx", force: true })).toBe(true);
    expect(isGroupFileWrite({ ...write, bytes: [1, 2] })).toBe(false);
    expect(isGroupFileWrite({ ...write, as: "pdf" })).toBe(false);
    expect(isGroupFileWrite({ ...write, baseBlobId: "nope" })).toBe(false);
    const context = sanitizeGroupContext({
      groupId: "g1",
      title: "Lisbon",
      updatedAt: "2026-09-30T00:00:00.000Z",
      items: [{ id: "0123456789ab", kind: "file", name: "trip.docx", mediaType: DOCX_MEDIA_TYPE, byteLength: 10, blobId: "b".repeat(24), addedAt: "x", addedBy: "person", editedAt: "2026-09-30T01:00:00.000Z" }],
    });
    expect(context?.items[0]).toMatchObject({ mediaType: DOCX_MEDIA_TYPE, editedAt: "2026-09-30T01:00:00.000Z" });
  });
});
