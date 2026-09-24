/**
 * The DOM mirror end to end WITHOUT the socket (docs/web-browser-design.md §16):
 * the recorder serializes a real page, the renderer rebuilds it in another
 * real page, and the two documents match; a mutation becomes a patch that
 * applies; an asset token becomes the bytes the broker hands over.
 *
 * Both halves run in real Chromium — the recorder because it hooks the CSSOM
 * and shadow DOM the way only a browser has, the renderer because it builds
 * DOM and object URLs. The recorder's control object and the renderer factory
 * are stringified into their pages, exactly as they are shipped.
 */

import type { BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  recorderReportSchema,
  createMirrorRenderer,
  mirrorRecorderSource,
  rewriteNode,
  type MirrorNode,
  type RecorderReport,
} from "@pistachio/dom-mirror";
import { PlaywrightBrowserRuntime } from "../../src/browser/runtime.js";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";
import { settle } from "../helpers/fixture-server.js";

const CONTROL = "__mc_test";
const BINDING = "__mb_test";
const RENDER = "__mirror_render";

const PAGE_HTML = `<!doctype html><html><head><title>Doc</title>
<style>.box{color:rgb(10,20,30)} .box::before{content:"x"}</style>
</head><body style="margin:0">
<h1 id="h">Hello mirror</h1>
<p class="box">A paragraph of <strong>real</strong> text.</p>
<input id="field" value="start" />
<img id="pic" src="https://asset.invalid/logo.png" alt="logo" />
<div id="host"></div>
<script>
  const root = document.getElementById("host").attachShadow({mode:"open"});
  root.innerHTML = "<span id='shadowed'>inside shadow</span>";
</script>
</body></html>`;

/** The renderer factory, stringified into the viewer page and exposed as a global. */
function rendererBootScript(): string {
  // The `__name` shim answers esbuild's keepNames helper, exactly as
  // `mirrorRecorderSource` does for the recorder.
  return `const __name=(f)=>f; window.${RENDER} = (${createMirrorRenderer.toString()});`;
}

