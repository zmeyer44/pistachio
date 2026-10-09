/**
 * The desk at a glance (docs/spaces.md): the desktop's surface is always up,
 * on main's current space. A quick pass for any desktop change: ⌘T puts a
 * window out in the current space, a tab chosen in another space passes the
 * desk to it and back, and a cold start comes up on the space that was
 * current with its windows where they were. The rest of the desk is
 * desk.spec's and spaces.spec's.
 */

import { expect, test } from "@playwright/test";
import { box, createGroup, launchDesk, openTabs, screenshots, selectSpace, selectTab, settled, snapshot, VENDOR, windowSelector, type Box } from "./desk-harness";

const capture = screenshots("desk-smoke");
const NORTH = "pistachio://demo/invoices?page=north";

test("the desk: ⌘T puts a window out, a tab of another space passes the desk and back, and a cold start comes back on its windows", { tag: ["@desk", "@smoke"] }, async () => {
  test.setTimeout(90_000);
  let { app, shell, userData } = await launchDesk({ name: "smoke" });
  try {
    // ── 1. Up from the first frame, on the current space: its one tab, its window filling the desk ─
    const home = (await snapshot(shell)).activeTabId!;
    const current = (await snapshot(shell)).currentGroupId!;
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${current}"]`)).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    expect(Math.round((await box(shell, windowSelector(home))).width)).toBe(Math.round(stage.width));

    // ── 2. ⌘T: a new tab in the current space, out as the window in use ─
    await createGroup(shell, "smoke", [home], "Smoke", "green");
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe("smoke");
    await shell.keyboard.press("Meta+t");
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "smoke")?.tabIds.length).toBe(2);
    const made = (await snapshot(shell)).tabGroups.find((group) => group.id === "smoke")!.tabIds.find((tabId) => tabId !== home)!;
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(made);
    await shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.5);
    await settled(shell, app);
    const left: Record<string, Box> = { [home]: await box(shell, windowSelector(home)), [made]: await box(shell, windowSelector(made)) };
    await capture(app, shell, "01-cmd-t.png");

    // ── 3. A tab of another space chosen: the desk passes to it; the space chosen again, its windows come back ─
    const [north] = (await openTabs(shell, [NORTH, VENDOR])) as [string, string];
    await selectTab(shell, north);
    await expect(shell.locator('.desk-stage[data-phase="open"]:not([data-group-id="smoke"])')).toHaveCount(1);
    await expect(shell.locator(windowSelector(north))).toHaveCount(1);
    await expect(shell.locator(windowSelector(home))).toHaveCount(0);
    await settled(shell, app);
    await capture(app, shell, "02-passed.png");
    await selectSpace(shell, "smoke");
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);
    for (const tabId of [home, made]) {
      const now = await box(shell, windowSelector(tabId));
      for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(now[key] - left[tabId]![key])).toBeLessThan(3);
    }

    // ── 4. A cold start: on the space that was current, its windows where they were ─
    await expect
      .poll(() => shell.evaluate(() => (JSON.parse(localStorage.getItem("pistachio.desk.v1") ?? "{}") as { saved?: Record<string, { windows: unknown[] }> }).saved?.["smoke"]?.windows.length ?? 0))
      .toBe(2);
    await app.close();
    ({ app, shell, userData } = await launchDesk({ name: "smoke", userData }));
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe("smoke");
    await expect(shell.locator('.desk-stage[data-phase="open"][data-group-id="smoke"]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);
    for (const tabId of [home, made]) {
      const now = await box(shell, windowSelector(tabId));
      for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(now[key] - left[tabId]![key])).toBeLessThan(3);
    }
    await capture(app, shell, "03-cold-start.png");
  } finally {
    await app.close();
  }
});
