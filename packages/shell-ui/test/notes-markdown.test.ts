/**
 * The note document's shape, and markdown through it (docs/notes.md §5).
 *
 * The round trip runs with no DOM at all — `resolveExtensions` and
 * `MarkdownManager` read the extensions' configuration and nothing else — so
 * what the editor will keep for a heading, a task list or a `note-blob:`
 * image is pinned here rather than only in a browser.
 */

import { describe, expect, it } from "vitest";
import { docToMarkdown, looksLikeMarkdown, markdownToDoc, noteExtensions, normalizeNoteMarkdown } from "../src/lib/notes-markdown";

const BLOB = "0123456789abcdef01234567";

const FIXTURE = `# A note

Some **bold**, *italic*, ~~gone~~ and \`code\`.

## Lists

- one
- two

1. first
2. second

- [ ] to do
- [x] done

> a quote

\`\`\`ts
const a = 1;
\`\`\`

---

| a | b |
| --- | --- |
| 1 | 2 |

![a picture](note-blob:${BLOB})

[a link](https://example.com)
`;

describe("note extensions", () => {
  it("declares each name once — a duplicate would double every input rule", () => {
    const names = noteExtensions().map((extension) => extension.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("markdown in and out", () => {
  it("keeps every block a note is allowed to hold", () => {
    const doc = markdownToDoc(FIXTURE);
    const kinds = (doc.content ?? []).map((node) => node.type);
    expect(kinds).toEqual([
      "heading",
      "paragraph",
      "heading",
      "bulletList",
      "orderedList",
      "taskList",
      "blockquote",
      "codeBlock",
      "horizontalRule",
      "table",
      "image",
      "paragraph",
    ]);
    expect(doc.content?.[0]).toMatchObject({ attrs: { level: 1 } });
    expect(doc.content?.[5]?.content?.[1]).toMatchObject({ attrs: { checked: true } });
  });

  it("round trips: what comes back parses to the same document", () => {
    const once = normalizeNoteMarkdown(FIXTURE);
    expect(normalizeNoteMarkdown(once)).toBe(once);
    expect(once).toContain("# A note");
    expect(once).toContain("**bold**");
    expect(once).toContain("*italic*");
    expect(once).toContain("~~gone~~");
    expect(once).toContain("`code`");
    expect(once).toContain("- [ ] to do");
    expect(once).toContain("- [x] done");
    expect(once).toContain("> a quote");
    expect(once).toContain("```ts");
    expect(once).toContain("---");
    expect(once).toContain("| a ");
    expect(once).toContain("[a link](https://example.com)");
  });

  it("carries an image as its blob address, not as bytes", () => {
    const markdown = normalizeNoteMarkdown(`![a picture](note-blob:${BLOB})\n`);
    expect(markdown.trim()).toBe(`![a picture](note-blob:${BLOB})`);
    const doc = markdownToDoc(markdown);
    const image = (doc.content ?? []).flatMap((node) => (node.type === "image" ? [node] : node.content ?? [])).find((node) => node.type === "image");
    expect(image).toMatchObject({ attrs: { src: `note-blob:${BLOB}` } });
  });

  it("does not let markup in a note become markup in the document", () => {
    // The closed schema is the sanitizer (N11): a script tag is text.
    expect(docToMarkdown(markdownToDoc("hi <script>alert(1)</script>\n"))).not.toContain("<script>");
  });

  it("empties to an empty string rather than to a stray paragraph", () => {
    expect(normalizeNoteMarkdown("").trim()).toBe("");
  });
});

describe("looksLikeMarkdown", () => {
  it("tells block syntax from prose", () => {
    expect(looksLikeMarkdown("# heading")).toBe(true);
    expect(looksLikeMarkdown("- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("see [here](https://x.test)")).toBe(true);
    expect(looksLikeMarkdown("just a sentence, with a dash - inside")).toBe(false);
  });
});
