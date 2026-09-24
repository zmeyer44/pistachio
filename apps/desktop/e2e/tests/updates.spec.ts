import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { shellReady } from "./windows";

/**
 * The update flow against a local release feed: a `latest-mac.yml` naming a
 * far-future version and a small stand-in "zip" whose sha512 it carries.
 * electron-updater only verifies the archive at install time, so the check
 * and the download are exercised end to end without a real build. The pill
 * in the chrome and the About page are the two places the person acts from.
 */

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", executableSuffix),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

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

test("an available update is offered in the chrome and downloaded only on request", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-updates-"));
  // Skip the first-run wizard so the chrome is up.
  await writeFile(join(userData, "settings.json"), JSON.stringify({ onboarding: { completed: true } }));
  const feed = await serveFeed();

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, PISTACHIO_UPDATE_FEED: feed.url },
  });
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

test("a dev run without a feed says updates are for the installed app", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-updates-dev-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ onboarding: { completed: true } }));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, PISTACHIO_UPDATE_FEED: "" },
  });
  try {
    const shell = await shellReady(app);
    await expect(shell.getByTestId("update-pill")).toHaveCount(0);
    await shell.keyboard.press("Meta+,");
    const page = shell.getByTestId("settings-page");
    await page.getByRole("button", { name: "About", exact: true }).click();
    await expect(page.getByText("Updates apply to the installed app")).toBeVisible();
  } finally {
    await app.close();
  }
});
