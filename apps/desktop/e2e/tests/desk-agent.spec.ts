/**
 * The desk's agent end to end (docs/desk-agent.md): the Bar at the desk's
 * foot, the group's context as a Stack in the dock, and a turn through the
 * real controller and runner on a scripted model (PISTACHIO_AGENT_SCRIPT) —
 * the agent arranging the windows, wearing its ring on the window it works
 * in, pinning a note, saving a fact to the Stack; Undo layout; the
 * conversations; ⌘I.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/desk-agent");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", suffix)].find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

function api<T>(shell: Page, call: (pistachio: PistachioApi) => Promise<T>): Promise<T> {
  return shell.evaluate(`(${call.toString()})(window.pistachio)`) as Promise<T>;
}

const snapshot = (shell: Page): Promise<ShellSnapshot> => api(shell, (pistachio) => pistachio.getSnapshot());

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (found === null) throw new Error(`${selector} has no box`);
  return found;
}

/** The window as a person sees it: the shell with every live page composited over it at its box (desk.spec.ts). */
async function capture(app: ElectronApplication, shell: Page, filename: string): Promise<void> {
  // capturePage can hand back a frame from before the latest paint.
  await shell.waitForTimeout(400);
  const layers = await app.evaluate(async ({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const base = (await window.capturePage()).toDataURL();
    const views: Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }> = [];
    for (const child of window.contentView.children) {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) continue;
      const view = child as WebContentsView;
      if (Object.values(hashes).some((hash) => view.webContents.getURL().endsWith(hash))) continue;
      views.push({ dataUrl: (await view.webContents.capturePage()).toDataURL(), bounds: view.getBounds() });
    }
    return { base, views };
  }, CHROME_VIEW_HASHES);
  const png = await shell.evaluate(async ({ base, views }) => {
    const load = (src: string): Promise<HTMLImageElement> =>
      new Promise((done, fail) => {
        const image = new Image();
        image.onload = () => done(image);
        image.onerror = fail;
        image.src = src;
      });
    const ground = await load(base);
    const canvas = document.createElement("canvas");
    canvas.width = ground.naturalWidth;
    canvas.height = ground.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(ground, 0, 0);
    const scale = ground.naturalWidth / window.innerWidth;
    for (const view of views) {
      const image = await load(view.dataUrl);
      const { x, y, width, height } = view.bounds;
      context.save();
      context.beginPath();
      context.roundRect(x * scale, y * scale, width * scale, height * scale, 8 * scale);
      context.clip();
      context.drawImage(image, x * scale, y * scale, width * scale, height * scale);
      context.restore();
    }
    return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
  }, layers);
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

/** Move the window out from under the real cursor, whose hover would otherwise reach the dock (desk.spec.ts). */
async function clearOfCursor(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const inside = cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
    if (!inside) return;
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const x = cursor.x - area.x > bounds.width + 20 ? area.x : cursor.x + 20 + bounds.width <= area.x + area.width ? cursor.x + 20 : null;
    const y = cursor.y - area.y > bounds.height + 20 ? area.y : cursor.y + 20 + bounds.height <= area.y + area.height ? cursor.y + 20 : null;
    if (x !== null) window.setPosition(x, bounds.y);
    else if (y !== null) window.setPosition(bounds.x, y);
  });
}

async function settled(shell: Page): Promise<void> {
  await expect(shell.locator('.desk-stage[data-phase="open"]')).toHaveCount(1);
  await expect(shell.locator(".desk-stage[data-gesture]")).toHaveCount(0);
  await expect(shell.locator('[data-testid="desk-window"][data-flight]')).toHaveCount(0);
  await shell.waitForTimeout(900);
}

const windowSelector = (tabId: string): string => `[data-testid="desk-window"][data-tab-id="${tabId}"]`;

const INVOICES = "pistachio://demo/invoices";
const VENDOR = "pistachio://demo/vendors/atlas-medical";
const ACCOUNTS = "pistachio://demo/auth/relying-party";

/**
 * The agent's model, scripted: tab and item ids are named by what the
 * prompt shows (scripted-agent-model.ts). The first turn arranges the
 * invoice and the vendor side by side, reads the vendor, pins a note and
 * saves a fact — pausing while it thinks, so its presence can be seen.
 */
