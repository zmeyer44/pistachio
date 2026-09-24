import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mirrorRecorderSource, type RecorderControl } from "@pistachio/dom-mirror";
import { PlaywrightBrowserRuntime } from "../../src/browser/runtime.js";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";

describeChromium("encoded media replay window", () => {
  it("discovers changing media in an unsuitable document without serializing its DOM", async () => {
    const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
    try {
      const context = await (await runtime.browser()).newContext();
      const page = await context.newPage();
      await page.exposeFunction("__mediaReport", () => undefined);
      await page.addInitScript(mirrorRecorderSource({ control: "__mediaRecorder", binding: "__mediaReport" }));
      await page.goto('data:text/html,<h1>Private page text</h1><iframe srcdoc="Embedded page"></iframe>');
      const result = await page.evaluate(() => {
        const recorder = (globalThis as unknown as { __mediaRecorder: RecorderControl }).__mediaRecorder;
        const dom = recorder.start(1);
        const audio = recorder.start(2, true);
        const host = document.createElement("div"); document.body.append(host);
        const shadow = host.attachShadow({ mode: "closed" });
        const video = document.createElement("video"); video.src = "https://media.invalid/test.mp4";
        shadow.append(video);
        const first = recorder.mediaState();
        video.muted = true;
        const muted = recorder.mediaState();
        host.remove();
        return { dom, audio, first, muted, removed: recorder.mediaState(), recording: recorder.recording() };
      });
      expect(result.dom.kind).toBe("unsuitable");
      expect(result.audio.kind).toBe("snapshot");
      expect(JSON.stringify(result.audio)).not.toContain("Private page text");
      expect(result.first).toHaveLength(1);
      expect(result.first[0]).toMatchObject({ source: "https://media.invalid/test.mp4", kind: "video", muted: false });
      expect(result.muted[0]).toMatchObject({ id: result.first[0]!.id, muted: true });
      expect(result.removed).toEqual([]);
      expect(result.recording).toBe(false);
    } finally { await runtime.close(); }
  });

  it("continues an attached cursor past the history limit and explicitly rejects an expired cursor", async () => {
    const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
    try {
      const bytes = await readFile(new URL("../fixtures/media/video-fragmented.mp4", import.meta.url));
      const context = await (await runtime.browser()).newContext();
      const page = await context.newPage();
      await page.exposeFunction("__mediaReport", () => undefined);
      await page.addInitScript(mirrorRecorderSource({ control: "__mediaRecorder", binding: "__mediaReport" }));
      await page.goto("data:text/html,<video controls></video>");
      // MediaSource also works in opaque/insecure documents, where randomUUID is unavailable.
      expect(await page.evaluate(() => isSecureContext)).toBe(false);
      const result = await page.evaluate(async encoded => {
        const recorder = (globalThis as unknown as { __mediaRecorder: RecorderControl }).__mediaRecorder;
        const media = new MediaSource(); const video = document.querySelector("video")!;
        const opened = new Promise<void>(resolve => media.addEventListener("sourceopen", () => resolve(), { once: true }));
        video.src = URL.createObjectURL(media); await opened;
        const buffer = media.addSourceBuffer('video/mp4; codecs="avc1.42C01E"');
        const data = Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0));
        recorder.start(1);
        let cursor = 0, delivered = 0;
        const source = recorder.mediaState()[0]!.source;
        const update = (action: () => void): Promise<void> => new Promise((resolve, reject) => {
          buffer.addEventListener("updateend", () => resolve(), { once: true });
          buffer.addEventListener("error", () => reject(new Error("fixture append failed")), { once: true }); action();
        });
        for (let step = 0; step < 100; step++) {
          buffer.timestampOffset = step * 10;
          await update(() => buffer.appendBuffer(data));
          if (step > 2) { video.currentTime = step * 10; await update(() => buffer.remove(0, (step - 2) * 10)); }
          for (;;) {
            const batch = recorder.mediaData(source, cursor)!;
            if (batch.failed) throw new Error("An attached cursor lost its stream");
            if (!batch.chunks.length) break;
            cursor = batch.chunks.at(-1)!.seq;
            delivered += batch.chunks.filter(chunk => chunk.op === "append").length;
          }
        }
        return { delivered, healthy: !recorder.mediaState()[0]!.unsupported, lateFailed: recorder.mediaData(source, 0)!.failed, totalBytes: data.length * 100 };
      }, bytes.toString("base64"));
      expect(result.totalBytes).toBeGreaterThan(64 * 1024 * 1024);
      expect(result.delivered).toBeGreaterThan(100);
      expect(result.healthy).toBe(true); expect(result.lateFailed).toBe(true);
    } finally { await runtime.close(); }
  });
});
