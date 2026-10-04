import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi, SplitMode } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellReady } from "./windows";
import { launchApp } from "./app";
import { captureShell as captureWindowFrame, snapshot, visibleTabViewBoxes } from "./chrome-harness";

function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  return captureWindowFrame(app, "split-groups", filename);
}

/** Wait for the native tab views to catch up with the renderer's reported pane boxes. */
async function visibleTabLayout(app: ElectronApplication): Promise<SplitMode | "unknown"> {
  const views = await visibleTabViewBoxes(app);
  if (views.length === 1) return "single";
  const [first, second] = views;
  if (first === undefined || second === undefined || views.length !== 2) return "unknown";
  if (Math.abs(first.x - second.x) > 2) return "vertical";
  if (Math.abs(first.y - second.y) > 2) return "horizontal";
  return "unknown";
}

function axisCount(boxes: Array<{ x: number; y: number }>, axis: "x" | "y"): number {
  const values: number[] = [];
  for (const box of boxes) if (!values.some((value) => Math.abs(value - box[axis]) <= 2)) values.push(box[axis]);
  return values.length;
}

async function expectNativeLayout(app: ElectronApplication, mode: SplitMode): Promise<void> {
  await expect
    .poll(async () => {
      const boxes = await visibleTabViewBoxes(app);
      return { count: boxes.length, columns: axisCount(boxes, "x"), rows: axisCount(boxes, "y") };
    })
    .toEqual(
      mode === "grid"
        ? { count: 4, columns: 2, rows: 2 }
        : mode === "vertical"
          ? { count: 4, columns: 4, rows: 1 }
          : { count: 4, columns: 1, rows: 4 },
    );
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

// One window, pinned, over a web page: pairs kept apart while other tabs and
// pairs are chosen, then a group grown to four panes in a fresh set of tabs.
test.describe.serial("split groups", { tag: ["@sidebar", "@split"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    ({ app } = await launchApp({ settings: pageFirst({ layout: { sidebar: "pinned" } }), name: "split-groups" }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("split pairs remain isolated tab groups while switching among other tabs and pairs", { tag: ["@smoke"] }, async () => {
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
  });

  test("a split group grows to four panes and switches between grid, vertical, and horizontal layouts", async () => {
    // Four tabs of its own, apart from the pairs above.
    const ids = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const tabIds: string[] = [];
      for (const name of ["A", "B", "C", "D"]) {
        await api.createTab(`pistachio://demo/invoices?pane=${name}`);
        const active = (await api.getSnapshot()).activeTabId;
        if (active === null) throw new Error("the new tab was not selected");
        tabIds.push(active);
      }
      const [a, b, c] = tabIds;
      await api.selectTab(a!);
      await api.splitWith(b!, "right");
      await api.splitWith(c!, "bottom");
      return tabIds;
    });
    const group = async () => (await snapshot(shell)).splitGroups.find((candidate) => candidate.tabIds.includes(ids[0]!));

    await expect(shell.locator("[data-split-pane]")).toHaveCount(3);
    await expect
      .poll(async () => {
        const state = await snapshot(shell);
        return { mode: state.splitMode, visible: state.visibleTabIds, gridLayout: (await group())?.gridLayout };
      })
      .toEqual({ mode: "grid", visible: ids.slice(0, 3), gridLayout: "span-bottom" });
    const threePaneBoxes = await shell.locator("[data-split-pane]").evaluateAll((panes) =>
      panes.map((pane) => {
        const rect = pane.getBoundingClientRect();
        return { tabId: (pane as HTMLElement).dataset["tabId"], x: rect.x, y: rect.y, width: rect.width };
      }),
    );
    const top = threePaneBoxes.slice(0, 2);
    const bottom = threePaneBoxes[2];
    if (bottom === undefined) throw new Error("the spanning bottom pane is unavailable");
    expect(bottom.y).toBeGreaterThan(Math.max(...top.map((pane) => pane.y)) + 20);
    expect(bottom.width).toBeGreaterThan(top.reduce((width, pane) => Math.max(width, pane.width), 0) * 1.8);
    await expect.poll(() => visibleTabViewBoxes(app).then((boxes) => boxes.length)).toBe(3);

    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(tabId, "right"), ids[3]!);
    await expect(shell.locator("[data-split-pane]")).toHaveCount(4);
    await expect
      .poll(async () => {
        const state = await snapshot(shell);
        return { mode: state.splitMode, visible: state.visibleTabIds, group: (await group())?.tabIds };
      })
      .toEqual({ mode: "grid", visible: ids, group: ids });
    await expectNativeLayout(app, "grid");

    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.setSplit("vertical"));
    await expectNativeLayout(app, "vertical");

    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.setSplit("horizontal"));
    await expectNativeLayout(app, "horizontal");

    // Closing one pane contracts the group instead of dissolving the other
    // three or borrowing an unrelated tab to fill the vacancy.
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId), ids[3]!);
    await expect(shell.locator("[data-split-pane]")).toHaveCount(3);
    await expect
      .poll(async () => ({ visible: (await snapshot(shell)).visibleTabIds, group: (await group())?.tabIds }))
      .toEqual({ visible: ids.slice(0, 3), group: ids.slice(0, 3) });
    await expect.poll(() => visibleTabViewBoxes(app).then((boxes) => boxes.length)).toBe(3);
  });
});