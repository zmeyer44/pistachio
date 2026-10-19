import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";

/**
 * What live-share.spec.ts stands on besides the web stack and the SFU
 * (docs/live-share.md §12): the two pages the shared space holds, served on
 * loopback — each painting every frame (a capture brings frames only when
 * its page paints) under a big block of one colour, so a guest's video of
 * either can be checked for the page and not a blank — and the host's side
 * of the screen pictured as the person sees it, the browser's window with
 * the live-host window laid over it.
 */

/** The marker colours, as [r, g, b]: the board's magenta, the notes' cyan. */
export const BOARD_MARK = [255, 0, 255] as const;
export const NOTES_MARK = [0, 255, 255] as const;

/**
 * The window guests are let use: a marker across its top, a button counting
 * its clicks, a field, and a scrolling area. Everything the page hears of
 * mice, keys and wheels is kept in `__events`.
 */
const BOARD = `<!doctype html>
<html><head><title>Board</title><style>
  html, body { margin: 0; height: 100%; font: 16px -apple-system, sans-serif; background: #fff; overflow: hidden; }
  #marker { position: absolute; left: 0; top: 0; width: 100vw; height: 28vh; background: rgb(255, 0, 255); color: #fff; font: 700 9vh sans-serif; display: flex; align-items: center; justify-content: center; }
  #press { position: absolute; left: 4vw; top: 33vh; width: 30vw; height: 10vh; font-size: 3vh; }
  #field { position: absolute; left: 40vw; top: 33vh; width: 50vw; height: 10vh; font-size: 3vh; box-sizing: border-box; }
  #area { position: absolute; left: 4vw; top: 48vh; width: 86vw; height: 44vh; overflow: auto; border: 2px solid #333; box-sizing: border-box; }
  #area .tall { height: 4000px; background: linear-gradient(#fff, #09f); }
  #tick { position: fixed; right: 6px; bottom: 4px; font-size: 12px; color: #555; }
</style></head><body>
<div id="marker">BOARD</div>
<button id="press">Clicked 0</button>
<input id="field" aria-label="field" autocomplete="off">
<div id="area"><div class="tall"></div></div>
<div id="tick">0</div>
<script>
  window.__clicks = 0;
  window.__events = [];
  const press = document.getElementById("press");
  press.addEventListener("click", () => { window.__clicks += 1; press.textContent = "Clicked " + window.__clicks; });
  for (const type of ["mousedown", "keydown", "wheel"]) addEventListener(type, () => window.__events.push(type), true);
  let frame = 0;
  (function paint() { document.getElementById("tick").textContent = String(frame++); requestAnimationFrame(paint); })();
</script></body></html>`;

/** The space's other window, which guests are never let use: it must hear nothing of theirs. */
const NOTES = `<!doctype html>
<html><head><title>Notes</title><style>
  html, body { margin: 0; height: 100%; font: 16px -apple-system, sans-serif; background: #f6f6f6; overflow: hidden; }
  #marker { position: absolute; left: 0; top: 0; width: 100vw; height: 40vh; background: rgb(0, 255, 255); color: #033; font: 700 9vh sans-serif; display: flex; align-items: center; justify-content: center; }
  #tick { position: fixed; right: 6px; bottom: 4px; font-size: 12px; color: #555; }
</style></head><body>
<div id="marker">NOTES</div>
<div id="tick">0</div>
<script>
  window.__events = [];
  for (const type of ["mousedown", "keydown", "wheel"]) addEventListener(type, () => window.__events.push(type), true);
  let frame = 0;
  (function paint() { document.getElementById("tick").textContent = String(frame++); requestAnimationFrame(paint); })();
</script></body></html>`;

export interface SharedPages {
  board: string;
  notes: string;
  close(): Promise<void>;
}

/** The board at `/board` and the notes at `/notes`. */
export async function serveSharedPages(): Promise<SharedPages> {
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const body = path === "/board" ? BOARD : path === "/notes" ? NOTES : null;
    if (body === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    board: `${base}/board`,
    notes: `${base}/notes`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The browser's window as the host sees it: its own capture with the
 * live-host window's laid over it (two windows, and neither capture holds
 * the other), composed on a canvas in `canvasPage`, written to `path`.
 */
export async function captureHost(app: ElectronApplication, canvasPage: Page, path: string): Promise<void> {
  const shots = await app.evaluate(async ({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows();
    const host = all.find((window) => window.webContents.getURL().endsWith("#live-host"));
    const main = all.find((window) => window !== host)!;
    const base = (await main.capturePage()).toDataURL();
    const over = host === undefined ? null : (await host.webContents.capturePage()).toDataURL();
    return { base, over };
  });
  const png = await canvasPage.evaluate(async ({ base, over }) => {
    const load = (src: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
      });
    const under = await load(base);
    const canvas = document.createElement("canvas");
    canvas.width = under.naturalWidth;
    canvas.height = under.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(under, 0, 0);
    if (over !== null) context.drawImage(await load(over), 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }, shots);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(png, "base64"));
}
