import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { renderNoteHtml } from "@pistachio/notes";
import { chromiumPath, enterPin, signUpInTab, startWebStack, type WebStack } from "./web-harness";

/**
 * A note shared with a named account, on the web (docs/notes.md §9), and the
 * page a note is published as (§8) — the two places a note's widgets have to
 * work outside the desktop.
 *
 * Two accounts sign up on `www`, each its own device. The owner's device
 * names the second as an editor and pushes the body in both its forms, the
 * way the Mac does; the editor opens it from "Shared with me" in the same
 * block editor the desktop writes with, where the callout is a callout and
 * the widget's script runs, writes into it, and the owner reads back HTML
 * with the widget still in it and markdown derived from that HTML. Then the
 * owner publishes the rendered page, and a reader with no account opens it:
 * the widget runs there too, in a frame sized by what it reports.
 */

const PASSWORD = "correct-horse-battery";
const SCREENSHOTS = "e2e/screenshots/www-shared-note";
/** Twelve hex, as a note id is (docs/notes.md N6). */
const NOTE_ID = "9f8e7d6c5b4a";

/** A value inside a double-quoted attribute: what the editor's schema writes. */
function attr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const WIDGET = '<div id="w" style="height: 160px">inside</div><script>document.getElementById("w").textContent = "ran";</script>';
const BODY_HTML =
  "<p>Olives.</p>" +
  '<div data-type="callout" data-emoji="💡"><p>Bring cash</p></div>' +
  `<div data-type="html-block" data-html="${attr(WIDGET)}"></div>` +
  '<img src="note-blob:0123456789abcdef01234567" alt="the owner\'s own picture">';
const BODY_MARKDOWN = `Olives.\n\n> 💡 Bring cash\n\n\`\`\`html live\n${WIDGET}\n\`\`\`\n\n![the owner's own picture](note-blob:0123456789abcdef01234567)`;

