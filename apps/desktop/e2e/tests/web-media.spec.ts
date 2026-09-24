import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { startFixture } from "../../../../services/cloud-browser/test/helpers/fixture-server.js";
import { chromiumPath, openBrowseShell, openNewTab, signUpInTab, startWebStack, walkFirstRun, type WebStack } from "./web-harness";

const SHOTS = "e2e/screenshots/web-media";
for (const mode of ["native", "mse", "pixel", "pixel-native"]) test(`${mode} media plays audio locally with synchronized controls and seeking`, async ({ page }) => {
  const mse = mode === "mse" || mode === "pixel";
  const pixel = mode.startsWith("pixel");
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);
  const chromium = chromiumPath();
  test.skip(!chromium, "Chromium required");
  const shots = `${SHOTS}/${mode}`;
  await mkdir(shots, { recursive: true });
  const file = await readFile(new URL("../../../../services/cloud-browser/test/fixtures/media/av.mp4", import.meta.url));
  const fragmented = await readFile(new URL("../../../../services/cloud-browser/test/fixtures/media/video-fragmented.mp4", import.meta.url));
  const audioFile = await readFile(new URL("../../../../services/cloud-browser/test/fixtures/media/audio-fragmented.mp4", import.meta.url));
  const states: Array<{ paused: boolean; time: number; muted: boolean }> = [];
  const ranges: string[] = [];
  const errors: string[] = [];
  const mediaMessages: Array<{ k: string; [key: string]: unknown }> = [];
  page.on("websocket", socket => socket.on("framereceived", frame => {
    if (typeof frame.payload !== "string") return;
    try { const message = JSON.parse(frame.payload); if (message.t === "mirror" && ["snapshot", "media", "mediaData", "unsuitable", "stopped"].includes(message.msg?.k)) {
      mediaMessages.push(message.msg.k === "snapshot" ? { k: "snapshot", epoch: message.msg.epoch } : message.msg.k === "mediaData" ? { ...message.msg, batch: { ...message.msg.batch, chunks: message.msg.batch.chunks.map(({ data, ...chunk }: { data?: string }) => ({ ...chunk, bytes: data?.length })) } } : message.msg);
    } } catch { /* Binary or unrelated shell frames. */ }
  }));
  page.on("pageerror", error => errors.push(error.message));
  const fixture = await startFixture((request, response, body) => {
    if (request.url === "/done") { response.writeHead(200, { "content-type": "text/html" }); response.end("<h1>Media document closed</h1>"); return; }
    if (request.url === "/audio.mp4") { response.writeHead(200, { "content-type": "audio/mp4" }); response.end(audioFile); return; }
    if (request.url === "/state") { states.push(JSON.parse(body.toString())); response.end("ok"); return; }
    if (request.url === "/fragmented.mp4") { response.writeHead(200, { "content-type": "video/mp4" }); response.end(fragmented); return; }
    if (request.url === "/av.mp4") {
      if (!request.headers.cookie?.includes("media_test=authorized")) { response.writeHead(403); response.end(); return; }
      const range = request.headers.range ?? "bytes=0-";
      ranges.push(range);
      const match = /^bytes=(\d+)-(\d*)$/u.exec(range)!;
      const start = Number(match[1]), end = Math.min(file.length - 1, match[2] ? Number(match[2]) : file.length - 1);
      response.writeHead(206, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${file.length}`, "content-length": String(end - start + 1) });
      response.end(file.subarray(start, end + 1)); return;
    }
    response.writeHead(200, { "content-type": "text/html", "set-cookie": "media_test=authorized; HttpOnly; SameSite=Lax; Path=/" });
    response.end(`<!doctype html><title>Media fixture</title>
      <style>body{margin:20px;font:18px system-ui}video{display:block;width:100%;max-width:640px;height:auto}input{font:18px system-ui}</style>
      <h1>Local text beside real video</h1>${mse || pixel ? '<button id="remote">Play on cloud</button>' : ""}${pixel ? '<button id="gpu">Enable GPU effect</button><button id="toggle">Pause or play</button><button id="mute">Mute or unmute</button><button id="seek">Seek to five</button>' : ''}<input aria-label="Notes"><video id="player" aria-label="Test video" controls ${pixel ? "loop" : ""} preload="none" ${mse ? "" : 'src="/av.mp4"'}></video>
      <div style="height:1000px">Scroll the page</div>
      <script>const video=document.querySelector('video');${pixel ? `document.querySelector('#gpu').onclick=()=>{const c=document.createElement('canvas');c.style='position:fixed;right:0;bottom:0;width:100px;height:100px';document.body.append(c);const gl=c.getContext('webgl');gl.clearColor(0,0.5,0,1);gl.clear(gl.COLOR_BUFFER_BIT)};document.querySelector('#toggle').onclick=()=>video.paused?video.play():video.pause();document.querySelector('#mute').onclick=()=>video.muted=!video.muted;document.querySelector('#seek').onclick=()=>video.currentTime=5;` : ''}document.querySelector('#remote')?.addEventListener('click',()=>video.play());for(const name of ['play','pause','seeked','volumechange'])video.addEventListener(name,()=>fetch('/state',{method:'POST',body:JSON.stringify({paused:video.paused,time:video.currentTime,muted:video.muted})}));${mse ? `const mediaSource=new MediaSource();video.src=URL.createObjectURL(mediaSource);mediaSource.addEventListener('sourceopen',async()=>{await Promise.all([['video/mp4; codecs="avc1.42C01E"','/fragmented.mp4'],['audio/mp4; codecs="mp4a.40.2"','/audio.mp4']].map(async([mime,url])=>{const buffer=mediaSource.addSourceBuffer(mime);const data=await(await fetch(url)).arrayBuffer();await new Promise(resolve=>{buffer.addEventListener('updateend',resolve,{once:true});buffer.appendBuffer(data);});}));mediaSource.endOfStream();},{once:true});` : ""}${pixel && request.url?.includes("gpu=1") ? "document.querySelector('#gpu').click();" : ""}</script>`);
  });
  let stack: WebStack | null = null;
  try {
    stack = await startWebStack({ chromium: chromium!, name: "web-media", allowedOrigins: [fixture.origin], webEnv: { NEXT_PUBLIC_PISTACHIO_DOM_MIRROR: "1" } });
    await signUpInTab(page, { webUrl: stack.webUrl, email: `media-${randomUUID()}@example.com`, password: "correct-horse-battery" });
    await openBrowseShell(page); await walkFirstRun(page, "Media QA");
    const address = await openNewTab(page);
    await address.fill(fixture.origin); await address.press("Enter");
    const mirror = page.locator("[data-mirror-pane]");
    await expect(mirror).toHaveAttribute("data-painted", "1");
    const inner = mirror.frameLocator("iframe");
    await expect(inner.getByRole("heading", { name: "Local text beside real video" })).toBeVisible();
    const video = inner.locator("video");
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(4);
    await expect(page.locator("[data-streamed-pane]")).toHaveCount(0);
    await page.getByTestId("sidebar-menu-button").click();
    await expect(page.getByTestId("browser-rendering-status")).toBeVisible();
    await expect(page.getByTestId("browser-rendering-status")).toContainText("DOM + media playback");
    await page.screenshot({ path: `${shots}/01-native-ready.png` });
    await page.getByTestId("sidebar-menu-button").press("Escape");
    const mediaUrl = await video.evaluate(el => (el as HTMLVideoElement).currentSrc);
    expect(mediaUrl).not.toContain(fixture.origin);
    if (mse) expect(mediaUrl).toMatch(/^blob:/u);
    else {
      expect(mediaUrl).toContain("/media/");
      expect((await page.request.get(mediaUrl.replace(/[^/]+$/u, "invalid-capability"))).status()).toBe(404);
      expect((await page.request.get(mediaUrl, { headers: { range: "bytes=0-1,4-6" } })).status()).toBe(416);
    }

    // The native play control produces decoded audio and advances the cloud player.
    if (mse) await inner.getByRole("button", { name: "Play on cloud" }).click();
    else await video.click({ position: { x: 22, y: (await video.boundingBox())!.height - 48 } });
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).paused)).toBe(false);
    await expect.poll(() => states.some(state => !state.paused)).toBe(true);
    await video.evaluate(el => {
      const context = new AudioContext();
      const source = context.createMediaElementSource(el as HTMLMediaElement);
      const analyser = context.createAnalyser();
      source.connect(analyser); analyser.connect(context.destination);
      (window as unknown as { mediaAnalyser: AnalyserNode }).mediaAnalyser = analyser;
      void context.resume();
    });
    await expect.poll(() => video.evaluate(() => {
      const analyser = (window as unknown as { mediaAnalyser: AnalyserNode }).mediaAnalyser;
      const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
      return Math.max(...samples.map(Math.abs));
    })).toBeGreaterThan(0.01);
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(0.5);
    await inner.getByRole("textbox", { name: "Notes" }).fill("Text stays local while audio plays");
    await page.screenshot({ path: `${shots}/02-native-playing-with-audio.png` });

    if (pixel) {
      // Preserve the source controls' coordinates across the switch to pixels.
      const paneBox = (await mirror.boundingBox())!;
      const controls = new Map<string, { x: number; y: number }>();
      for (const name of ["Play on cloud", "Pause or play", "Mute or unmute", "Seek to five"]) {
        const box = (await inner.getByRole("button", { name }).boundingBox())!;
        controls.set(name, { x: box.x + box.width / 2 - paneBox.x, y: box.y + box.height / 2 - paneBox.y });
      }
      if (mode === "pixel-native") {
        await page.getByTestId("sidebar-menu-button").click();
        await page.getByRole("button", { name: "Use pixel rendering", exact: true }).click();
        await page.getByTestId("sidebar-menu-button").press("Escape");
      } else await inner.getByRole("button", { name: "Enable GPU effect" }).click();
      await expect(page.locator("[data-streamed-pane]")).toBeVisible();
      await expect(page.locator("[data-mirror-pane]")).toHaveCount(0);
      const audioFrame = page.frameLocator("[data-pixel-audio]");
      const audio = audioFrame.locator("audio");
      await expect.poll(() => audio.evaluate(el => (el as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(4);
      const enable = audioFrame.getByRole("button", { name: "Enable audio", exact: true });
      await expect.poll(async () => await enable.isVisible() || await audio.evaluate(el => !(el as HTMLAudioElement).paused)).toBe(true);
      if (await enable.isVisible()) {
        await page.screenshot({ path: `${shots}/03-pixel-enable-audio.png` });
        await enable.click();
      }
      await audio.evaluate(el => {
        const context = new AudioContext(); const analyser = context.createAnalyser();
        context.createMediaElementSource(el as HTMLAudioElement).connect(analyser); analyser.connect(context.destination);
        (window as unknown as { mediaAnalyser: AnalyserNode }).mediaAnalyser = analyser; void context.resume();
      });
      const amplitude = () => audio.evaluate(() => {
        const analyser = (window as unknown as { mediaAnalyser: AnalyserNode }).mediaAnalyser;
        const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
        return Math.max(...samples.map(Math.abs));
      });
      await expect.poll(amplitude).toBeGreaterThan(0.01);
      await page.getByTestId("sidebar-menu-button").click();
      await expect(page.getByTestId("browser-rendering-status")).toContainText(mode === "pixel-native" ? "Pixel stream + audio" : "Pixel fallback + audio");
      await page.screenshot({ path: `${shots}/04-pixel-playing-with-audio.png` });
      await page.getByTestId("sidebar-menu-button").press("Escape");
      const frame = page.getByTestId("streamed-pane-frame");
      await frame.click({ position: controls.get("Pause or play")! });
      await expect.poll(() => audio.evaluate(el => (el as HTMLAudioElement).paused)).toBe(true);
      await frame.click({ position: controls.get("Seek to five")! });
      await expect.poll(() => audio.evaluate(el => (el as HTMLAudioElement).currentTime)).toBeCloseTo(5, 0);
      await frame.click({ position: controls.get("Mute or unmute")! });
      await expect.poll(() => audio.evaluate(el => (el as HTMLAudioElement).muted)).toBe(true);
      await frame.click({ position: controls.get("Pause or play")! });
      await expect.poll(() => audio.evaluate(el => (el as HTMLAudioElement).paused)).toBe(false);
      await expect.poll(amplitude).toBe(0);
      await frame.click({ position: controls.get("Mute or unmute")! });
      await expect.poll(amplitude).toBeGreaterThan(0.01);
      await page.screenshot({ path: `${shots}/05-pixel-controls-audible.png` });
      await page.getByRole("button", { name: "Edit address", exact: true }).click();
      await page.getByTestId("address-input").fill(`${fixture.origin}/done`);
      await page.getByTestId("address-input").press("Enter");
      await expect(audio).toHaveCount(0);
      await page.screenshot({ path: `${shots}/06-pixel-navigation-silent.png` });
      // A fresh document with GPU effects from startup must play audio
      // without ever delivering a usable DOM snapshot.
      await page.getByRole("button", { name: "Edit address", exact: true }).click();
      await page.getByTestId("address-input").fill(`${fixture.origin}/?gpu=1`);
      await page.getByTestId("address-input").press("Enter");
      await expect.poll(() => audio.evaluate(el => (el as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(4);
      await frame.click({ position: controls.get("Play on cloud")! });
      await expect.poll(async () => await enable.isVisible() || await audio.evaluate(el => !(el as HTMLAudioElement).paused)).toBe(true);
      if (await enable.isVisible()) await enable.click();
      await expect.poll(() => audio.evaluate(el => (el as HTMLAudioElement).currentTime)).toBeGreaterThan(0.1);
      await page.screenshot({ path: `${shots}/07-pixel-fresh-document.png` });
      await page.getByRole("tab", { name: /Welcome to Pistachio Tab actions/u }).first().click();
      await expect(page.locator("[data-pixel-audio]")).toHaveCount(0);
      expect(errors).toEqual([]);
      return;
    }

    // Local seeking, pause and mute are applied to the cloud's authoritative player.
    await video.evaluate(el => { (el as HTMLVideoElement).currentTime = 5; });
    await expect.poll(() => states.some(state => state.time >= 4.8)).toBe(true);
    await video.evaluate(el => { (el as HTMLVideoElement).muted = true; (el as HTMLVideoElement).pause(); });
    await expect.poll(() => states.some(state => state.paused && state.muted && state.time >= 4.8)).toBe(true);
    await page.setViewportSize({ width: 850, height: 750 });
    await expect.poll(() => video.evaluate(el => el.getBoundingClientRect().width)).toBeLessThan(640);
    const ratio = await video.evaluate(el => { const box = el.getBoundingClientRect(); return box.width / box.height; });
    expect(ratio).toBeCloseTo(16 / 9, 1);
    await page.screenshot({ path: `${shots}/03-native-seek-pause-resize.png` });
    // Reattach to an already-playing document without re-running its scripts.
    await page.getByRole("tab", { name: /Welcome to Pistachio Tab actions/u }).first().click();
    await page.getByRole("tab", { name: /Media fixture Tab actions/u }).click();
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(4);
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(4.8);
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).muted)).toBe(true);
    await expect(page.locator("[data-streamed-pane]")).toHaveCount(0);
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).seeking)).toBe(false);
    await page.screenshot({ path: `${shots}/04-media-reattached.png` });
    if (!mse) await expect.poll(async () => (await page.request.get(mediaUrl)).status()).toBe(404);
    await page.getByRole("button", { name: "Edit address", exact: true }).click();
    await page.getByTestId("address-input").fill(`${fixture.origin}/done`);
    await page.getByTestId("address-input").press("Enter");
    await expect(inner.getByRole("heading", { name: "Media document closed" })).toBeVisible();
    await expect(inner.locator("video")).toHaveCount(0);
    await page.screenshot({ path: `${shots}/05-media-navigation.png` });
    if (!mse) expect(ranges.length).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
  } catch (error) { console.error("Audio DOM", await page.frameLocator("[data-pixel-audio]").locator("audio").evaluateAll(nodes => nodes.map(node => { const el = node as HTMLAudioElement; return { ready: el.readyState, error: el.error?.message, src: el.currentSrc, time: el.currentTime, paused: el.paused }; })).catch(() => [])); if (stack) console.error(stack.logs().web.slice(-5000)); console.error(JSON.stringify({ errors, mediaMessages: mediaMessages.filter(message => message.k !== "media").slice(-20), recentMedia: mediaMessages.slice(-2) })); throw error; }
  finally { await stack?.close(); await fixture.close(); }
});
