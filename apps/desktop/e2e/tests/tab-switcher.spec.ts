import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellPage } from "./windows";

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

test("Control–Tab previews and selects the five most recently visited tabs", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-tab-switcher-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst()));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const visited = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const ids: string[] = [];
      for (const url of [
        "pistachio://demo/vendors/atlas-medical?visit=1",
        "pistachio://demo/invoices?visit=2",
        "pistachio://demo/vendors/atlas-medical?visit=3",
        "pistachio://demo/invoices?visit=4",
        "pistachio://demo/vendors/atlas-medical?visit=5",
      ]) {
        await api.createTab(url);
        const active = (await api.getSnapshot()).activeTabId;
        if (active === null) throw new Error("the new tab was not selected");
        ids.push(active);
      }
      return ids;
    });

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("the app window is unavailable");
      window.webContents.focus();
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Control", modifiers: ["control"] });
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers: ["control"] });
    });

    const switcher = shell.getByTestId("tab-switcher");
    await expect(switcher).toBeVisible();
    const options = switcher.getByTestId("tab-switcher-option");
    await expect(options).toHaveCount(5);
    await expect(options.nth(0)).toHaveAttribute("data-tab-id", visited[4]!);
    await expect(options.nth(1)).toHaveAttribute("data-tab-id", visited[3]!);
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    // Count the five page captures, not favicon images that may finish
    // loading inside the labels before this assertion runs.
    await expect(options.locator(".tab-switcher-thumbnail > img")).toHaveCount(5);

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("the app window is unavailable");
      // Electron's synthetic input does not emit modifier-only keyUp events;
      // deliver the same main-to-shell release message that native input emits.
      window.webContents.send("pistachio:tab-switcher-input", { type: "commit" });
    });
    await expect(switcher).toHaveCount(0);
    await expect
      .poll(() =>
        shell.evaluate(async () => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot().then((state) => state.activeTabId)),
      )
      .toBe(visited[3]);
  } finally {
    await app.close();
  }
});

test("closing the active tab returns to the most recently visited tab", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-tab-close-mru-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst()));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const outcome = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const ids: string[] = [];
      for (const url of [
        "pistachio://demo/vendors/atlas-medical?close=1",
        "pistachio://demo/invoices?close=2",
        "pistachio://demo/vendors/atlas-medical?close=3",
      ]) {
        await api.createTab(url);
        const active = (await api.getSnapshot()).activeTabId;
        if (active === null) throw new Error("the new tab was not selected");
        ids.push(active);
      }
      // Visit order is now C > B > A; return to B so C is the previous tab.
      await api.selectTab(ids[1]!);
      await api.closeTab(ids[1]!);
      return { survivorId: ids[2], activeTabId: (await api.getSnapshot()).activeTabId };
    });
    expect(outcome.activeTabId).toBe(outcome.survivorId);
  } finally {
    await app.close();
  }
});
