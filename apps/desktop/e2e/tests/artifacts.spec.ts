import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellPage } from "./windows";

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      suffix,
    ),
  ].find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

const ARTIFACT_ID = "feed00112233";
const ARTIFACT_URL = `pistachio://artifact/${ARTIFACT_ID}`;
const ARTIFACT_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Morning news feed</title></head>
<body><h1 data-testid="artifact-headline">Six stories since yesterday</h1></body>
</html>`;

/**
 * The library a previous session left behind: the store reads its files
 * once at startup, so seeding userData before launch is exactly the state
 * an already-built artifact has on the next morning's run.
 */
async function seedArtifact(userData: string): Promise<void> {
  const at = "2026-08-28T12:00:00.000Z";
  await mkdir(join(userData, "artifacts"), { recursive: true });
  await writeFile(join(userData, "artifacts", `${ARTIFACT_ID}.html`), ARTIFACT_HTML, "utf8");
  await writeFile(
    join(userData, "artifacts.json"),
    JSON.stringify({
      version: 1,
      artifacts: [
        {
          id: ARTIFACT_ID,
          title: "Morning news feed",
          brief: "What I missed since yesterday",
          createdAt: at,
          updatedAt: at,
          revision: 1,
          builtWith: "anthropic/claude-opus-5",
          source: { kind: "agent", runId: "run-e2e" },
        },
      ],
    }),
    "utf8",
  );
}

function activeUrl(shell: Page): Promise<string | null> {
  return shell.evaluate(async () => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    const current = await api.getSnapshot();
    return current.tabs.find((tab) => tab.id === current.activeTabId)?.url ?? null;
  });
}

/** Chromium may give a standard-scheme address a trailing slash; accept both. */
function sameAddress(candidate: string | null, url: string): boolean {
  return candidate === url || candidate === `${url}/`;
}

async function navigate(shell: Page, url: string): Promise<void> {
  await shell.keyboard.press("Meta+L");
  await expect(shell.getByTestId("address-input")).toBeFocused();
  await shell.getByTestId("address-input").fill(url);
  await shell.keyboard.press("Enter");
  await expect.poll(async () => sameAddress(await activeUrl(shell), url)).toBe(true);
}

async function pageAt(app: ElectronApplication, url: string): Promise<Page> {
  await expect.poll(() => app.windows().some((page) => sameAddress(page.url(), url))).toBe(true);
  const page = app.windows().find((candidate) => sameAddress(candidate.url(), url));
  if (page === undefined) throw new Error(`No Electron page at ${url}`);
  return page;
}

test("a stored artifact serves at its address, is listed by the library, and cannot phone home", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-artifacts-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst()));
  await seedArtifact(userData);
  const app: ElectronApplication = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: {
      ...process.env,
      PISTACHIO_E2E: "1",
      PISTACHIO_USER_DATA: userData,
    },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");

    // The page itself, in a normal tab.
    await navigate(shell, ARTIFACT_URL);
    const artifact = await pageAt(app, ARTIFACT_URL);
    await expect(artifact.getByTestId("artifact-headline")).toHaveText("Six stories since yesterday");
    await expect(artifact).toHaveTitle("Morning news feed");

    // Its CSP: a script in the page cannot reach out.
    const reach = await artifact.evaluate(() =>
      fetch("https://example.com/").then(
        () => "reached",
        () => "blocked",
      ),
    );
    expect(reach).toBe("blocked");

    // The library index links it; the link is a real navigation.
    await navigate(shell, "pistachio://artifacts");
    const index = await pageAt(app, "pistachio://artifacts");
    const link = index.locator(`a[href="${ARTIFACT_URL}"]`);
    await expect(link).toHaveText("Morning news feed");
    await link.click();
    await expect.poll(async () => sameAddress(await activeUrl(shell), ARTIFACT_URL)).toBe(true);
  } finally {
    await app.close();
  }
});
