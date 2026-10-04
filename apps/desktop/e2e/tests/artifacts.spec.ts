import { expect, test, type Page } from "@playwright/test";
import { pageFirst, shellPage } from "./windows";
import { launchApp } from "./app";
import { activeTabUrl, pageAt, sameAddress } from "./agent-harness";

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
function seededLibrary(): Record<string, unknown> {
  const at = "2026-08-28T12:00:00.000Z";
  return {
    [`artifacts/${ARTIFACT_ID}.html`]: ARTIFACT_HTML,
    "artifacts.json": {
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
    },
  };
}

async function navigate(shell: Page, url: string): Promise<void> {
  await shell.keyboard.press("Meta+L");
  await expect(shell.getByTestId("address-input")).toBeFocused();
  await shell.getByTestId("address-input").fill(url);
  await shell.keyboard.press("Enter");
  await expect.poll(async () => sameAddress(await activeTabUrl(shell), url)).toBe(true);
}

test("a stored artifact serves at its address, is listed by the library, and cannot phone home", { tag: ["@pages", "@agent"] }, async () => {
  test.setTimeout(45_000);
  const { app } = await launchApp({ name: "artifacts", settings: pageFirst(), files: seededLibrary() });

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
    await expect.poll(async () => sameAddress(await activeTabUrl(shell), ARTIFACT_URL)).toBe(true);
  } finally {
    await app.close();
  }
});
