/**
 * The pure half of notes (docs/notes.md §2, §6): what survives a sanitizer,
 * what a snippet says, which pictures a note claims, how a search ranks, and
 * the one edit the agent makes without holding the whole document.
 *
 * The edit modes are the sharp part. `note_update` is how the agent writes
 * into something the person wrote, and a mode that silently loses the rest of
 * the note is the bug this file exists to prevent — so every mode is pinned,
 * including `replace_section` refusing a heading the note does not have
 * rather than appending and hoping.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_NOTE_MARKDOWN_BYTES,
  MAX_NOTE_TITLE,
  NOTE_SNIPPET_LENGTH,
  NOTE_UNTITLED,
  applyNoteEdit,
  describeNote,
  isNoteBlobId,
  isNoteId,
  noteBlobIdsIn,
  noteSnippet,
  noteToolView,
  sanitizeNote,
  sanitizeNoteBlob,
  sanitizeNoteInput,
  sanitizeNotePatch,
  searchNotes,
  summaryOf,
  type Note,
} from "../src/views/notes.js";

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "0a1b2c3d4e5f",
    title: "Sour cherry pie",
    markdown: "Sour cherries, a lattice top.",
    icon: null,
    blobIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    revision: 1,
    source: { kind: "user", runId: null },
    ...overrides,
  };
}

describe("ids", () => {
  it("are twelve hex for a note and twenty-four for a blob, lowercase both", () => {
    expect(isNoteId("0a1b2c3d4e5f")).toBe(true);
    expect(isNoteId("0A1B2C3D4E5F")).toBe(false);
    expect(isNoteId("0a1b2c3d4e5")).toBe(false);
    expect(isNoteBlobId("0123456789abcdef01234567")).toBe(true);
    expect(isNoteBlobId("0a1b2c3d4e5f")).toBe(false);
  });
});

describe("sanitizeNote", () => {
  it("reads a whole note and recomputes its blob ids from the markdown", () => {
    const read = sanitizeNote({
      ...note({ markdown: "![pie](note-blob:0123456789abcdef01234567)" }),
      blobIds: ["something the file claimed"],
    });
    expect(read?.blobIds).toEqual(["0123456789abcdef01234567"]);
  });

  it("drops a note whose id, revision or timestamps are not what they must be", () => {
    expect(sanitizeNote(null)).toBeNull();
    expect(sanitizeNote(note({ id: "nope" }))).toBeNull();
    expect(sanitizeNote({ ...note(), revision: 0 })).toBeNull();
    expect(sanitizeNote({ ...note(), updatedAt: "whenever" })).toBeNull();
  });

  it("bounds the title, keeps an emoji icon and refuses a word as one", () => {
    const long = sanitizeNote(note({ title: "a".repeat(MAX_NOTE_TITLE + 40), icon: "🥧" }));
    expect(long?.title).toHaveLength(MAX_NOTE_TITLE);
    expect(long?.icon).toBe("🥧");
    expect(sanitizeNote(note({ icon: "pie" }))?.icon).toBeNull();
  });

  it("bounds the markdown by BYTES, not characters, and normalizes line endings", () => {
    const huge = sanitizeNote(note({ markdown: "🥧".repeat(MAX_NOTE_MARKDOWN_BYTES) }));
    expect(new TextEncoder().encode(huge?.markdown ?? "").length).toBeLessThanOrEqual(MAX_NOTE_MARKDOWN_BYTES);
    expect(sanitizeNote(note({ markdown: "a\r\nb\rc" }))?.markdown).toBe("a\nb\nc");
  });
});

describe("sanitizeNoteInput / sanitizeNotePatch", () => {
  it("carry only the fields that were named", () => {
    expect(sanitizeNoteInput({})).toEqual({});
    expect(sanitizeNotePatch({})).toEqual({});
    expect(sanitizeNoteInput({ title: "  Pie  ", markdown: "x" })).toEqual({ title: "Pie", markdown: "x" });
    expect(sanitizeNotePatch({ icon: "🥧" })).toEqual({ icon: "🥧" });
    // An empty title is a real value: a person may clear it.
    expect(sanitizeNotePatch({ title: "   " })).toEqual({ title: "" });
  });
});

describe("sanitizeNoteBlob", () => {
  const blob = {
    id: "0123456789abcdef01234567",
    mediaType: "image/png",
    byteLength: 12,
    data: "AAAA",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("keeps a well-formed image and refuses everything else", () => {
    expect(sanitizeNoteBlob(blob)).toEqual(blob);
    expect(sanitizeNoteBlob({ ...blob, id: "0a1b2c3d4e5f" })).toBeNull();
    expect(sanitizeNoteBlob({ ...blob, mediaType: "image/svg+xml" })).toBeNull();
    expect(sanitizeNoteBlob({ ...blob, byteLength: 40_000_000 })).toBeNull();
    expect(sanitizeNoteBlob({ ...blob, data: "" })).toBeNull();
  });
});

describe("noteSnippet", () => {
  it("says what the note says, without the syntax", () => {
    const markdown = "# Sunday\n\n- [ ] **butter**\n- [x] `flour`\n\n> a [link](https://example.com) and ![alt](note-blob:0123456789abcdef01234567)";
    expect(noteSnippet(markdown)).toBe("Sunday butter flour a link and alt");
  });

  it("stops around a hundred and sixty characters, on a word", () => {
    const snippet = noteSnippet(`${"word ".repeat(80)}end`);
    expect(snippet.length).toBeLessThanOrEqual(NOTE_SNIPPET_LENGTH);
    expect(snippet.endsWith("word")).toBe(true);
  });

  it("is empty for an empty note", () => {
    expect(noteSnippet("")).toBe("");
    expect(summaryOf(note({ markdown: "" })).snippet).toBe("");
  });
});

describe("noteBlobIdsIn", () => {
  it("finds every reference once, in the order they appear", () => {
    const a = "0123456789abcdef01234567";
    const b = "89abcdef0123456789abcdef";
    expect(noteBlobIdsIn(`![](note-blob:${a}) ![](note-blob:${b}) again ![](note-blob:${a})`)).toEqual([a, b]);
  });

  it("ignores anything that is not a blob id", () => {
    expect(noteBlobIdsIn("note-blob:nope and note-blob:0123 and https://example.com/note-blob:x")).toEqual([]);
  });
});

describe("searchNotes", () => {
  const pie = note({ id: "aaaaaaaaaaaa", title: "Sour cherry pie", markdown: "Lattice top." });
  const tools = note({ id: "bbbbbbbbbbbb", title: "Workshop", markdown: "A pie tin, a rolling pin.", updatedAt: "2026-01-03T00:00:00.000Z" });

  it("ranks a title match above a body match, however recent the body is", () => {
    expect(searchNotes([tools, pie], "pie").map((entry) => entry.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  });

  it("folds case and drops a note some word of the query misses", () => {
    expect(searchNotes([pie, tools], "SOUR CHERRY").map((entry) => entry.id)).toEqual(["aaaaaaaaaaaa"]);
    expect(searchNotes([pie, tools], "pie hammer")).toEqual([]);
  });

  it("is the most recently edited, newest first, when nothing was typed", () => {
    expect(searchNotes([pie, tools], "  ").map((entry) => entry.id)).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
    expect(searchNotes([pie, tools], "", { limit: 1 })).toHaveLength(1);
  });
});

describe("applyNoteEdit", () => {
  const body = "# Shopping\n\n- butter\n\n## Later\n\n- a tin\n\n# Notes\n\nnothing yet";

  it("replaces the whole document", () => {
    expect(applyNoteEdit(body, { mode: "replace", markdown: "new" })).toEqual({ ok: true, markdown: "new" });
  });

  it("appends and prepends with one blank line between, and handles an empty note", () => {
    expect(applyNoteEdit("a", { mode: "append", markdown: "b" })).toEqual({ ok: true, markdown: "a\n\nb" });
    expect(applyNoteEdit("a", { mode: "prepend", markdown: "b" })).toEqual({ ok: true, markdown: "b\n\na" });
    expect(applyNoteEdit("", { mode: "append", markdown: "b" })).toEqual({ ok: true, markdown: "b" });
    expect(applyNoteEdit("   \n", { mode: "prepend", markdown: "b" })).toEqual({ ok: true, markdown: "b" });
  });

  it("replaces a section up to the next heading of equal or higher level, keeping the rest", () => {
    const edited = applyNoteEdit(body, { mode: "replace_section", markdown: "- flour", section: "Later" });
    expect(edited).toEqual({
      ok: true,
      markdown: "# Shopping\n\n- butter\n\n## Later\n\n- flour\n\n# Notes\n\nnothing yet",
    });
  });

  it("takes the whole of a top-level section, its subheadings included", () => {
    const edited = applyNoteEdit(body, { mode: "replace_section", markdown: "gone", section: "shopping" });
    expect(edited).toEqual({ ok: true, markdown: "# Shopping\n\ngone\n\n# Notes\n\nnothing yet" });
  });

  it("empties a section when the new body is blank, and reaches the end of the note", () => {
    expect(applyNoteEdit(body, { mode: "replace_section", markdown: "", section: "Notes" })).toEqual({
      ok: true,
      markdown: "# Shopping\n\n- butter\n\n## Later\n\n- a tin\n\n# Notes",
    });
  });

  it("refuses a heading the note does not have rather than guessing", () => {
    expect(applyNoteEdit(body, { mode: "replace_section", markdown: "x", section: "Dessert" })).toEqual({
      ok: false,
      error: 'no section titled "Dessert" in this note',
    });
    expect(applyNoteEdit(body, { mode: "replace_section", markdown: "x" }).ok).toBe(false);
  });
});

describe("what the model sees", () => {
  it("lists a snippet and reads the whole markdown", () => {
    expect(noteToolView(note(), { full: false })).toEqual({
      id: "0a1b2c3d4e5f",
      title: "Sour cherry pie",
      updatedAt: "2026-01-02T00:00:00.000Z",
      snippet: "Sour cherries, a lattice top.",
    });
    expect(noteToolView(note(), { full: true }).markdown).toBe("Sour cherries, a lattice top.");
    expect(noteToolView(note(), { full: true }).snippet).toBeUndefined();
  });

  it("names an untitled note rather than showing a blank", () => {
    expect(noteToolView(note({ title: "" }), { full: false }).title).toBe(NOTE_UNTITLED);
    expect(describeNote(note({ title: "" }))).toContain(NOTE_UNTITLED);
    expect(describeNote(summaryOf(note()))).toBe("Sour cherry pie — note, edited 2026-01-02: Sour cherries, a lattice top.");
  });
});
