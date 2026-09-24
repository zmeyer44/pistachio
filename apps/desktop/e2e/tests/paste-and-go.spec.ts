import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellPage } from "./windows";

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      suffix,
    ),
  ].find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

function activeUrl(shell: Page): Promise<string | null> {
  return shell.evaluate(async () => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    const current = await api.getSnapshot();
    return current.tabs.find((tab) => tab.id === current.activeTabId)?.url ?? null;
  });
}

/**
 * Open the overlay and wait for main's palette inventory — which carries
 * the clipboard's verdict — to have landed, so a missing row means "not
 * offered", never "not yet".
 */
async function openBrowsing(shell: Page): Promise<void> {
  await shell.keyboard.press("Meta+L");
  await expect(shell.getByTestId("address-input")).toBeFocused();
  await shell.evaluate(() =>
    (window as unknown as { pistachio: PistachioApi }).pistachio.getCommandPalette(),
  );
  await shell.waitForTimeout(250);
}

test("the address overlay offers the clipboard's URL first, as Paste and Go", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-paste-and-go-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst()));
  const app: ElectronApplication = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: {
      ...process.env,
      PISTACHIO_E2E: "1",
      PISTACHIO_USER_DATA: userData,
    },
  });

  // This drives the machine's real clipboard; put back what it held.
  const previous = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const target = "pistachio://demo/invoices?paste-and-go";

    // A copied address is the first row, the first stop on ↓, and ↵ goes there.
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), target);
    await openBrowsing(shell);
    const row = shell.getByTestId("paste-and-go");
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-index", "0");
    await expect(row).toContainText("Paste and Go");
    await expect(row).toContainText("demo/invoices?paste-and-go");
    await shell.keyboard.press("ArrowDown");
    await expect(row).toHaveClass(/bg-alpha-200/);
    await shell.keyboard.press("Enter");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect.poll(() => activeUrl(shell)).toBe(target);

    // Already on that page: nothing to paste and go to.
    await openBrowsing(shell);
    await expect(shell.getByTestId("paste-and-go")).toHaveCount(0);
    await shell.keyboard.press("Escape");

    // Copied prose is not an address, and never becomes a search.
    await app.evaluate(({ clipboard }) => clipboard.writeText("invoice policy notes"));
    await openBrowsing(shell);
    await expect(shell.getByTestId("paste-and-go")).toHaveCount(0);
    await shell.keyboard.press("Escape");

    // Typing hides the row: the typed address is the suggestion then.
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), "pistachio://demo/invoices?typed-over");
    await openBrowsing(shell);
    await expect(shell.getByTestId("paste-and-go")).toBeVisible();
    await shell.getByTestId("address-input").fill("keyboard shortcuts");
    await expect(shell.getByTestId("paste-and-go")).toHaveCount(0);
    await shell.keyboard.press("Escape");
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous);
    await app.close();
  }
});
