import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi, SplitMode } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellPage } from "./windows";

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", executableSuffix),
  ];
  return candidates.find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

function visibleTabBoxes(app: ElectronApplication): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.contentView.children
      .filter((child) => {
        if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return false;
        return !Object.values(hashes).some((hash) => (child as WebContentsView).webContents.getURL().endsWith(hash));
      })
      .map((child) => (child as WebContentsView).getBounds());
  }, CHROME_VIEW_HASHES);
}

function axisCount(boxes: Array<{ x: number; y: number }>, axis: "x" | "y"): number {
  const values: number[] = [];
  for (const box of boxes) if (!values.some((value) => Math.abs(value - box[axis]) <= 2)) values.push(box[axis]);
  return values.length;
}

async function expectNativeLayout(app: ElectronApplication, mode: SplitMode): Promise<void> {
  await expect.poll(async () => {
    const boxes = await visibleTabBoxes(app);
    return {
      count: boxes.length,
      columns: axisCount(boxes, "x"),
      rows: axisCount(boxes, "y"),
    };
  }).toEqual(
    mode === "grid"
      ? { count: 4, columns: 2, rows: 2 }
      : mode === "vertical"
        ? { count: 4, columns: 4, rows: 1 }
        : { count: 4, columns: 1, rows: 4 },
  );
}

test("a split group grows to four panes and switches between grid, vertical, and horizontal layouts", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-four-pane-"));
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
    const ids = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      for (const name of ["B", "C", "D"]) await api.createTab(`pistachio://demo/invoices?pane=${name}`);
      const tabIds = (await api.getSnapshot()).tabs.map((tab) => tab.id);
      const [a, b, c, d] = tabIds;
      if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error("four tabs were not created");
      await api.selectTab(a);
      await api.splitWith(b, "right");
      await api.splitWith(c, "bottom");
      return [a, b, c, d];
    });

    await expect(shell.locator("[data-split-pane]")).toHaveCount(3);
    await expect.poll(() => shell.evaluate(async () => {
      const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
      return {
        mode: snapshot.splitMode,
        visible: snapshot.visibleTabIds,
        gridLayout: snapshot.splitGroups[0]?.gridLayout,
      };
    })).toEqual({ mode: "grid", visible: ids.slice(0, 3), gridLayout: "span-bottom" });
    const threePaneBoxes = await shell.locator("[data-split-pane]").evaluateAll((panes) => panes.map((pane) => {
      const rect = pane.getBoundingClientRect();
      return { tabId: (pane as HTMLElement).dataset["tabId"], x: rect.x, y: rect.y, width: rect.width };
    }));
    const top = threePaneBoxes.slice(0, 2);
    const bottom = threePaneBoxes[2];
    if (bottom === undefined) throw new Error("the spanning bottom pane is unavailable");
    expect(bottom.y).toBeGreaterThan(Math.max(...top.map((pane) => pane.y)) + 20);
    expect(bottom.width).toBeGreaterThan(top.reduce((width, pane) => Math.max(width, pane.width), 0) * 1.8);
    await expect.poll(() => visibleTabBoxes(app).then((boxes) => boxes.length)).toBe(3);

    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(tabId, "right"), ids[3]!);
    await expect(shell.locator("[data-split-pane]")).toHaveCount(4);
    await expect.poll(() => shell.evaluate(async () => {
      const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
      return { mode: snapshot.splitMode, visible: snapshot.visibleTabIds, group: snapshot.splitGroups[0]?.tabIds };
    })).toEqual({ mode: "grid", visible: ids, group: ids });
    await expectNativeLayout(app, "grid");

    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.setSplit("vertical"));
    await expectNativeLayout(app, "vertical");

    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.setSplit("horizontal"));
    await expectNativeLayout(app, "horizontal");

    // Closing one pane contracts the group instead of dissolving the other
    // three or borrowing an unrelated tab to fill the vacancy.
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId), ids[3]!);
    await expect(shell.locator("[data-split-pane]")).toHaveCount(3);
    await expect.poll(() => shell.evaluate(async () => {
      const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
      return { visible: snapshot.visibleTabIds, group: snapshot.splitGroups[0]?.tabIds };
    })).toEqual({ visible: ids.slice(0, 3), group: ids.slice(0, 3) });
    await expect.poll(() => visibleTabBoxes(app).then((boxes) => boxes.length)).toBe(3);
  } finally {
    await app.close();
  }
});
