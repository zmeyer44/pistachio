import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/duplicate-tab");

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      executableSuffix,
    ),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

test("a tab duplicates from its context menu, and self-drops split with a fresh copy", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-duplicate-tab-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const snapshot = () =>
      shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot());

    const before = await snapshot();
    const original = before.tabs[0];
    if (original === undefined) throw new Error("no starting tab");
    await expect(shell.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(1);

    // "Duplicate tab" in the row's context menu opens a second tab on the
    // same page, right beside the original, and hands it the focus.
    await shell.getByTestId("sidebar-tab-list").getByTestId("human-tab").first().click({ button: "right" });
    await captureShell(app, "01-context-menu.png");
    await shell.getByRole("menuitem", { name: "Duplicate tab" }).or(shell.getByRole("button", { name: "Duplicate tab" })).click();
    await expect(shell.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(2);
    const afterMenu = await snapshot();
    expect(afterMenu.tabs).toHaveLength(2);
    const menuCopy = afterMenu.tabs.find((tab) => tab.id !== original.id);
    if (menuCopy === undefined) throw new Error("no duplicate tab appeared");
    expect(menuCopy.url).toBe(original.url);
    expect(afterMenu.activeTabId).toBe(menuCopy.id);
    await captureShell(app, "02-duplicated-from-menu.png");

    // "Open in split view" on the ACTIVE tab — like dropping it onto its own
    // surface (both commit splitWith with the tab's own id) — splits it with
    // a fresh copy instead of pulling in the other, unrelated tab.
    await shell.locator(`[data-testid="human-tab"][data-tab-id="${menuCopy.id}"]`).click({ button: "right" });
    await shell.getByRole("menuitem", { name: "Open in split view" }).or(shell.getByRole("button", { name: "Open in split view" })).click();
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    const afterSelfSplit = await snapshot();
    expect(afterSelfSplit.tabs).toHaveLength(3);
    const splitCopy = afterSelfSplit.tabs.find(
      (tab) => tab.id !== original.id && tab.id !== menuCopy.id,
    );
    if (splitCopy === undefined) throw new Error("the self-drop created no duplicate");
    expect(splitCopy.url).toBe(menuCopy.url);
    expect(afterSelfSplit.splitGroups).toHaveLength(1);
    expect(afterSelfSplit.splitGroups[0]?.tabIds).toEqual([menuCopy.id, splitCopy.id]);
    // The unrelated first tab stayed out of the split.
    expect(afterSelfSplit.splitGroups[0]?.tabIds).not.toContain(original.id);
    await captureShell(app, "03-self-drop-split-with-copy.png");

    // A second self-drop grows the same group with another copy on the
    // dropped edge rather than replacing a pane.
    const activeId = afterSelfSplit.activeTabId;
    if (activeId === null) throw new Error("no active tab after the self split");
    await shell.evaluate(
      (tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(tabId, "left"),
      activeId,
    );
    const afterSecond = await snapshot();
    expect(afterSecond.tabs).toHaveLength(4);
    const group = afterSecond.splitGroups[0];
    if (group === undefined) throw new Error("the split group dissolved");
    expect(group.tabIds).toHaveLength(3);
    expect(group.tabIds[0]).not.toBe(activeId);
    expect(group.tabIds).toContain(activeId);
    await captureShell(app, "04-second-self-drop-grows-group.png");
  } finally {
    await app.close();
  }
});
