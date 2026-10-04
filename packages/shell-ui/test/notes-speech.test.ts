/**
 * A note as prose to be spoken (lib/notes-speech.ts): the document the
 * markdown stands for, read the way the reader reads an article.
 */

import { describe, expect, it } from "vitest";
import { noteSpeechText } from "../src/lib/notes-speech";

describe("a note read aloud", () => {
  it("reads the title, then the body, with no markdown punctuation and nothing that is not prose", () => {
    const markdown = `# Plans

Some **bold**, *italic*, ~~gone~~ and \`code\`, and [a link](https://example.com).

- Book flights
- Find a hotel
  - near Alfama

1. first
2. second

- [ ] Renew passport
- [x] Pack

> Pastel de nata, every morning.

\`\`\`ts
const a = 1;
\`\`\`

---

| City | Nights |
| --- | --- |
| Lisbon | 3 |

![a picture](note-blob:0123456789abcdef01234567)
`;
    expect(noteSpeechText("Lisbon trip", markdown)).toBe(
      [
        "Lisbon trip.",
        "Plans.",
        "Some bold, italic, gone and code, and a link.",
        "Book flights.",
        "Find a hotel.",
        "near Alfama.",
        "first.",
        "second.",
        "Renew passport.",
        "Pack.",
        "Pastel de nata, every morning.",
        "City, Nights.",
        "Lisbon, 3.",
      ].join("\n\n"),
    );
  });

  it("keeps a stop a line already ends with, and line breaks are spaces", () => {
    expect(noteSpeechText("Questions?", "## Why now:\n\nOne line  \nand the next.")).toBe("Questions?\n\nWhy now:\n\nOne line and the next.");
  });

  it("has nothing to say for an untitled note of code and pictures alone", () => {
    expect(noteSpeechText("  ", "```\nx\n```\n\n---\n")).toBe("");
  });
});
