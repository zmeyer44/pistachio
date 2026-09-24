/**
 * Notes (docs/notes.md): ⌘⌥N opens a blank note the shell draws in the pane
 * at `pistachio://notes/<id>`, the person types markdown that becomes
 * structure as they go, `/` offers blocks, a dropped picture lands as an
 * image the note keeps, and nothing is ever saved by hand: the library
 * lists the note, reopening it shows every word, and a native view stays
 * hidden behind the page throughout. No account is needed — notes are
 * local first and sync when there is one.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { NOTES_PAGE_URL } from "@pistachio/shell-contracts/notes";
import { shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/notes");

/** A 2×2 red PNG — enough for the editor's decode-and-downscale pipeline to take it. */
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoAADgYAgLC4OWUAAAAAElFTkSuQmCC",
  "base64",
);

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", executableSuffix)];
  return candidates.find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function captureShell(app: ElectronApplication, shell: Page, filename: string): Promise<void> {
  await shell.waitForTimeout(400);
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

function visibleTabViews(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.contentView.children.filter((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return false;
      const url = (child as WebContentsView).webContents.getURL();
      return !Object.values(hashes).some((hash) => url.endsWith(hash));
    }).length;
  }, CHROME_VIEW_HASHES);
}

async function tabs(shell: Page): Promise<Array<{ id: string; url: string; title: string }>> {
  return shell.evaluate(async () => {
    const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
    return snapshot.tabs.filter((tab) => tab.kind === "human").map(({ id, url, title }) => ({ id, url, title }));
  });
}

async function activeTab(shell: Page): Promise<{ id: string; url: string; title: string } | null> {
  return shell.evaluate(async () => {
    const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
    const tab = snapshot.tabs.find((candidate) => candidate.id === snapshot.activeTabId);
    return tab === undefined ? null : { id: tab.id, url: tab.url, title: tab.title };
  });
}

async function launch(prefix: string): Promise<{ app: ElectronApplication; userData: string }> {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  return { app, userData };
}

const body = (shell: Page) => shell.getByTestId("note-editor").locator(".ProseMirror");

