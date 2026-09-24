import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi, SplitMode } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/split-groups");

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

/** Wait for the native tab views to catch up with the renderer's reported pane boxes. */
function visibleTabLayout(app: ElectronApplication): Promise<SplitMode | "unknown"> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const views = window.contentView.children
      .filter((child) => {
        if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return false;
        const url = (child as WebContentsView).webContents.getURL();
        return !Object.values(hashes).some((hash) => url.endsWith(hash));
      })
      .map((child) => (child as WebContentsView).getBounds());
    if (views.length === 1) return "single";
    const [first, second] = views;
    if (first === undefined || second === undefined || views.length !== 2) return "unknown";
    if (Math.abs(first.x - second.x) > 2) return "vertical";
    if (Math.abs(first.y - second.y) > 2) return "horizontal";
    return "unknown";
  }, CHROME_VIEW_HASHES);
}

async function expectLayoutSettled(
  shell: Page,
  app: ElectronApplication,
  mode: SplitMode,
): Promise<void> {
  // Snapshot delivery, React layout, and the fire-and-forget layout IPC are
  // three ordered stages. Observe two completed paints before capturing.
  await shell.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  if (mode === "single") {
    await expect(shell.getByTestId("secondary-pane")).toHaveCount(0);
  } else {
    await expect(shell.getByRole("separator", { name: "Resize split panes" })).toHaveAttribute(
      "aria-orientation",
      mode,
    );
  }
  await expect.poll(() => visibleTabLayout(app)).toBe(mode);
}

function groupState(shell: Page): Promise<{
  activeTabId: string | null;
  secondaryTabId: string | null;
  splitMode: string;
  groups: string[];
}> {
  return shell.evaluate(async () => {
    const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
    return {
      activeTabId: snapshot.activeTabId,
      secondaryTabId: snapshot.secondaryTabId,
      splitMode: snapshot.splitMode,
      groups: snapshot.splitGroups
        .map((group) => [group.primaryTabId, group.secondaryTabId].sort().join(":"))
        .sort(),
    };
  });
}