const SCRIPT = {
  steps: [
    {
      tools: [
        {
          name: "desk_arrange",
          input: {
            layout: null,
            place: [
              { tabId: "{{tab:Northstar}}", zone: "left", box: null },
              { tabId: "{{tab:Atlas}}", zone: "right", box: null },
            ],
            bringOut: null,
            putAway: null,
          },
        },
      ],
    },
    { tools: [{ name: "page_inspect", input: { tabId: "{{tab:Atlas}}" } }] },
    {
      delayMs: 2_500,
      tools: [
        { name: "desk_note", input: { tabId: "{{tab:Atlas}}", text: "Net 30 · due Oct 12" } },
        { name: "context_save", input: { kind: "fact", text: "Atlas Medical invoice NS-2048 is due Oct 12", url: null, title: null } },
      ],
    },
    { text: "Atlas Medical is beside the invoice now. Their terms are **net 30**, so NS-2048 is due Oct 12 — I saved that to this desk's context." },
    // The second turn opens a page into the group.
    { tools: [{ name: "tab_open", input: { url: ACCOUNTS } }] },
    { text: "Opened the connected accounts beside it." },
    // The third clicks a link that opens a new tab, in the invoice while it is in the dock.
    { tools: [{ name: "page_click", input: { tabId: "{{tab:Northstar}}", target: "#vendor-record-link" } }] },
    { text: "Opened the vendor record from the invoice." },
    // The fourth works on after the person has left the desk.
    { delayMs: 3_000, tools: [{ name: "page_click", input: { tabId: "{{tab:Northstar}}", target: "#vendor-record-link" } }] },
    { text: "Opened it once more, after you left the desk." },
  ],
};

