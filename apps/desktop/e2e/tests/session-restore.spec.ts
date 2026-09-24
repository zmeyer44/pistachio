import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

async function launch(executablePath: string, userData: string): Promise<{ app: ElectronApplication; shell: Page }> {
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  const shell = await shellPage(app);
  await shell.waitForLoadState("domcontentloaded");
  return { app, shell };
}

function snapshot(shell: Page): Promise<ShellSnapshot> {
  return shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot());
}

test("human tabs and split groups restore durably while background tabs remain suspended", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-session-restore-"));
  let current: ElectronApplication | null = null;
  try {
    let launched = await launch(executablePath, userData);
    current = launched.app;
    let state = await snapshot(launched.shell);
    const first = state.activeTabId;
    if (first === null) throw new Error("initial tab unavailable");

    await launched.shell.evaluate(
      (url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url),
      "pistachio://demo/vendors/atlas-medical",
    );
    state = await snapshot(launched.shell);
    const second = state.activeTabId;
    if (second === null || second === first) throw new Error("second tab unavailable");

    await launched.shell.evaluate(
      (url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url),
      "pistachio://demo/invoices?restored=background",
    );
    state = await snapshot(launched.shell);
    const background = state.activeTabId;
    if (background === null || background === second) throw new Error("background tab unavailable");

    await launched.shell.evaluate(
      ({ secondId, firstId }) =>
        (window as unknown as { pistachio: PistachioApi }).pistachio
          .selectTab(secondId)
          .then(() => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(firstId, "right")),
      { secondId: second, firstId: first },
    );
    await launched.shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.suspendTab(tabId), background);
    state = await snapshot(launched.shell);
    expect(state).toMatchObject({
      activeTabId: second,
      secondaryTabId: first,
      splitMode: "vertical",
    });
    expect(state.tabs.find((tab) => tab.id === background)?.lifecycle).toBe("suspended");
    await launched.app.close();
    current = null;

    launched = await launch(executablePath, userData);
    current = launched.app;
    state = await snapshot(launched.shell);
    expect(state.tabs.map((tab) => tab.id)).toEqual([first, second, background]);
    expect(state).toMatchObject({
      activeTabId: second,
      secondaryTabId: first,
      splitMode: "vertical",
    });
    expect(state.tabs.find((tab) => tab.id === first)?.lifecycle).toBe("live");
    expect(state.tabs.find((tab) => tab.id === second)?.lifecycle).toBe("live");
    expect(state.tabs.find((tab) => tab.id === background)?.lifecycle).toBe("suspended");
    await expect(launched.shell.getByLabel("Sleeping")).toHaveCount(1);

    await launched.shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), background);
    await expect.poll(async () => (await snapshot(launched.shell)).activeTabId).toBe(background);
    expect((await snapshot(launched.shell)).tabs.find((tab) => tab.id === background)?.lifecycle).toBe("live");
    await launched.app.close();
    current = null;

    launched = await launch(executablePath, userData);
    current = launched.app;
    state = await snapshot(launched.shell);
    expect(state.activeTabId).toBe(background);
    expect(state.tabs.find((tab) => tab.id === background)?.lifecycle).toBe("live");
    expect(state.tabs.find((tab) => tab.id === first)?.lifecycle).toBe("suspended");
    expect(state.tabs.find((tab) => tab.id === second)?.lifecycle).toBe("suspended");
    expect(state.splitGroups).toEqual([
      expect.objectContaining({
        primaryTabId: second,
        secondaryTabId: first,
        mode: "vertical",
      }),
    ]);
    await expect(launched.shell.getByLabel("Sleeping")).toHaveCount(2);
  } finally {
    if (current !== null) await current.close();
  }
});
