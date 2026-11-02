import { describe, expect, it } from "vitest";
import { completeNote, completeNoteBody, noteToPlainText, noteWordCount } from "../src/index.js";

describe("noteToPlainText / noteWordCount", () => {
  it("reads what a reader would see, not what was typed", () => {
    expect(noteToPlainText('<h1>One</h1><p><strong>two</strong> <a href="https://example.com/">three</a> <code>four</code></p>')).toBe("One two three four");
    expect(noteToPlainText('<img src="note-blob:0123456789abcdef01234567" alt="a pie">')).toBe("a pie");
  });

  it("says nothing for a widget, an embed or code, and reads a toggle's title and body", () => {
    const html =
      '<div data-type="html-block" data-html="&lt;b&gt;secret&lt;/b&gt;"></div><div data-type="embed" data-src="https://youtu.be/abcdefghijk"></div>' +
      '<pre><code>const a = 1;</code></pre><details><summary>More</summary><div data-type="detailsContent"><p>inside</p></div></details>';
    expect(noteToPlainText(html)).toBe("More inside");
  });

  it("counts the words, and counts nothing as nothing", () => {
    expect(noteWordCount("<h1>One</h1><ul><li><p>two</p></li><li><p>three</p></li></ul>")).toBe(3);
    expect(noteWordCount("")).toBe(0);
    expect(noteWordCount("<p></p>")).toBe(0);
  });
});

describe("completeNote", () => {
  it("derives the half that is missing, and leaves a whole note alone", () => {
    expect(completeNoteBody({ markdown: "# Hi\n\nThere." })).toEqual({ html: "<h1>Hi</h1><p>There.</p>", markdown: "# Hi\n\nThere." });
    expect(completeNoteBody({ html: "<h1>Hi</h1><p>There.</p>" })).toEqual({ html: "<h1>Hi</h1><p>There.</p>", markdown: "# Hi\n\nThere.\n" });
    expect(completeNoteBody({ html: "<p>a</p>", markdown: "stale" })).toEqual({ html: "<p>a</p>", markdown: "stale" });
    expect(completeNoteBody({})).toEqual({ html: "", markdown: "" });
    expect(completeNote({ id: "x", title: "T", markdown: "a" })).toEqual({ id: "x", title: "T", markdown: "a", html: "<p>a</p>" });
  });
});
