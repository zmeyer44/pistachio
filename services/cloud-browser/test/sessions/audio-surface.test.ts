import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { audioSurfaceSource, type AudioSurfaceReport, type MirrorServerMessage } from "@pistachio/dom-mirror";
import { PlaywrightBrowserRuntime } from "../../src/browser/runtime.js";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";
import { startFixture } from "../helpers/fixture-server.js";

describeChromium("pixel audio autoplay and isolation", () => {
  it("requires a local gesture when autoplay is blocked and drops the previous document's audio", async () => {
    const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
    const file = await readFile(new URL("../fixtures/media/av.mp4", import.meta.url));
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "video/mp4", "access-control-allow-origin": "*" }); response.end(file);
    });
    try {
      const context = await (await runtime.browser()).newContext();
      const page = await context.newPage();
      const reports: AudioSurfaceReport[] = [];
      await page.exposeFunction("__reportAudio", (message: AudioSurfaceReport) => reports.push(message));
      await page.setContent('<iframe title="Audio" sandbox="allow-scripts" allow="autoplay \'none\'" style="width:400px;height:100px"></iframe>');
      await page.evaluate(source => {
        const frame = document.querySelector("iframe")!;
        frame.onload = () => {
          const channel = new MessageChannel();
          channel.port1.onmessage = event => (window as unknown as { __reportAudio(message: unknown): void }).__reportAudio(event.data);
          (window as unknown as { audioPort: MessagePort }).audioPort = channel.port1;
          channel.port1.start(); frame.contentWindow!.postMessage("pistachio:audio-connect", "*", [channel.port2]);
        };
        frame.srcdoc = source;
      }, audioSurfaceSource("audioTest", fixture.origin));
      await expect.poll(() => reports.some(report => report.kind === "ready")).toBe(true);
      const send = (message: MirrorServerMessage) => page.evaluate(message =>
        (window as unknown as { audioPort: MessagePort }).audioPort.postMessage(message), message);
      await send({ k: "snapshot", frame: "main", epoch: 1, seq: 0, root: { t: "doc", id: 1, c: [] }, url: "about:blank", title: "Audio", focus: null, width: 400, height: 100 });
      const item = { id: 2, source: `${fixture.origin}/v1/shell/test/media/capability`, kind: "video" as const,
        visible: true, mse: false, unsupported: false, paused: false, time: 0, duration: 10, volume: 1, muted: false, rate: 1 };
      await send({ k: "media", frame: "main", epoch: 1, items: [item] });
      const inner = page.frameLocator("iframe");
      const audio = inner.locator("audio");
      await expect.poll(() => reports.some(report => report.kind === "audio" && report.blocked)).toBe(true);
      await inner.getByRole("button", { name: "Enable audio", exact: true }).click();
      await expect.poll(() => audio.evaluate(el => (el as HTMLAudioElement).paused)).toBe(false);
      await expect.poll(() => audio.evaluate(el => (el as HTMLAudioElement).currentTime)).toBeGreaterThan(0.1);
      expect(await audio.evaluate(() => { try { return parent.document.body !== null; } catch { return false; } })).toBe(false);
      await send({ k: "stopped" });
      await expect.poll(() => audio.count()).toBe(0);
      await send({ k: "media", frame: "main", epoch: 1, items: [item] });
      await send({ k: "snapshot", frame: "main", epoch: 2, seq: 0, root: { t: "doc", id: 1, c: [] }, url: "about:blank", title: "Audio", focus: null, width: 400, height: 100 });
      await send({ k: "media", frame: "main", epoch: 1, items: [item] });
      await send({ k: "media", frame: "main", epoch: 2, items: [] });
      await expect.poll(() => reports.at(-1)).toMatchObject({ kind: "audio", count: 0, blocked: false });
      expect(await audio.count()).toBe(0);
    } finally { await runtime.close(); await fixture.close(); }
  });
});
