/**
 * The desk's smart layout end to end (docs/desk-layout.md): a window that
 * comes out, one that leaves, and ⌘⌥L each ask the layout model about the
 * desk, and the desk lays itself out as the model judged — with a notice
 * whose Undo puts it back — or, with the Feel's Layout set to By hand, stays
 * as it is (that is desk-smart-layout.test's).
 *
 * The model is scripted (PISTACHIO_LAYOUT_SCRIPT, main/desk-layout.ts): the
 * real evaluator, IPC hop, policy and geometry run over it, and the answers
 * are stated here. The pages are a local server's, so every window has a
 * title of its own for the script to name.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { noticePage } from "./windows";
import { box, createGroup, launchDesk, selectSpace, openMore, openTabs, rowSelector, screenshots, selectTab, settled, snapshot, windowSelector, type Box } from "./desk-harness";

const capture = screenshots("desk-layout");
const GAP = 8;

/** Pages with titles of their own. */
const PAGES: Record<string, string> = {
  "/budget": "Q3 budget - Sheets",
  "/inbox": "Inbox - Mail",
  "/invoice": "Invoice #2048 - Atlas Medical Supply",
  "/vendor": "Atlas Medical Supply - Vendor record",
};

function serve(): Promise<Server> {
  const server = createServer((request, response) => {
    const title = PAGES[request.url ?? ""] ?? "Page";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${title}</title><body style="font:16px system-ui;margin:24px"><h1>${title}</h1></body>`);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

test("a window coming out, one leaving, and ⌘⌥L lay the desk out as the layout model judges, with Undo", { tag: ["@desk", "@notices"] }, async () => {
  test.setTimeout(90_000);
  const server = await serve();
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const urls = ["/budget", "/inbox", "/invoice", "/vendor"].map((path) => `${origin}${path}`);
  const { app, shell } = await launchDesk({
    name: "layout",
    homeUrl: urls[0],
    env: {
      // The model's answers, by what happened: a window just out goes beside the invoice; a gap is closed up; asked, the budget is the main work.
      PISTACHIO_LAYOUT_SCRIPT: JSON.stringify({
        opened: { move: "pair", partner: "Invoice #2048" },
        closed: { move: "fill" },
        asked: { move: "focus", main: "Q3 budget" },
      }),
    },
  });
  try {
    const notices = await noticePage(app);
    await openTabs(shell, urls.slice(1));
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url) && tab.title !== "").length).toBe(urls.length);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const [budget, inbox, invoice, vendor] = urls.map((url) => byUrl.get(url)!) as [string, string, string, string];
    await createGroup(shell, "desk-layout", [budget, inbox, invoice, vendor], "Accounts", "orange");
    await selectTab(shell, budget);
    await selectSpace(shell, "desk-layout");
    await expect(shell.locator('[data-testid="tab-group"] [role="tab"]')).toHaveCount(4);
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const awayFromDock = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.95);
    // Two more windows out (nothing for the model to move: the script's partner is not out yet, or is the window itself), then tiled.
    for (const tabId of [inbox, invoice]) {
      await shell.locator(rowSelector(tabId)).click();
      await expect(shell.locator(windowSelector(tabId))).toHaveCount(1);
    }
    await awayFromDock();
    await settled(shell, app);
    await openMore(shell);
    await expect(shell.getByTestId("desk-arrange")).toContainText("⌘⌥L");
    await shell.getByTestId("desk-tile").click();
    await awayFromDock();
    await settled(shell, app);

    // The desk in its own terms: the whole card beside the sidebar (the Bar's notch lies over its foot).
    const left = stage.x;
    const top = stage.y;
    const width = stage.width;
    const height = stage.height;
    const halfW = (width - GAP) / 2;
    const halfH = (height - GAP) / 2;
    const near = (actual: Box, expected: { x: number; y: number; width: number; height: number }): string => {
      const off = Math.max(
        Math.abs(actual.x - expected.x),
        Math.abs(actual.y - expected.y),
        Math.abs(actual.width - expected.width),
        Math.abs(actual.height - expected.height),
      );
      return off <= 2 ? "there" : `off by ${off.toFixed(1)}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`;
    };
    const at = (tabId: string): Promise<Box> => box(shell, windowSelector(tabId));
    const quarter = {
      topLeft: { x: left, y: top, width: halfW, height: halfH },
      topRight: { x: left + halfW + GAP, y: top, width: halfW, height: halfH },
      bottomLeft: { x: left, y: top + halfH + GAP, width: halfW, height: halfH },
      bottomRight: { x: left + halfW + GAP, y: top + halfH + GAP, width: halfW, height: halfH },
    };
    const leftHalf = { x: left, y: top, width: halfW, height };
    await expect.poll(async () => near(await at(budget), leftHalf)).toBe("there");
    await expect.poll(async () => near(await at(inbox), quarter.topRight)).toBe("there");
    await expect.poll(async () => near(await at(invoice), quarter.bottomRight)).toBe("there");
    await capture(app, shell, "01-tiled.png");

    // ── 1. A window out: the rule split the budget, the model sets it beside the invoice ─
    await selectTab(shell, budget);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(budget);
    await shell.locator(rowSelector(vendor)).click();
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(1);
    await awayFromDock();
    const card = notices.getByTestId("notice-card").filter({ hasText: "beside" });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Put “Atlas Medical Supply - Vendor r…” beside “Invoice #2048 - Atlas Medical S…”");
    await settled(shell, app);
    // The budget has its half back; the invoice's quarter is shared, side by side.
    const shared = quarter.bottomRight;
    const sharedW = (shared.width - GAP) / 2;
    await expect.poll(async () => near(await at(budget), leftHalf)).toBe("there");
    await expect.poll(async () => near(await at(invoice), { ...shared, width: sharedW })).toBe("there");
    await expect.poll(async () => near(await at(vendor), { ...shared, x: shared.x + sharedW + GAP, width: sharedW })).toBe("there");
    await capture(app, shell, "02-paired.png");
    // Undo: where the rule put it, splitting the budget.
    await card.getByRole("button", { name: "Undo" }).click();
    await settled(shell, app);
    await expect.poll(async () => near(await at(budget), quarter.topLeft)).toBe("there");
    await expect.poll(async () => near(await at(vendor), quarter.bottomLeft)).toBe("there");
    await expect.poll(async () => near(await at(invoice), quarter.bottomRight)).toBe("there");
    await capture(app, shell, "03-undone.png");

    // ── 2. A window leaves: its neighbour closes the gap up, as a split view's pane does ─
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId), inbox);
    await expect(shell.locator(windowSelector(inbox))).toHaveCount(0);
    await expect(notices.getByTestId("notice-card").filter({ hasText: "filled the gap" })).toHaveCount(1);
    await settled(shell, app);
    await expect.poll(async () => near(await at(budget), { x: left, y: top, width, height: halfH })).toBe("there");
    await expect.poll(async () => near(await at(vendor), quarter.bottomLeft)).toBe("there");
    await capture(app, shell, "04-filled.png");

    // ── 3. ⌘⌥L: asked, the budget is the main work and takes the main place ─
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("pistachio:shell-command", { type: "runShortcut", id: "arrangeDesk" });
    });
    await expect(notices.getByTestId("notice-card").filter({ hasText: "the main place" })).toHaveCount(1);
    await settled(shell, app);
    const mainW = Math.round((width - GAP) * 0.62);
    await expect.poll(async () => near(await at(budget), { x: left, y: top, width: mainW, height })).toBe("there");
    const column = { x: left + mainW + GAP, width: width - mainW - GAP };
    for (const tabId of [vendor, invoice]) {
      const placed = await at(tabId);
      expect(Math.abs(placed.x - column.x)).toBeLessThan(2);
      expect(Math.abs(placed.width - column.width)).toBeLessThan(2);
    }
    await capture(app, shell, "05-focused.png");

  } finally {
    await app.close();
    server.close();
  }
});
