import { describe, expect, it } from "vitest";
import {
  canvasImageScript,
  imageFileName,
  imageInsertFromBytes,
  normalizeMediaType,
  parseDataUrl,
  selectionInsert,
} from "../src/main/chat-attach";
import { isChatInsert, MAX_CHAT_ATTACHMENT_BYTES, MAX_CHAT_SELECTION_CHARS } from "@pistachio/shell-contracts/chat-insert";
import { isShellCommand } from "@pistachio/shell-contracts/chrome";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR42mP8z8DwnwEIGIEEAxQwYgEAcQwEAd0b4hkAAAAASUVORK5CYII=", "base64");

describe("parseDataUrl", () => {
  it("decodes base64 and percent-encoded payloads, and nothing that is not a data URL", () => {
    const png = parseDataUrl(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(png?.mediaType).toBe("image/png");
    expect(Buffer.from(png?.bytes ?? []).equals(PNG)).toBe(true);
    const svg = parseDataUrl("data:image/svg+xml,%3Csvg%3E%3C/svg%3E");
    expect(svg?.mediaType).toBe("image/svg+xml");
    expect(Buffer.from(svg?.bytes ?? []).toString()).toBe("<svg></svg>");
    expect(parseDataUrl("data:,plain")?.mediaType).toBe("text/plain");
    expect(parseDataUrl("data:image/JPG;charset=x;base64,AA")?.mediaType).toBe("image/jpeg");
    expect(parseDataUrl("https://example.com/a.png")).toBeNull();
    expect(parseDataUrl("data:image/png;base64")).toBeNull();
  });
});

describe("imageInsertFromBytes", () => {
  it("packages an image the model can take as a data URL named after its address", () => {
    const result = imageInsertFromBytes(new Uint8Array(PNG), "image/png", "https://cdn.example.com/photos/Cat%20One.png?w=800");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.insert).toEqual({
      kind: "image",
      name: "Cat One.png",
      mediaType: "image/png",
      url: `data:image/png;base64,${PNG.toString("base64")}`,
    });
    expect(isChatInsert(result.insert)).toBe(true);
  });

  it("refuses formats the vision path lacks, empty bytes, and oversized images with a readable reason", () => {
    expect(imageInsertFromBytes(new Uint8Array([1]), "image/svg+xml", "https://x/a.svg")).toEqual({
      ok: false,
      reason: "Only PNG, JPEG, GIF, and WebP images can be added",
    });
    expect(imageInsertFromBytes(new Uint8Array(0), "image/png", "https://x/a.png")).toEqual({ ok: false, reason: "That image is empty" });
    expect(imageInsertFromBytes(new Uint8Array(MAX_CHAT_ATTACHMENT_BYTES + 1), "image/png", "https://x/a.png")).toEqual({
      ok: false,
      reason: "That image is over 4 MB",
    });
    // The header's parameters and the `jpg` spelling both settle to the canonical type.
    expect(normalizeMediaType("Image/JPG; charset=binary")).toBe("image/jpeg");
    expect(imageInsertFromBytes(new Uint8Array([1]), "image/jpg; charset=binary", "https://x/a").ok).toBe(true);
  });
});

describe("imageFileName", () => {
  it("keeps the address's file name but always the extension of the bytes attached", () => {
    expect(imageFileName("https://x/pics/logo.svg", "image/png")).toBe("logo.png");
    expect(imageFileName("https://x/pics/photo.jpeg", "image/jpeg")).toBe("photo.jpg");
    expect(imageFileName("https://x/", "image/webp")).toBe("image.webp");
    expect(imageFileName("data:image/png;base64,AA", "image/png")).toBe("image.png");
    expect(imageFileName("blob:https://x/9c1a", "image/gif")).toBe("9c1a.gif");
    expect(imageFileName("https://x/a%3Fb%2Fc.png", "image/png")).toBe("a b c.png");
  });
});

describe("selectionInsert", () => {
  it("trims the words, keeps the page, and clamps a very long selection", () => {
    const page = { title: "Example", url: "https://example.com/" };
    expect(selectionInsert("  hello\r\nworld  ", page)).toEqual({ kind: "selection", text: "hello\nworld", title: "Example", url: "https://example.com/" });
    expect(selectionInsert("   ", page)).toBeNull();
    const long = selectionInsert("x".repeat(MAX_CHAT_SELECTION_CHARS * 2), page);
    expect(long?.kind === "selection" && long.text.length).toBe(MAX_CHAT_SELECTION_CHARS);
    expect(long?.kind === "selection" && long.text.endsWith("…")).toBe(true);
    expect(isChatInsert(long)).toBe(true);
  });
});

describe("canvasImageScript", () => {
  it("finds the page's own <img> by address and paints it as a PNG, embedding the address as JSON", () => {
    const script = canvasImageScript('https://x/"; alert(1); "');
    expect(script).toContain('\\"; alert(1); \\"');
    expect(script).toContain("document.images");
    expect(script).toContain('toDataURL("image/png")');
  });
});

describe("chat insert guards", () => {
  it("lets only well-formed inserts through the shell command boundary", () => {
    const image = { kind: "image", name: "a.png", mediaType: "image/png", url: "data:image/png;base64,AA" };
    expect(isShellCommand({ type: "attachToChat", insert: image })).toBe(true);
    expect(isShellCommand({ type: "attachToChat", insert: { ...image, mediaType: "image/svg+xml" } })).toBe(false);
    expect(isShellCommand({ type: "attachToChat", insert: { ...image, url: "https://x/a.png" } })).toBe(false);
    expect(isShellCommand({ type: "attachToChat", insert: { kind: "selection", text: " ", title: "t", url: "u" } })).toBe(false);
    expect(isShellCommand({ type: "attachToChat", insert: { kind: "selection", text: "words", title: "t", url: "u" } })).toBe(true);
    expect(isShellCommand({ type: "attachToChatFailed", reason: "nope" })).toBe(true);
    expect(isShellCommand({ type: "attachToChatFailed", reason: "" })).toBe(false);
  });
});
