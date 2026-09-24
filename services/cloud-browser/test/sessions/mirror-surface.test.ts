import { readFile } from "node:fs/promises";
import type { BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { mirrorSurfaceSource, mirrorRecorderSource, type MirrorClientMessage, type MirrorServerMessage, type RecorderControl } from "@pistachio/dom-mirror";
import { PlaywrightBrowserRuntime } from "../../src/browser/runtime.js";
import { TabMirror, type MirrorViewer } from "../../src/sessions/mirror/tab-mirror.js";
import { AssetBroker } from "../../src/sessions/mirror/asset-broker.js";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";
import { startFixture, type FixtureServer } from "../helpers/fixture-server.js";

const CONTROL = "__surfaceRecorder";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC", "base64");

describeChromium("the isolated mirror surface", () => {
  const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
  let context: BrowserContext;
  let cdn: FixtureServer;
  let fixture: FixtureServer;
  let markup = "";
  const calls = new Map<string, number>();
  const cleanups: Array<() => void> = [];
  beforeAll(async () => {
    const font = await readFile(new URL("../../../../apps/web/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2", import.meta.url));
    cdn = await startFixture((request, response) => {
      const path = request.url ?? "/";
      calls.set(path, (calls.get(path) ?? 0) + 1);
      if (path === "/failed-redirect.css") { response.writeHead(302, { location: "/missing.css" }); response.end(); return; }
      if (path === "/missing.css") { response.writeHead(404, { "content-type": "text/plain" }); response.end("missing"); return; }
      if (path === "/broken.png") { response.writeHead(200, { "content-type": "image/png" }); response.write(PNG.subarray(0, 10)); setTimeout(() => response.destroy(), 10); return; }
      if (path === "/redirect.png") { response.writeHead(302, { location: "/redirected.png" }); response.end(); return; }
      if (path === "/css/app.css") {
        response.writeHead(200, { "content-type": "text/css" });
        response.end('@import "nested/other.css"; #heading{color:rgb(12,34,56)}');
      } else if (path === "/css/nested/other.css") {
        response.writeHead(200, { "content-type": "text/css" });
        response.end('@font-face{font-family:MirrorFont;src:url(../../font.woff2)} #heading{font-family:MirrorFont} #picture{background-image:url(../../logo.png)}');
      } else if (path === "/font.woff2") {
        response.writeHead(200, { "content-type": "font/woff2", "access-control-allow-origin": "*" }); response.end(font);
      } else if (path === "/replacement.css") {
        response.writeHead(200, { "content-type": "text/css" }); response.end('#heading{color:rgb(90,80,70)}');
      } else { response.writeHead(200, { "content-type": "image/png" }); response.end(PNG); }
    });
    fixture = await startFixture((request, response) => {
      if (request.url === "/local.css") { response.writeHead(200, { "content-type": "text/css" }); response.end('#heading{color:rgb(1,2,3)}'); return; }
      response.writeHead(200, { "content-type": "text/html" }); response.end(markup);
    });
  });
  afterEach(async () => { cleanups.splice(0).forEach(fn => fn()); await context?.close(); });
  afterAll(async () => { await fixture.close(); await cdn.close(); await runtime.close(); });

  async function setup(html: string, delay = 0) {
    markup = `<!doctype html><html><head><title>Fixture</title></head><body>${html}</body></html>`;
    context = await (await runtime.browser()).newContext({ viewport: { width: 1000, height: 700 } });
    const source = await context.newPage();
    const viewer = await context.newPage();
    const broker = new AssetBroker({ waitMs: 1000 });
    broker.observe(source);
    // The binding is installed before navigation; the mirror starts afterwards.
    // eslint-disable-next-line prefer-const
    let mirror: TabMirror;
    await source.exposeBinding("__sourceReport", (_source, report) => mirror?.onReport(report));
    await source.addInitScript(mirrorRecorderSource({ control: CONTROL, binding: "__sourceReport" }));
    await source.goto(fixture.origin);
    mirror = new TabMirror({ page: source, session: await context.newCDPSession(source), tabId: "tab", broker, control: CONTROL });
    cleanups.push(() => mirror.dispose());
    let authority = true;
    const input: MirrorClientMessage[] = [];
    const sent: MirrorServerMessage[] = [];
    const fallback: string[] = [];
    let ready = false;
    let deliveries = Promise.resolve();
    const deliverAsset = async (id: string): Promise<void> => {
      const asset = await mirror.asset(id);
      if (asset === "deferred" || asset === "pending") return;
      if (asset && asset !== "missing") await viewer.evaluate(({ id, type, bytes }) => {
        (window as unknown as { mirrorPort: MessagePort }).mirrorPort.postMessage({ kind: "asset", id, type, bytes: new Uint8Array(bytes) });
      }, { id, type: asset.type, bytes: [...asset.bytes] });
      else destination.send({ k: "assetMissing", id });
    };
    const destination: MirrorViewer = { send(message) {
      sent.push(message);
      deliveries = deliveries.then(async () => {
        if (message.k === "assetReady") { await deliverAsset(message.id); return; }
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        await viewer.evaluate(message => (window as unknown as { mirrorPort: MessagePort }).mirrorPort.postMessage({ kind: "mirror", message }), message);
      });
      // Teardown can close an in-flight delivery.
      void deliveries.catch(() => undefined);
    } };
    await viewer.exposeBinding("__viewerReport", async (_source, report: { kind: string; reason?: string; message: MirrorClientMessage }) => {
      if (report.kind === "ready") { ready = true; return; }
      if (report.kind === "fallback") { fallback.push(report.reason!); return; }
      if (report.kind !== "input") return;
      input.push(report.message);
      if (report.message.k === "need") {
        await Promise.all(report.message.ids.map(deliverAsset));
      } else {
        if (delay && report.message.k !== "ack") await new Promise(resolve => setTimeout(resolve, delay));
        await mirror.handle(report.message, destination, () => authority);
      }
    });
    await viewer.setContent('<iframe sandbox="allow-scripts" style="width:650px;height:550px;border:0"></iframe>');
    await viewer.evaluate(source => new Promise<void>(resolve => {
      const frame = document.querySelector("iframe")!;
      frame.onload = () => {
        const channel = new MessageChannel();
        (window as unknown as { mirrorPort: MessagePort }).mirrorPort = channel.port1;
        channel.port1.onmessage = event => {
          if (event.data.kind === "ready") channel.port1.postMessage({ kind: "state", human: true, active: true });
          void (window as unknown as { __viewerReport(report: unknown): Promise<void> }).__viewerReport(event.data);
        };
        channel.port1.start();
        frame.contentWindow!.postMessage("pistachio:mirror-connect", "*", [channel.port2]);
        resolve();
      };
      frame.srcdoc = source;
    }), mirrorSurfaceSource("surface-test-nonce"));
    await expect.poll(() => ready).toBe(true);
    await mirror.attach(destination);
    await deliveries;
    const inner = viewer.frameLocator("iframe");
    return { source, viewer, broker, mirror, input, sent, fallback, inner, destination,
      setAuthority: (value: boolean) => { authority = value; },
      state: async (human: boolean) => viewer.evaluate(human => (window as unknown as { mirrorPort: MessagePort }).mirrorPort.postMessage({ kind: "state", human, active: true }), human) };
  }

  it("preserves source errors across redirects and failed response-body capture", async () => {
    const { source, broker } = await setup(`<link rel="stylesheet" href="${cdn.origin}/failed-redirect.css"><img src="${cdn.origin}/broken.png">`);
    const scope = broker.scopeFor(source);
    const sheet = broker.assign(`${cdn.origin}/failed-redirect.css`, "style", scope);
    const image = broker.assign(`${cdn.origin}/broken.png`, "image", scope);
    await expect.poll(() => broker.diagnostic(sheet)).toEqual({ reason: "source-http", status: 404, context: "style" });
    await expect.poll(() => broker.diagnostic(image)).toEqual({ reason: "source-network", context: "image" });
  });

  it.each([
    ["image", "evicted", false],
    ["font", "capture", false],
    ["style", "source-http", false],
    ["style", "source-network", false],
    ["style", "evicted", true],
    ["style", "timeout", true],
  ] as const)("handles a %s asset with %s without unnecessary fallback", async (kind, reason, critical) => {
    const { source, viewer, broker, destination, fallback } = await setup("<h1>Readable page</h1>");
    const id = broker.assign(`https://example.invalid/${kind}`, kind, broker.scopeFor(source));
    destination.send({ k: "snapshot", frame: "main", epoch: 99, seq: 0,
      root: { t: "doc", id: 1, c: [{ t: "e", id: 2, tag: "html", c: [
        { t: "e", id: 3, tag: "head", c: kind === "style" ? [{ t: "e", id: 5, tag: "link", a: { rel: "stylesheet", href: `pa-asset:${id}` } }]
          : kind === "font" ? [{ t: "e", id: 5, tag: "style", css: `@font-face{font-family:Test;src:url(pa-asset:${id})}` }] : [] },
        { t: "e", id: 4, tag: "body", c: [{ t: "e", id: 6, tag: "img", a: { src: `pa-asset:${id}`, alt: "Picture" } }] },
      ] }] }, url: "https://example.invalid/", title: "Asset test", width: 1000, height: 700, focus: null });
    await expect.poll(() => viewer.frameLocator("iframe").locator("img").count()).toBe(1);
    await viewer.evaluate(({ id, reason, kind }) => (window as unknown as { mirrorPort: MessagePort }).mirrorPort.postMessage({ kind: "mirror", message: { k: "assetMissing", id, failure: { reason, context: kind } } }), { id, reason, kind });
    // A round-trip through the port is observable: the noncritical surface stays interactive.
    if (critical) await expect.poll(() => fallback).toContain("asset");
    else {
      await viewer.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(fallback).toEqual([]);
    }
  });

  it("defers unused CSS assets and delivers them when the source page later needs them", async () => {
    calls.clear();
    const { source, inner, mirror, broker, input, fallback, sent } = await setup(`
      <style>@font-face{font-family:Unused;src:url(${cdn.origin}/unused.woff2)}
      #later{display:none;width:30px;height:30px;background-image:url(${cdn.origin}/later.png)}</style>
      <h1>Deferred assets</h1><div id="later"></div>`);
    const id = broker.assign(`${cdn.origin}/later.png`, "image", broker.scopeFor(source));
    await expect.poll(() => input.some(message => message.k === "need" && message.ids.includes(id))).toBe(true);
    expect(await mirror.asset(id)).toBe("deferred");
    expect(calls.get("/later.png")).toBeUndefined();
    expect(calls.get("/unused.woff2")).toBeUndefined();
    expect(fallback).toEqual([]);
    await source.locator("#later").evaluate(el => (el as HTMLElement).style.display = "block");
    await expect.poll(() => sent.some(message => message.k === "assetReady" && message.id === id)).toBe(true);
    await expect.poll(() => inner.locator("#later").evaluate(el => getComputedStyle(el).backgroundImage)).toContain("blob:");
    expect(calls.get("/later.png")).toBe(1);
    expect(fallback).toEqual([]);
  });

  it("reports a local snapshot exception immediately and accepts a fresh snapshot afterward", async () => {
    const { viewer, destination, sent, fallback, inner } = await setup('<h1>Working document</h1>');
    await expect.poll(() => inner.getByRole("heading").textContent()).toBe("Working document");
    const errors: string[] = [];
    viewer.on("pageerror", error => errors.push(error.message));
    const original = sent.find(message => message.k === "snapshot")!;
    if (original.k !== "snapshot") throw new Error("Missing snapshot");
    // A schema-valid tree can still contain an operation the native DOM refuses.
    // File inputs, for example, cannot be assigned a nonempty value.
    destination.send({ ...original, epoch: original.epoch + 1, root: { t: "doc", id: 1, c: [
      { t: "e", id: 2, tag: "html", c: [{ t: "e", id: 3, tag: "body", c: [
        { t: "e", id: 4, tag: "input", a: { type: "file" }, v: "private exception content" },
      ] }] },
    ] } });
    await expect.poll(() => fallback).toEqual(["error"]);
    expect(errors).toEqual([]);
    destination.send({ ...original, epoch: original.epoch + 2 });
    await expect.poll(() => inner.getByRole("heading").textContent()).toBe("Working document");
  });

  it("keeps redirected CSS asset tokens valid without repeating the request", async () => {
    calls.clear();
    const { inner, fallback, broker, source, mirror } = await setup(`<style>#picture{width:32px;height:32px;background-image:url(${cdn.origin}/redirect.png)}</style><div id="picture"></div>`);
    const original = broker.assign(`${cdn.origin}/redirect.png`, "image", broker.scopeFor(source));
    const asset = await mirror.asset(original);
    expect(asset && typeof asset === "object" && Buffer.from(asset.bytes)).toEqual(PNG);
    await expect.poll(() => inner.locator("#picture").evaluate(el => getComputedStyle(el).backgroundImage)).toContain("blob:");
    expect(calls.get("/redirect.png")).toBe(1);
    expect(calls.get("/redirected.png")).toBe(1);
    expect(fallback).toEqual([]);
  });

  it("renders cross-origin CSS, nested imports, fonts, decoded images and a page-owned blob without a second GET", async () => {
    calls.clear();
    const { inner, source, fallback } = await setup(`<link rel="stylesheet" href="${cdn.origin}/css/app.css"><h1 id="heading">Readable</h1>
      <img id="picture" src="${cdn.origin}/logo.png"><img id="blob"><script>document.querySelector('#blob').src=URL.createObjectURL(new Blob([Uint8Array.from(atob('${PNG.toString("base64")}'), c=>c.charCodeAt(0))],{type:'image/png'}))</script>`);
    await expect.poll(() => inner.locator("#heading").evaluate(el => getComputedStyle(el).color)).toBe("rgb(12, 34, 56)");
    await expect.poll(() => inner.locator("#picture").evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
    await expect.poll(() => inner.locator("#blob").evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
    await expect.poll(() => inner.locator("#heading").evaluate(() => [...document.fonts].some(font => font.family === "MirrorFont" && font.status === "loaded"))).toBe(true);
    expect(calls.get("/css/app.css")).toBe(1);
    expect(calls.get("/css/nested/other.css")).toBe(1);
    expect(calls.get("/font.woff2")).toBe(1);
    expect(calls.get("/logo.png")).toBe(1);
    expect(fallback).toEqual([]);
    const oldSrc = await inner.locator("#picture").getAttribute("src");
    await source.locator("#picture").evaluate((el, url) => el.setAttribute("src", url), `${cdn.origin}/new.png`);
    await expect.poll(() => inner.locator("#picture").evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
    await expect.poll(() => calls.get("/new.png")).toBe(1);
    await expect.poll(() => inner.locator("#picture").getAttribute("src")).not.toBe(oldSrc);
  });

  it("replaces readable linked CSS with an unreadable cross-origin sheet without losing its identity", async () => {
    const { inner, source, fallback } = await setup('<link id="sheet" rel="stylesheet" href="/local.css"><h1 id="heading">Styles</h1>');
    await expect.poll(() => inner.locator("#heading").evaluate(el => getComputedStyle(el).color)).toBe("rgb(1, 2, 3)");
    await source.locator("#sheet").evaluate((el, url) => el.setAttribute("href", url), `${cdn.origin}/replacement.css`);
    await expect.poll(() => inner.locator("#heading").evaluate(el => getComputedStyle(el).color)).toBe("rgb(90, 80, 70)");
    expect(fallback).toEqual([]);
  });

  it("keeps newly typed passwords intact while cloud value patches arrive", async () => {
    const { inner, viewer, source, fallback } = await setup('<input id="secret" type="password">', 40);
    await inner.locator("#secret").click(); await viewer.keyboard.type("a-secret");
    await expect.poll(() => source.locator("#secret").inputValue()).toBe("a-secret");
    await expect.poll(() => inner.locator("#secret").inputValue()).toBe("a-secret");
    expect(fallback).toEqual([]);
  });

  it("preserves textarea, select and native change-on-blur behavior", async () => {
    const { inner, viewer, source } = await setup('<textarea id="note" onchange="document.title=this.value"></textarea><select id="choice"><option>A</option><option>B</option></select>');
    await inner.locator("#note").fill("line one\nline two");
    await viewer.keyboard.press("Tab");
    await expect.poll(() => source.title()).toBe("line one line two");
    await expect.poll(() => source.locator("#note").inputValue()).toBe("line one\nline two");
    await inner.locator("#choice").selectOption({ label: "B" });
    await expect.poll(() => source.locator("#choice").inputValue()).toBe("B");
  });

  it("keeps typing local with latency and addresses reflowed controls by node ID", async () => {
    const { inner, source, viewer, input } = await setup('<style>@media(min-width:800px){#field{margin-left:350px}}</style><input id="field"><button id="button" onclick="this.textContent=\'Clicked\'">Click</button>', 80);
    await inner.locator("#field").click();
    await viewer.keyboard.type("instant text", { delay: 0 });
    expect(await inner.locator("#field").inputValue()).toBe("instant text");
    await expect.poll(() => source.locator("#field").inputValue(), { timeout: 10000 }).toBe("instant text");
    expect(input.filter(m => m.k === "edit")).toHaveLength(12);
    expect(input.filter(m => m.k === "pointer").every(m => m.k === "pointer" && m.id !== null)).toBe(true);
    await inner.locator("#button").click();
    await expect.poll(() => source.locator("#button").textContent()).toBe("Clicked");
  });

  it("does not duplicate input after snapshots and allows a read-only viewer to recover", async () => {
    const { mirror, destination, viewer, inner, source, input, sent, state, setAuthority } = await setup('<input id="field">');
    await mirror.handle({ k: "resync" }, destination);
    await expect.poll(() => sent.filter(m => m.k === "snapshot").length).toBe(2);
    await inner.locator("#field").click();
    input.length = 0;
    await viewer.keyboard.type("one");
    await expect.poll(() => source.locator("#field").inputValue()).toBe("one");
    expect(input.filter(m => m.k === "edit")).toHaveLength(3);
    setAuthority(false); await state(false);
    await expect.poll(() => sent.filter(m => m.k === "snapshot").length).toBeGreaterThan(2);
    await expect.poll(() => inner.locator("html").evaluate(el => (el as HTMLElement).inert)).toBe(true);
  });

  it("rejects stale document edits and input whose authority changed while resolving a target", async () => {
    const { mirror, destination, source, sent, setAuthority } = await setup('<input id="field" value="safe"><button id="button" onclick="this.textContent=\'bad\'">safe</button>');
    const snapshot = sent.find(m => m.k === "snapshot")!;
    if (snapshot.k !== "snapshot") throw new Error("missing snapshot");
    const id = await source.evaluate(control => (window as unknown as Record<string, RecorderControl>)[control]!.idOf(document.querySelector("#field")!), CONTROL);
    await mirror.handle({ k: "resync" }, destination);
    await mirror.handle({ k: "edit", frame: "main", epoch: snapshot.epoch, id: id!, rev: 1, v: "stale", s: null, e: null }, destination);
    expect(await source.locator("#field").inputValue()).toBe("safe");
    setAuthority(false);
    const current = sent.filter(m => m.k === "snapshot").at(-1)!;
    if (current.k !== "snapshot") throw new Error("missing snapshot");
    await mirror.handle({ k: "edit", frame: "main", epoch: current.epoch, id: id!, rev: 2, v: "denied", s: null, e: null }, destination, () => false);
    expect(await source.locator("#field").inputValue()).toBe("safe");
    await source.evaluate(() => { document.querySelector("#button")!.addEventListener("mousedown", () => { document.title = "pressed"; }); });
    const buttonId = await source.evaluate(control => (window as unknown as Record<string, RecorderControl>)[control]!.idOf(document.querySelector("#button")!), CONTROL);
    let checks = 0;
    await mirror.handle({ k: "pointer", frame: "main", epoch: current.epoch, id: buttonId, type: "mousePressed", fx: .5, fy: .5, x: 0, y: 0, button: "left", clickCount: 1, modifiers: 0 }, destination, () => ++checks === 1);
    expect(checks).toBe(2);
    expect(await source.title()).toBe("Fixture");
  });

  it("isolates shell storage and DOM and never executes website scripts or handlers", async () => {
    const { viewer, inner } = await setup('<h1 id="heading">safe</h1><script>window.siteRan=true</script><img src="data:," onerror="window.siteRan=true">');
    expect(await viewer.evaluate(() => document.querySelector("iframe")!.contentDocument)).toBeNull();
    const isolated = await inner.locator("body").evaluate(() => {
      let parentBlocked = false, storageBlocked = false;
      try { void parent.document.body; } catch { parentBlocked = true; }
      try { void localStorage.length; } catch { storageBlocked = true; }
      return { parentBlocked, storageBlocked, siteRan: !!(window as unknown as { siteRan?: boolean }).siteRan, scripts: document.querySelectorAll("script").length };
    });
    expect(isolated).toEqual({ parentBlocked: true, storageBlocked: true, siteRan: false, scripts: 0 });
  });

  it.each(["visibility:hidden", "opacity:0"])("keeps hidden media and frames in DOM mode (%s), but falls back when revealed", async hidden => {
    const { source, inner, fallback, mirror } = await setup(`<h1>Readable page</h1>
      <div id="hidden" style="${hidden}"><iframe src="${cdn.origin}/embedded" width="400" height="200"></iframe>
      <video width="300" height="180"></video><div contenteditable>Editor</div></div>`);
    await expect.poll(() => inner.getByRole("heading").textContent()).toBe("Readable page");
    // A resnapshot runs suitability again after the iframe and styles settle.
    await mirror.handle({ k: "resync" });
    expect(fallback).toEqual([]);
    await source.locator("#hidden").evaluate(el => el.removeAttribute("style"));
    await expect.poll(() => fallback, { timeout: 5_000 }).toContain("frame");
  });

  it("mirrors idle editors read-only and rejects only when the cloud editor receives focus", async () => {
    const { source, inner, fallback, mirror, sent } = await setup('<h1>Timeline</h1><div contenteditable role="textbox" aria-label="Composer" style="width:400px;height:200px">Draft</div>');
    await expect.poll(() => inner.getByRole("heading").textContent()).toBe("Timeline");
    expect(await inner.getByRole("textbox").evaluate(el => (el as HTMLElement).isContentEditable)).toBe(false);
    await mirror.handle({ k: "resync" });
    expect(fallback).toEqual([]);
    // History updates on SPAs must not restart the recorder or audio lane.
    const before = sent.filter(message => message.k === "snapshot").length;
    await source.evaluate(() => { for (let i = 0; i < 10; i++) history.replaceState({}, "", `#${i}`); });
    await source.getByRole("heading").evaluate(el => { el.textContent = "Updated timeline"; });
    await expect.poll(() => inner.getByRole("heading").textContent()).toBe("Updated timeline");
    expect(sent.filter(message => message.k === "snapshot")).toHaveLength(before);
    await source.getByRole("textbox").focus();
    await expect.poll(() => fallback, { timeout: 1000 }).toContain("editor");
  });

  it("detects focused editors inside closed shadow roots immediately", async () => {
    const { source, inner, fallback } = await setup('<h1>Timeline</h1><div id="host"></div><script>window.editor = document.querySelector("#host").attachShadow({mode:"closed"}).appendChild(document.createElement("div")); window.editor.contentEditable = "true"; window.editor.textContent = "Composer";</script>');
    await expect.poll(() => inner.getByRole("heading").textContent()).toBe("Timeline");
    expect(fallback).toEqual([]);
    await source.evaluate(() => (window as unknown as { editor: HTMLElement }).editor.focus());
    await expect.poll(() => fallback, { timeout: 1000 }).toContain("editor");
  });

  it.each([
    ['<iframe src="https://example.invalid" style="width:400px;height:200px"></iframe>', "frame"],

    ['<video src="https://example.invalid/movie.mp4" style="width:300px;height:180px"></video>', "video"],
    ['<input type="password" value="prefilled-secret">', "password"],

    ['<canvas id="canvas" width="1000" height="700"></canvas><script>document.querySelector("canvas").getContext("webgl")</script>', "webgl"],
  ])("falls back instead of silently dropping unsupported content: %s", async (html, reason) => {
    const { fallback } = await setup(html);
    await expect.poll(() => fallback).toContain(reason);
  });
});
