import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { UpdateSnoozeRecord } from "@pistachio/shell-contracts/updates";
import { shellReady } from "./windows";
import { launchApp } from "./app";

/**
 * The update flow against a local release feed: a `latest-mac.yml` naming a
 * far-future version and a small stand-in "zip" whose sha512 it carries.
 * electron-updater only verifies the archive at install time, so the check
 * and the download are exercised end to end without a real build. The dialog
 * over the page, the pill in the chrome, and the About page are the places
 * the person acts from.
 * (A run with no feed at all is settings.spec.ts's: About says so.)
 */

const VERSION = "99.0.0";
const ARCHIVE = `Pistachio-${VERSION}-arm64-mac.zip`;

async function serveFeed(): Promise<{ server: Server; url: string; requests: string[] }> {
  const archive = randomBytes(256 * 1024);
  const sha512 = createHash("sha512").update(archive).digest("base64");
  const feed = [
    `version: ${VERSION}`,
    "files:",
    `  - url: ${ARCHIVE}`,
    `    sha512: ${sha512}`,
    `    size: ${archive.byteLength}`,
    `path: ${ARCHIVE}`,
    `sha512: ${sha512}`,
    `releaseDate: '2030-01-01T00:00:00.000Z'`,
    "",
  ].join("\n");
  const requests: string[] = [];
  const server = createServer((request, response) => {
    // electron-updater appends a cache-buster query to the feed request.
    const path = new URL(request.url ?? "/", "http://feed").pathname;
    requests.push(path);
    if (path.endsWith("latest-mac.yml")) {
      response.writeHead(200, { "content-type": "text/yaml" });
      response.end(feed);
    } else if (path.endsWith(ARCHIVE)) {
      response.writeHead(200, { "content-type": "application/zip", "content-length": archive.byteLength });
      response.end(archive);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("feed did not bind");
  return { server, url: `http://127.0.0.1:${address.port}/`, requests };
}

test("an available update is offered in the chrome and downloaded only on request", { tag: ["@settings"] }, async () => {
  const feed = await serveFeed();
  // Skip the first-run wizard so the chrome is up.
  const { app } = await launchApp({ settings: { onboarding: { completed: true } }, env: { PISTACHIO_UPDATE_FEED: feed.url }, name: "updates" });
  try {
    const shell = await shellReady(app);

    // The scheduled check waits fifteen seconds; About's "Check now" does not.
    await shell.keyboard.press("Meta+,");
    const page = shell.getByTestId("settings-page");
    await expect(page).toBeVisible();
    await page.getByRole("button", { name: "About", exact: true }).click();
    await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
    await page.getByTestId("update-check").click();

    // Available: nothing downloaded yet — only the feed was read.
    const pill = shell.getByTestId("update-pill");
    await expect(pill).toHaveAttribute("data-status", "available");
    await expect(pill).toHaveText("Update");
    await expect(page.getByTestId("update-download")).toBeVisible();
    expect(feed.requests.some((url) => url.endsWith(ARCHIVE))).toBe(false);

    // The download starts from the pill and ends with a restart offer in both places.
    await pill.click();
    await expect(pill).toHaveAttribute("data-status", "ready");
    await expect(pill).toHaveText("Restart");
    await expect(page.getByTestId("update-install")).toBeVisible();
    expect(feed.requests.some((url) => url.endsWith(ARCHIVE))).toBe(true);
  } finally {
    await app.close();
    feed.server.close();
  }
});

/** The scheduled check waits fifteen seconds; ask now, the way About's "Check now" does. */
async function checkNow(shell: Page): Promise<void> {
  await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.checkForUpdates());
}

test("an available update is offered over the page until it is put off", { tag: ["@settings"] }, async () => {
  const feed = await serveFeed();
  const options = { settings: { onboarding: { completed: true } }, env: { PISTACHIO_UPDATE_FEED: feed.url } };
  const launched = await launchApp({ ...options, name: "update-prompt" });
  const { userData } = launched;
  let { app } = launched;
  const snoozeFile = join(userData, "update-prompt.json");
  try {
    // First offer: over the page, with only "tomorrow" to put it off.
    let shell = await shellReady(app);
    await checkNow(shell);
    const prompt = shell.getByTestId("update-prompt");
    await expect(prompt).toHaveAttribute("data-phase", "offer");
    await expect(prompt).toContainText(VERSION);
    await expect(shell.getByTestId("update-prompt-later")).toHaveCount(0);
    await shell.getByTestId("update-prompt-tomorrow").click();
    await expect(prompt).toHaveCount(0);
    // The pill stays, and nothing was downloaded.
    await expect(shell.getByTestId("update-pill")).toHaveAttribute("data-status", "available");
    expect(feed.requests.some((url) => url.endsWith(ARCHIVE))).toBe(false);
    await expect
      .poll(async () => JSON.parse(await readFile(snoozeFile, "utf8").catch(() => "null")) as UpdateSnoozeRecord | null)
      .toMatchObject({ version: VERSION, count: 1 });

    // A relaunch within the day keeps it put off.
    await app.close();
    ({ app } = await launchApp({ ...options, userData }));
    shell = await shellReady(app);
    await checkNow(shell);
    await expect
      .poll(() => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getUpdateState()))
      .toMatchObject({ status: "available", prompt: { due: false, snoozes: 1 } });
    await expect(shell.getByTestId("update-pill")).toHaveAttribute("data-status", "available");
    await expect(shell.getByTestId("update-prompt")).toHaveCount(0);

    // A day later it is back, and now "later" is on offer too.
    await app.close();
    const record = JSON.parse(await readFile(snoozeFile, "utf8")) as UpdateSnoozeRecord;
    await writeFile(snoozeFile, JSON.stringify({ ...record, until: new Date(Date.now() - 1_000).toISOString() }));
    ({ app } = await launchApp({ ...options, userData }));
    shell = await shellReady(app);
    await checkNow(shell);
    await expect(shell.getByTestId("update-prompt")).toHaveAttribute("data-phase", "offer");
    await shell.getByTestId("update-prompt-later").click();
    await expect(shell.getByTestId("update-prompt")).toHaveCount(0);
    await expect
      .poll(async () => JSON.parse(await readFile(snoozeFile, "utf8")) as UpdateSnoozeRecord)
      .toMatchObject({ version: VERSION, until: null, count: 2 });
    await expect(shell.getByTestId("update-pill")).toHaveAttribute("data-status", "available");
  } finally {
    await app.close();
    feed.server.close();
  }
});
