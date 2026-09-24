import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { shellReady } from "./windows";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/delegation");
const execFile = promisify(execFileCallback);

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      executableSuffix,
    ),
  ];

  return candidates.find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

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

async function captureWindow(app: ElectronApplication, filename: string): Promise<void> {
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

test("a person collaborates with the agent in their live tab, steers, approves once, and replays activity", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) {
    throw new Error(
      "No complete Electron runtime is installed. Run pnpm install or set PISTACHIO_ELECTRON_PATH.",
    );
  }

  // A scratch userData, like the other specs: the flow drives the top-tabs
  // strip, and a developer whose own settings.json chose the sidebar layout
  // would otherwise watch it fail on the strip's selectors.
  const userData = await mkdtemp(join(tmpdir(), "pistachio-delegation-"));
  await writeFile(
    join(userData, "settings.json"),
    // The demo invoice page is the subject of the whole journey, so it is the
    // home page: the window no longer opens on it by itself.
    JSON.stringify({
      layout: { mode: "top", sidebar: "pinned" },
      general: { consoleOpenOnLaunch: true, homeUrl: "pistachio://demo/invoices" },
    }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: join(process.cwd()),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);

    // The starting state proves the browser and persistent agent chat arrive together.
    await expect(shell.getByTestId("agent-panel")).toBeVisible();
    await expect(shell.getByTestId("human-tab")).toBeVisible();
    await expect(shell.getByTestId("delegate-button")).toBeVisible();
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

    // A user-created split remains intact when the agent begins work.
    await shell.getByTestId("split-toggle").click();
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await captureWindow(app, "02-human-split-view.png");

    const viewCountBefore = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? 0,
    );

    // The conversation acts in the selected tab and can be interrupted without a
    // handoff. Send is a message button: it stays disabled until one is written.
    await shell.getByTestId("delegation-intent").fill("Reconcile the invoice and route it for payment");
    await shell.getByTestId("delegate-button").click();
    await expect(shell.getByTestId("run-status")).toContainText("Running");
    await shell.waitForTimeout(450);
    await shell.getByTestId("interrupt-button").click();
    await expect(shell.getByTestId("run-status")).toContainText("Interrupted");
    await expect(shell.getByTestId("approval-card")).toHaveCount(0);
    await expect(shell.getByText("You interrupted the agent.", { exact: false })).toBeVisible();
    await captureWindow(app, "03-agent-interrupted.png");

    // A message steers and resumes from the same live page state.
    await shell.getByTestId("delegation-intent").fill("Keep the existing due date, then continue.");
    await shell.getByTestId("delegate-button").click();
    await expect(shell.getByTestId("approval-card")).toBeVisible();
    await expect(shell.getByTestId("run-status")).toContainText("Waiting for approval");
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
    await expect(shell.getByText("I’m resuming from the page exactly as you left it", { exact: false })).toBeVisible();
    await captureWindow(app, "04-agent-steered.png");

    await shell.getByTestId("approve-button").click();
    await expect(shell.getByTestId("completion-meta")).toBeVisible();
    await expect(shell.getByTestId("run-status")).toContainText("Completed");

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

    // The completed run must expose its full hash-chained evidence record.
    await shell.getByRole("button", { name: /View \d+ activity records/ }).click();
    await expect(shell.getByTestId("evidence-replay")).toBeVisible();
    await shell.waitForTimeout(100);
    await captureWindow(app, "06-evidence-replay.png");

    // Ambiguous prompts use the structured questionnaire primitive and
    // continue the same conversational interaction once answered.
    await shell.getByRole("button", { name: "Close replay" }).click();
    await shell.getByTestId("delegation-intent").fill("Help");
    await shell.getByTestId("delegate-button").click();
    await expect(shell.getByTestId("questionnaire-card")).toBeVisible();
    await captureWindow(app, "07-questionnaire.png");
    await shell.getByText("Inspect and report", { exact: true }).click();
    await shell.getByRole("button", { name: "Continue" }).click();
    await expect(shell.getByTestId("run-status")).toContainText("Running");
  } finally {
    await app.close();
  }
});