test("split pairs remain isolated tab groups while switching among other tabs and pairs", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-split-groups-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify(pageFirst({ layout: { mode: "sidebar", sidebar: "pinned" } })),
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

    // Build A+B, lone C, and D+E through the real controller API. Selection
    // after this point is driven through the rendered sidebar groups.
    const setup = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      for (const name of ["B", "C", "D", "E"]) {
        await api.createTab(`pistachio://demo/invoices?tab=${name}`);
      }
      const [a, b, c, d, e] = (await api.getSnapshot()).tabs.map((tab) => tab.id);
      if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined) {
        throw new Error("five tabs were not created");
      }
      await api.selectTab(a);
      await api.splitWith(b, "right");
      await api.setSplit("horizontal");
      await api.selectTab(c);
      await api.selectTab(d);
      await api.splitWith(e, "right");
      const snapshot = await api.getSnapshot();
      return { ids: { a, b, c, d, e }, groupIds: snapshot.splitGroups.map((group) => group.id) };
    });
    const { a, b, c, d, e } = setup.ids;
    const expectedGroups = [[a, b].sort().join(":"), [d, e].sort().join(":")].sort();
    await expect(shell.locator("[data-split-group-id]")).toHaveCount(2);
    for (const groupId of setup.groupIds) {
      await expect(shell.locator(`[data-split-group-id="split:${groupId}"]`)).toBeVisible();
    }
    await expect.poll(() => groupState(shell)).toEqual({
      activeTabId: d,
      secondaryTabId: e,
      splitMode: "vertical",
      groups: expectedGroups,
    });
    await expectLayoutSettled(shell, app, "vertical");
    await captureShell(app, "01-two-pairs-and-lone-tab.png");

    // The lower split-tab entry represents the right pane in a vertical
    // split. Focusing it must not move either the entry or its page left.
    const secondSplit = shell.locator(`[data-split-group-id]:has([data-tab-id="${d}"])`);
    await secondSplit.locator(`[data-tab-id="${e}"]`).click();
    await expect.poll(() => groupState(shell)).toEqual({
      activeTabId: e,
      secondaryTabId: d,
      splitMode: "vertical",
      groups: expectedGroups,
    });
    await expect(secondSplit.getByRole("tab").first()).toHaveAttribute("data-tab-id", d);
    await expect(secondSplit.getByRole("tab").last()).toHaveAttribute("data-tab-id", e);
    await expect(shell.getByTestId("primary-pane")).toHaveAttribute("data-tab-id", d);
    await expect(shell.getByTestId("secondary-pane")).toHaveAttribute("data-tab-id", e);

    // A lone tab occupies one full pane without dissolving either saved pair.
    await shell.locator(`[data-tab-id="${c}"]`).click();
    await expect.poll(() => groupState(shell)).toEqual({
      activeTabId: c,
      secondaryTabId: null,
      splitMode: "single",
      groups: expectedGroups,
    });
    await expectLayoutSettled(shell, app, "single");
    await captureShell(app, "02-lone-tab-active.png");

    // Selecting either member restores exactly split A, with B unchanged.
    await shell.locator(`[data-tab-id="${a}"]`).click();
    await expect.poll(() => groupState(shell)).toEqual({
      activeTabId: a,
      secondaryTabId: b,
      splitMode: "horizontal",
      groups: expectedGroups,
    });
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await expectLayoutSettled(shell, app, "horizontal");
    await captureShell(app, "03-first-split-restored.png");

    // Focusing the lower half keeps both the split-tab slots and page panes
    // in their saved order. activeTabId follows focus; it no longer means
    // "the tab in the first pane."
    const firstSplit = shell.locator(`[data-split-group-id]:has([data-tab-id="${a}"])`);
    await firstSplit.locator(`[data-tab-id="${b}"]`).click();
    await expect.poll(() => groupState(shell)).toEqual({
      activeTabId: b,
      secondaryTabId: a,
      splitMode: "horizontal",
      groups: expectedGroups,
    });
    await expect(firstSplit.getByRole("tab").first()).toHaveAttribute("data-tab-id", a);
    await expect(firstSplit.getByRole("tab").last()).toHaveAttribute("data-tab-id", b);
    await expect(firstSplit.locator(`[data-tab-id="${b}"]`)).toHaveAttribute("aria-selected", "true");
    await expect(shell.getByTestId("primary-pane")).toHaveAttribute("data-tab-id", a);
    await expect(shell.getByTestId("secondary-pane")).toHaveAttribute("data-tab-id", b);

    // The same lower-half click restores an inactive split without changing
    // its pane order, and focuses the member that was actually clicked.
    await shell.locator(`[data-tab-id="${c}"]`).click();
    await expectLayoutSettled(shell, app, "single");
    await firstSplit.locator(`[data-tab-id="${b}"]`).click();
    await expect.poll(() => groupState(shell)).toEqual({
      activeTabId: b,
      secondaryTabId: a,
      splitMode: "horizontal",
      groups: expectedGroups,
    });
    await expectLayoutSettled(shell, app, "horizontal");
    await expect(firstSplit.getByRole("tab").first()).toHaveAttribute("data-tab-id", a);
    await expect(firstSplit.getByRole("tab").last()).toHaveAttribute("data-tab-id", b);
    await expect(shell.getByTestId("primary-pane")).toHaveAttribute("data-tab-id", a);
    await expect(shell.getByTestId("secondary-pane")).toHaveAttribute("data-tab-id", b);

    // Split D restores as a separate unit; returning to A proves neither
    // selection borrowed a component from the other pair.
    await shell.locator(`[data-tab-id="${d}"]`).click();
    await expect.poll(() => groupState(shell)).toEqual({
      activeTabId: d,
      secondaryTabId: e,
      splitMode: "vertical",
      groups: expectedGroups,
    });
    await expectLayoutSettled(shell, app, "vertical");
    await captureShell(app, "04-second-split-restored.png");
    await shell.locator(`[data-tab-id="${a}"]`).click();
    await expect.poll(() => groupState(shell)).toEqual({
      activeTabId: a,
      secondaryTabId: b,
      splitMode: "horizontal",
      groups: expectedGroups,
    });
    await expectLayoutSettled(shell, app, "horizontal");
    await captureShell(app, "05-first-split-restored-again.png");
  } finally {
    await app.close();
  }
});
