/**
 * The agent browses behind the person's tab, against the real models, in
 * the real app: a question asked on the home page that needs the web opens
 * its pages in the background — the person's tab never changes, the chat
 * says which tab is being worked and the tab's row carries the agent's
 * ring — and only "show me…" switches the person to a page (`tab_show`).
 * Runs only with PISTACHIO_AGENT_LIVE=1 and a reachable control plane (the
 * unpackaged app dials localhost:8787), like console-routing.live. The two
 * console cases share a launch on a web page.
 *
 *   PISTACHIO_AGENT_LIVE=1 pnpm playwright test -c e2e/playwright.config.ts background-tabs.live
 */
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";
import { launchApp } from "./app";
import { captureShell, snapshot } from "./agent-harness";

const live = process.env["PISTACHIO_AGENT_LIVE"] === "1";

test.describe.configure({ timeout: 480_000 });
test.skip(!live, "needs PISTACHIO_AGENT_LIVE=1 and a reachable control plane");

function capture(shell: Page, filename: string): Promise<void> {
  return captureShell(shell, "background-tabs", filename);
}

/**
 * How a tab's page is laid out against its view: the page's own viewport
 * and the native view's box. A page read off screen before it was drawn is
 * given an emulated viewport; once it is on screen the two must agree.
 */
async function pageFit(app: ElectronApplication, tabUrlPrefix: string): Promise<{ inner: [number, number]; view: [number, number]; visible: boolean }> {
  return app.evaluate(async ({ BrowserWindow }, prefix) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const view = window.contentView.children.find(
      (child) => "webContents" in child && (child as Electron.WebContentsView).webContents.getURL().startsWith(prefix),
    ) as Electron.WebContentsView | undefined;
    if (view === undefined) throw new Error(`no view at ${prefix}`);
    const inner = (await view.webContents.executeJavaScript("[innerWidth, innerHeight]")) as [number, number];
    const bounds = view.getBounds();
    return { inner, view: [bounds.width, bounds.height] as [number, number], visible: view.getVisible() };
  }, tabUrlPrefix);
}

async function launch(general: Record<string, unknown> = {}): Promise<{ app: ElectronApplication; shell: Page }> {
  // Not under PISTACHIO_E2E: that flag keeps the account services — and with
  // them every model — off.
  const { app } = await launchApp({
    name: "background-tabs",
    settings: { layout: { sidebar: "pinned" }, general, onboarding: { completed: true, completedAt: new Date().toISOString() } },
    env: { PISTACHIO_E2E: undefined, PISTACHIO_AGENT_LIVE: "1" },
  });
  const shell = await shellPage(app);
  await shell.waitForLoadState("domcontentloaded");
  await expect(shell.getByTestId("chrome-layout-ground")).toBeVisible();
  await expect
    .poll(async () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getAiStatus().then((status) => status.available)), { timeout: 60_000 })
    .toBe(true);
  return { app, shell };
}

