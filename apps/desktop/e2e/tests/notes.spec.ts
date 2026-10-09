/**
 * Notes (docs/notes.md): ⌘⌥N opens a blank note the shell draws in the pane
 * at `pistachio://notes/<id>`, the person types markdown that becomes
 * structure as they go, `/` offers blocks, a dropped picture lands as an
 * image the note keeps, and nothing is ever saved by hand: the library
 * lists the note, reopening it shows every word, and a native view stays
 * hidden behind the page throughout. No account is needed — notes are
 * local first and sync when there is one.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { IPC, type PistachioApi } from "@pistachio/shell-contracts/ipc";
import { NOTES_PAGE_URL } from "@pistachio/shell-contracts/notes";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { windowInUse } from "./desk-harness";
import { captureShell as captureWindow, humanTabs as tabs, visibleTabViews } from "./pages-harness";

/** A 2×2 red PNG — enough for the editor's decode-and-downscale pipeline to take it. */
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoAADgYAgLC4OWUAAAAAElFTkSuQmCC",
  "base64",
);

function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  return captureWindow(app, `notes/${filename}`, 400);
}

async function activeTab(shell: Page): Promise<{ id: string; url: string; title: string } | null> {
  return shell.evaluate(async () => {
    const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
    const tab = snapshot.tabs.find((candidate) => candidate.id === snapshot.activeTabId);
    return tab === undefined ? null : { id: tab.id, url: tab.url, title: tab.title };
  });
}

const body = (shell: Page) => shell.getByTestId("note-editor").locator(".ProseMirror");

/** Main's read aloud stood in for: what the shell asks it to speak, and under what name. */
async function standInForReadAloud(app: ElectronApplication): Promise<() => Promise<unknown[][]>> {
  await app.evaluate(({ ipcMain }, channel) => {
    const calls: unknown[][] = [];
    (globalThis as { readAloudCalls?: unknown[][] }).readAloudCalls = calls;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, ...args: unknown[]) => {
      calls.push(args);
    });
  }, IPC.readAloudSpeak);
  return () => app.evaluate(() => (globalThis as { readAloudCalls?: unknown[][] }).readAloudCalls ?? []);
}

/** The title's height, and the height its text needs at its width now (a copy of it measured). */
function titleFit(shell: Page): Promise<{ height: number; needed: number }> {
  return shell.evaluate(() => {
    // (The note in use: on the desk, the window in use's.)
    const title = (document.querySelector<HTMLTextAreaElement>('[data-testid="desk-window"][data-focused] [data-testid="note-title"]') ??
      document.querySelector<HTMLTextAreaElement>('[data-testid="note-title"]'))!;
    const copy = title.cloneNode() as HTMLTextAreaElement;
    copy.value = title.value;
    copy.style.cssText = `position: absolute; visibility: hidden; height: 0px; width: ${String(title.clientWidth)}px`;
    title.parentElement!.append(copy);
    const needed = copy.scrollHeight;
    copy.remove();
    return { height: title.offsetHeight, needed };
  });
}

test("notes: a new note by shortcut, written, pictured, kept, and listed", { tag: ["@smoke", "@pages"] }, async () => {
  test.setTimeout(90_000);
  const { app, userData } = await launchApp({ settings: { layout: { sidebar: "pinned" } }, name: "notes" });
  try {
    const shell = await shellReady(app);
    await expect(shell.getByTestId("home-page")).toBeVisible();

    // ⌘⌥N: a blank note in a tab of its own, drawn by the shell.
    await shell.keyboard.press("Meta+Alt+N");
    await expect(shell.getByTestId("note-editor")).toBeVisible();
    await expect.poll(() => activeTab(shell).then((tab) => tab?.url ?? "")).toMatch(/^pistachio:\/\/notes\/[a-f0-9]{12}$/u);
    await expect.poll(() => visibleTabViews(app)).toBe(0);
    const noteUrl = (await activeTab(shell))!.url;
    await captureShell(app, "01-blank-note.png");

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
    await captureShell(app, "02-typed.png");

    // "/" offers blocks; Escape leaves the paragraph as it was.
    await shell.keyboard.type("/");
    await expect(shell.getByTestId("note-slash-menu")).toBeVisible();
    await shell.keyboard.type("code");
    await expect(shell.getByTestId("note-slash-row").first()).toContainText("Code");
    await captureShell(app, "03-slash-menu.png");
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
    await captureShell(app, "04-image.png");

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
    await captureShell(app, "05-library.png");
    await shell.getByTestId("note-row").first().click();
    await expect(shell.getByTestId("note-editor")).toBeVisible();
    await expect(body(shell).locator("h1")).toHaveText("Plans");
    await expect(shell.getByTestId("note-image").locator("img")).toBeVisible();
    expect((await activeTab(shell))!.url).toBe(noteUrl);
    // The placeholder behind the page says "Notes"; the tab keeps the note's name.
    await expect.poll(() => activeTab(shell).then((tab) => tab?.title ?? "")).toBe("Lisbon trip");

    // Read aloud, from the bar's …: the whole note, title first, as prose — its
    // markdown's punctuation gone, its picture unsaid — under the note's name.
    const spoken = await standInForReadAloud(app);
    await shell.getByTestId("note-menu").click();
    await shell.getByTestId("note-menu-read-aloud").click();
    await expect(shell.getByTestId("note-menu-panel")).toBeHidden();
    await expect
      .poll(spoken)
      .toEqual([["Lisbon trip.\n\nPlans.\n\nBook flights.\n\nFind a hotel near Alfama.\n\nRenew passport.\n\nPastel de nata, every morning.", "Lisbon trip"]]);

    // The home page's teaser knows it too.
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab("pistachio://home/"));
    // (Out on the desk as the window in use: the first home window is under it.)
    const home = windowInUse(shell).getByTestId("home-page");
    await expect(home).toBeVisible();
    await expect(home.getByTestId("home-note").first()).toContainText("Lisbon trip");
    await captureShell(app, "06-home-teaser.png");

    const open = await tabs(shell);
    expect(open.some((tab) => tab.url === noteUrl)).toBe(true);
    expect(open.some((tab) => tab.url.startsWith(NOTES_PAGE_URL))).toBe(true);

    // A title keeps to its text as the window's width changes: written in a
    // narrow window until it wraps, then the window widened — one line again,
    // not the two it was measured at, so the body is not left far below it.
    await shell.keyboard.press("Meta+Alt+N");
    await expect(windowInUse(shell).getByTestId("note-title")).toBeFocused();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(980, 800));
    await shell.keyboard.type("Weekend");
    const oneLine = (await titleFit(shell)).height;
    // (A narrow letter at a time, so the line it wraps at is still short of the wide window's measure.)
    for (let word = 0; word < 60 && (await titleFit(shell)).height < oneLine * 1.5; word += 1) await shell.keyboard.type(" I");
    expect((await titleFit(shell)).height).toBeGreaterThan(oneLine * 1.5);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
    await expect.poll(async () => (await titleFit(shell)).needed).toBe(oneLine);
    await expect.poll(() => titleFit(shell)).toEqual({ height: oneLine, needed: oneLine });
    await captureShell(app, "07-title-widened.png");
  } finally {
    await app.close();
  }
});
