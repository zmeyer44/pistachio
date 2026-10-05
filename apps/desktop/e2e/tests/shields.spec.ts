/**
 * Shields end to end (docs/shields.md): a real page in a real Space session,
 * against a local server with two sites on it — 127.0.0.1 is the page, and
 * localhost is "another site" (a different registrable host).
 *
 * Nothing is fetched from the list servers under PISTACHIO_E2E: the spec lays
 * a tiny EasyList, a tiny badware list, and a one-scriptlet resources file
 * into the list cache before launch, and adds filters of its own — the same
 * files a real fetch would have written.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { ShieldsStatus } from "@pistachio/shell-contracts/shields";
import { pageFirst, shellReady } from "./windows";
import { launchApp } from "./app";
import { captureShell as captureWindow, captureView, openSiteInfo } from "./pages-harness";

/** The tab's own pixels: a window capture shows the chrome, not the native page view over it. */
function captureTab(app: ElectronApplication, filename: string): Promise<void> {
  return captureView(app, "pistachio://shields", `shields/${filename}`);
}

function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  return captureWindow(app, `shields/${filename}`);
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

interface Hit {
  host: string;
  path: string;
  gpc: string | undefined;
  cookie: string | undefined;
}

function fixtureServer(): { server: Server; hits: Hit[]; listen(): Promise<number> } {
  const hits: Hit[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    hits.push({
      host: url.hostname,
      path: `${url.pathname}${url.search}`,
      gpc: request.headers["sec-gpc"] as string | undefined,
      cookie: request.headers.cookie,
    });
    response.setHeader("cache-control", "no-store");
    const port = (server.address() as { port: number }).port;
    if (url.pathname === "/page") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head><title>Shields fixture</title>
<script>
  window.__gpc = navigator.globalPrivacyControl === true;
  window.__ua = navigator.userAgent;
  window.__scriptlet = String(window.__shieldsScriptlet);
  window.__shared = [window.__sharedFirst, window.__sharedSecond].join();
</script></head><body>
<div class="ad-banner" id="ad-banner">AD</div>
<div class="sponsor-box" id="sponsor">SPONSOR</div>
<p id="content">The article.</p>
<img id="ad" src="http://localhost:${String(port)}/ads/banner.png" width="10" height="10">
<img id="pixel" src="http://localhost:${String(port)}/pixel.png" width="10" height="10">
<a id="pinglink" href="/target" ping="/pinged">Read on</a>
<div id="crowd"></div>
<script>
  // More distinct classes than one report carries, then an ad after them.
  const crowd = document.getElementById("crowd");
  for (let i = 0; i < 2100; i++) { const item = document.createElement("span"); item.className = "junk-" + i; crowd.appendChild(item); }
</script>
<div class="late-ad" id="late-ad">LATE AD</div>
<script>
  const canvas = document.createElement("canvas");
  canvas.width = 160; canvas.height = 40;
  const g = canvas.getContext("2d");
  g.fillStyle = "#f60"; g.fillRect(0, 0, 160, 40);
  g.fillStyle = "#069"; g.font = "16px sans-serif"; g.fillText("Pistachio fingerprint", 4, 24);
  window.__canvas = canvas.toDataURL();
  window.__canvasAgain = canvas.toDataURL();
  // The known-plaintext attack on noise that ignores the content: read a
  // black canvas of the same size, and XOR what came back out of the
  // fingerprint's reading.
  const hash = (data) => { let h = 2166136261; for (let i = 0; i < data.length; i++) { h ^= data[i]; h = Math.imul(h, 16777619); } return h >>> 0; };
  const fingerprint = g.getImageData(0, 0, 160, 40).data;
  const black = document.createElement("canvas");
  black.width = 160; black.height = 40;
  const b = black.getContext("2d");
  b.fillStyle = "#000"; b.fillRect(0, 0, 160, 40);
  const mask = b.getImageData(0, 0, 160, 40).data;
  const recovered = fingerprint.map((value, i) => (i % 4 === 3 ? value : value ^ mask[i]));
  window.__pixels = hash(fingerprint);
  window.__recovered = hash(recovered);
  // Audio copied twice into the same array is protected both times.
  const audio = new AudioBuffer({ length: 256, sampleRate: 44100 });
  audio.copyToChannel(Float32Array.from({ length: 256 }, (_, i) => Math.sin(i / 7)), 0);
  const copy = new Float32Array(256);
  audio.copyFromChannel(copy, 0);
  const first = Array.from(copy);
  audio.copyFromChannel(copy, 0);
  window.__audioStable = first.every((value, i) => value === copy[i]);
  // Noise lands only on the samples a copy (or an analyser) wrote.
  const short = new AudioBuffer({ length: 2, sampleRate: 44100 });
  short.copyToChannel(Float32Array.of(0.25, 0.75), 0);
  const roomy = new Float32Array(256).fill(0.5);
  short.copyFromChannel(roomy, 0);
  const analyser = new OfflineAudioContext(1, 128, 44100).createAnalyser();
  const bins = new Float32Array(analyser.frequencyBinCount + 64).fill(7);
  analyser.getFloatFrequencyData(bins);
  window.__audioTails = roomy.slice(2).every((value) => value === 0.5) && bins.slice(analyser.frequencyBinCount).every((value) => value === 7);
  window.__audioNoisy = first.some((value, i) => value !== Math.fround(Math.sin(i / 7)));
  // An OffscreenCanvas exported as a blob is protected like a canvas is.
  window.__offscreen = "pending";
  const offscreen = new OffscreenCanvas(160, 40);
  const o = offscreen.getContext("2d");
  o.fillStyle = "#f60"; o.fillRect(0, 0, 160, 40);
  o.fillStyle = "#069"; o.font = "16px sans-serif"; o.fillText("Pistachio fingerprint", 4, 24);
  offscreen.convertToBlob().then((blob) => blob.arrayBuffer()).then((bytes) => { window.__offscreen = hash(new Uint8Array(bytes)); });
  // WebGL noise stays inside the pixels the read wrote — where pixel-pack
  // state puts them — and reaches a buffer from another realm too.
  const gl2 = document.createElement("canvas").getContext("webgl2");
  if (gl2 === null) {
    window.__webglPacked = "no webgl2";
  } else {
    gl2.clearColor(0.2, 0.4, 0.6, 1); gl2.clear(gl2.COLOR_BUFFER_BIT);
    const tight = new Uint8Array(4);
    gl2.readPixels(0, 0, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, tight);
    gl2.pixelStorei(gl2.PACK_ROW_LENGTH, 4); gl2.pixelStorei(gl2.PACK_SKIP_ROWS, 1); gl2.pixelStorei(gl2.PACK_SKIP_PIXELS, 1);
    const packed = new Uint8Array(64).fill(7);
    gl2.readPixels(0, 0, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, packed);
    gl2.pixelStorei(gl2.PACK_ROW_LENGTH, 0); gl2.pixelStorei(gl2.PACK_SKIP_ROWS, 0); gl2.pixelStorei(gl2.PACK_SKIP_PIXELS, 0);
    const outside = Array.from(packed).filter((_, i) => i < 20 || i > 23).every((value) => value === 7);
    const inside = Array.from(packed.slice(20, 24)).every((value, i) => value === tight[i]);
    const helper = document.createElement("iframe");
    document.body.appendChild(helper);
    const foreign = new helper.contentWindow.Uint8Array(4);
    gl2.readPixels(0, 0, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, foreign);
    const sameNoise = Array.from(foreign).every((value, i) => value === tight[i]);
    window.__webglPacked = outside && inside && sameNoise ? true : JSON.stringify({ outside, inside, sameNoise });
  }
  const gl = document.createElement("canvas").getContext("webgl");
  if (gl === null) {
    window.__webglIntact = "no webgl";
  } else {
    gl.clearColor(0.2, 0.4, 0.6, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const target = new Uint8Array(16).fill(7);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, target);
    const empty = new Uint8Array(8).fill(7);
    gl.readPixels(0, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, empty);
    window.__webglIntact = target.slice(4).every((value) => value === 7) && empty.every((value) => value === 7);
  }
  // Frames the HTML parser makes run their own scripts — protected from
  // their first line, same-origin or not.
  window.__frames = {};
  window.addEventListener("message", (event) => {
    if (event.data && event.data.kind === "fp-frame") window.__frames[event.data.host] = event.data.gpc;
  });
  document.body.insertAdjacentHTML("beforeend", '<iframe src="/fp-frame"></iframe><iframe src="http://localhost:${String(port)}/fp-frame"></iframe>');
  // A blob: frame inherits the page's origin and must not be a clean room either.
  const blobFrame = document.createElement("iframe");
  blobFrame.src = URL.createObjectURL(new Blob(['<script>parent.postMessage({ kind: "fp-frame", host: "blob", gpc: navigator.globalPrivacyControl === true }, "*");<\\/script>'], { type: "text/html" }));
  document.body.append(blobFrame);
  // A wide-gamut canvas exports its colors, not sRGB's clipped ones.
  window.__p3 = "pending";
  const p3 = document.createElement("canvas");
  p3.width = 8; p3.height = 8;
  const p3c = p3.getContext("2d", { colorSpace: "display-p3" });
  p3c.fillStyle = "color(display-p3 1 0 0)"; p3c.fillRect(0, 0, 8, 8);
  const reread = new Image();
  reread.onload = () => {
    const back = document.createElement("canvas");
    back.width = 8; back.height = 8;
    const backc = back.getContext("2d", { colorSpace: "display-p3" });
    backc.drawImage(reread, 0, 0);
    const [r, g, b] = backc.getImageData(0, 0, 1, 1, { colorSpace: "display-p3" }).data;
    window.__p3 = r > 245 && g < 10 && b < 10 ? true : JSON.stringify([r, g, b]);
  };
  reread.src = p3.toDataURL();
  // HDR readback gets noise a float can carry, not a bit flip.
  const hdr = document.createElement("canvas");
  hdr.width = 16; hdr.height = 16;
  const h = hdr.getContext("2d");
  h.fillStyle = "rgb(128,128,128)"; h.fillRect(0, 0, 16, 16);
  let floats = null;
  try { floats = h.getImageData(0, 0, 16, 16, { pixelFormat: "rgba-float16" }).data; } catch {}
  window.__floatPixels = floats === null || floats instanceof Uint8ClampedArray ? "unsupported" : Array.from(floats).every((value, i) => i % 4 === 3 || Math.abs(value - 0.502) < 0.01);
  // A frame the page makes and then navigates (same origin) is protected again.
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  window.__frameGpc = "pending";
  frame.onload = () => { window.__frameGpc = frame.contentWindow.navigator.globalPrivacyControl === true; };
  frame.src = "/frame";
</script>
</body></html>`);
      return;
    }
    if (url.pathname === "/beacon") {
      // YouTube's ad pings: a same-origin fetch the server sends on to an ad
      // host, where the custom header needs a CORS preflight.
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Beacon</title><script>
  window.__beacon = "pending";
  fetch("/hop", { headers: { "x-shields-test": "1" } }).then(() => "loaded", () => "refused").then((result) => { window.__beacon = result; });
</script>`);
      return;
    }
    if (url.pathname === "/hop") {
      response.statusCode = 302;
      response.setHeader("location", `http://localhost:${String(port)}/ads/beacon`);
      response.end();
      return;
    }
    if (url.pathname === "/fp-frame") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><script>parent.postMessage({ kind: "fp-frame", host: location.host, gpc: navigator.globalPrivacyControl === true }, "*");</script>`);
      return;
    }
    if (url.pathname.endsWith(".png")) {
      response.setHeader("content-type", "image/png");
      if (url.pathname === "/pixel.png") response.setHeader("set-cookie", "tp=1; Path=/; SameSite=None; Secure");
      response.end(PNG);
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>${url.pathname}</title><p>${url.pathname}</p>`);
  });
  return {
    server,
    hits,
    listen: () =>
      new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port))),
  };
}

