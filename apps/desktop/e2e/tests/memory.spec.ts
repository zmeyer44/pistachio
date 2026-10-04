import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { pageFirst, shellPage } from "./windows";
import { launchApp } from "./app";
import { captureWindow } from "./agent-harness";

/** The settings page lives in the chrome, so the window capture is the whole picture. */
function capture(app: ElectronApplication, filename: string): Promise<void> {
  // Let the page's 140ms fade-in settle first.
  return captureWindow(app, "memory", filename, 350);
}

/** The slice of a stored memory the assertions read back from disk. */
interface Entry {
  id: string;
  key: string | null;
  content: string;
  version: number;
  isLatest: boolean;
  isForgotten: boolean;
  review: string;
  source: { kind: string };
}

test("memory page writes keyed facts, versions them, reviews learned ones, and previews the prompt", { tag: ["@settings", "@agent"] }, async () => {
  test.setTimeout(60_000);
  const { app, userData } = await launchApp({
    name: "memory",
    settings: pageFirst(),
    files: {
      // A learned, unsure fact already on disk — what the review queue is for.
      "memory.json": {
        version: 1,
        entries: [
          {
            id: "learned-1",
            rootId: "learned-1",
            parentId: null,
            version: 1,
            isLatest: true,
            content: "Probably prefers morning meetings",
            label: null,
            key: null,
            kind: "dynamic",
            bucket: "routine",
            source: { kind: "learned", runId: null },
            confidence: 0.5,
            review: "pending",
            mentions: 1,
            createdAt: "2026-08-20T10:00:00.000Z",
            lastRecalledAt: null,
            isForgotten: false,
            forgottenAt: null,
            forgetAfter: null,
            forgetReason: null,
          },
          {
            id: "agent-1",
            rootId: "agent-1",
            parentId: null,
            version: 1,
            isLatest: true,
            content: "Ships everything to the office",
            label: null,
            key: null,
            kind: "static",
            bucket: "preference",
            source: { kind: "agent", runId: null },
            confidence: 0.8,
            review: "approved",
            mentions: 1,
            createdAt: "2026-08-21T10:00:00.000Z",
            lastRecalledAt: null,
            isForgotten: false,
            forgottenAt: null,
            forgetAfter: "2026-12-31T00:00:00.000Z",
            forgetReason: null,
          },
        ],
      },
    },
  });
  const file = async (): Promise<Entry[]> => (JSON.parse(await readFile(join(userData, "memory.json"), "utf8")) as { entries: Entry[] }).entries;
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await shell.keyboard.press("Meta+,");
    const page = shell.getByTestId("settings-page");
    await expect(page).toBeVisible();
    // Memory is a row of the Agent group's menu.
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Needs your review" })).toBeVisible();
    await capture(app, "01-review.png");

    // Review: keep the guess.
    await page.getByRole("button", { name: "Keep" }).click();
    await expect.poll(async () => (await file()).find((e) => e.id === "learned-1")?.review).toBe("approved");
    await expect(page.getByRole("heading", { name: "Needs your review" })).toHaveCount(0);

    // Profile: three keyed memories from one Save.
    await page.getByLabel("Preferred name").fill("Alex Kim");
    await page.getByLabel("About you").fill("Product designer. Runs most mornings.");
    await page.getByLabel("Time zone").selectOption("America/Denver");
    await page.getByRole("button", { name: "Save" }).first().click();
    await expect.poll(async () => (await file()).find((e) => e.key === "profile.name")?.content).toBe("Alex Kim");

    // Saving the name again versions it rather than duplicating.
    await page.getByLabel("Preferred name").fill("Alex");
    await page.getByRole("button", { name: "Save" }).first().click();
    await expect.poll(async () => (await file()).filter((e) => e.key === "profile.name").map((e) => [e.version, e.isLatest, e.content])).toEqual([
      [1, false, "Alex Kim"],
      [2, true, "Alex"],
    ]);

    // Locations and projects.
    await page.getByPlaceholder("Home").fill("Home");
    await page.getByPlaceholder("Denver, Colorado").fill("Denver, Colorado");
    await page.locator("section", { hasText: "Locations" }).first().getByRole("button", { name: "Add" }).click();
    await page.getByPlaceholder("Northstar").fill("Northstar");
    await page.getByPlaceholder("Invoice reconciliation pilot, launching in March").fill("Invoice pilot");
    await page.locator("section", { hasText: "Projects" }).first().getByRole("button", { name: "Add" }).click();
    await expect.poll(async () => (await file()).find((e) => e.key === "location.home")?.content).toBe("Denver, Colorado");
    await capture(app, "02-profile.png");

    // The full list: the agent's fact is there with its badges; add one by hand.
    const list = page.locator("section", { hasText: "Everything remembered" }).first();
    await expect(list).toContainText("Ships everything to the office");
    await expect(list).toContainText("Agent");
    await page.getByLabel("Fact", { exact: true }).fill("Prefers aisle seats on flights");
    await page.getByRole("button", { name: "Remember" }).click();
    await expect.poll(async () => (await file()).some((e) => e.content === "Prefers aisle seats on flights" && e.source.kind === "user")).toBe(true);
    await list.scrollIntoViewIfNeeded();
    await capture(app, "03-list.png");

    // Forget one from the list, find it under Forgotten, restore it.
    await list.getByRole("button", { name: "Forget Ships everything to the office" }).click();
    await expect.poll(async () => (await file()).find((e) => e.id === "agent-1")?.isForgotten).toBe(true);
    await list.getByRole("tab", { name: "Forgotten" }).click();
    await expect(list).toContainText("Forgotten in Settings");
    await capture(app, "04-forgotten.png");
    await list.getByRole("button", { name: "Restore" }).click();
    await expect.poll(async () => (await file()).find((e) => e.id === "agent-1")?.isForgotten).toBe(false);

    // The prompt preview carries all of it.
    await page.getByRole("button", { name: "Show" }).click();
    const preview = page.getByTestId("memory-prompt-preview");
    await expect(preview).toContainText("- Name: Alex");
    await expect(preview).toContainText("America/Denver");
    await expect(preview).toContainText("Home: Denver, Colorado");
    await expect(preview).toContainText("Prefers aisle seats on flights");
    await preview.scrollIntoViewIfNeeded();
    await capture(app, "05-preview.png");
  } finally {
    await app.close();
  }
});