test("a question that needs the web is browsed behind the person's tab, and 'show me' takes them there", { tag: ["@agent", "@tabs", "@live"] }, async () => {
  const { app, shell } = await launch();
  try {
    const first = await snapshot(shell);
    const homeTabId = first.activeTabId;
    expect(homeTabId).not.toBeNull();

    // Asked on the home page, which becomes the chat.
    await shell.getByTestId("home-search-input").click();
    await shell.keyboard.type("What is the current price of Bitcoin on Coinbase?");
    await shell.keyboard.press("ArrowDown");
    await shell.keyboard.press("Enter");
    await expect(shell.getByTestId("home-page")).toHaveAttribute("data-mode", "chat");

    // Watch the whole turn: the person's tab never changes, however many
    // tabs the agent opens and works.
    const activeSeen = new Set<string | null>();
    let chipSeen = false;
    let ringSeen = false;
    const deadline = Date.now() + 300_000;
    let status = "running";
    while (Date.now() < deadline) {
      const now = await snapshot(shell);
      activeSeen.add(now.activeTabId);
      status = now.run?.status ?? "none";
      if (!chipSeen && (await shell.getByTestId("agent-tab-chip").isVisible())) {
        chipSeen = true;
        await capture(shell, "01-browsing-in-background.png");
      }
      if (!ringSeen && (await shell.getByTestId("tab-agent-working").first().isVisible())) ringSeen = true;
      if (now.run !== null && /completed|failed|human_control|waiting_for_judgment|waiting_for_approval|interrupted/.test(status)) break;
      await shell.waitForTimeout(250);
    }
    const done = await snapshot(shell);
    const run = done.run;
    console.log(
      "first turn:",
      JSON.stringify({ status, activeSeen: [...activeSeen], chipSeen, ringSeen, tools: run?.toolCalls.map((call) => `${call.name}:${call.status}:${call.tabId ?? ""}`) }),
    );
    console.log("answer:", run?.messages.at(-1)?.content.slice(0, 400));
    await capture(shell, "02-answered.png");

    expect(run?.status).toBe("completed");
    expect([...activeSeen]).toEqual([homeTabId]);
    expect(run?.toolCalls.some((call) => call.name === "tab.open" && call.status === "completed")).toBe(true);
    expect(run?.toolCalls.some((call) => call.name === "tab.show")).toBe(false);
    expect(run?.toolCalls.filter((call) => call.name === "page.inspect").every((call) => call.status === "completed")).toBe(true);
    expect(done.tabs.length).toBeGreaterThan(1);
    expect(chipSeen).toBe(true);
    expect(ringSeen).toBe(true);
    await expect(shell.getByTestId("home-page")).toHaveAttribute("data-mode", "chat");

    // Now the person asks to be shown it: the one request that switches tabs.
    await shell.getByTestId("home-chat-input").fill("Show me Bitcoin on Coinbase");
    await shell.getByTestId("home-chat-input").press("Enter");
    await expect
      .poll(async () => (await snapshot(shell)).run?.toolCalls.some((call) => call.name === "tab.show" && call.status === "completed") ?? false, { timeout: 240_000 })
      .toBe(true);
    await expect.poll(async () => (await snapshot(shell)).activeTabId, { timeout: 30_000 }).not.toBe(homeTabId);
    const shown = await snapshot(shell);
    console.log("shown:", JSON.stringify(shown.tabs.find((tab) => tab.id === shown.activeTabId)?.url));
    expect(shown.tabs.find((tab) => tab.id === shown.activeTabId)?.url).toMatch(/coinbase\.com/u);
    await capture(shell, "03-shown.png");

    // It was read before it was ever drawn (the home page has no native
    // view to draw it under), so it was laid out at an emulated viewport;
    // on screen now, it fits its pane.
    await expect.poll(async () => {
      const fit = await pageFit(app, "https://www.coinbase.com/");
      return fit.visible && fit.inner[0] === fit.view[0] && fit.inner[1] === fit.view[1];
    }, { timeout: 15_000 }).toBe(true);
  } finally {
    await app.close();
  }
});

