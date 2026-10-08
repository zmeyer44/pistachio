/**
 * Dictation in the desk's Bar end to end: the microphone (Chromium's
 * synthetic one) listens while the field shows what it hears, and what was
 * said lands where the caret was, to be read back and sent. A recording
 * discarded (even while it is transcribed), a failed transcription, a tap
 * too short to hear, and an empty field are lib/dictation.ts's
 * (packages/shell-ui/test/dictation.test.ts).
 *
 * The speech-to-text itself is main's (the walkthrough's), which is offline
 * under Playwright: its handler is swapped for one that records what it was
 * sent and answers from a script.
 */

import { expect, test, type ElectronApplication } from "@playwright/test";
import { IPC } from "@pistachio/shell-contracts/ipc";
import { box, createGroup, INVOICES, launchDesk, openGroupDesk, openTabs, reachBar, screenshots, settled, VENDOR } from "./desk-harness";

const capture = screenshots("desk-dictation");

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

test("dictation in the desk's Bar: it listens, and what was said lands at the caret", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(90_000);
  // A synthetic microphone: a tone, no device, no system prompt.
  const { app, shell } = await launchDesk({ name: "dictation", args: ["--use-fake-device-for-media-stream"] });
  try {
    const pageErrors: string[] = [];
    shell.on("pageerror", (error) => pageErrors.push(error.message));
    const speech = await transcriber(app);
    const tabIds = await openTabs(shell, [INVOICES, VENDOR]);
    await createGroup(shell, "desk-dictation", tabIds, "Northstar", "green");
    await openGroupDesk(shell, "desk-dictation");
    await expect(shell.locator('[data-testid="tab-group"] [role="tab"]')).toHaveCount(2);
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const away = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.4);
    await away();

    const input = shell.getByTestId("desk-bar-input");
    const dictate = shell.getByTestId("desk-bar-dictate");
    const wave = shell.getByTestId("desk-bar-dictation");
    const done = shell.getByTestId("desk-bar-dictation-done");

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
    await expect(shell.getByTestId("desk-bar-more")).toHaveCount(0);
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
    await expect(shell.getByTestId("desk-bar-more")).toBeVisible();
    await capture(app, shell, "03-transcribed.png");

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