test("the desk's agent: the Bar, the Stack, a turn that arranges the windows, its presence, a note, a saved fact, Undo layout, the conversations", async () => {
  test.setTimeout(180_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-agent-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ onboarding: { completed: true, completedAt: null }, general: { homeUrl: INVOICES } })));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) },
  });
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await clearOfCursor(app);
    const shell = await shellReady(app);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === INVOICES)).toBe(true);
    await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), VENDOR);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === VENDOR)).toBe(true);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const invoice = byUrl.get(INVOICES)!;
    const vendor = byUrl.get(VENDOR)!;
    await shell.evaluate(
      (tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-agent", tabIds, title: "Northstar", color: "green" }),
      [invoice, vendor],
    );
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), invoice);
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(2);
    await settled(shell);
    const stage = await box(shell, ".desk-stage");
    const away = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.4);
    await away();

    // ── 1. The Bar at the desk's foot, the windows above it; the Stack in the dock, empty ─
    const bar = shell.getByTestId("desk-bar");
    await expect(bar).toBeVisible();
    // Just the field and its buttons: it asks about the group by name.
    await expect(shell.getByTestId("desk-bar-input")).toHaveAttribute("placeholder", "Ask about Northstar…");
    // A pill at one line.
    expect(await shell.getByTestId("desk-bar").evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("26px");
    // Every button says what it does.
    await shell.getByTestId("desk-bar-attach").hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveText("Attach files");
    await capture(app, shell, "01b-desk-bar-tooltip.png");
    await shell.getByTestId("desk-bar-send").hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]', { hasText: "Send" })).toBeVisible();
    await away();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveCount(0);
    const barBox = await box(shell, '[data-testid="desk-bar"]');
    expect(barBox.y + barBox.height).toBeGreaterThan(stage.y + stage.height - 4);
    const entry = await box(shell, windowSelector(invoice));
    expect(entry.y + entry.height).toBeLessThanOrEqual(barBox.y + 1);
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "0");
    await capture(app, shell, "01-desk-bar.png");

    // ── 2. Files dropped on the Stack go into the group's context; a fact typed on its card too ─
    const transfer = await shell.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["Boarding pass BA 0490, seat 14C, gate closes 09:10"], "boarding-pass.txt", { type: "text/plain" }));
      return data;
    });
    for (const type of ["dragenter", "dragover", "drop"]) await shell.dispatchEvent('[data-testid="desk-stack"]', type, { dataTransfer: transfer });
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "1");
    await shell.getByTestId("desk-stack").click();
    await expect(shell.locator('[data-testid="desk-stack-card"][data-shown]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-stack-file")).toContainText("boarding-pass.txt");
    await shell.getByTestId("desk-stack-fact").fill("Approver: Dana in finance");
    await shell.getByTestId("desk-stack-fact").press("Enter");
    await expect(shell.getByTestId("desk-stack-line")).toContainText("Approver: Dana in finance");
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "2");
    // The card is a cover: the window in use under it is its still meanwhile.
    await expect(shell.locator(`${windowSelector(invoice)}[data-drawn]`)).toHaveCount(1);
    await capture(app, shell, "02-desk-stack.png");
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("desk-stack-card")).toHaveCount(0);
    const synced = await api(shell, (pistachio) => pistachio.getGroupContexts());
    expect(synced.find((context) => context.groupId === "desk-agent")?.items.map((item) => item.kind)).toEqual(["file", "fact"]);

    // ── 3. ⌘I puts the keyboard in the Bar; a message there is a turn at this desk ─
    await shell.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await shell.keyboard.press("Meta+i");
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    const before = await box(shell, windowSelector(invoice));
    await shell.getByTestId("desk-bar-input").fill("Put the vendor beside the invoice and tell me when it's due");
    await shell.getByTestId("desk-bar-input").press("Enter");

    // ── 4. It arranges the windows side by side, the keyboard staying put, and is seen where it works ─
    await expect(shell.locator('[data-testid="desk-answer"][data-shown]')).toHaveCount(1);
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(1);
    await expect(shell.locator(`${windowSelector(vendor)}[data-agent]`)).toHaveCount(1);
    await expect(shell.locator(`${windowSelector(vendor)} [data-testid="desk-window-agent"]`)).toContainText("Thinking");
    await expect(shell.locator(`[data-testid="desk-dock-icon"][data-tab-id="${vendor}"][data-agent]`)).toHaveCount(1);
    await expect(shell.getByTestId("desk-bar-stop")).toBeVisible();
    expect((await snapshot(shell)).activeTabId).toBe(invoice);
    await capture(app, shell, "03-desk-agent-working.png");

    // ── 5. Done: a note on the vendor's window, the fact in the Stack, the answer on the card ─
    await expect(shell.getByTestId("desk-answer")).toContainText("net 30", { timeout: 15_000 });
    await expect(shell.locator(`${windowSelector(vendor)} [data-testid="desk-window-note"]`)).toContainText("Net 30 · due Oct 12");
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "3");
    await expect(shell.locator("[data-agent]")).toHaveCount(0);
    await settled(shell);
    const left = await box(shell, windowSelector(invoice));
    const right = await box(shell, windowSelector(vendor));
    expect(left.x + left.width).toBeLessThan(right.x);
    expect(Math.abs(left.width - right.width)).toBeLessThan(4);
    expect(right.y + right.height).toBeLessThanOrEqual(barBox.y + 1);
    const run = (await snapshot(shell)).run!;
    expect(run.groupId).toBe("desk-agent");
    expect(run.toolCalls.map((call) => call.name)).toEqual(["desk.arrange", "page.inspect", "desk.note", "context.save"]);
    await capture(app, shell, "04-desk-agent-answer.png");

    // The answer is as wide as the Bar and rests on it, however tall the Bar grows; it collapses with a chevron.
    const card = await box(shell, '[data-testid="desk-answer"]');
    const barNow = await box(shell, '[data-testid="desk-bar"]');
    expect(Math.abs(card.width - barNow.width)).toBeLessThan(1);
    expect(Math.abs(card.x - barNow.x)).toBeLessThan(1);
    expect(Math.abs(card.y + card.height + 8 - barNow.y)).toBeLessThan(1.5);
    await shell.getByTestId("desk-bar-input").fill("one\ntwo\nthree\nfour");
    await expect.poll(async () => (await box(shell, '[data-testid="desk-bar"]')).height).toBeGreaterThan(barNow.height + 30);
    const taller = await box(shell, '[data-testid="desk-bar"]');
    const lifted = await box(shell, '[data-testid="desk-answer"]');
    expect(Math.abs(lifted.y + lifted.height + 8 - taller.y)).toBeLessThan(1.5);
    await capture(app, shell, "04b-desk-answer-on-a-tall-bar.png");
    await shell.getByTestId("desk-bar-input").fill("");
    await expect(shell.getByTestId("desk-answer-close")).toHaveAttribute("aria-label", "Hide the answer");

    // ── 6. Undo layout puts every window back where it was before the turn ─
    await shell.getByTestId("desk-undo-layout").click();
    await settled(shell);
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(0);
    const undone = await box(shell, windowSelector(invoice));
    expect(Math.abs(undone.x - before.x)).toBeLessThan(3);
    expect(Math.abs(undone.width - before.width)).toBeLessThan(3);
    await expect(shell.getByTestId("desk-undo-layout")).toHaveCount(0);

    // ── 7. A tab it opens joins the group and comes out quietly, under the window in use ─
    await shell.getByTestId("desk-bar-input").fill("Open the connected accounts too");
    await shell.getByTestId("desk-bar-input").press("Enter");
    await expect(shell.getByTestId("desk-answer")).toContainText("Opened the connected accounts", { timeout: 15_000 });
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(3);
    const opened = (await snapshot(shell)).tabs.find((tab) => tab.url === ACCOUNTS)!;
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-agent")?.tabIds).toContain(opened.id);
    await expect(shell.locator(windowSelector(opened.id))).toHaveCount(1);
    expect((await snapshot(shell)).activeTabId).toBe(invoice);
    await settled(shell);
    await capture(app, shell, "05-desk-agent-opened.png");

    // ── 8. A page the agent's click opens joins the group — from a tab in the dock too — and comes out quietly ─
    await shell.locator(`${windowSelector(invoice)} button[aria-label="Collapse"]`).click();
    await settled(shell);
    await expect(shell.locator(windowSelector(invoice))).toHaveCount(0);
    // The person goes on in another window: the invoice is in the dock, and not the tab in use.
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), opened.id);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(opened.id);
    await settled(shell);
    const inUseBefore = opened.id;
    await shell.getByTestId("desk-bar-input").fill("Open the vendor record from the invoice");
    await shell.getByTestId("desk-bar-input").press("Enter");
    await expect(shell.getByTestId("desk-answer")).toContainText("Opened the vendor record from the invoice", { timeout: 15_000 });
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => tab.url === VENDOR).length).toBe(2);
    const fromLink = (await snapshot(shell)).tabs.find((tab) => tab.url === VENDOR && tab.id !== vendor)!;
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-agent")?.tabIds).toContain(fromLink.id);
    await expect(shell.locator(windowSelector(fromLink.id))).toHaveCount(1);
    expect((await snapshot(shell)).activeTabId).toBe(inUseBefore);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);

    // ── 9. The conversations: this desk's, marked; a new one starts empty ─
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.locator('[data-testid="desk-conversations"][data-shown]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-conversation")).toHaveCount(1);
    await expect(shell.getByTestId("desk-conversation").first()).toContainText("This desk");
    // Rows, as the mentions' are: New conversation first; no heading.
    await expect(shell.getByTestId("desk-conversations")).not.toContainText("Conversations");
    await expect(shell.getByTestId("desk-conversation-new")).toHaveText("New conversation");
    await expect(shell.getByTestId("desk-conversation").first()).toHaveAttribute("aria-current", "true");
    await capture(app, shell, "06-desk-conversations.png");
    // A press anywhere else puts them away: in the shell (the Bar's field)…
    await shell.getByTestId("desk-bar-input").click();
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    // …or in a live page, which main relays.
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.locator('[data-testid="desk-conversations"][data-shown]')).toHaveCount(1);
    await app.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      contents.sendInputEvent({ type: "mouseMove", x: 420, y: 24 });
      contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: 420, y: 24 });
      await new Promise((done) => setTimeout(done, 40));
      contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: 420, y: 24 });
    }, ACCOUNTS);
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    // Its own button still toggles it.
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.locator('[data-testid="desk-conversations"][data-shown]')).toHaveCount(1);
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.locator('[data-testid="desk-conversations"][data-shown]')).toHaveCount(1);
    const runId = run.runId;
    await shell.getByTestId("desk-conversation-new").click();
    await expect.poll(async () => (await snapshot(shell)).run).toBeNull();
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    // And the earlier one is still there to continue here.
    await shell.getByTestId("desk-bar-conversations").click();
    await shell.locator(`[data-testid="desk-conversation"][data-run-id="${runId}"]`).click();
    await expect.poll(async () => (await snapshot(shell)).run?.runId).toBe(runId);

    // ── 10. Left mid-turn, the desk's turn goes on in its group: a page it opens still joins the group ─
    await shell.getByTestId("desk-bar-input").fill("Open the vendor record once more");
    await shell.getByTestId("desk-bar-input").press("Enter");
    await expect.poll(async () => (await snapshot(shell)).run?.status).toBe("running");
    await shell.getByTestId("desk-more").hover();
    await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(1);
    await shell.getByTestId("desk-leave").click();
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
    await expect
      .poll(async () => (await snapshot(shell)).run?.messages.at(-1)?.content ?? "", { timeout: 20_000 })
      .toContain("Opened it once more");
    const vendorTabs = (await snapshot(shell)).tabs.filter((tab) => tab.url === VENDOR);
    expect(vendorTabs).toHaveLength(3);
    const offDesk = vendorTabs.find((tab) => tab.id !== vendor && tab.id !== fromLink.id)!;
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-agent")?.tabIds).toContain(offDesk.id);
  } finally {
    await app.close();
  }
});