/** The tab showing the fixture's 127.0.0.1 or localhost pages, or the warning. */
async function tabEval<T>(app: ElectronApplication, code: string): Promise<T> {
  return app.evaluate(async ({ webContents }, script) => {
    const tab = webContents
      .getAllWebContents()
      .find((contents) => /^(http:\/\/(127\.0\.0\.1|localhost|danger\.test)|pistachio:\/\/shields)/.test(contents.getURL()));
    if (tab === undefined) throw new Error("the fixture tab is not open");
    return (await tab.executeJavaScript(script)) as T;
  }, code) as Promise<T>;
}

async function tabUrl(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ webContents }) => {
    const tab = webContents
      .getAllWebContents()
      .find((contents) => /^(http:\/\/(127\.0\.0\.1|localhost|danger\.test)|pistachio:\/\/shields|chrome-error)/.test(contents.getURL()));
    return tab?.getURL() ?? "";
  });
}

async function navigate(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(async ({ webContents }, target) => {
    const tab = webContents
      .getAllWebContents()
      .find((contents) => /^(http:\/\/(127\.0\.0\.1|localhost|danger\.test)|pistachio:\/\/shields|chrome-error)/.test(contents.getURL()));
    if (tab === undefined) throw new Error("the fixture tab is not open");
    await tab.loadURL(target).catch(() => undefined);
  }, url);
}

