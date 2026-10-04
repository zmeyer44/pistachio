import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { captureShell, pageAt } from "./agent-harness";

/**
 * The console around a conversation, on one launch: its feedback popover
 * posts a report to the API, and a link in a message previews as a Glance.
 * The owner page is the window's only tab, so it is the home page: launch
 * opens on `general.homeUrl` and nothing else.
 */

const OWNER_URL = "pistachio://demo/invoices";
const PREVIEW_URL = "pistachio://demo/vendors/atlas-medical";
const REMINDER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OCCURRENCE_ID = "16fd2706-8baf-433b-82eb-8c7fada847da";
const RUN_ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function visibleTabViews(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.contentView.children.flatMap((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return [];
      const url = (child as WebContentsView).webContents.getURL();
      return Object.values(hashes).some((hash) => url.endsWith(hash)) ? [] : [url];
    });
  }, CHROME_VIEW_HASHES);
}

function tabUrls(shell: Page): Promise<string[]> {
  return shell.evaluate(async () => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    return (await api.getSnapshot()).tabs.map(({ url }) => url);
  });
}

/** A finished agent reminder whose report names a page, waiting in the console's inbox. */
function remindersDocument(): unknown {
  const at = "2026-08-27T13:11:47.556Z";
  return {
    version: 1,
    reminders: [
      {
        id: REMINDER_ID,
        title: "Vendor review",
        schedule: { kind: "daily", time: "09:10" },
        action: { kind: "agent", prompt: "Find the vendor record that needs review and send me the link." },
        timezone: "America/New_York",
        status: "active",
        source: { kind: "agent", runId: RUN_ID },
        createdAt: at,
        updatedAt: at,
        nextFireAt: "2099-01-01T14:10:00.000Z",
        lastFiredAt: at,
        until: null,
        maxFires: null,
        fireCount: 1,
      },
    ],
    occurrences: [
      {
        id: OCCURRENCE_ID,
        reminderId: REMINDER_ID,
        title: "Vendor review",
        actionKind: "agent",
        scheduledFor: at,
        startedAt: at,
        finishedAt: "2026-08-27T13:12:08.435Z",
        status: "completed",
        output: `One vendor record needs a look:\n${PREVIEW_URL}\nThe contact email bounced twice this week.`,
        error: null,
        runId: RUN_ID,
        acknowledgedAt: null,
      },
    ],
  };
}

test.describe.serial("the console's feedback and links", { tag: ["@glance", "@agent"] }, () => {
  test.describe.configure({ timeout: 45_000 });

  let app: ElectronApplication;
  let shell: Page;
  let sink: Awaited<ReturnType<typeof feedbackSink>>;

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    sink = await feedbackSink();
    ({ app } = await launchApp({
      name: "console-links",
      settings: { layout: { sidebar: "pinned" }, general: { consoleOpenOnLaunch: true, homeUrl: OWNER_URL } },
      files: { "reminders.json": remindersDocument() },
      env: { PISTACHIO_API_URL: sink.apiUrl },
    }));
    shell = await shellReady(app);
    await pageAt(app, OWNER_URL);
  });

  test.afterAll(async () => {
    await app?.close();
    sink?.server.close();
  });

  test("the console's feedback popover posts the message, reaction, and context to the API", async () => {
    // The trigger sits in the console header; the popover is Geist's: field, emoji row, Send.
    const trigger = shell.getByTestId("console-feedback");
    await trigger.click();
    const popover = shell.getByRole("dialog", { name: "Feedback" });
    await expect(popover).toBeVisible();
    const field = popover.getByPlaceholder("Your feedback...");
    await expect(field).toBeFocused();
    const send = popover.getByRole("button", { name: "Send" });
    await expect(send).toBeDisabled();
    await captureShell(shell, "console-feedback", "01-popover-open.png");

    await popover.getByRole("radio", { name: "Loved it" }).click();
    await expect(popover.getByRole("radio", { name: "Loved it" })).toHaveAttribute("aria-checked", "true");
    await field.fill("The vendor link opened the wrong page.");
    await expect(send).toBeEnabled();
    await captureShell(shell, "console-feedback", "02-popover-filled.png");
    await send.click();

    // Received: acknowledged in place, then the popover closes on its own.
    await expect(popover.getByRole("status")).toContainText("Your feedback has been received!");
    await captureShell(shell, "console-feedback", "03-popover-sent.png");
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
        // A reminder's finished report in the inbox is not an open conversation.
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
  });

  test("a link in a console message previews as a Glance; ⌘-click opens a tab instead", async () => {
    // The URL in the report is a real link; the prose around it is not.
    const link = shell.getByRole("link", { name: PREVIEW_URL });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", PREVIEW_URL);
    await captureShell(shell, "console-links", "01-link-in-console.png");

    // A plain click previews the page above the live tab and creates no tab.
    await link.click();
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect.poll(() => visibleTabViews(app)).toEqual([PREVIEW_URL]);
    const preview = await pageAt(app, PREVIEW_URL);
    expect(await tabUrls(shell)).toEqual([OWNER_URL]);
    await captureShell(shell, "console-links", "02-link-previewed.png");

    // Escape in the preview runs the usual close motion back to the owner.
    await preview.keyboard.press("Escape");
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect.poll(() => visibleTabViews(app)).toEqual([OWNER_URL]);

    // A second click while a preview is open replaces it rather than being ignored.
    await link.click();
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await link.click();
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect.poll(() => visibleTabViews(app)).toEqual([PREVIEW_URL]);
    expect(await tabUrls(shell)).toEqual([OWNER_URL]);
    await shell.getByTestId("glance-close").click();
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);

    // On the full-window reminders page a preview would open behind the page,
    // so the same link opens a tab and the page steps aside to show it. This
    // goes before the console's own ⌘-click: opening a link in a tab closes
    // any full-window page once the tab has LANDED (store.ts openLink), well
    // after the snapshot that first shows the tab — so a page opened between
    // those two moments would be swept away by the earlier click.
    await shell.getByRole("button", { name: "Details" }).click();
    const page = shell.getByTestId("reminders-page");
    await expect(page).toBeVisible();
    await page.getByRole("link", { name: PREVIEW_URL }).click();
    await expect.poll(() => tabUrls(shell)).toEqual([OWNER_URL, PREVIEW_URL]);
    await expect(page).toHaveCount(0);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);

    // ⌘-click asks for a real tab, as anywhere else in a browser.
    await link.click({ modifiers: ["Meta"] });
    await expect.poll(() => tabUrls(shell)).toEqual([OWNER_URL, PREVIEW_URL, PREVIEW_URL]);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
  });
});
