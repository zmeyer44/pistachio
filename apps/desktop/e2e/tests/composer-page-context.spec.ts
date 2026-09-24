/**
 * The page in view is attached to a console message unless the person
 * dismisses it (docs/console-routing.md §5.1): the composer's chip carries
 * an X for a web page, dismissing strikes the page through and offers
 * "Attach", what is sent says which, and another page attaches again.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { IPC, type PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/composer-page-context");

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", executableSuffix)];
  return candidates.find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function captureShell(app: ElectronApplication, shell: Page, filename: string): Promise<void> {
  await shell.evaluate(() => new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted))));
  await shell.waitForTimeout(150);
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const title = path === "/guidelines" ? "Brand Guidelines" : path === "/pricing" ? "Pricing" : null;
    if (title === null) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>Typography: use Inter at 16px.</p></body></html>`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

test("the page in view is attached to a message until the person dismisses it", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-composer-page-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({
      layout: { mode: "sidebar", sidebar: "pinned" },
      general: { consoleOpenOnLaunch: true, homeUrl: `${origin}/guidelines` },
    }),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);
    // What reaches main: the composer's sends are recorded, not run.
    await app.evaluate(({ ipcMain }, channels) => {
      const sent: unknown[][] = [];
      (globalThis as unknown as { sent: unknown[][] }).sent = sent;
      ipcMain.removeHandler(channels.start);
      ipcMain.handle(channels.start, (_event, ...args: unknown[]) => void sent.push(args));
    }, { start: IPC.runStart });
    const sent = (): Promise<unknown[][]> => app.evaluate(() => (globalThis as unknown as { sent: unknown[][] }).sent);

    const chip = shell.getByTestId("composer-context");
    await expect(chip).toHaveText("Brand Guidelines");
    await expect(chip).toHaveAttribute("data-page-attached", "true");
    const dismiss = shell.getByTestId("composer-context-dismiss");
    await expect(dismiss).toBeVisible();
    await captureShell(app, shell, "01-page-attached.png");

    // Attached: the message goes with the page.
    await shell.getByTestId("delegation-intent").fill("does this mention rules around typography?");
    await shell.getByTestId("delegation-intent").press("Enter");
    await expect.poll(async () => (await sent()).at(-1)?.[2]).toEqual({ page: true });

    // Dismissed: struck through, "Attach" offered, and the message goes without it.
    await dismiss.click();
    await expect(chip).toHaveAttribute("data-page-attached", "false");
    await expect(shell.getByTestId("composer-context-attach")).toBeVisible();
    await captureShell(app, shell, "02-page-dismissed.png");
    await shell.getByTestId("delegation-intent").fill("what is a hash map?");
    await shell.getByTestId("delegation-intent").press("Enter");
    await expect.poll(async () => (await sent()).at(-1)?.[2]).toEqual({ page: false });

    // "Attach" undoes it.
    await shell.getByTestId("composer-context-attach").click();
    await expect(chip).toHaveAttribute("data-page-attached", "true");

    // A dismissal belongs to its page: another page is attached again.
    await dismiss.click();
    await expect(chip).toHaveAttribute("data-page-attached", "false");
    await shell.evaluate((url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url), `${origin}/pricing`);
    await expect(chip).toHaveText("Pricing");
    await expect(chip).toHaveAttribute("data-page-attached", "true");
  } finally {
    await app.close();
  }
});
