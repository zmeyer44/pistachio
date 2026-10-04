/**
 * The home page as a chat (shell-ui components/home/HomeChat.tsx): a
 * question typed into the home page's search and asked of Pistachio turns
 * the page into a conversation in place — the search pill becomes the
 * composer, the question is the first bubble, the run's work and reply
 * follow — and the same conversation is the console's open thread. Driven
 * against the demo executor (PISTACHIO_E2E), whose scripted run reaches an
 * approval the spec declines.
 */

import { expect, test, type ElectronApplication, type JSHandle, type Locator, type Page } from "@playwright/test";
import { HOME_PAGE_URL } from "@pistachio/shell-contracts/home";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { captureShell as captureWindow } from "./pages-harness";

/** capturePage right after a change returns the frame before it: let it paint first. */
function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  return captureWindow(app, `home-chat/${filename}`, 200);
}

async function snapshot(shell: Page): Promise<ShellSnapshot> {
  return shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot());
}

const QUESTION = "What is the tallest mountain on earth?";

/** A 1×1 PNG: an image the composer can show as a thumbnail. */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** What a drag from Finder carries: files, as a DataTransfer the page can read. */
async function fileDrag(shell: Page, files: Array<{ name: string; type: string; base64: string }>): Promise<JSHandle<DataTransfer>> {
  return shell.evaluateHandle((entries) => {
    const data = new DataTransfer();
    for (const entry of entries) {
      const bytes = Uint8Array.from(atob(entry.base64), (char) => char.charCodeAt(0));
      data.items.add(new File([bytes], entry.name, { type: entry.type }));
    }
    return data;
  }, files);
}

/** The drag events a held (and let go) drag fires at the element under it. */
async function dragEvents(target: Locator, data: JSHandle<DataTransfer>, types: string[]): Promise<void> {
  await target.evaluate(
    (element, { data, types }) => {
      for (const type of types) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    },
    { data, types },
  );
}

