import { beforeAll, describe, expect, it } from "vitest";
import {
  attachmentSink,
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

describe("files being read for one owner of a composer that serves several", () => {
  const attachment = (name: string): ComposerAttachment => ({ id: name, name, kind: "text", text: name }) as ComposerAttachment;

  it("go to the list on screen while their owner is the one served, and are kept for it when it is not", () => {
    // The desk's Bar: one composer, for whichever space is in front. A file dropped in g1 is still being read when
    // the person goes to g2, and another is read once they are back.
    let served = "g1";
    const here: string[] = [];
    const rejected: string[] = [];
    const kept: Array<[string, string]> = [];
    const sink = attachmentSink(
      "g1",
      () => served,
      { add: (file) => here.push(file.name), reject: (reason) => rejected.push(reason) },
      (owner, file) => kept.push([owner, file.name]),
    );
    sink.add(attachment("first.txt"));
    expect(sink.here()).toBe(true);
    served = "g2";
    // Read with g2 in front: g1's still, kept for it — g2's list is handed nothing, and hears no refusal of g1's.
    sink.add(attachment("second.txt"));
    sink.reject("third.png is over 4 MB");
    expect(sink.here()).toBe(false);
    served = "g1";
    sink.add(attachment("fourth.txt"));
    sink.reject("fifth.png is empty");
    expect(here).toEqual(["first.txt", "fourth.txt"]);
    expect(kept).toEqual([["g1", "second.txt"]]);
    expect(rejected).toEqual(["fifth.png is empty"]);
  });

  it("are kept for their owner once the composer itself has gone (the Bar, made anew for another Profile)", () => {
    const here: string[] = [];
    const kept: Array<[string, string]> = [];
    // (useAttachmentDrop serves nobody — null — once it is unmounted.)
    const sink = attachmentSink<string | null>("g1", () => null, { add: (file) => here.push(file.name), reject: () => undefined }, (owner, file) => kept.push([owner ?? "", file.name]));
    sink.add(attachment("late.txt"));
    expect(here).toEqual([]);
    expect(kept).toEqual([["g1", "late.txt"]]);
  });

  it("are the list's as ever where the composer has one owner (the console, the home chat)", () => {
    const here: string[] = [];
    const sink = attachmentSink(undefined, () => undefined, { add: (file) => here.push(file.name), reject: () => undefined }, undefined);
    sink.add(attachment("only.txt"));
    expect(here).toEqual(["only.txt"]);
    expect(sink.here()).toBe(true);
  });
});

