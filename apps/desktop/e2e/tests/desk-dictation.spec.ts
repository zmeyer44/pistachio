/**
 * Dictation in the desk's Bar end to end: the microphone (Chromium's
 * synthetic one) listens while the field shows what it hears, and what was
 * said lands where the caret was, to be read back and sent. Escape, and the
 * discard button, drop a recording — even one being transcribed — and a
 * failed transcription or a tap too short to hear says so in the Bar.
 *
 * The speech-to-text itself is main's (the walkthrough's), which is offline
 * under Playwright: its handler is swapped for one that records what it was
 * sent and answers from a script.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import { IPC, type PistachioApi, type ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/desk-dictation");

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

/** The Bar grown from its idle pill, as the pointer coming to it grows it, so its field and buttons can be used. */
async function reachBar(shell: Page): Promise<void> {
  const bar = shell.getByTestId("desk-bar");
  if ((await bar.getAttribute("data-compact")) !== null) await shell.getByTestId("desk-bar-pill").hover();
  await expect(bar).not.toHaveAttribute("data-compact", "");
}

/** The window as a person sees it: the shell with every live page composited over it at its box (desk.spec.ts). */
async function capture(app: ElectronApplication, shell: Page, filename: string): Promise<void> {
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

/** Move the window out from under the real cursor, whose hover would otherwise reach the sidebar (desk.spec.ts). */
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

const INVOICES = "pistachio://demo/invoices";
const VENDOR = "pistachio://demo/vendors/atlas-medical";

/** What main's speech-to-text was sent, and how it answers: text, or an error; after a delay. */
interface Transcriber {
  heard: Array<{ mediaType: string; bytes: number }>;
  answers: Array<string | { error: string }>;
  delayMs: number;
}

async function transcriber(app: ElectronApplication): Promise<{ answer(...answers: Array<string | { error: string }>): Promise<void>; delay(ms: number): Promise<void>; heard(): Promise<Transcriber["heard"]> }> {
  await app.evaluate(
    ({ ipcMain }, channels) => {
      const state: Transcriber = { heard: [], answers: [], delayMs: 0 };
      (globalThis as unknown as { __transcriber: Transcriber }).__transcriber = state;
      // The system's microphone prompt would stop the test; the synthetic device needs none.
      ipcMain.removeHandler(channels.microphone);
      ipcMain.handle(channels.microphone, () => true);
      ipcMain.removeHandler(channels.speech);
      ipcMain.handle(channels.speech, async (_event, input: { data: string; mediaType: string }) => {
        state.heard.push({ mediaType: input.mediaType, bytes: Buffer.from(input.data, "base64").byteLength });
        if (state.delayMs > 0) await new Promise((done) => setTimeout(done, state.delayMs));
        const answer = state.answers.shift() ?? "";
        if (typeof answer !== "string") throw new Error(answer.error);
        return answer;
      });
    },
    { microphone: IPC.microphoneRequest, speech: IPC.speechTranscribe },
  );
  return {
    answer: (...answers) =>
      app.evaluate((_electron, next) => {
        (globalThis as unknown as { __transcriber: Transcriber }).__transcriber.answers.push(...next);
      }, answers),
    delay: (ms) =>
      app.evaluate((_electron, value) => {
        (globalThis as unknown as { __transcriber: Transcriber }).__transcriber.delayMs = value;
      }, ms),
    heard: () => app.evaluate(() => (globalThis as unknown as { __transcriber: Transcriber }).__transcriber.heard.slice()),
  };
}

test("dictation in the desk's Bar: it listens, what was said lands at the caret, a recording can be discarded, failures are said", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-dictation-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ onboarding: { completed: true, completedAt: null }, general: { homeUrl: INVOICES } })));
  const app = await electron.launch({
    // A synthetic microphone: a tone, no device, no system prompt.
    args: [".", "--use-fake-device-for-media-stream"],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await clearOfCursor(app);
    const shell = await shellReady(app);
    const pageErrors: string[] = [];
    shell.on("pageerror", (error) => pageErrors.push(error.message));
    const speech = await transcriber(app);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === INVOICES)).toBe(true);
    await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), VENDOR);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === VENDOR)).toBe(true);
    const tabIds = (await snapshot(shell)).tabs.filter((tab) => tab.url === INVOICES || tab.url === VENDOR).map((tab) => tab.id);
    await shell.evaluate(
      (ids) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-dictation", tabIds: ids, title: "Northstar", color: "green" }),
      tabIds,
    );
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.locator('[data-testid="tab-group"] [role="tab"]')).toHaveCount(2);
    await settled(shell);
    const stage = await shell.locator(".desk-stage").boundingBox();
    if (stage === null) throw new Error("no desk stage");
    const away = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.4);
    await away();

    const input = shell.getByTestId("desk-bar-input");
    const dictate = shell.getByTestId("desk-bar-dictate");
    const wave = shell.getByTestId("desk-bar-dictation");
    const done = shell.getByTestId("desk-bar-dictation-done");
    const discard = shell.getByTestId("desk-bar-dictation-discard");
    const banner = shell.getByTestId("desk-bar").getByRole("status");

    // ── 1. The microphone is one of the Bar's buttons, beside Send ─
    await expect(dictate).toBeVisible();
    await reachBar(shell);
    await dictate.hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveText("Dictate");
    await away();

    // ── 2. Pressed, the field gives way to what the microphone hears; Done has the keyboard ─
    await input.fill("Compare with.");
    await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
    await speech.answer("the vendor record");
    await reachBar(shell);
    await dictate.click();
    await expect(wave).toHaveAttribute("data-phase", "recording");
    await expect(input).toBeHidden();
    await expect(shell.getByTestId("desk-bar-attach")).toHaveCount(0);
    await expect(shell.getByTestId("desk-bar-conversations")).toHaveCount(0);
    await expect(shell.getByTestId("desk-bar-send")).toHaveCount(0);
    await expect(done).toBeFocused();
    // The synthetic tone reaches the waveform, and the clock runs.
    await expect.poll(() => wave.locator(".desk-bar-wave > span").evaluateAll((bars) => Math.max(...bars.map((bar) => bar.getBoundingClientRect().height))), { timeout: 5_000 }).toBeGreaterThan(6);
    await expect(wave.locator(".desk-bar-dictation-clock")).toHaveText(/^0:0[1-9]$/, { timeout: 5_000 });
    await capture(app, shell, "01-listening.png");

    // ── 3. Enter is Done: while its words are transcribed it holds; then they land at the caret ─
    await speech.delay(900);
    await shell.keyboard.press("Enter");
    await expect(wave).toHaveAttribute("data-phase", "transcribing");
    await expect(done).toHaveAttribute("aria-disabled", "true");
    await capture(app, shell, "02-transcribing.png");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("Compare the vendor record with.");
    await expect(input).toBeFocused();
    expect(await input.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([25, 25]);
    const [first] = await speech.heard();
    expect(first?.mediaType).toMatch(/^audio\//);
    expect(first?.bytes).toBeGreaterThan(1_000);
    await expect(shell.getByTestId("desk-bar-send")).toBeVisible();
    await expect(shell.getByTestId("desk-bar-attach")).toBeVisible();
    await capture(app, shell, "03-transcribed.png");

    // ── 4. Escape drops a recording: nothing is sent to be transcribed, the text is as it was ─
    await speech.delay(0);
    await input.press("End");
    await reachBar(shell);
    await dictate.click();
    await expect(wave).toHaveAttribute("data-phase", "recording");
    await shell.waitForTimeout(1_200);
    await shell.keyboard.press("Escape");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("Compare the vendor record with.");
    await expect(input).toBeFocused();
    expect(await speech.heard()).toHaveLength(1);

    // ── 5. Discarded while its words are being transcribed, they are dropped when they come ─
    await speech.delay(1_500);
    await speech.answer("and never mind");
    await reachBar(shell);
    await dictate.click();
    await expect(wave).toHaveAttribute("data-phase", "recording");
    await shell.waitForTimeout(1_200);
    await done.click();
    await expect(wave).toHaveAttribute("data-phase", "transcribing");
    await discard.click();
    await expect(input).toBeVisible();
    await expect.poll(async () => (await speech.heard()).length).toBe(2);
    await shell.waitForTimeout(1_800);
    await expect(input).toHaveValue("Compare the vendor record with.");

    // ── 6. A transcription that fails says why, in the Bar's words, and keeps the text ─
    await speech.delay(0);
    await speech.answer({ error: "Voice isn't available right now: Pistachio's models couldn't be reached from this Mac. Type your introduction instead." });
    await reachBar(shell);
    await dictate.click();
    await expect(wave).toHaveAttribute("data-phase", "recording");
    await shell.waitForTimeout(1_200);
    await done.click();
    await expect(banner).toHaveText("Voice isn't available right now: Pistachio's models couldn't be reached from this Mac.");
    await expect(input).toHaveValue("Compare the vendor record with.");
    await capture(app, shell, "04-failed.png");

    // ── 7. A tap too short to hear is not sent, and says what to do; the next press clears it ─
    await reachBar(shell);
    await dictate.click();
    await expect(banner).toHaveCount(0);
    await expect(wave).toHaveAttribute("data-phase", "recording");
    await done.click();
    await expect(banner).toContainText("too short to hear");
    expect(await speech.heard()).toHaveLength(3);
    await expect(input).toHaveValue("Compare the vendor record with.");

    // ── 8. Into an empty field, what was said is the message ─
    await input.fill("");
    await speech.answer("  What is due this week?  ");
    await reachBar(shell);
    await dictate.click();
    await expect(wave).toHaveAttribute("data-phase", "recording");
    await shell.waitForTimeout(1_200);
    await done.click();
    await expect(input).toHaveValue("What is due this week?");
    await expect(shell.getByTestId("desk-bar-send")).not.toHaveAttribute("aria-disabled", "true");

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
