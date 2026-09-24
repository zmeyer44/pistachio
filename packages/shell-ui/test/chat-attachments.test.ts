import { beforeAll, describe, expect, it } from "vitest";
import {
  composerAttachmentFromInsert,
  formatAttachmentText,
  formatSelectionText,
  MAX_ATTACHMENT_BYTES,
  readComposerAttachment,
  selectionChipLabel,
  toAgentAttachments,
  type ComposerAttachment,
} from "../src/lib/chat-attachments";

/**
 * The image path reads through FileReader, which the renderer has and Node
 * does not. The shim is the two members the reader actually uses.
 */
beforeAll(() => {
  if ("FileReader" in globalThis) return;
  (globalThis as Record<string, unknown>)["FileReader"] = class {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(file: File): void {
      void file.arrayBuffer().then((bytes) => {
        this.result = `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
        this.onload?.();
      });
    }
  };
});

describe("composer attachments", () => {
  it("reads an image as a data URL and a text file as decoded text", async () => {
    const png = await readComposerAttachment(
      new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }),
    );
    expect(png.ok).toBe(true);
    if (!png.ok) return;
    expect(png.attachment.kind).toBe("image");
    expect(png.attachment.url.startsWith("data:image/png;base64,")).toBe(true);

    const notes = await readComposerAttachment(new File(["hello"], "notes.md", { type: "" }));
    expect(notes.ok).toBe(true);
    if (!notes.ok) return;
    // Text is decoded here and folds into the message body, so it carries no URL.
    expect(notes.attachment).toMatchObject({ kind: "text", text: "hello", url: "" });
  });

  it("refuses empty, oversized, and unsupported files with a readable reason", async () => {
    const empty = await readComposerAttachment(new File([], "nothing.png", { type: "image/png" }));
    expect(empty).toEqual({ ok: false, reason: "nothing.png is empty" });

    const huge = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "big.png", { type: "image/png" });
    expect(await readComposerAttachment(huge)).toEqual({ ok: false, reason: "big.png is over 4 MB" });

    const binary = await readComposerAttachment(new File([new Uint8Array([1])], "app.bin", { type: "" }));
    expect(binary.ok).toBe(false);
    if (binary.ok) return;
    expect(binary.reason).toContain("only images, PDFs, and text files");
  });

  it("fences attached text so its own backticks cannot break out", () => {
    const block = formatAttachmentText("readme.md", "```\ncode\n```");
    expect(block).toContain("````");
    expect(block).toContain("```\ncode\n```");
  });

  it("sends only the files the model can see — text already rode in the body", () => {
    const staged: ComposerAttachment[] = [
      { id: "a", name: "shot.png", mediaType: "image/png", url: "data:image/png;base64,AA", kind: "image" },
      { id: "b", name: "notes.md", mediaType: "text/plain", url: "", kind: "text", text: "hi" },
      { id: "c", name: "spec.pdf", mediaType: "application/pdf", url: "data:application/pdf;base64,BB", kind: "pdf" },
    ];
    staged.push({ id: "d", name: "Example", mediaType: "text/plain", url: "https://example.com/", kind: "selection", text: "quoted" });
    expect(toAgentAttachments(staged).map((file) => file.name)).toEqual(["shot.png", "spec.pdf"]);
    // The wire shape drops `kind`/`text`; only what the thread renders survives.
    expect(toAgentAttachments(staged)[0]).toEqual({
      id: "a",
      name: "shot.png",
      mediaType: "image/png",
      url: "data:image/png;base64,AA",
    });
  });

  it("stages what a page's menu sent exactly as a drop would", () => {
    const image = composerAttachmentFromInsert({ kind: "image", name: "photo.jpg", mediaType: "image/jpeg", url: "data:image/jpeg;base64,AA" });
    expect(image).toMatchObject({ kind: "image", name: "photo.jpg", mediaType: "image/jpeg", url: "data:image/jpeg;base64,AA" });
    expect(image.id).not.toBe("");

    const words = composerAttachmentFromInsert({ kind: "selection", text: "some words", title: "Example", url: "https://example.com/a" });
    expect(words).toMatchObject({ kind: "selection", name: "Example", url: "https://example.com/a", text: "some words" });
  });

  it("tells the model where selected words came from, and shows a short chip for them", () => {
    const block = formatSelectionText("Example Domain", "https://example.com/", "one\ntwo");
    expect(block.startsWith("Selected on Example Domain (https://example.com/):\n````\none\ntwo\n````")).toBe(true);
    expect(formatSelectionText("  ", "https://example.com/", "x")).toContain("Selected on https://example.com/:");
    expect(selectionChipLabel("  a   short\nline ")).toBe("a short line");
    expect(selectionChipLabel("word ".repeat(20))).toBe("word word word word word word word word…");
  });
});