test("shared notes on the web: the block editor writes back, and the published page runs a widget", { tag: ["@web"] }, async ({ browser }) => {
  // A cold `next dev`, a real Chromium fleet behind control, two sign-ups.
  test.setTimeout(600_000);
  const chromium = chromiumPath();
  test.skip(chromium === null, "no Chromium build is available for the cloud browser");

  const stack: WebStack = await startWebStack({ chromium, name: "www-shared-note", apps: ["www"] });
  const { controlUrl, urls } = stack;

  /** Control, as the owner's device: the share and the body are the Mac's to push (§9). */
  const api = async (
    path: string,
    init: { token: string; body?: unknown; method?: string },
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await fetch(`${controlUrl}/v1${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        authorization: `Bearer ${init.token}`,
      },
      body: init.body === undefined ? null : JSON.stringify(init.body),
    });
    const text = await response.text();
    return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };

  const ownerContext = await browser.newContext();
  const editorContext = await browser.newContext();
  const readerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const editor = await editorContext.newPage();
  for (const [name, page] of [["owner", owner], ["editor", editor]] as const) {
    page.on("console", (message) => stack.noteWebLog(`${name} console: ${message.type()} ${message.text()}`));
    page.on("pageerror", (error) => stack.noteWebLog(`${name} error: ${error.message}`));
  }
  // The owner's device token, read off the dashboard's own calls to control:
  // the web app is a device too, and its bearer is what the share routes take.
  let ownerToken: string | null = null;
  owner.on("request", (request) => {
    if (!request.url().startsWith(controlUrl)) return;
    const auth = request.headers()["authorization"];
    if (auth?.startsWith("Bearer ") === true) ownerToken = auth.slice("Bearer ".length);
  });

  try {
    /* ------------------------------ two accounts ---------------------------- */

    const ownerEmail = `owner-${randomUUID().slice(0, 8)}@example.com`;
    const editorEmail = `editor-${randomUUID().slice(0, 8)}@example.com`;
    await signUpInTab(owner, { webUrl: urls.www, email: ownerEmail, password: PASSWORD, at: "/app" });
    await expect(owner.getByRole("navigation")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => ownerToken, { timeout: 60_000, message: "the dashboard never spoke to control" }).not.toBeNull();
    await signUpInTab(editor, { webUrl: urls.www, email: editorEmail, password: PASSWORD, at: "/app" });
    await expect(editor.getByRole("navigation")).toBeVisible({ timeout: 60_000 });

    /* ------------------------- the owner shares a note ---------------------- */

    const shared = await api(`/notes/${NOTE_ID}/shares`, { token: ownerToken!, body: { email: editorEmail, role: "editor" } });
    expect(shared.status).toBe(200);
    expect(shared.json["share"]).not.toBeNull();
    const pushed = await api(`/notes/${NOTE_ID}/shared`, {
      token: ownerToken!,
      method: "PUT",
      body: { title: "Groceries", html: BODY_HTML, markdown: BODY_MARKDOWN, revision: 1 },
    });
    expect(pushed.status).toBe(200);
    expect(pushed.json).toMatchObject({ stale: false });

    /* --------------------- the editor writes, on the web -------------------- */

    await editor.goto(`${urls.www}/app/shared`);
    await enterPin(editor);
    await editor.getByRole("link", { name: /Groceries/u }).click();
    const document = editor.getByTestId("shared-note-document");
    await expect(document).toBeVisible({ timeout: 60_000 });
    await expect(document).toHaveAttribute("data-editable", "true");
    // The same blocks the desktop shows: a callout, a widget whose script
    // runs in its own frame, and the owner's picture said to be elsewhere.
    await expect(editor.getByTestId("note-callout")).toContainText("Bring cash");
    const frame = editor.getByTestId("note-html-block-frame");
    await expect(frame).toBeVisible();
    await expect(editor.frameLocator('[data-testid="note-html-block-frame"]').locator("#w")).toHaveText("ran");
    await expect.poll(() => frame.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(160);
    await expect(editor.getByTestId("note-image")).toContainText("stays on the owner's devices");
    await editor.screenshot({ path: `${SCREENSHOTS}/01-editor.png`, fullPage: true });

    await editor.getByTestId("note-body").locator("p", { hasText: /^Olives\.$/u }).click();
    await editor.keyboard.press("End");
    await editor.keyboard.type(" Capers.");
    await expect(editor.getByTestId("shared-note-save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await editor.screenshot({ path: `${SCREENSHOTS}/02-saved.png`, fullPage: true });

    /* ------------------------ the owner reads it back ----------------------- */

    const back = await api(`/notes/${NOTE_ID}/shared`, { token: ownerToken! });
    const note = back.json["note"] as { title: string; html: string; markdown: string; revision: number };
    expect(note.revision).toBe(2);
    expect(note.html).toContain("<p>Olives. Capers.</p>");
    // The widget and the picture came through the edit untouched: the body
    // is edited as HTML (N1), never flattened through markdown.
    expect(note.html).toContain(`data-html="${attr(WIDGET)}"`);
    expect(note.html).toContain('src="note-blob:0123456789abcdef01234567"');
    // And the markdown beside it was derived from that HTML, in the browser.
    expect(note.markdown).toContain("Olives. Capers.");
    expect(note.markdown).toContain("> 💡 Bring cash");
    expect(note.markdown).toContain("```html live\n");

    /* --------------------- the published page, to anyone -------------------- */

    const rendered = renderNoteHtml({ title: note.title, html: note.html, icon: null }, { blob: () => null });
    const published = await api(`/notes/${NOTE_ID}/visibility`, {
      token: ownerToken!,
      method: "PUT",
      body: { revision: note.revision, visibility: "public", html: rendered },
    });
    expect(published.status).toBe(200);
    const shareId = (published.json["note"] as { shareId: string }).shareId;

    const reader = await readerContext.newPage();
    const response = await reader.goto(`${urls.www}/notes/${shareId}`);
    expect(response?.status()).toBe(200);
    const policy = response?.headers()["content-security-policy"] ?? "";
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).toContain("script-src 'unsafe-inline'");
    await expect(reader.locator("h1.note-title")).toHaveText("Groceries");
    await expect(reader.locator("p", { hasText: /^Olives\. Capers\.$/u })).toHaveCount(1);
    // The widget runs on the page as it ran in the editor, and the page's own
    // listener sizes its frame to the height it reports.
    await expect(reader.frameLocator("iframe.note-html-frame").locator("#w")).toHaveText("ran");
    await expect
      .poll(() => reader.locator("iframe.note-html-frame").evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThanOrEqual(160);
    await expect(reader.locator(".note-image-missing")).toHaveCount(1);
    await reader.screenshot({ path: `${SCREENSHOTS}/03-published.png`, fullPage: true });
  } catch (error) {
    const log = stack.logs();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nControl at ${controlUrl}, www at ${urls.www}\nControl log:\n${log.control.slice(-6_000)}\nWeb output:\n${log.web.slice(-8_000)}`,
    );
  } finally {
    await ownerContext.close();
    await editorContext.close();
    await readerContext.close();
    await stack.close();
  }
});