test("notes: a new note by shortcut, written, pictured, kept, and listed", async () => {
  test.setTimeout(150_000);
  const { app, userData } = await launch("pistachio-notes-");
  try {
    const shell = await shellReady(app);
    await expect(shell.getByTestId("home-page")).toBeVisible();

    // ⌘⌥N: a blank note in a tab of its own, drawn by the shell.
    await shell.keyboard.press("Meta+Alt+N");
    await expect(shell.getByTestId("note-editor")).toBeVisible();
    await expect.poll(() => activeTab(shell).then((tab) => tab?.url ?? "")).toMatch(/^pistachio:\/\/notes\/[a-f0-9]{12}$/u);
    await expect.poll(() => visibleTabViews(app)).toBe(0);
    const noteUrl = (await activeTab(shell))!.url;
    await captureShell(app, shell, "01-blank-note.png");

    // The title is where the cursor lands; Enter moves into the body.
    await expect(shell.getByTestId("note-title")).toBeFocused();
    await shell.keyboard.type("Lisbon trip");
    await shell.keyboard.press("Enter");
    await expect(body(shell)).toBeFocused();
    await expect.poll(() => activeTab(shell).then((tab) => tab?.title ?? "")).toBe("Lisbon trip");

    // Markdown as it is typed: a heading, a list, a to-do, a quote.
    await shell.keyboard.type("# Plans");
    await shell.keyboard.press("Enter");
    await shell.keyboard.type("- Book flights");
    await shell.keyboard.press("Enter");
    await shell.keyboard.type("Find a hotel near Alfama");
    await shell.keyboard.press("Enter");
    await shell.keyboard.press("Enter");
    await shell.keyboard.type("[] Renew passport");
    await shell.keyboard.press("Enter");
    await shell.keyboard.press("Enter");
    await shell.keyboard.type("> Pastel de nata, every morning.");
    await shell.keyboard.press("Enter");
    await shell.keyboard.press("Enter");
    await expect(body(shell).locator("h1")).toHaveText("Plans");
    await expect(body(shell).locator("ul li")).toHaveCount(3);
    await expect(body(shell).locator("blockquote")).toContainText("Pastel de nata");
    await expect(shell.getByTestId("note-save-state")).toHaveText("Saved");
    await captureShell(app, shell, "02-typed.png");

    // "/" offers blocks; Escape leaves the paragraph as it was.
    await shell.keyboard.type("/");
    await expect(shell.getByTestId("note-slash-menu")).toBeVisible();
    await shell.keyboard.type("code");
    await expect(shell.getByTestId("note-slash-row").first()).toContainText("Code");
    await captureShell(app, shell, "03-slash-menu.png");
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("note-slash-menu")).toBeHidden();
    await shell.keyboard.press("Backspace");
    await shell.keyboard.press("Backspace");
    await shell.keyboard.press("Backspace");
    await shell.keyboard.press("Backspace");
    await shell.keyboard.press("Backspace");

    // A picture through the slash command's file picker: the same pipeline a drop takes.
    const picture = join(userData, "square.png");
    await writeFile(picture, RED_PNG);
    await shell.getByTestId("note-image-input").setInputFiles(picture);
    await expect(shell.getByTestId("note-image").locator("img")).toBeVisible();
    await expect(shell.getByTestId("note-save-state")).toHaveText("Saved");
    await captureShell(app, shell, "04-image.png");

    // Nothing was saved by hand, and it is all on disk.
    const index = JSON.parse(await readFile(join(userData, "notes.json"), "utf8")) as { notes: Array<{ id: string; title: string; blobIds: string[] }>; blobs: unknown[] };
    expect(index.notes).toHaveLength(1);
    expect(index.notes[0]!.title).toBe("Lisbon trip");
    expect(index.notes[0]!.blobIds).toHaveLength(1);
    expect(index.blobs).toHaveLength(1);
    const markdown = await readFile(join(userData, "notes", `${index.notes[0]!.id}.md`), "utf8");
    expect(markdown).toContain("# Plans");
    expect(markdown).toContain("- Book flights");
    expect(markdown).toContain("Renew passport");
    expect(markdown).toMatch(/note-blob:[a-f0-9]{24}/u);

    // The library lists it; opening the row brings the note back whole.
    await shell.getByTestId("note-back").click();
    await expect(shell.getByTestId("notes-library")).toBeVisible();
    await expect(shell.getByTestId("note-row")).toHaveCount(1);
    await expect(shell.getByTestId("note-row").first()).toContainText("Lisbon trip");
    await expect.poll(() => visibleTabViews(app)).toBe(0);
    await captureShell(app, shell, "05-library.png");
    await shell.getByTestId("note-row").first().click();
    await expect(shell.getByTestId("note-editor")).toBeVisible();
    await expect(body(shell).locator("h1")).toHaveText("Plans");
    await expect(shell.getByTestId("note-image").locator("img")).toBeVisible();
    expect((await activeTab(shell))!.url).toBe(noteUrl);
    // The placeholder behind the page says "Notes"; the tab keeps the note's name.
    await expect.poll(() => activeTab(shell).then((tab) => tab?.title ?? "")).toBe("Lisbon trip");

    // The home page's teaser knows it too.
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab("pistachio://home/"));
    await expect(shell.getByTestId("home-page")).toBeVisible();
    await expect(shell.getByTestId("home-note").first()).toContainText("Lisbon trip");
    await captureShell(app, shell, "06-home-teaser.png");

    const open = await tabs(shell);
    expect(open.some((tab) => tab.url === noteUrl)).toBe(true);
    expect(open.some((tab) => tab.url.startsWith(NOTES_PAGE_URL))).toBe(true);
  } finally {
    await app.close();
  }
});
