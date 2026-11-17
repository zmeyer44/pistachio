import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { captureEnabled, launchApp } from "./app";
import { startLocalApps, type LocalAppFixture, type LocalApps } from "./local-apps-harness";
import { activeUrl } from "./pages-harness";
import { pageFirst, shellReady } from "./windows";

type Api = { pistachio: PistachioApi };

/** The owner's Mac, more or less: one project on four ports, a sign-in page, a desktop app's UI with no icon — and enough else to pass a dozen. */
const MANY: LocalAppFixture[] = [
  { title: "BlueBubbles Server", project: "BlueBubbles", server: "", colour: "" },
  { title: "Swagger UI", project: "billing-api", server: "uvicorn", colour: "#49cc90" },
  { title: "Acme — Marketing", project: "acme-marketing", server: "astro", colour: "#ff5d01" },
  { title: "", project: "scratch", server: "", colour: "" },
  { title: "Storybook", project: "design-system", server: "storybook", colour: "#ff4785" },
  { title: "Sign in · emily", project: "emilylevy", server: "next", colour: "#111111" },
  { title: "Vite + React + TS", project: "playground", server: "vite", colour: "#646cff" },
  { title: "Admin", project: "admin-console", server: "next", colour: "#0070f3" },
  { title: "Marius", project: "marius", server: "vite", colour: "#7c5cff" },
  { title: "Marius", project: "marius", server: "vite", colour: "#7c5cff" },
  { title: "Marius", project: "marius", server: "vite", colour: "#7c5cff" },
  { title: "Marius", project: "marius", server: "vite", colour: "#7c5cff" },
];

/** Main looks at these ports from its next scan on: it reads PISTACHIO_LOCAL_APP_PORTS each time, so a spec can change what is "running". */
async function lookAt(app: ElectronApplication, shell: Page, ports: number[]): Promise<void> {
  await app.evaluate((_electron, list) => {
    process.env["PISTACHIO_LOCAL_APP_PORTS"] = list;
  }, ports.join(","));
  // A scan is reused for a moment: wait until main's answer is the new one.
  await expect
    .poll(() => shell.evaluate(async () => (await (window as unknown as Api).pistachio.localApps()).map((found) => found.port).sort()))
    .toEqual([...ports].sort());
}

const pillPorts = (shell: Page): Promise<number[]> =>
  shell.getByTestId("local-app").evaluateAll((pills) => pills.map((pill) => Number(pill.getAttribute("data-port"))));

/**
 * The palette and a margin of what it sits over, to e2e/screenshots/local-apps/`name`
 * (only under PISTACHIO_E2E_CAPTURE=1). Two frames and a beat first: a capture
 * taken on the heels of a change hands back the frame before it.
 */
async function capturePalette(app: ElectronApplication, shell: Page, name: string, settleMs = 250): Promise<void> {
  if (!captureEnabled) return;
  await shell.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await new Promise((done) => setTimeout(done, settleMs));
  const box = await shell.getByTestId("url-bar").boundingBox();
  if (box === null) throw new Error("the palette is not on screen");
  const margin = 28;
  const rect = {
    x: Math.max(0, Math.round(box.x - margin)),
    y: Math.max(0, Math.round(box.y - margin)),
    width: Math.round(box.width + 2 * margin),
    height: Math.round(box.height + 2 * margin),
  };
  const png = await app.evaluate(async ({ BrowserWindow }, area) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage(area)).toPNG().toString("base64");
  }, rect);
  const folder = join(process.cwd(), "e2e/screenshots/local-apps");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, name), Buffer.from(png, "base64"));
}

