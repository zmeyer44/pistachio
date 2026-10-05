import { expect, test, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { launchApp } from "./app";
import { activeTabUrl, captureShell, sameAddress } from "./agent-harness";
import { sidebarMenuItem } from "./footer";
import { shellPage } from "./windows";

const ARTIFACT_ID = "feed00112233";
const ARTIFACT_URL = `pistachio://artifact/${ARTIFACT_ID}`;
const AT = "2026-10-01T09:00:00.000Z";

/**
 * What an earlier session left behind: an artifact the agent built and a
 * page the person saved. The stores read their files once at startup, so
 * seeding userData is exactly that state.
 */
function seeded(): Record<string, unknown> {
  return {
    [`artifacts/${ARTIFACT_ID}.html`]: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Morning news feed</title></head><body><h1>Six stories</h1></body></html>`,
    "artifacts.json": {
      version: 1,
      artifacts: [
        {
          id: ARTIFACT_ID,
          title: "Morning news feed",
          brief: "What I missed since yesterday",
          createdAt: AT,
          updatedAt: AT,
          revision: 1,
          builtWith: "anthropic/claude-opus-5",
          source: { kind: "agent", runId: "run-e2e" },
        },
      ],
    },
    "bookmarks.json": {
      version: 1,
      bookmarks: [
        {
          id: "6f1c2a3e-0d4b-4c5e-9f6a-7b8c9d0e1f2a",
          url: "https://shop.example/espresso",
          kind: "product",
          title: "Espresso machine",
          siteName: "Shop",
          createdAt: AT,
        },
      ],
    },
  };
}

async function openLibrary(shell: Page): Promise<void> {
  await (await sidebarMenuItem(shell, "library-button")).click();
  await expect(shell.getByTestId("library-page")).toBeVisible();
}

test("the library gathers artifacts, notes and saved pages from the sidebar menu, and opens each", { tag: ["@pages", "@sidebar"] }, async () => {
  test.setTimeout(60_000);
  const { app } = await launchApp({ name: "library", settings: { layout: { sidebar: "pinned" } }, files: seeded() });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const noteId = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const response = await api.notes({ type: "create", input: { title: "Groceries", markdown: "milk, eggs, coffee" } });
      return response.type === "note" ? response.note.id : null;
    });
    expect(noteId).not.toBeNull();

    await openLibrary(shell);
    const library = shell.getByTestId("library-page");
    await expect(library.getByTestId("library-summary")).toContainText("1 artifact · 1 note · 1 saved");
    await expect(library.getByTestId("library-artifact")).toHaveText(/Morning news feed/);
    await expect(library.getByTestId("library-note")).toHaveText(/Groceries/);
    await expect(library.getByTestId("library-saved")).toHaveText(/Espresso machine/);
    // Watchtower answers for itself: a fresh profile has read nothing.
    await expect(library.getByTestId("library-summary")).toContainText("0 visits");
    await expect(library.getByTestId("library-section-watchtower")).toContainText(/Watchtower is off|Nothing read yet/);
    await captureShell(shell, "library", "overview.png");

    // A filter narrows every kind at once; a kind with nothing matching steps aside.
    await library.getByTestId("library-filter").fill("coffee");
    await expect(library.getByTestId("library-note")).toHaveText(/Groceries/);
    await expect(library.getByTestId("library-section-artifacts")).toHaveCount(0);
    await expect(library.getByTestId("library-section-saved")).toHaveCount(0);
    await library.getByTestId("library-filter").fill("");

    // An artifact opens at this Mac's own copy, and the page gets out of the way.
    await library.getByTestId("library-artifact").click();
    await expect(library).toHaveCount(0);
    await expect.poll(async () => sameAddress(await activeTabUrl(shell), ARTIFACT_URL)).toBe(true);

    // One kind's view lists it whole; a note opens in its own tab.
    await openLibrary(shell);
    await shell.getByTestId("library-view-notes").click();
    await expect(shell.getByTestId("library-section-artifacts")).toHaveCount(0);
    await captureShell(shell, "library", "notes-view.png");
    await shell.getByTestId("library-note").click();
    await expect(shell.getByTestId("library-page")).toHaveCount(0);
    await expect.poll(async () => sameAddress(await activeTabUrl(shell), `pistachio://notes/${noteId}`)).toBe(true);

    // The menu's row closes the page it opened, and Escape does too.
    await openLibrary(shell);
    await (await sidebarMenuItem(shell, "library-button")).click();
    await expect(shell.getByTestId("library-page")).toHaveCount(0);
    await openLibrary(shell);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("library-page")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