test.describe.serial("the agent works a background tab from the console", { tag: ["@tabs", "@agent", "@live"] }, () => {
  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    // The first tab is a web page with a native view, so a background tab is
    // drawn once beneath it (browser-controller #drawUnderCover) and has a
    // real size, and a picture, before the person ever sees it.
    ({ app, shell } = await launch({ homePage: "url", homeUrl: "https://example.com/", consoleOpenOnLaunch: true }));
    await expect.poll(async () => (await snapshot(shell)).tabs[0]?.url ?? "", { timeout: 30_000 }).toMatch(/example\.com/u);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a page open in the person's tab stays put while the agent works a background tab, which it can picture", async () => {
    const homeTabId = (await snapshot(shell)).activeTabId;
    await expect(shell.getByTestId("agent-panel")).toBeVisible();
    await shell.getByTestId("delegation-intent").fill("Open example.org in a new tab, take a screenshot of it, and tell me what its main heading says.");
    await shell.getByTestId("delegate-button").click();

    const activeSeen = new Set<string | null>();
    let status = "running";
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const now = await snapshot(shell);
      activeSeen.add(now.activeTabId);
      status = now.run?.status ?? "none";
      if (now.run !== null && now.run.messages.length > 1 && /completed|failed|human_control|waiting_for_judgment|waiting_for_approval|interrupted/.test(status)) break;
      await shell.waitForTimeout(250);
    }
    const run = (await snapshot(shell)).run;
    console.log(
      "turn:",
      JSON.stringify({ status, activeSeen: [...activeSeen], tools: run?.toolCalls.map((call) => `${call.name}:${call.status}:${call.tabId ?? ""}`) }),
    );
    console.log("answer:", run?.messages.at(-1)?.content.slice(0, 400));
    await capture(shell, "04-console-answered.png");

    expect(run?.status).toBe("completed");
    expect([...activeSeen]).toEqual([homeTabId]);
    const opened = run?.toolCalls.find((call) => call.name === "tab.open" && call.status === "completed");
    expect(opened?.tabId).toBeTruthy();
    const pictured = run?.toolCalls.filter((call) => call.name === "page.screenshot" && call.tabId === opened?.tabId) ?? [];
    expect(pictured.length).toBeGreaterThan(0);
    expect(pictured.every((call) => call.status === "completed")).toBe(true);

    // Off screen, and laid out at the size of the pane it would show in.
    const fit = await pageFit(app, "https://example.org/");
    const pane = await pageFit(app, "https://example.com/");
    console.log("fit:", JSON.stringify({ fit, pane }));
    expect(fit.visible).toBe(false);
    expect(fit.inner).toEqual(pane.view);
  });

  test("a tab asleep in the background is woken and read where it is, without switching to it", async () => {
    // tabs_list names sleeping tabs too; reading one wakes it behind the
    // person's tab (browser-controller #ensureLiveTab) — it used to take a
    // tab_focus to wake it, which is gone. A conversation of its own: the
    // case before's tool calls are not this one's.
    await shell.getByTestId("new-conversation").click();
    await expect.poll(async () => (await snapshot(shell)).run).toBeNull();
    const homeTabId = (await snapshot(shell)).activeTabId!;
    expect((await snapshot(shell)).tabs.find((tab) => tab.id === homeTabId)?.url).toMatch(/example\.com/u);
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab("https://en.wikipedia.org/wiki/Pistachio"));
    await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => /wikipedia\.org/u.test(tab.url))?.loading ?? true, { timeout: 30_000 }).toBe(false);
    const sleeperId = (await snapshot(shell)).tabs.find((tab) => /wikipedia\.org/u.test(tab.url))!.id;
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), homeTabId);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.suspendTab(tabId), sleeperId);
    await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.id === sleeperId)?.lifecycle).toBe("suspended");
    expect((await snapshot(shell)).activeTabId).toBe(homeTabId);

    await expect(shell.getByTestId("agent-panel")).toBeVisible();
    // The page in view goes with a message by default, and the router can
    // answer from it alone; this request is about another tab.
    await shell.getByTestId("composer-context-dismiss").click();
    await expect(shell.getByTestId("composer-context")).toHaveAttribute("data-page-attached", "false");
    await shell.getByTestId("delegation-intent").fill("Read the Wikipedia tab I already have open and tell me the botanical name of the plant it is about. Don't open any new tabs.");
    await shell.getByTestId("delegate-button").click();

    const activeSeen = new Set<string | null>();
    let status = "running";
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const now = await snapshot(shell);
      activeSeen.add(now.activeTabId);
      status = now.run?.status ?? "none";
      if (now.run !== null && now.run.messages.length > 1 && /completed|failed|human_control|waiting_for_judgment|waiting_for_approval|interrupted/.test(status)) break;
      await shell.waitForTimeout(250);
    }
    const done = await snapshot(shell);
    const run = done.run;
    console.log("turn:", JSON.stringify({ status, activeSeen: [...activeSeen], tools: run?.toolCalls.map((call) => `${call.name}:${call.status}:${call.tabId ?? ""}`) }));
    console.log("answer:", run?.messages.at(-1)?.content.slice(0, 400));

    expect(run?.status).toBe("completed");
    expect([...activeSeen]).toEqual([homeTabId]);
    const reads = run?.toolCalls.filter((call) => call.name === "page.inspect" && call.tabId === sleeperId) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((call) => call.status === "completed")).toBe(true);
    expect(run?.toolCalls.some((call) => call.name === "tab.open" || call.name === "tab.show")).toBe(false);
    expect(done.tabs.find((tab) => tab.id === sleeperId)?.lifecycle).toBe("live");
    expect(run?.messages.at(-1)?.content).toMatch(/Pistacia vera/u);
  });
});
