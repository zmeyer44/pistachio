import { execFile as execFileCallback } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { shellReady } from "./windows";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { captureEnabled, launchApp } from "./app";
import { snapshot } from "./agent-harness";
import { reachBar } from "./desk-harness";

/**
 * The demo agent (RunController's no-model flow under PISTACHIO_E2E) in the
 * person's live tab, asked from the desk's Bar and read in its answer card
 * (the desktop's one chat since 2026-11-16: no panel stands beside the
 * desk): interrupt, steer, approve once, replay the record — then the two
 * questions it can ask, a choice and a typed value, each resuming the same
 * conversation. One launch; each step leaves the thread where the next one
 * starts.
 */

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/delegation");
const execFile = promisify(execFileCallback);

/** capturePage throws UnknownVizError until a view's compositor has its first frame. */
async function withFirstFrame<T>(capture: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await capture();
    } catch (error: unknown) {
      lastError = error;
      await new Promise((done) => setTimeout(done, 150));
    }
  }
  throw lastError;
}

/** The shell with each visible tab view composited over it (ImageMagick `magick`). */
async function captureWindow(app: ElectronApplication, filename: string): Promise<void> {
  if (!captureEnabled) return;
  const capture = await withFirstFrame(() => app.evaluate(async ({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const shell = await window.capturePage();
    const views = await Promise.all(
      window.contentView.children.flatMap((child) => {
        if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return [];
        const view = child as WebContentsView;
        // Utility chrome views (drag capture and find) are not tab panes.
        if (Object.values(hashes).some((hash) => view.webContents.getURL().endsWith(hash))) return [];
        return [
          view.webContents.capturePage().then((image) => ({
            bounds: view.getBounds(),
            png: image.toPNG().toString("base64"),
          })),
        ];
      }),
    );
    return { shell: shell.toPNG().toString("base64"), views };
  }, CHROME_VIEW_HASHES));
  await mkdir(screenshotDirectory, { recursive: true });
  const outputPath = join(screenshotDirectory, filename);
  const shellPath = join(screenshotDirectory, `.${filename}.shell.png`);
  const viewPaths: string[] = [];
  await writeFile(shellPath, Buffer.from(capture.shell, "base64"));
  const command = [shellPath];
  for (const [index, view] of capture.views.entries()) {
    const viewPath = join(screenshotDirectory, `.${filename}.view-${index}.png`);
    viewPaths.push(viewPath);
    await writeFile(viewPath, Buffer.from(view.png, "base64"));
    command.push(
      "(",
      viewPath,
      "-resize",
      `${view.bounds.width}x${view.bounds.height}!`,
      ")",
      "-geometry",
      `+${view.bounds.x}+${view.bounds.y}`,
      "-composite",
    );
  }
  command.push(outputPath);
  await execFile("magick", command);
  await Promise.all([shellPath, ...viewPaths].map((path) => unlink(path)));
}

test.describe.serial("the agent works in the person's tab, asked at the desk's Bar", { tag: ["@agent"] }, () => {
  test.describe.configure({ timeout: 45_000 });

  let app: ElectronApplication;
  let shell: Page;
  /** The desk's answer card: the conversation of the space in front. */
  const panel = (): Locator => shell.getByTestId("desk-answer");
  /** A message from the Bar's field, the pill out of the nub for it. */
  const say = async (text: string): Promise<void> => {
    await reachBar(shell);
    await shell.getByTestId("desk-bar-input").fill(text);
    await shell.getByTestId("desk-bar-input").press("Enter");
  };
  /** The conversation's status, as main has it (the card says it in its lines, not in a word of its own). */
  const status = (): Promise<string | null> => snapshot(shell).then((state) => state.run?.status ?? null);

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    // The demo invoice page is the subject of the whole journey, so it is the
    // home page: the window no longer opens on it by itself.
    ({ app } = await launchApp({
      name: "delegation",
      settings: {
        layout: { sidebar: "pinned" },
        general: { homeUrl: "pistachio://demo/invoices" },
      },
    }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a person collaborates with the agent in their live tab, steers, approves once, and replays activity", { tag: ["@smoke"] }, async () => {
    // The starting state: the browser, and the chat where it lives — the desk's nub. No panel stands beside the desk.
    await expect(shell.getByTestId("human-tab")).toBeVisible();
    await expect(shell.getByTestId("desk-nub")).toBeVisible();
    await expect(shell.getByTestId("agent-panel")).toHaveCount(0);
    await captureWindow(app, "01-browser-ready.png");

    // The agent should inherit the exact live browser session rather than
    // copying a sanitized subset into a second tab.
    await app.evaluate(async ({ BrowserWindow }, hashes) => {
      const window = BrowserWindow.getAllWindows()[0];
      // The first TAB view: the chrome views (main/chrome-view.ts) are children too.
      const isChromeView = (url: string): boolean => Object.values(hashes).some((hash) => url.endsWith(hash));
      const humanView = window?.contentView.children.find(
        (child) => "webContents" in child && !isChromeView((child as WebContentsView).webContents.getURL()),
      ) as WebContentsView | undefined;
      if (humanView === undefined) throw new Error("human browser view is unavailable");
      await humanView.webContents.executeJavaScript(`(() => {
        document.querySelector('[name="csrfToken"]').value = 'human-only-csrf';
        document.querySelector('[name="accountPassword"]').value = 'human-only-password';
      })()`);
    }, CHROME_VIEW_HASHES);

    // The person's tab is the desk's one window, live: the agent works in it where it is, adding no view.
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await captureWindow(app, "02-human-desk-window.png");

    const viewCountBefore = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? 0,
    );

    // The conversation acts in the selected tab and can be interrupted without a
    // handoff. Send is a message button: it stays disabled until one is written.
    await say("Reconcile the invoice and route it for payment");
    await expect.poll(status).toBe("running");
    await expect(panel()).toBeVisible();
    // Interrupt once the draft is typed into the page, before the approval
    // the demo asks for next: the steered run resumes from that page state.
    await expect
      .poll(async () => (await snapshot(shell)).run?.toolCalls.some((call) => call.name === "page.type" && call.status === "completed") ?? false, { intervals: [50] })
      .toBe(true);
    await shell.getByTestId("desk-bar-stop").click();
    await expect.poll(status).toBe("interrupted");
    await expect(panel().getByTestId("approval-card")).toHaveCount(0);
    await expect(panel().getByText("You interrupted the agent.", { exact: false })).toBeVisible();
    await captureWindow(app, "03-agent-interrupted.png");

    // A message steers and resumes from the same live page state.
    await say("Keep the existing due date, then continue.");
    await expect(panel().getByTestId("approval-card")).toBeVisible();
    await expect.poll(status).toBe("waiting_for_approval");
    await expect(shell.getByTestId("agent-tab")).toHaveCount(0);

    const boundary = await app.evaluate(async ({ BrowserWindow }, hashes) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Pistachio window is unavailable");
      const isChromeView = (url: string): boolean => Object.values(hashes).some((hash) => url.endsWith(hash));
      const views = window.contentView.children.filter(
        (child): child is WebContentsView =>
          "webContents" in child && !isChromeView((child as WebContentsView).webContents.getURL()),
      );
      let controlledView: WebContentsView | undefined;
      for (const view of views) {
        const wasEditedByAgent = await view.webContents.executeJavaScript(
          `document.body.dataset.agent === 'working'`,
        );
        if (wasEditedByAgent === true) controlledView = view;
      }
      if (controlledView === undefined) throw new Error("controlled browser view is unavailable");
      const sessionValues = await controlledView.webContents.executeJavaScript(`({
        csrf: document.querySelector('[name="csrfToken"]').value,
        password: document.querySelector('[name="accountPassword"]').value,
        memo: document.querySelector('#memo').value,
      })`);
      return {
        viewCount: window.contentView.children.length,
        url: controlledView.webContents.getURL(),
        sessionValues,
      };
    }, CHROME_VIEW_HASHES);
    expect(boundary.viewCount).toBe(viewCountBefore);
    expect(boundary.url).toBe("pistachio://demo/invoices");
    expect(boundary.sessionValues).toEqual({
      csrf: "human-only-csrf",
      password: "human-only-password",
      memo: "PO total matched. Documented the $20 freight variance from the vendor invoice.",
    });
    await expect(panel().getByText("I’m resuming from the page exactly as you left it", { exact: false })).toBeVisible();
    await captureWindow(app, "04-agent-steered.png");

    await panel().getByTestId("approve-button").click();
    await expect(panel().getByTestId("completion-meta")).toBeVisible();
    await expect.poll(status).toBe("completed");

    const evidence = await shell.evaluate(() =>
      (window as unknown as { pistachio: PistachioApi }).pistachio.getEvidence(),
    );
    const start = evidence.find((entry) => entry.type === "interaction.started");
    expect(start?.payload).toMatchObject({ sessionMode: "user-session", forkCreated: false });
    expect(evidence.filter((entry) => entry.type === "browser.action")).toHaveLength(2);
    const endedIndex = evidence.findIndex((entry) => entry.type === "authority.ended");
    expect(endedIndex).toBeGreaterThan(-1);
    expect(evidence[endedIndex]?.payload).toMatchObject({
      browserSessionPreserved: true,
      separateSessionCreated: false,
    });
    await captureWindow(app, "05-work-completed-in-place.png");

    // The completed run must expose its full hash-chained evidence record: in the card, in the conversation's place.
    await panel().getByRole("button", { name: /View \d+ activity records/ }).click();
    await expect(panel().getByTestId("evidence-replay")).toBeVisible();
    await expect(panel().getByTestId("desk-answer-evidence")).toHaveAttribute("aria-pressed", "true");
    await captureWindow(app, "06-evidence-replay.png");
    await shell.getByRole("button", { name: "Close replay" }).click();
    await expect(shell.getByTestId("evidence-replay")).toHaveCount(0);
    // The card's own button opens it too, and puts it away.
    await panel().getByTestId("desk-answer-evidence").click();
    await expect(panel().getByTestId("evidence-replay")).toBeVisible();
    await panel().getByTestId("desk-answer-evidence").click();
    await expect(shell.getByTestId("evidence-replay")).toHaveCount(0);
    await expect(panel().getByTestId("completion-meta")).toBeVisible();
  });

  test("a structured question disappears and the run resumes after Continue", async () => {
    // Ambiguous prompts use the structured questionnaire primitive: the
    // finished demo thread starts over, paused on the question and its directions.
    await say("Help");
    const card = panel().getByTestId("questionnaire-card");
    await expect(card).toBeVisible();
    await expect(card.getByText("Inspect and report", { exact: true })).toBeVisible();
    await captureWindow(app, "07-questionnaire.png");

    // A chosen direction gives Continue a concrete value to submit.
    await card.getByText("Inspect and report", { exact: true }).click();
    await expect(card.getByRole("button", { name: "Continue" })).toBeEnabled();

    // Removing the card is the user-visible contract that the answer resumed this conversation.
    await card.getByRole("button", { name: "Continue" }).click();
    await expect(card).toHaveCount(0);

    // It runs on to its approval; declined, the thread is finished.
    await expect(panel().getByTestId("approval-card")).toBeVisible();
    await panel().getByTestId("reject-button").click();
    await expect.poll(status).toBe("rejected");
  });

  test("a person types a requested value and the agent resumes with it", async () => {
    // The agent can request a verbatim value without inventing choices.
    await say("I will provide my ZIP code");
    const card = panel().getByTestId("questionnaire-card");
    const input = card.getByTestId("question-text-input");
    await expect(card.getByText("What ZIP code should I use?", { exact: true })).toBeVisible();
    await expect(input).toHaveAttribute("placeholder", "ZIP code");
    await expect(card.getByRole("radio")).toHaveCount(0);
    await captureWindow(app, "08-text-question.png");

    // The exact value is staged in the dedicated answer field.
    await input.fill("10001");
    await expect(input).toHaveValue("10001");

    // Continue consumes the text and returns to the same conversation.
    await card.getByRole("button", { name: "Continue" }).click();
    await expect(card).toHaveCount(0);
    await expect(panel().getByText("10001", { exact: true })).toBeVisible();
  });
});
