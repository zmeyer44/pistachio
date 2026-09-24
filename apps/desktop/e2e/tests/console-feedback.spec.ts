import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/console-feedback");
const OWNER_URL = "pistachio://demo/invoices";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

interface Received {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

/** Stands in for apps/www: records every POST and answers 201. */
async function feedbackSink(): Promise<{ server: Server; apiUrl: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({ method: request.method, url: request.url, contentType: request.headers["content-type"], body: JSON.parse(body) });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { server, apiUrl: `http://127.0.0.1:${String(port)}/api`, received };
}

test("the console's feedback popover posts the message, reaction, and context to the API", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-console-feedback-"));
  await writeFile(
    join(userData, "settings.json"),
    // The report names the active tab, and this spec's expectation is the demo
    // page — so open on it; the window's home page is otherwise the search engine.
    JSON.stringify({
      layout: { mode: "top", sidebar: "pinned" },
      general: { consoleOpenOnLaunch: true, homeUrl: OWNER_URL },
    }),
  );
  const sink = await feedbackSink();

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, PISTACHIO_API_URL: sink.apiUrl },
  });
  try {
    const shell = await shellReady(app);

    // The trigger sits in the console header; the popover is Geist's: field, emoji row, Send.
    const trigger = shell.getByTestId("console-feedback");
    await trigger.click();
    const popover = shell.getByRole("dialog", { name: "Feedback" });
    await expect(popover).toBeVisible();
    const field = popover.getByPlaceholder("Your feedback...");
    await expect(field).toBeFocused();
    const send = popover.getByRole("button", { name: "Send" });
    await expect(send).toBeDisabled();

    await mkdir(screenshotDirectory, { recursive: true });
    await shell.screenshot({ path: join(screenshotDirectory, "01-popover-open.png") });
    await popover.getByRole("radio", { name: "Loved it" }).click();
    await expect(popover.getByRole("radio", { name: "Loved it" })).toHaveAttribute("aria-checked", "true");
    await field.fill("The vendor link opened the wrong page.");
    await expect(send).toBeEnabled();
    await shell.screenshot({ path: join(screenshotDirectory, "02-popover-filled.png") });
    await send.click();

    // Received: acknowledged in place, then the popover closes on its own.
    await expect(popover.getByRole("status")).toContainText("Your feedback has been received!");
    await shell.screenshot({ path: join(screenshotDirectory, "03-popover-sent.png") });
    await expect.poll(() => sink.received.length).toBe(1);
    const [report] = sink.received;
    if (report === undefined) throw new Error("no report received");
    expect(report.method).toBe("POST");
    expect(report.url).toBe("/api/feedback");
    expect(report.contentType).toBe("application/json");
    expect(report.body).toEqual(
      expect.objectContaining({
        version: 1,
        id: expect.stringMatching(UUID_RE),
        message: "The vendor link opened the wrong page.",
        reaction: "love",
        app: expect.objectContaining({ version: expect.any(String), electron: expect.any(String), platform: expect.any(String), model: expect.any(String) }),
        browser: expect.objectContaining({ activeTab: expect.objectContaining({ url: OWNER_URL }), tabCount: 1 }),
        run: null,
      }),
    );
    await expect(popover).toHaveCount(0);

    // The next report starts blank.
    await trigger.click();
    await expect(shell.getByRole("dialog", { name: "Feedback" }).getByPlaceholder("Your feedback...")).toHaveValue("");
    await shell.keyboard.press("Escape");
    await expect(shell.getByRole("dialog", { name: "Feedback" })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await app.close();
    sink.server.close();
  }
});
