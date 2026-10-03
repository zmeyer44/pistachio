# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e/tests/desk.spec.ts >> the sidebar lists the Space's other groups; on the rail a click on one passes the desk to it (its desk button, in the whole sidebar), each group's windows going home and coming back where they were left
- Location: e2e/tests/desk.spec.ts:1974:1

# Error details

```
TimeoutError: locator.boundingBox: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('[data-testid="desk-window"][data-tab-id="9e1175b3-b8d0-4c52-bbea-0e94b4a2e430"]').first()

```

# Test source

```ts
  16  | import { tmpdir } from "node:os";
  17  | import { dirname, join, resolve } from "node:path";
  18  | import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
  19  | import type { WebContentsView } from "electron";
  20  | import { CHROME_VIEW_HASHES, TRAFFIC_LIGHTS_H } from "@pistachio/shell-contracts/chrome";
  21  | import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
  22  | import { pageFirst, shellReady } from "./windows";
  23  | 
  24  | const screenshotDirectory = join(process.cwd(), "e2e/screenshots/desk");
  25  | 
  26  | function resolveElectronExecutable(): string | undefined {
  27  |   const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  28  |   return [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", suffix)].find(
  29  |     (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  30  |   );
  31  | }
  32  | 
  33  | function api<T>(shell: Page, call: (pistachio: PistachioApi) => Promise<T>): Promise<T> {
  34  |   return shell.evaluate(`(${call.toString()})(window.pistachio)`) as Promise<T>;
  35  | }
  36  | 
  37  | const snapshot = (shell: Page): Promise<ShellSnapshot> => api(shell, (pistachio) => pistachio.getSnapshot());
  38  | 
  39  | /** One of a window's less-used controls, on its frame's menu (⋯): mask, minimize, a document's own. */
  40  | async function fromFrameMenu(shell: Page, win: string, testId: string): Promise<void> {
  41  |   await shell.locator(`${win} [data-testid="desk-window-more"]`).click();
  42  |   await shell.locator(`[data-testid="context-menu"] [data-testid="${testId}"]`).click();
  43  | }
  44  | 
  45  | 
  46  | interface Box {
  47  |   x: number;
  48  |   y: number;
  49  |   width: number;
  50  |   height: number;
  51  | }
  52  | 
  53  | /** The tab views main has on screen, bottom to top, with their boxes. */
  54  | function liveViews(app: ElectronApplication): Promise<Array<{ url: string; bounds: Box }>> {
  55  |   return app.evaluate(({ BrowserWindow }, hashes) => {
  56  |     const window = BrowserWindow.getAllWindows()[0];
  57  |     if (window === undefined) throw new Error("Pistachio window is unavailable");
  58  |     return window.contentView.children.flatMap((child) => {
  59  |       if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return [];
  60  |       const url = (child as WebContentsView).webContents.getURL();
  61  |       return Object.values(hashes).some((hash) => url.endsWith(hash)) ? [] : [{ url, bounds: (child as WebContentsView).getBounds() }];
  62  |     });
  63  |   }, CHROME_VIEW_HASHES);
  64  | }
  65  | 
  66  | /**
  67  |  * The window as a person sees it: the shell with every live page composited
  68  |  * over it at its box, in stacking order. Playwright's own screenshot is the
  69  |  * shell's document alone — the pages are other views.
  70  |  */
  71  | async function capture(app: ElectronApplication, shell: Page, filename: string): Promise<void> {
  72  |   const layers = await app.evaluate(async ({ BrowserWindow }, hashes) => {
  73  |     const window = BrowserWindow.getAllWindows()[0];
  74  |     if (window === undefined) throw new Error("Pistachio window is unavailable");
  75  |     const base = (await window.capturePage()).toDataURL();
  76  |     const views: Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }> = [];
  77  |     for (const child of window.contentView.children) {
  78  |       if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) continue;
  79  |       const view = child as WebContentsView;
  80  |       if (Object.values(hashes).some((hash) => view.webContents.getURL().endsWith(hash))) continue;
  81  |       views.push({ dataUrl: (await view.webContents.capturePage()).toDataURL(), bounds: view.getBounds() });
  82  |     }
  83  |     return { base, views };
  84  |   }, CHROME_VIEW_HASHES);
  85  |   const png = await shell.evaluate(async ({ base, views }) => {
  86  |     const load = (src: string): Promise<HTMLImageElement> =>
  87  |       new Promise((done, fail) => {
  88  |         const image = new Image();
  89  |         image.onload = () => done(image);
  90  |         image.onerror = fail;
  91  |         image.src = src;
  92  |       });
  93  |     const ground = await load(base);
  94  |     const canvas = document.createElement("canvas");
  95  |     canvas.width = ground.naturalWidth;
  96  |     canvas.height = ground.naturalHeight;
  97  |     const context = canvas.getContext("2d")!;
  98  |     context.drawImage(ground, 0, 0);
  99  |     const scale = ground.naturalWidth / window.innerWidth;
  100 |     for (const view of views) {
  101 |       const image = await load(view.dataUrl);
  102 |       const { x, y, width, height } = view.bounds;
  103 |       context.save();
  104 |       context.beginPath();
  105 |       context.roundRect(x * scale, y * scale, width * scale, height * scale, 8 * scale);
  106 |       context.clip();
  107 |       context.drawImage(image, x * scale, y * scale, width * scale, height * scale);
  108 |       context.restore();
  109 |     }
  110 |     return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
  111 |   }, layers);
  112 |   await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
  113 | }
  114 | 
  115 | async function box(page: Page, selector: string): Promise<Box> {
> 116 |   const found = await page.locator(selector).first().boundingBox();
      |                                                      ^ TimeoutError: locator.boundingBox: Timeout 30000ms exceeded.
  117 |   if (found === null) throw new Error(`${selector} has no box`);
  118 |   return found;
  119 | }
  120 | 
  121 | const windowSelector = (tabId: string): string => `[data-testid="desk-window"][data-tab-id="${tabId}"]`;
  122 | /** A tab's row in the sidebar — the desk's dock — whether it is drawn whole or as the rail. */
  123 | const rowSelector = (tabId: string): string => `[data-testid="sidebar-tab-list"] [role="tab"][data-tab-id="${tabId}"]`;
  124 | /** A tab's row's mark: its window out on the desk ("out"), or in use there ("focused"). */
  125 | const markSelector = (tabId: string, mark?: "out" | "focused"): string => `${rowSelector(tabId)} [data-testid="desk-row-mark"]${mark === undefined ? "" : `[data-mark="${mark}"]`}`;
  126 | 
  127 | /** Where the desk's windows go: the whole of its card (the Bar's notch and the shelf lie over its foot, the windows there cut short of them). */
  128 | const usableOf = (stage: Box): Box => ({ x: stage.x, y: stage.y, width: stage.width, height: stage.height });
  129 | 
  130 | /** The desk is at rest: nothing entering, nothing in hand, nothing still flying or settling. */
  131 | async function settled(shell: Page): Promise<void> {
  132 |   await expect(shell.locator('.desk-stage[data-phase="open"]')).toHaveCount(1);
  133 |   await expect(shell.locator(".desk-stage[data-gesture]")).toHaveCount(0);
  134 |   await expect(shell.locator('[data-testid="desk-window"][data-flight]')).toHaveCount(0);
  135 |   // Springs settle within a second; give the last layout a frame to reach main.
  136 |   await shell.waitForTimeout(900);
  137 | }
  138 | 
  139 | /** The desk's card up: its button in the sidebar hovered, and the card drawn once the pages under it have given way. */
  140 | async function openMore(shell: Page): Promise<void> {
  141 |   await shell.getByTestId("desk-more").hover();
  142 |   await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(1);
  143 | }
  144 | 
  145 | /** Leave the desk: its way out is on the More card. */
  146 | async function leaveDesk(shell: Page): Promise<void> {
  147 |   await openMore(shell);
  148 |   await shell.getByTestId("desk-leave").click();
  149 | }
  150 | 
  151 | /** A slow drag: the pointer stops before letting go, so it is a placement, not a throw. */
  152 | async function place(shell: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  153 |   await shell.mouse.move(from.x, from.y);
  154 |   await shell.mouse.down();
  155 |   await shell.mouse.move(from.x + 6, from.y, { steps: 2 });
  156 |   for (let step = 1; step <= 12; step += 1) {
  157 |     await shell.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
  158 |     await shell.waitForTimeout(16);
  159 |   }
  160 |   await shell.waitForTimeout(160);
  161 |   await shell.mouse.up();
  162 | }
  163 | 
  164 | /** A flick: a few fast frames and a release while still moving. */
  165 | async function fling(shell: Page, from: { x: number; y: number }, by: { x: number; y: number }): Promise<void> {
  166 |   await shell.mouse.move(from.x, from.y);
  167 |   await shell.mouse.down();
  168 |   await shell.mouse.move(from.x + 6, from.y, { steps: 2 });
  169 |   for (let step = 1; step <= 5; step += 1) {
  170 |     await shell.mouse.move(from.x + (by.x * step) / 5, from.y + (by.y * step) / 5);
  171 |     await shell.waitForTimeout(12);
  172 |   }
  173 |   await shell.mouse.up();
  174 | }
  175 | 
  176 | /**
  177 |  * Move the window off the real cursor, if it rests over it. A drag's native
  178 |  * layer relays where the REAL pointer is, and Playwright's pointer is not
  179 |  * that one: a real cursor over the window would pull a drag to it.
  180 |  */
  181 | async function clearOfCursor(app: ElectronApplication): Promise<void> {
  182 |   await app.evaluate(({ BrowserWindow, screen }) => {
  183 |     const window = BrowserWindow.getAllWindows()[0];
  184 |     if (window === undefined) return;
  185 |     const cursor = screen.getCursorScreenPoint();
  186 |     const bounds = window.getBounds();
  187 |     const inside = cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
  188 |     if (!inside) return;
  189 |     const area = screen.getDisplayNearestPoint(cursor).workArea;
  190 |     const x = cursor.x - area.x > bounds.width + 20 ? area.x : cursor.x + 20 + bounds.width <= area.x + area.width ? cursor.x + 20 : null;
  191 |     const y = cursor.y - area.y > bounds.height + 20 ? area.y : cursor.y + 20 + bounds.height <= area.y + area.height ? cursor.y + 20 : null;
  192 |     if (x !== null) window.setPosition(x, bounds.y);
  193 |     else if (y !== null) window.setPosition(bounds.x, y);
  194 |   });
  195 | }
  196 | 
  197 | function center(rect: Box): { x: number; y: number } {
  198 |   return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  199 | }
  200 | 
  201 | /** The desk's notch view (main's "notch" chrome view) on screen, and its box; null while it is not. */
  202 | function notchView(app: ElectronApplication): Promise<Box | null> {
  203 |   return app.evaluate(({ BrowserWindow }) => {
  204 |     const window = BrowserWindow.getAllWindows()[0];
  205 |     const view = window?.contentView.children.find(
  206 |       (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith("#notch") && (child as WebContentsView).getVisible(),
  207 |     ) as WebContentsView | undefined;
  208 |     return view === undefined ? null : view.getBounds();
  209 |   });
  210 | }
  211 | 
  212 | /** A mouse event on the notch view, as the person's pointer would reach it. */
  213 | function notchMouse(app: ElectronApplication, type: "mouseMove" | "mouseLeave", x: number, y: number): Promise<void> {
  214 |   return app.evaluate(
  215 |     async ({ webContents }, { type, x, y }) => {
  216 |       const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#notch"));
```