function shieldsStatus(shell: Page): Promise<ShieldsStatus> {
  return shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.shields({ type: "status" }));
}

async function cookieNames(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(async ({ webContents }) => {
    const tab = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("http://127.0.0.1"));
    if (tab === undefined) return [];
    return (await tab.session.cookies.get({ domain: "localhost" })).map((cookie) => cookie.name);
  });
}

test("Shields block, hide, clean, and protect — and stand down for a site", { tag: ["@site"] }, async () => {
  test.setTimeout(120_000);
  const fixture = fixtureServer();
  const port = await fixture.listen();
  const page = `http://127.0.0.1:${String(port)}/page`;

  // The list cache, as a fetch would have left it.
  const now = Date.now();
  const fresh = { fetchedAt: now, expiresAt: now + 86_400_000, etag: null, lastModified: null, rules: 1, error: null };
  const { app, userData } = await launchApp({
    files: {
      "shields/lists/easylist.txt": "! Title: EasyList (fixture)\n! Expires: 4 days\n||localhost^*/ads/\n",
      "shields/lists/ubo-badware.txt": "! Title: Badware (fixture)\n||danger.test^\n",
      "shields/lists/resources.json": {
        scriptlets: [
          { name: "shields-test.js", aliases: [], dependencies: [], body: "function shieldsTest(value = '') { window.__shieldsScriptlet = value; }" },
          // Two scriptlets carrying the same class, as uBO's JSONPath ones do.
          { name: "shields-shared.fn", aliases: [], dependencies: [], body: "class ShieldsShared { static set(name, value) { window[name] = value; } }" },
          { name: "shields-first.js", aliases: [], dependencies: ["shields-shared.fn"], body: "function shieldsFirst(value = '') { ShieldsShared.set('__sharedFirst', value); }" },
          { name: "shields-second.js", aliases: [], dependencies: ["shields-shared.fn"], body: "function shieldsSecond(value = '') { ShieldsShared.set('__sharedSecond', value); }" },
        ],
        redirects: [{ name: "noop.txt", aliases: [], body: "", contentType: "text/plain" }],
      },
      "shields/lists/lists.json": { easylist: fresh, "ubo-badware": fresh, resources: { ...fresh, rules: 0 } },
    },
    settings: {
      ...pageFirst({ layout: { sidebar: "pinned" }, general: { homeUrl: page } }),
      shields: {
        enabled: true,
        level: "custom",
        blocking: "standard",
        cookieBanners: "off",
        trackingParams: "standard",
        bounceTracking: true,
        crossSiteCookies: "all",
        fingerprinting: "standard",
        https: "off",
        globalPrivacyControl: true,
        referrer: "trim",
        webRtc: "default",
        blockPings: true,
        dangerousSites: true,
        customFilters: [
          "##.ad-banner",
          "##.late-ad",
          "127.0.0.1##.sponsor-box",
          "127.0.0.1##+js(shields-test, ran)",
          "127.0.0.1##+js(shields-first, one)",
          "127.0.0.1##+js(shields-second, two)",
          "||localhost^*/ads/beacon$xhr,redirect=noop.txt",
        ].join("\n"),
      },
    },
    name: "shields",
  });
  try {
    const shell = await shellReady(app);

    // The engine is built from the cache in the worker; the first page may
    // have beaten it, so the page is loaded again once it is ready.
    await expect.poll(async () => (await shieldsStatus(shell)).engine.state, { timeout: 30_000 }).toBe("ready");
    const status = await shieldsStatus(shell);
    expect(status.engine.networkFilters).toBeGreaterThanOrEqual(1);
    expect(status.lists.find((list) => list.id === "easylist")).toMatchObject({ state: "ready", enabled: true });
    fixture.hits.length = 0;
    await navigate(app, page);
    await expect.poll(() => tabEval<string>(app, "document.readyState")).toBe("complete");

    // ── Blocking and hiding ──────────────────────────────────────────────
    expect(fixture.hits.some((hit) => hit.path === "/ads/banner.png")).toBe(false);
    expect(fixture.hits.some((hit) => hit.path === "/pixel.png")).toBe(true);
    expect(await tabEval<boolean>(app, "document.getElementById('ad').naturalWidth === 0")).toBe(true);
    // The scriptlet ran in the page's world BEFORE the page's first script.
    expect(await tabEval<string>(app, "window.__scriptlet")).toBe("ran");
    // Scriptlets carrying the same class each run in a scope of their own.
    expect(await tabEval<string>(app, "window.__shared")).toBe("one,two");
    // The site's own hiding rule is in the style sheet from the first paint…
    expect(await tabEval<string>(app, "getComputedStyle(document.getElementById('sponsor')).display")).toBe("none");
    // …and a generic one arrives once the DOM has said which classes it has.
    await expect.poll(() => tabEval<string>(app, "getComputedStyle(document.getElementById('ad-banner')).display")).toBe("none");
    // …however many classes the page has before it.
    await expect.poll(() => tabEval<string>(app, "getComputedStyle(document.getElementById('late-ad')).display")).toBe("none");
    expect(await tabEval<string>(app, "getComputedStyle(document.getElementById('content')).display")).toBe("block");

    // ── Privacy ──────────────────────────────────────────────────────────
    expect(await tabEval<boolean>(app, "window.__gpc")).toBe(true);
    expect(fixture.hits.find((hit) => hit.path === "/page")?.gpc).toBe("1");
    const ua = await tabEval<string>(app, "window.__ua");
    expect(ua).not.toContain("Electron");
    expect(ua).toMatch(/Chrome\/\d+\.0\.0\.0/);
    // Farbled canvas reads the same twice on this site…
    const farbled = await tabEval<string>(app, "window.__canvas");
    expect(await tabEval<string>(app, "window.__canvasAgain")).toBe(farbled);
    const recovered = await tabEval<number>(app, "window.__recovered");
    expect(await tabEval<boolean>(app, "window.__audioNoisy")).toBe(true);
    expect(await tabEval<boolean>(app, "window.__audioStable")).toBe(true);
    expect(await tabEval<boolean>(app, "window.__audioTails")).toBe(true);
    await expect.poll(() => tabEval<boolean | string>(app, "window.__frameGpc")).toBe(true);
    expect(await tabEval<boolean | string>(app, "window.__webglIntact")).toBe(true);
    expect(await tabEval<boolean | string>(app, "window.__webglPacked")).toBe(true);
    await expect.poll(() => tabEval<boolean | undefined>(app, `window.__frames["127.0.0.1:${String(port)}"]`)).toBe(true);
    await expect.poll(() => tabEval<boolean | undefined>(app, `window.__frames["localhost:${String(port)}"]`)).toBe(true);
    await expect.poll(() => tabEval<boolean | undefined>(app, `window.__frames["blob"]`)).toBe(true);
    await expect.poll(() => tabEval<boolean | string>(app, "window.__p3")).toBe(true);
    console.log("[shields] float16 readback:", await tabEval<boolean | string>(app, "window.__floatPixels"));
    expect(await tabEval<boolean | string>(app, "window.__floatPixels")).not.toBe(false);
    await expect.poll(() => tabEval<number | string>(app, "window.__offscreen")).not.toBe("pending");
    const offscreen = await tabEval<number>(app, "window.__offscreen");
    // …and the cross-site pixel's cookie never landed (every cross-site cookie is blocked).
    expect(await cookieNames(app)).not.toContain("tp");

    // The popover counts what was stopped on this page, and names the host.
    const popover = await openSiteInfo(shell);
    await expect(popover.getByTestId("site-info-shields")).toContainText("1 request blocked");
    await popover.getByRole("button", { name: "Show what was blocked" }).click();
    await expect(popover.getByTestId("site-info-shields-hosts")).toContainText("localhost");
    await captureShell(app, "01-popover.png");
    await shell.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);

    // Hyperlink auditing: the click goes through, its ping does not.
    await tabEval(app, "document.getElementById('pinglink').click()");
    await expect.poll(() => tabUrl(app)).toContain("/target");
    expect(fixture.hits.some((hit) => hit.path === "/pinged")).toBe(false);

    // A fetch redirected to a blocked host: its CORS preflight is refused —
    // redirected to the no-op resource, it crashed Electron's main process.
    await navigate(app, `http://127.0.0.1:${String(port)}/beacon`);
    await expect.poll(() => tabEval<string>(app, "window.__beacon")).toBe("refused");
    expect(fixture.hits.some((hit) => hit.path === "/hop")).toBe(true);
    expect(fixture.hits.some((hit) => hit.path === "/ads/beacon")).toBe(false);

    // ── Addresses ────────────────────────────────────────────────────────
    await navigate(app, `http://127.0.0.1:${String(port)}/landing?id=1&fbclid=abc123`);
    await expect.poll(() => tabUrl(app)).toBe(`http://127.0.0.1:${String(port)}/landing?id=1`);
    expect(fixture.hits.some((hit) => hit.path.includes("fbclid"))).toBe(false);
    await navigate(app, `https://www.google.com/url?q=${encodeURIComponent(`http://127.0.0.1:${String(port)}/bounced`)}&sa=D`);
    await expect.poll(() => tabUrl(app)).toBe(`http://127.0.0.1:${String(port)}/bounced`);

    // ── A dangerous page ─────────────────────────────────────────────────
    await navigate(app, "http://danger.test/download");
    await expect.poll(() => tabUrl(app)).toMatch(/^pistachio:\/\/shields\/blocked\?t=/);
    await expect.poll(() => tabEval<string>(app, "document.body.innerText")).toContain("danger.test may be dangerous");
    await captureTab(app, "02-dangerous-site.png");
    await tabEval(app, "document.getElementById('proceed').click()");
    // Let through for the rest of the run: the page itself is asked for (and, here, cannot resolve).
    await expect.poll(() => tabUrl(app)).toMatch(/^(http:\/\/danger\.test\/download|chrome-error)/);

    // ── Shields down for the site ────────────────────────────────────────
    await navigate(app, page);
    await expect.poll(() => tabEval<string>(app, "document.readyState")).toBe("complete");
    fixture.hits.length = 0;
    await openSiteInfo(shell);
    await popover.getByRole("switch", { name: "Shields" }).click();
    await expect(popover.getByTestId("site-info-shields")).toContainText("Down for this site");
    await shell.keyboard.press("Escape");
    // The switch reloads the page, which now loads as written.
    await expect.poll(() => fixture.hits.some((hit) => hit.path === "/ads/banner.png"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => tabEval<string>(app, "document.readyState")).toBe("complete");
    expect(await tabEval<string>(app, "getComputedStyle(document.getElementById('ad-banner')).display")).toBe("block");
    expect(await tabEval<string>(app, "String(window.__scriptlet)")).toBe("undefined");
    // Unfarbled, the same drawing reads differently: the noise was real…
    expect(await tabEval<string>(app, "window.__canvas")).not.toBe(farbled);
    // …and reading a black canvas did not give the noise away…
    expect(recovered).not.toBe(await tabEval<number>(app, "window.__pixels"));
    // …and an OffscreenCanvas blob carried it too.
    await expect.poll(() => tabEval<number | string>(app, "window.__offscreen")).not.toBe("pending");
    expect(await tabEval<number>(app, "window.__offscreen")).not.toBe(offscreen);
    // GPC speaks for the person, not the page: still sent where Shields are down.
    expect(await tabEval<boolean>(app, "window.__gpc")).toBe(true);

    // ── Settings ─────────────────────────────────────────────────────────
    // The page has the keyboard, and ⌘, is a menu accelerator a synthetic key never reaches.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send("pistachio:shell-command", { type: "runShortcut", id: "openSettings" }),
    );
    const settings = shell.getByTestId("settings-page");
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "Privacy & security", exact: true }).click();
    await expect(settings.getByRole("heading", { name: "Ads & trackers" })).toBeVisible();
    await expect(settings.getByTestId("shields-level-custom")).toHaveAttribute("aria-checked", "true");
    await expect(settings.getByText("127.0.0.1", { exact: true })).toBeVisible();
    await captureShell(app, "03-settings.png");
    await settings.getByRole("button", { name: "Raise Shields on 127.0.0.1" }).click();
    await expect(settings.getByText("Shields are up everywhere.")).toBeVisible();

    // A level owns its knobs; the person's own filters stay.
    await settings.getByTestId("shields-level-strict").click();
    await expect(settings.getByTestId("shields-level-strict")).toHaveAttribute("aria-checked", "true");
    await expect(settings.getByLabel("Fingerprinting", { exact: true })).toHaveValue("strict");
    await expect(settings.getByLabel("HTTPS", { exact: true })).toHaveValue("strict");
    await expect(settings.getByTestId("shields-custom-filters")).toHaveValue(/127\.0\.0\.1##\.sponsor-box/);
    // One knob changed makes it Custom.
    await settings.getByLabel("WebRTC", { exact: true }).selectOption("default");
    await expect(settings.getByTestId("shields-level-custom")).toHaveAttribute("aria-checked", "true");
    await captureShell(app, "04-settings-strict.png");
    await settings.getByRole("heading", { name: "Filter lists" }).scrollIntoViewIfNeeded();
    await expect(settings.getByText(/Updated just now · 1 rule\./).first()).toBeVisible();
    await captureShell(app, "05-settings-lists.png");
    await settings.getByTestId("shields-custom-filters").scrollIntoViewIfNeeded();
    await captureShell(app, "06-settings-filters.png");

    const saved = async () => (JSON.parse(await readFile(join(userData, "settings.json"), "utf8")) as { shields: { level: string; fingerprinting: string; webRtc: string } }).shields;
    await expect.poll(async () => (await saved()).webRtc).toBe("default");
    expect(await saved()).toMatchObject({ level: "custom", fingerprinting: "strict" });
  } finally {
    await app.close();
    fixture.server.close();
  }
});
