import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { pageFirst, shellPage } from "./windows";

/** The settings page lives in the chrome, so the shell capture is the whole picture. */
const screenshotDirectory = join(process.cwd(), "e2e/screenshots/memory");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ];
  return candidates.find((c) => c !== undefined && existsSync(c) && existsSync(resolve(dirname(c), "../Info.plist")));
}

async function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  // Let the page's 140ms fade-in settle first.
  await new Promise((done) => setTimeout(done, 350));
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w === undefined) throw new Error("no window");
    return (await w.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
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

test("memory page writes keyed facts, versions them, reviews learned ones, and previews the prompt", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No Electron runtime");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-memory-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst()));
  // A learned, unsure fact already on disk — what the review queue is for.
  await writeFile(
    join(userData, "memory.json"),
    JSON.stringify({
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
    }),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  const file = async (): Promise<Entry[]> => (JSON.parse(await readFile(join(userData, "memory.json"), "utf8")) as { entries: Entry[] }).entries;
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await shell.keyboard.press("Meta+i");
    await shell.keyboard.press("Meta+,");
    const page = shell.getByTestId("settings-page");
    await expect(page).toBeVisible();
    // Memory is a row of the Agent group's menu.
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Needs your review" })).toBeVisible();
    await captureShell(app, "01-review.png");

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
    await captureShell(app, "02-profile.png");

    // The full list: the agent's fact is there with its badges; add one by hand.
    const list = page.locator("section", { hasText: "Everything remembered" }).first();
    await expect(list).toContainText("Ships everything to the office");
    await expect(list).toContainText("Agent");
    await page.getByLabel("Fact", { exact: true }).fill("Prefers aisle seats on flights");
    await page.getByRole("button", { name: "Remember" }).click();
    await expect.poll(async () => (await file()).some((e) => e.content === "Prefers aisle seats on flights" && e.source.kind === "user")).toBe(true);
    await list.scrollIntoViewIfNeeded();
    await captureShell(app, "03-list.png");

    // Forget one from the list, find it under Forgotten, restore it.
    await list.getByRole("button", { name: "Forget Ships everything to the office" }).click();
    await expect.poll(async () => (await file()).find((e) => e.id === "agent-1")?.isForgotten).toBe(true);
    await list.getByRole("tab", { name: "Forgotten" }).click();
    await expect(list).toContainText("Forgotten in Settings");
    await captureShell(app, "04-forgotten.png");
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
    await captureShell(app, "05-preview.png");
  } finally {
    await app.close();
  }
});