describeChromium("the DOM mirror recorder and renderer", () => {
  const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
  let context: BrowserContext;
  let source: Page;
  let viewer: Page;
  /** Reports the recorder pushes through its binding (patches, blobs). */
  const reports: RecorderReport[] = [];

  beforeAll(async () => {
    const browser = await runtime.browser();
    context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    source = await context.newPage();
    await source.exposeBinding(BINDING, (_source, payload: unknown) => {
      reports.push(payload as RecorderReport);
    });
    await source.addInitScript(mirrorRecorderSource({ control: CONTROL, binding: BINDING }));
    await source.goto(`data:text/html,${encodeURIComponent(PAGE_HTML)}`, { waitUntil: "domcontentloaded" });

    viewer = await context.newPage();
    await viewer.setContent("<!doctype html><html><head></head><body></body></html>", { waitUntil: "domcontentloaded" });
    await viewer.addScriptTag({ content: rendererBootScript() });
    await viewer.evaluate((render: string) => {
      const factory = (window as unknown as Record<string, (opts: { document: Document }) => unknown>)[render]!;
      (window as unknown as Record<string, unknown>)["view"] = factory({ document: window.document });
    }, RENDER);
  });

  it("mirrors a large self-contained welcome document without sending its data URL as metadata", async () => {
    const page = await context.newPage();
    try {
      await page.addInitScript(mirrorRecorderSource({ control: CONTROL, binding: BINDING }));
      await page.goto(`data:text/html,${encodeURIComponent(`<h1>Welcome</h1><p>${"welcome ".repeat(6000)}</p>`)}`);
      const raw = await page.evaluate(control => (window as unknown as Record<string, { start(epoch: number): unknown }>)[control]!.start(1), CONTROL);
      const report = recorderReportSchema.parse(raw);
      expect(report.kind).toBe("snapshot");
      if (report.kind === "snapshot") { expect(report.url).toBe("about:blank"); expect(report.base).toBe("about:blank"); expect(report.root).toBeTruthy(); }
    } finally { await page.close(); }
  });

  afterAll(async () => {
    await context.close().catch(() => undefined);
    await runtime.close();
  });

  async function snapshot(): Promise<Extract<RecorderReport, { kind: "snapshot" }>> {
    const raw = (await source.evaluate((control: string) => {
      const api = (window as unknown as Record<string, { start(): unknown }>)[control]!;
      return api.start();
    }, CONTROL)) as RecorderReport;
    if (raw.kind !== "snapshot") throw new Error(`expected a snapshot, got ${raw.kind}`);
    return raw;
  }

  /** Rewrite the snapshot's asset URLs to tokens, the way the host does. */
  function withTokens(root: MirrorNode): { root: MirrorNode; assets: Map<string, string> } {
    const assets = new Map<string, string>();
    const rewritten = rewriteNode(root, "https://asset.invalid/", (url) => {
      const id = `a${String(assets.size)}`;
      assets.set(id, url);
      return `pa-asset:${id}`;
    });
    return { root: rewritten, assets };
  }

  async function applySnapshot(report: Extract<RecorderReport, { kind: "snapshot" }>, root: MirrorNode): Promise<void> {
    await viewer.evaluate(
      (message) => (window as unknown as Record<string, { applySnapshot(m: unknown): unknown }>)["view"]!.applySnapshot(message),
      { k: "snapshot", frame: "main", epoch: 1, seq: 0, url: report.url, title: report.title, root, focus: report.focus, width: report.width, height: report.height },
    );
  }

  async function viewerText(selector: string): Promise<string> {
    return viewer.evaluate((sel: string) => document.querySelector(sel)?.textContent ?? "", selector);
  }

  it("rebuilds the document's text, a field value, and a shadow tree", async () => {
    const snap = await snapshot();
    const { root } = withTokens(snap.root);
    await applySnapshot(snap, root);

    expect(await viewerText("#h")).toBe("Hello mirror");
    expect(await viewerText(".box")).toContain("real");
    expect(await viewer.evaluate(() => (document.getElementById("field") as HTMLInputElement).value)).toBe("start");
    // The shadow tree came across and rebuilt as a real shadow root.
    expect(
      await viewer.evaluate(() => document.getElementById("host")?.shadowRoot?.getElementById("shadowed")?.textContent ?? ""),
    ).toBe("inside shadow");
    // The style survived: the computed colour the sheet sets is present.
    expect(await viewer.evaluate(() => getComputedStyle(document.querySelector(".box") as Element).color)).toBe("rgb(10, 20, 30)");
  });

  it("swaps an asset token for the bytes the broker provides", async () => {
    const snap = await snapshot();
    const { root, assets } = withTokens(snap.root);
    await applySnapshot(snap, root);
    // The token is not yet resolved, so the image has no src.
    expect(await viewer.evaluate(() => (document.getElementById("pic") as HTMLImageElement).getAttribute("src"))).toBeNull();
    const id = [...assets.keys()][0];
    if (id === undefined) throw new Error("no asset was tokenized");
    const dataUrl = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";
    await viewer.evaluate(
      ([assetId, url]: [string, string]) =>
        (window as unknown as Record<string, { resolveAsset(i: string, u: string, t: string, c: string | null): void }>)["view"]!.resolveAsset(
          assetId,
          url,
          "image/gif",
          null,
        ),
      [id, dataUrl] as [string, string],
    );
    expect(await viewer.evaluate(() => (document.getElementById("pic") as HTMLImageElement).getAttribute("src"))).toBe(dataUrl);
  });

  it("turns a live mutation into a patch the renderer applies", async () => {
    const snap = await snapshot();
    const { root } = withTokens(snap.root);
    await applySnapshot(snap, root);
    reports.length = 0;

    // Change the heading text and append a paragraph in the source page.
    await source.evaluate(() => {
      document.getElementById("h")!.textContent = "Changed";
      const p = document.createElement("p");
      p.id = "added";
      p.textContent = "brand new";
      document.body.appendChild(p);
    });
    await settle(() => reports.some((report) => report.kind === "patch"));
    let seq = 0;
    for (const report of reports) {
      if (report.kind !== "patch") continue;
      seq += 1;
      const ops = report.ops;
      await viewer.evaluate(
        (message) => (window as unknown as Record<string, { applyPatch(m: unknown): unknown }>)["view"]!.applyPatch(message),
        { k: "patch", frame: "main", epoch: 1, seq, ops },
      );
    }
    expect(await viewerText("#h")).toBe("Changed");
    expect(await viewerText("#added")).toBe("brand new");
  });
});
