/**
 * The agent's structural edit (docs/notes.md §6): a mode that silently loses
 * the rest of the note is the bug this file exists to prevent — so every
 * mode is pinned, including `replace_section` refusing a heading the note
 * does not have rather than appending and hoping, and a widget elsewhere in
 * the note surviving an edit untouched.
 */

import { describe, expect, it } from "vitest";
import { applyNoteEdit } from "../src/index.js";

const WIDGET = '<div data-type="html-block" data-html="&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;"></div>';
const NOTE = `<h2>Filling</h2><p>Sour cherries.</p>${WIDGET}<h2>Crust</h2><p>All butter.</p>`;

function ok(result: ReturnType<typeof applyNoteEdit>): string {
  if (!result.ok) throw new Error(result.error);
  return result.html;
}

describe("applyNoteEdit", () => {
  it("replaces the whole note", () => {
    expect(ok(applyNoteEdit(NOTE, { mode: "replace", markdown: "# New\n\nText" }))).toBe("<h1>New</h1><p>Text</p>");
  });

  it("appends and prepends without touching the rest", () => {
    expect(ok(applyNoteEdit(NOTE, { mode: "append", markdown: "- socks" }))).toBe(`${NOTE}<ul><li><p>socks</p></li></ul>`);
    expect(ok(applyNoteEdit(NOTE, { mode: "prepend", markdown: "> 💡 Tip" }))).toBe(`<div data-type="callout" data-emoji="💡"><p>Tip</p></div>${NOTE}`);
  });

  it("writes into an empty note as if it were new", () => {
    expect(ok(applyNoteEdit("", { mode: "append", markdown: "Hello" }))).toBe("<p>Hello</p>");
    expect(ok(applyNoteEdit("<p></p>", { mode: "prepend", markdown: "Hello" }))).toBe("<p>Hello</p>");
    expect(ok(applyNoteEdit("<p>x</p>", { mode: "replace", markdown: "" }))).toBe("");
  });

  it("replaces the body under a heading, up to the next of equal or higher level", () => {
    const out = ok(applyNoteEdit(NOTE, { mode: "replace_section", markdown: "Rhubarb, and less sugar.", section: "filling" }));
    expect(out).toBe("<h2>Filling</h2><p>Rhubarb, and less sugar.</p><h2>Crust</h2><p>All butter.</p>");
    const last = ok(applyNoteEdit(NOTE, { mode: "replace_section", markdown: "Lard.", section: "Crust" }));
    expect(last).toBe(`<h2>Filling</h2><p>Sour cherries.</p>${WIDGET}<h2>Crust</h2><p>Lard.</p>`);
  });

  it("keeps a deeper heading inside the section it belongs to", () => {
    const nested = "<h1>Pie</h1><p>a</p><h2>Crust</h2><p>b</p><h1>Cake</h1><p>c</p>";
    expect(ok(applyNoteEdit(nested, { mode: "replace_section", markdown: "new", section: "Pie" }))).toBe("<h1>Pie</h1><p>new</p><h1>Cake</h1><p>c</p>");
  });

  it("refuses a section the note does not have, and a nameless one", () => {
    expect(applyNoteEdit(NOTE, { mode: "replace_section", markdown: "x", section: "Ingredients" })).toEqual({
      ok: false,
      error: 'no section titled "Ingredients" in this note',
    });
    expect(applyNoteEdit(NOTE, { mode: "replace_section", markdown: "x" })).toEqual({ ok: false, error: "replace_section needs the heading to write under" });
  });
});