/** Local apps (docs/local-apps.md): main finds the web apps on this Mac's ports and hands the shell what they are. */
test.describe.serial("local apps", { tag: ["@address"] }, () => {
  test.describe.configure({ timeout: 90_000 });
  let servers: LocalApps;
  let more: LocalApps | undefined;
  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    servers = await startLocalApps();
    ({ app } = await launchApp({
      settings: pageFirst(),
      name: "local-apps",
      env: servers.env,
      size: { width: 1280, height: 820 },
      // Pictures at Retina's density, whatever screen the run is on.
      args: captureEnabled ? ["--force-device-scale-factor=2"] : [],
    }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
    servers?.stop();
    more?.stop();
  });

  test("main finds each app on its port — title, icon, project and server — newest first", async () => {
    const apps = await shell.evaluate(() => (window as unknown as Api).pistachio.localApps());
    expect(apps.map((found) => [found.project, found.title, found.server, found.iconUrl === null])).toEqual([
      ["acme-web", "Acme Dashboard", "Next.js", false],
      ["playground", "Vite + React + TS", "Vite", false],
      ["design-system", "Storybook", "Storybook", false],
      ["acme-marketing", "Acme — Marketing", "Astro", false],
      ["billing-api", "Swagger UI", "Uvicorn", false],
      ["scratch", null, "Node", true],
    ]);
    expect(apps[0]?.url).toBe(`http://localhost:${servers.ports.at(-1)}/`);
  });

  test("with no app running the bar has no tray at all; apps turning up while it is open unfold one under the selection", async () => {
    await lookAt(app, shell, []);
    await shell.evaluate(() => (window as unknown as Api).pistachio.createTab("pistachio://demo/vendors"));
    await expect.poll(() => activeUrl(shell)).toBe("pistachio://demo/vendors");
    await shell.keyboard.press("Meta+L");
    const input = shell.getByTestId("address-input");
    await expect(input).toBeFocused();
    // The bar's own scan is answered in a moment; give it that, so "absent" is not "not yet".
    await shell.waitForTimeout(400);
    await expect(shell.getByTestId("local-tray")).toHaveCount(0);
    await input.fill("5173");
    await shell.waitForTimeout(200);
    await expect(shell.getByTestId("local-tray")).toHaveCount(0);
    await shell.keyboard.press("Escape");

    // Steered to a row, then servers start: the bar's next look finds them,
    // the tray unfolds above the list, and the row stays the one chosen.
    await shell.keyboard.press("Meta+L");
    await expect(input).toBeFocused();
    // (The first stop is the recent sites' first chip, this page's own site.)
    await shell.keyboard.press("ArrowDown");
    await shell.keyboard.press("ArrowRight");
    const steered = await input.inputValue();
    expect(steered).not.toContain("localhost");
    await lookAt(app, shell, servers.ports);
    await expect(shell.getByTestId("local-app")).toHaveCount(servers.ports.length);
    await capturePalette(app, shell, "6-arrival.png", 120);
    await expect(input).toHaveValue(steered);
    await expect(shell.locator('[data-testid="local-app"][data-selected]')).toHaveCount(0);
    await shell.keyboard.press("Escape");
  });

  test("browsing, the tray sits under the field: ↓ reaches it first, ←/→ walk it, an open app's ↵ switches to its tab", async () => {
    const newest = [...servers.ports].reverse();
    const playground = newest[1]!;
    // A morning's tabs, one of them a local app already open.
    await shell.evaluate((url) => (window as unknown as Api).pistachio.createTab(url), `http://localhost:${playground}/`);
    await expect.poll(() => activeUrl(shell)).toBe(`http://localhost:${playground}/`);
    const openTabId = await shell.evaluate(async () => (await (window as unknown as Api).pistachio.getSnapshot()).activeTabId);
    await shell.evaluate(() => (window as unknown as Api).pistachio.createTab("pistachio://demo/invoices"));
    await expect.poll(() => activeUrl(shell)).toBe("pistachio://demo/invoices");
    // (For the picture: the page painted under the veil.)
    if (captureEnabled) await shell.waitForTimeout(1000);

    await shell.keyboard.press("Meta+L");
    const input = shell.getByTestId("address-input");
    await expect(input).toBeFocused();
    const tray = shell.getByTestId("local-tray");
    await expect(tray).toHaveAttribute("data-shown", "");
    // One pill per project, newest first: each fixture is its own project.
    await expect.poll(() => pillPorts(shell)).toEqual(newest);
    await expect(shell.locator(`[data-testid="local-app"][data-port="${playground}"]`)).toHaveAttribute("data-open", "");
    await capturePalette(app, shell, "1-browse-light.png", 1300);

    const pill = (port: number) => shell.locator(`[data-testid="local-app"][data-port="${port}"]`);
    await shell.keyboard.press("ArrowDown");
    await expect(pill(newest[0]!)).toHaveAttribute("data-selected", "");
    await expect(input).toHaveValue(`http://localhost:${newest[0]}/`);
    await expect(shell.getByTestId("local-app-detail")).toContainText("Next.js");
    await shell.keyboard.press("ArrowRight");
    await expect(pill(playground)).toHaveAttribute("data-selected", "");
    await expect(shell.getByTestId("local-app-detail")).toContainText("Switch to tab");
    await capturePalette(app, shell, "2-selected.png");

    // ↓ leaves the tray for the list; ↑ comes back to it, and ↑ again to the field.
    await shell.keyboard.press("ArrowDown");
    await expect(shell.locator('[data-testid="local-app"][data-selected]')).toHaveCount(0);
    await shell.keyboard.press("ArrowUp");
    await expect(pill(newest[0]!)).toHaveAttribute("data-selected", "");
    await shell.keyboard.press("ArrowUp");
    await expect(shell.locator('[data-testid="local-app"][data-selected]')).toHaveCount(0);
    await expect(input).toHaveValue("pistachio://demo/invoices");

    // The open app: ↵ goes to its tab, and loads nothing.
    await shell.keyboard.press("ArrowDown");
    await shell.keyboard.press("ArrowRight");
    await shell.keyboard.press("Enter");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect.poll(() => shell.evaluate(async () => (await (window as unknown as Api).pistachio.getSnapshot()).activeTabId)).toBe(openTabId);

    // Any other: ↵ goes to it in the page in use.
    await shell.keyboard.press("Meta+L");
    await expect(input).toBeFocused();
    await expect.poll(() => pillPorts(shell)).toEqual(newest);
    await shell.keyboard.press("ArrowDown");
    await shell.keyboard.press("Enter");
    await expect.poll(() => activeUrl(shell)).toBe(`http://localhost:${newest[0]}/`);
  });

  test("typing, the tray keeps what the text reaches, folds when nothing does, and ↵ stays the text's until ⇥ picks", async () => {
    const storybook = [...servers.ports].reverse()[2]!;
    await shell.keyboard.press("Meta+L");
    const input = shell.getByTestId("address-input");
    await expect(input).toBeFocused();
    const tray = shell.getByTestId("local-tray");
    await expect(tray).toHaveAttribute("data-shown", "");

    await input.fill("story");
    await expect.poll(() => pillPorts(shell)).toEqual([storybook]);
    await expect(shell.getByTestId("local-tray-hint")).toBeVisible();
    // Nothing in the tray is chosen by itself: ↵ would still search for "story".
    await expect(shell.locator('[data-testid="local-app"][data-selected]')).toHaveCount(0);
    await capturePalette(app, shell, "3-typing.png");
    // It is above the first row, so ↑ from there reaches it too, and ↓ goes back.
    await shell.keyboard.press("ArrowUp");
    await expect(shell.locator(`[data-testid="local-app"][data-port="${storybook}"]`)).toHaveAttribute("data-selected", "");
    await expect(shell.getByTestId("local-tray-hint")).toHaveCount(0);
    await shell.keyboard.press("ArrowDown");
    await expect(shell.locator('[data-testid="local-app"][data-selected]')).toHaveCount(0);

    await input.fill("zzqx");
    await expect(tray).not.toHaveAttribute("data-shown", "");
    // Folding, it keeps its pills to fold away with, but they are no longer
    // stops: an index the selection can name is the list's row alone, so the
    // list scrolls to the row, not to a hidden pill holding its number.
    await expect(tray.locator("[data-index]")).toHaveCount(0);

    // A port's first digits, then ⇥: the field shows the app, ↵ opens it.
    await input.fill(String(storybook).slice(0, 3));
    await expect(tray).toHaveAttribute("data-shown", "");
    await expect.poll(async () => (await pillPorts(shell)).includes(storybook)).toBe(true);
    await input.fill(`:${storybook}`);
    await expect.poll(() => pillPorts(shell)).toEqual([storybook]);
    await shell.keyboard.press("Tab");
    await expect(shell.locator(`[data-testid="local-app"][data-port="${storybook}"]`)).toHaveAttribute("data-selected", "");
    await expect(input).toHaveValue(`http://localhost:${storybook}/`);
    await capturePalette(app, shell, "3b-typing-picked.png");
    // ⇥ past the last pill comes round to what was typed.
    await shell.keyboard.press("Tab");
    await expect(shell.locator('[data-testid="local-app"][data-selected]')).toHaveCount(0);
    await expect(input).toHaveValue(`:${storybook}`);
    await shell.keyboard.press("Shift+Tab");
    await expect(input).toHaveValue(`http://localhost:${storybook}/`);
    await shell.keyboard.press("Enter");
    await expect.poll(() => activeUrl(shell)).toBe(`http://localhost:${storybook}/`);
  });

  test("a dozen apps, four of them one project's: one pill per project, one line that scrolls", async () => {
    test.setTimeout(120_000);
    more = await startLocalApps(MANY);
    await lookAt(app, shell, more.ports);
    await shell.evaluate(() => (window as unknown as Api).pistachio.createTab("pistachio://demo/invoices"));
    await shell.keyboard.press("Meta+L");
    const input = shell.getByTestId("address-input");
    await expect(input).toBeFocused();
    await expect(shell.getByTestId("local-app")).toHaveCount(12);
    const marius = shell.getByRole("group", { name: "marius", exact: true });
    await expect(marius.getByTestId("local-app")).toHaveCount(4);
    await expect(marius).toContainText(/^marius\s*\d+\d+\d+\d+$/u);
    // Never a second line: the strip is one pill tall, and what does not fit is scrolled to.
    const strip = shell.getByRole("group", { name: "Running on this Mac" });
    const fits = () => strip.evaluate((node) => ({ height: node.clientHeight, overflows: node.scrollWidth > node.clientWidth, left: node.scrollLeft }));
    expect((await fits()).height).toBeLessThanOrEqual(28);
    expect((await fits()).overflows).toBe(true);
    // The fade says there is more; the count, how much.
    await expect(shell.getByTestId("local-tray-more")).toHaveText(/^\+\d+$/u);
    await capturePalette(app, shell, "4-many.png", 1300);

    // A click on the count scrolls the strip on, and the keyboard stays the
    // field's: what is typed next, and the arrows, still work the bar.
    const scrolledFrom = (await fits()).left;
    await shell.getByTestId("local-tray-more").click();
    await expect.poll(async () => (await fits()).left).toBeGreaterThan(scrolledFrom);
    await expect(input).toBeFocused();

    await shell.keyboard.press("Tab");
    await shell.keyboard.press("ArrowRight");
    await shell.keyboard.press("ArrowRight");
    await capturePalette(app, shell, "4b-many-group-port.png");
    for (let step = 0; step < 12; step++) await shell.keyboard.press("ArrowRight");
    await expect(shell.getByTestId("local-app").last()).toHaveAttribute("data-selected", "");
    await expect.poll(async () => (await fits()).left).toBeGreaterThan(0);
    await expect(shell.getByTestId("local-tray-more")).toHaveCount(0);
    await capturePalette(app, shell, "4c-many-scrolled.png", 450);

    // Typing a project's name narrows to its pill; a port's digits to one port of it.
    await input.fill("marius");
    await expect(shell.getByTestId("local-app")).toHaveCount(4);
    await shell.keyboard.press("Escape");
  });

  test("dark", async () => {
    test.skip(!captureEnabled, "only a picture to look at");
    await shell.evaluate(() => (window as unknown as Api).pistachio.updateSettings({ appearance: { scheme: "dark" } }));
    await lookAt(app, shell, servers.ports);
    await shell.keyboard.press("Meta+L");
    await expect(shell.getByTestId("address-input")).toBeFocused();
    await expect(shell.getByTestId("local-app")).toHaveCount(6);
    await capturePalette(app, shell, "5-browse-dark.png", 1300);
    await shell.keyboard.press("ArrowDown");
    await shell.keyboard.press("ArrowRight");
    await capturePalette(app, shell, "5b-selected-dark.png");
    await shell.keyboard.press("Escape");
    await shell.evaluate(() => (window as unknown as Api).pistachio.updateSettings({ appearance: { scheme: "light" } }));
  });
});