test("a question asked of Pistachio turns the home page into the conversation, and back", { tag: ["@home", "@agent"] }, async () => {
  test.setTimeout(90_000);
  const { app } = await launchApp({ settings: { layout: { sidebar: "pinned" } }, name: "home-chat" });
  try {
    const shell = await shellReady(app);
    const home = shell.getByTestId("home-page");
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute("data-mode", "home");
    const input = shell.getByTestId("home-search-input");
    await expect(input).toBeFocused();

    // The search offers to ask Pistachio itself, in its own row, and ↓ ↵ takes it.
    await shell.keyboard.type(QUESTION);
    const askRow = shell.getByTestId("home-search-results").locator('[data-suggestion-kind="ai"]');
    await expect(askRow).toContainText(`Ask Pistachio “${QUESTION}”`);
    await captureShell(app, "01-ask-row.png");
    await shell.keyboard.press("ArrowDown");
    await expect(askRow).toHaveClass(/bg-alpha-200/u);
    await shell.keyboard.press("Enter");

    // The page is the chat now: the question is the first bubble and the
    // composer has the keyboard; the tab is still the home tab.
    await expect(home).toHaveAttribute("data-mode", "chat");
    const chat = shell.getByTestId("home-chat");
    await expect(chat.getByTestId("user-message").first()).toContainText(QUESTION);
    await expect(shell.getByTestId("home-chat-input")).toBeFocused();
    await expect.poll(async () => (await snapshot(shell)).tabs.map((tab) => tab.url)).toEqual([HOME_PAGE_URL]);

    // Main's run is this tab's conversation: the demo executor's reply,
    // its trace, and the approval it stops at, all in the page.
    await expect.poll(async () => (await snapshot(shell)).run?.purpose).toBe(QUESTION);
    await expect(chat).toHaveAttribute("data-run-id", /.+/u);
    await expect(chat.getByTestId("assistant-message").first()).toContainText("I’m on it");
    await expect(chat.getByTestId("work-trace").first()).toBeVisible();
    await expect(chat.getByTestId("approval-card")).toBeVisible();
    await expect(shell.getByTestId("home-chat-title")).toHaveText(QUESTION);
    await captureShell(app, "02-conversation.png");

    // The sidebar shows the very same conversation.
    await shell.getByTestId("home-chat-sidebar").click();
    const panel = shell.getByTestId("agent-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("approval-card")).toBeVisible();
    await expect(panel.getByTestId("assistant-message").first()).toContainText("I’m on it");
    await captureShell(app, "03-with-sidebar.png");

    // The panel is a drop zone of its own, on the same hook: files let go
    // over its thread are staged in the console's composer, not the page's.
    const report = await fileDrag(shell, [{ name: "report.md", type: "text/markdown", base64: Buffer.from("# Report").toString("base64") }]);
    await dragEvents(panel.getByTestId("assistant-message").first(), report, ["dragenter", "dragover"]);
    await expect(panel.getByTestId("attachment-drop-veil")).toBeVisible();
    await expect(shell.getByTestId("home-chat-drop-veil")).toHaveCount(0);
    await dragEvents(panel.getByTestId("assistant-message").first(), report, ["drop"]);
    await expect(panel.getByTestId("attachment-drop-veil")).toHaveCount(0);
    await expect(panel.getByTestId("staged-attachments")).toContainText("report.md");
    await expect(shell.getByTestId("home-staged-attachments")).toHaveCount(0);
    await shell.getByTestId("console-close").click();

    // Declining the approval ends the run; the page still shows the thread.
    await chat.getByTestId("reject-button").click();
    await expect.poll(async () => (await snapshot(shell)).run?.status).toBe("rejected");
    await expect(chat.getByTestId("home-chat-send")).toBeVisible();

    // The whole page is a drop zone: files held over the thread — not the
    // composer — raise the veil, and let go there they are staged in the
    // composer for the next message. A drag that leaves puts nothing down,
    // and a drag of text is not a drop of files.
    const veil = shell.getByTestId("home-chat-drop-veil");
    const staged = shell.getByTestId("home-staged-attachments");
    const overThread = chat.getByTestId("user-message").first();
    const text = await shell.evaluateHandle(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "just words");
      return data;
    });
    await dragEvents(overThread, text, ["dragenter", "dragover"]);
    await expect(veil).toHaveCount(0);
    await dragEvents(overThread, text, ["dragleave"]);
    const files = await fileDrag(shell, [
      { name: "notes.txt", type: "text/plain", base64: Buffer.from("Everest is 8,849 m.").toString("base64") },
      { name: "pixel.png", type: "image/png", base64: PIXEL_PNG },
    ]);
    await dragEvents(overThread, files, ["dragenter", "dragover"]);
    await expect(veil).toBeVisible();
    await expect(veil).toContainText("Drop files to attach");
    await captureShell(app, "04-drop-veil.png");
    await dragEvents(overThread, files, ["dragleave"]);
    await expect(veil).toHaveCount(0);
    await expect(staged).toHaveCount(0);
    await dragEvents(overThread, files, ["dragenter", "dragover", "drop"]);
    await expect(veil).toHaveCount(0);
    await expect(staged.locator(":scope > span")).toHaveCount(2);
    await expect(staged).toContainText("notes.txt");
    await expect(staged.getByRole("img", { name: "pixel.png" })).toBeVisible();
    await expect(shell.getByTestId("home-chat-input")).toBeFocused();
    await expect(chat.getByTestId("home-chat-send")).toBeEnabled();
    await captureShell(app, "05-files-staged.png");

    // Back to the home page: the search is back with the keyboard, and the
    // conversation is still the console's open thread.
    await shell.getByTestId("home-chat-home").click();
    await expect(home).toHaveAttribute("data-mode", "home");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("");
    expect((await snapshot(shell)).run?.purpose).toBe(QUESTION);
    await captureShell(app, "06-home-again.png");
  } finally {
    await app.close();
  }
});
