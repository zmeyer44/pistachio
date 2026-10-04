/**
 * Shields against the real web (docs/shields.md §8): the real lists, fetched
 * from their maintainers, on real pages. Runs only with PISTACHIO_SHIELDS_LIVE=1
 * and a network:
 *
 *   PISTACHIO_SHIELDS_LIVE=1 pnpm playwright test -c e2e/playwright.config.ts shields.live
 *
 * It reports what it saw (the list sizes, and the requests two news front
 * pages lost) — and, with PISTACHIO_E2E_CAPTURE=1, keeps screenshots under
 * e2e/screenshots/shields-live — rather than asserting numbers the web will
 * change tomorrow; the assertions are the floors that must hold.
 */

import { expect, test, type ElectronApplication } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { ShieldsStatus } from "@pistachio/shell-contracts/shields";
import { pageFirst, shellReady } from "./windows";
import { launchApp } from "./app";
import { captureView } from "./pages-harness";

const live = process.env["PISTACHIO_SHIELDS_LIVE"] === "1";
test.skip(!live, "needs PISTACHIO_SHIELDS_LIVE=1 and a network");

function captureTab(app: ElectronApplication, prefix: string, filename: string): Promise<void> {
  return captureView(app, prefix, `shields-live/${filename}`);
}

test("the real lists load, and real pages lose their ads", { tag: ["@site", "@live"] }, async () => {
  test.setTimeout(240_000);
  const { app } = await launchApp({
    settings: pageFirst({ layout: { sidebar: "pinned" }, general: { homeUrl: "https://example.com/" } }),
    env: { PISTACHIO_SHIELDS_FETCH: "1" },
    name: "shields-live",
  });
  try {
    const shell = await shellReady(app);
    const status = () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.shields({ type: "status" })) as Promise<ShieldsStatus>;
    // The first check runs a few seconds after launch; then the engine is rebuilt from what arrived.
    await expect
      .poll(async () => {
        const now = await status();
        return now.engine.state === "ready" && !now.updating && now.engine.networkFilters > 50_000;
      }, { timeout: 120_000, intervals: [1_000] })
      .toBe(true);
    const ready = await status();
    console.log(
      "[shields-live] lists:",
      ready.lists.filter((list) => list.enabled).map((list) => `${list.id}=${String(list.rules)}${list.error === null ? "" : ` (${list.error})`}`).join(", "),
    );
    console.log(`[shields-live] engine: ${String(ready.engine.networkFilters)} network, ${String(ready.engine.cosmeticFilters)} cosmetic`);
    expect(ready.lists.filter((list) => list.enabled && list.state === "ready").length).toBeGreaterThanOrEqual(8);

    const open = async (url: string) => {
      await app.evaluate(async ({ webContents }, target) => {
        const tab = webContents.getAllWebContents().find((contents) => /^(about:|https?:)/.test(contents.getURL()) && !contents.getURL().startsWith("pistachio-app"));
        if (tab === undefined) throw new Error("no tab");
        await tab.loadURL(target).catch(() => undefined);
      }, url);
    };
    const controls = () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getBrowserControls());

    // Ad-heavy front pages: what each lost, and to whom.
    const counts: number[] = [];
    for (const [index, url] of ["https://www.cnn.com/", "https://www.theverge.com/"].entries()) {
      await open(url);
      // A front page's ads arrive for seconds after its load: what they lost is counted after that.
      await new Promise((settle) => setTimeout(settle, 12_000));
      const shields = (await controls()).shields;
      counts.push(shields?.blocked ?? 0);
      console.log(
        `[shields-live] ${url}: ${String(shields?.blocked ?? 0)} blocked; top hosts ${shields?.blockedHosts.slice(0, 8).map((entry) => `${entry.host}×${String(entry.count)}`).join(", ") ?? ""}`,
      );
      await captureTab(app, url.slice(0, -1), `0${String(index + 1)}-${new URL(url).hostname}.png`);
    }
    expect(Math.max(...counts)).toBeGreaterThan(10);
  } finally {
    await app.close();
  }
});
