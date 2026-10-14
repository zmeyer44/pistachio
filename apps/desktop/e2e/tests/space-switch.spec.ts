/**
 * Switching spaces end to end (Settings → General → Switching spaces;
 * docs/desk.md): by default the windows of the space left bloom away where
 * they stand, once main's stills of their live pages are up, and the chosen
 * space's sharpen in at their places, then are live pages again. Set to Into
 * its icon, they fly into the space's tile as every switch did before, and
 * Arriving windows stands aside.
 *
 * What only the real app has is proved here: live pages handing over to
 * their stills and back, and the setting reaching the desk. The poses
 * themselves are space-switch.test's and desk-engine.test's.
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chooseSpace, createGroup, INVOICES, launchDesk, openTabs, selectTab, settled, VENDOR, windowSelector } from "./desk-harness";

/** What a desk window was seen to be at each change of its style or its flight while recording. */
interface Seen {
  tabId: string;
  flight: string | null;
  switching: boolean;
  filter: string;
}

/** Note every desk window's flight, pose and filter as they change, from now until the recording is read. */
async function record(shell: Page): Promise<void> {
  await shell.evaluate(() => {
    const seen: Seen[] = [];
    const observer = new MutationObserver((changes) => {
      for (const change of changes) {
        const el = change.target;
        if (!(el instanceof HTMLElement) || el.dataset["testid"] !== "desk-window") continue;
        seen.push({ tabId: el.dataset["tabId"] ?? "", flight: el.dataset["flight"] ?? null, switching: el.dataset["switching"] !== undefined, filter: el.style.filter });
      }
    });
    observer.observe(document.querySelector(".desk-stage")!, { subtree: true, attributes: true, attributeFilter: ["style", "data-flight", "data-switching"] });
    (window as unknown as { switchSeen: () => Seen[] }).switchSeen = () => {
      observer.disconnect();
      return seen;
    };
  });
}

const recorded = (shell: Page): Promise<Seen[]> => shell.evaluate(() => (window as unknown as { switchSeen: () => Seen[] }).switchSeen());

test.describe.serial("switching spaces", { tag: ["@desk", "@sidebar", "@settings"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let north: string, south: string, vendor: string, east: string;

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({ name: "space-switch" }));
    [north, south, vendor, east] = (await openTabs(shell, [`${INVOICES}?page=north`, `${INVOICES}?page=south`, VENDOR, `${INVOICES}?page=east`])) as [string, string, string, string];
    await createGroup(shell, "sw-ledger", [north, south], "Ledger", "blue");
    await createGroup(shell, "sw-vendors", [vendor, east], "Vendors", "green");
    // Two windows out on each space's desk.
    await chooseSpace(shell, "sw-vendors");
    await selectTab(shell, east);
    await selectTab(shell, vendor);
    await settled(shell, app);
    await chooseSpace(shell, "sw-ledger");
    await selectTab(shell, south);
    await selectTab(shell, north);
    await settled(shell, app);
    await expect(shell.locator(`${windowSelector(north)}, ${windowSelector(south)}`)).toHaveCount(2);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("by default the windows left bloom away where they stand, and the chosen space's sharpen in at their places, live again once in", async () => {
    await record(shell);
    await chooseSpace(shell, "sw-vendors");
    await settled(shell, app);
    const seen = await recorded(shell);
    // The ledger's windows went as their stills, posed, blurring as they went.
    for (const tabId of [north, south]) expect(seen.some((change) => change.tabId === tabId && change.flight === "away" && change.switching && change.filter.startsWith("blur("))).toBe(true);
    // The vendors' came in posed at their places, never out of the tile.
    for (const tabId of [vendor, east]) expect(seen.some((change) => change.tabId === tabId && change.flight === "in" && change.switching)).toBe(true);
    await expect(shell.locator(`${windowSelector(north)}, ${windowSelector(south)}`)).toHaveCount(0);
    await expect(shell.locator('[data-testid="desk-window"][data-switching]')).toHaveCount(0);
    // Their pages are live again, nothing of the pose left on them.
    await expect(shell.locator(`${windowSelector(vendor)}:not([data-drawn])`)).toHaveCount(1);
    for (const tabId of [vendor, east]) {
      expect(await shell.locator(windowSelector(tabId)).evaluate((el: HTMLElement) => [el.style.opacity, el.style.filter])).toEqual(["", ""]);
    }
  });

  test("Into its icon flies them into the space's tile as before, and Arriving windows stands aside", async () => {
    await shell.keyboard.press("Meta+,");
    const settings = shell.getByTestId("settings-page");
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "General", exact: true }).click();
    await expect(settings.getByTestId("space-switch-exit")).toHaveValue("bloom");
    await expect(settings.getByTestId("space-switch-arrival")).toHaveValue("matched");
    await settings.getByTestId("space-switch-exit").selectOption("tile");
    await expect(settings.getByTestId("space-switch-arrival")).toBeDisabled();
    await expect(settings.getByTestId("space-switch-arrival")).toHaveValue("tile");
    await shell.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    await record(shell);
    await chooseSpace(shell, "sw-ledger");
    await settled(shell, app);
    const seen = await recorded(shell);
    expect(seen.some((change) => (change.tabId === vendor || change.tabId === east) && change.flight === "away")).toBe(true);
    expect(seen.some((change) => change.switching)).toBe(false);
    await expect(shell.locator(`${windowSelector(north)}:not([data-drawn])`)).toHaveCount(1);
  });
});
