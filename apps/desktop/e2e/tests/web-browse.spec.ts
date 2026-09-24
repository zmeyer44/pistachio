import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { startFixture, type FixtureServer } from "../../../../services/cloud-browser/test/helpers/fixture-server.js";
import {
  chromiumPath,
  corsAllowed,
  openBrowseShell,
  openNewTab,
  enterPin,
  signUpInTab,
  startWebStack,
  walkFirstRun,
  type WebStack,
} from "./web-harness";

/**
 * S4's gate (docs/web-browser-design.md §7, §15): this app IS the browser.
 *
 * Everything under this test is real. Control runs on PGlite with its hub; a
 * cloud-browser worker runs beside it with real Chromium and no egress gateway
 * (`egressMode: 'direct'`); an HTTP fixture stands in for a site; and the web
 * browser app is `next dev --webpack` on its own port, pointed at control and building
 * into a private dist directory so it cannot contend with a developer's live
 * Next process.
 *
 * The path it walks is the product's: sign up in the browser, keys derived in
 * the tab, turn the cloud on for the Space, land on the shell at `/`, and use
 * the desktop's own chrome — the new-tab button, the address bar — to open a
 * page that is a Chromium tab on the worker, painted here as a screencast.
 * Typing goes the other way, over the same socket, and the fixture records
 * what arrives. THEN THE OUTER PAGE IS RELOADED: the session is durable and
 * the viewer is not, so the same tab must still be there afterwards.
 */

const PASSWORD = "correct-horse-battery";
const TYPED = "typed from the web";
/** The second note, typed into the SAME tab after the outer page was reloaded. */
const TYPED_AGAIN = "typed after the reload";
/** What `/payload.txt` serves, byte for byte, so a download can be compared. */
const PAYLOAD = "the bytes a cloud download must hand back unchanged\n";
/** What the person picks in their own browser and the cloud page receives. */
const UPLOADED = "picked in the person's own browser\n";
const SCREENSHOTS = "e2e/screenshots/web-browse";

function escapeHtml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/**
 * The fixture site. `/` is one text field over one big Save button, both
 * placed by viewport percentage so the test can address them through the
 * screencast without knowing anything about layout: the field is the top
 * third of the page and the button is the bottom half. Typing lands in the
 * field and the click submits it to `/typed`, so what this process records is
 * proof that the keystrokes AND the pointer crossed the socket, the host, CDP
 * and the page — the pointer through `@pistachio/live-view`'s arithmetic,
 * which is the part that fails silently when it is wrong.
 */
function formHtml(): string {
  return [
    "<!doctype html><html><head><title>Cloud fixture</title>",
    "<style>body{margin:0;font:32px system-ui}",
    "#note{position:fixed;left:0;top:0;width:100%;height:30%;font-size:32px;box-sizing:border-box}",
    "#save{position:fixed;left:0;bottom:0;width:100%;height:50%;font-size:32px}</style>",
    "</head><body>",
    '<form action="/typed" method="GET">',
    '<input id="note" name="note" type="text" autofocus>',
    '<button id="save" type="submit">Save</button>',
    "</form></body></html>",
  ].join("");
}

/**
 * §11's two round trips that exist only because the page is a picture inside
 * somebody else's browser: a download whose bytes must reach THAT browser, and
 * a file picker that must open in it. Two full-width bands, addressed through
 * the screencast by viewport percentage like everything else here — big
 * targets, because a pointer that is a few percent out must fail loudly on the
 * form above rather than quietly here.
 */
function toolsHtml(): string {
  return [
    "<!doctype html><html><head><title>Cloud tools</title>",
    "<style>body{margin:0;font:32px system-ui}",
    "#get{position:fixed;left:0;top:0;width:100%;height:49%;display:grid;place-items:center;background:#eee}",
    "#pick{position:fixed;left:0;bottom:0;width:100%;height:49%;font-size:32px}</style>",
    "</head><body>",
    "<a id=\"get\" href=\"/payload.txt\" download>Download</a>",
    "<input id=\"pick\" type=\"file\">",
    "<script>",
    "document.getElementById('get').addEventListener('click', () => { fetch('/clicked'); });",
    "document.getElementById('pick').addEventListener('change', (event) => {",
    "  const file = event.target.files[0];",
    "  if (!file) return;",
    "  fetch('/picked?file=' + encodeURIComponent(file.name + ':' + String(file.size)));",
    "});",
    "</script>",
    "</body></html>",
  ].join("");
}

/**
 * What `/typed` serves back: the note the fixture recorded, read into a band
 * of its own at the top, over a field and a Save button placed like the
 * form's. The echo makes the recorded value part of the PICTURE, and the
 * field is what the reload half of this test types into — so the tab that
 * survived is one that can still be used, not merely one that is listed.
 */
function typedHtml(note: string): string {
  return [
    `<!doctype html><html><head><title>Typed: ${escapeHtml(note)}</title>`,
    "<style>body{margin:0;font:32px system-ui}",
    "#echo{position:fixed;left:0;top:0;width:100%;height:24%;margin:0;display:grid;place-items:center;",
    "font-size:44px;background:#eee}",
    "#note{position:fixed;left:0;top:25%;width:100%;height:24%;font-size:32px;box-sizing:border-box}",
    "#save{position:fixed;left:0;bottom:0;width:100%;height:50%;font-size:32px}</style>",
    "</head><body>",
    `<p id="echo">${escapeHtml(note)}</p>`,
    '<form action="/typed" method="GET">',
    '<input id="note" name="note" type="text">',
    '<button id="save" type="submit">Save</button>',
    "</form></body></html>",
  ].join("");
}

/**
 * What this process can see of the picture inside a pane. A frame is a whole
 * JPEG as a `data:` URL, so nothing here carries one across the CDP boundary:
 * `mark` is a cheap identity for the `src` and the rest is what the browser
 * itself knows about the image it decoded.
 */
interface PaintedFrame {
  /** `data-frame-seq`: how many frames this pane has painted since it mounted. */
  seq: number;
  /** The `src`'s scheme and encoding, which an empty or placeholder box has not got. */
  head: string;
  /** The `src`'s length and last bytes, so two frames can be told apart. */
  mark: string;
  /** What the <img> DECODED to. A frame that is not an image is 0x0 here. */
  width: number;
  height: number;
}

/** The frame a pane is showing, or `null` while it is still saying "Opening…". */
async function paintedFrame(pane: Locator): Promise<PaintedFrame | null> {
  return pane.evaluate((element: HTMLElement): PaintedFrame | null => {
    const image = element.querySelector<HTMLImageElement>('[data-testid="streamed-pane-frame"]');
    if (image === null) return null;
    const src = image.getAttribute("src") ?? "";
    return {
      seq: Number(image.getAttribute("data-frame-seq") ?? "0"),
      head: src.slice(0, "data:image/jpeg;base64,".length),
      mark: `${String(src.length)}:${src.slice(-64)}`,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  });
}

/**
 * The file a cloud download left on the worker's disk
 * (`CLOUD_BROWSER_STATE_DIR/<userId>/downloads/<id>-<name>`), so the test can
 * compare the bytes rather than trust the row.
 */
async function findDownloadedFile(stateDir: string, name: string): Promise<string | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const users = await readdir(stateDir, { withFileTypes: true }).catch(() => []);
    for (const user of users) {
      if (!user.isDirectory()) continue;
      const dir = join(stateDir, user.name, "downloads");
      const files = await readdir(dir).catch(() => []);
      const match = files.find((file) => file.endsWith(name));
      if (match !== undefined) return join(dir, match);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/** The shell's own chrome: one new tab, addressed at `url`. */
async function openTab(page: Page, url: string): Promise<void> {
  const address = await openNewTab(page);
  await address.fill(url);
  await address.press("Enter");
}

test("the web app opens a cloud tab, types into it, and finds it again after a reload", async ({ page }) => {
  // S6 added two more round trips to this walk (a download and an upload), on
  // top of a cold `next dev` and a real Chromium fleet.
  test.setTimeout(600_000);
  const chromium = chromiumPath();
  test.skip(chromium === null, "no Chromium build is available for the cloud browser");

  /** Every note the fixture was asked to record, in order. */
  const typed: string[] = [];
  /** What the fixture's upload form was handed, as the page reported it. */
  const uploads: string[] = [];
  const clicks: string[] = [];
  const fixture: FixtureServer = await startFixture((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/payload.txt") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="payload.txt"',
      });
      response.end(PAYLOAD);
      return;
    }
    if (url.pathname === "/tools") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(toolsHtml());
      return;
    }
    if (url.pathname === "/clicked") {
      clicks.push("get");
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/picked") {
      uploads.push(url.searchParams.get("file") ?? "");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body><p id=\"ok\">picked</p></body></html>");
      return;
    }
    if (url.pathname === "/typed") {
      const note = url.searchParams.get("note") ?? "";
      typed.push(note);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(typedHtml(note));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(formHtml());
  });

  const stack: WebStack = await startWebStack({
    chromium,
    name: "web-browse",
    allowedOrigins: [fixture.origin],
  });
  const { controlUrl, runnerUrl, webUrl, stateDir } = stack;
  expect(await corsAllowed(controlUrl, webUrl)).toBe(webUrl);
  page.on("console", (message) => {
    stack.noteWebLog(`Browser console: ${message.type()} ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    stack.noteWebLog(`Browser error: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    stack.noteWebLog(`Request failed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`);
  });

  try {

    /* ------------------------- an account, in the tab ----------------------- */

    // Signing up in the browser is also a password ceremony, so it wraps the
    // first Space for the cloud device on the way (cloud-sync-design.md §17),
    // and the gate then sends a new account straight to the browser (§14).
    const email = `browse-${randomUUID().slice(0, 8)}@example.com`;
    await signUpInTab(page, { webUrl, email, password: PASSWORD });

    /* ------------------------------- the shell ------------------------------ */

    await openBrowseShell(page);
    await page.screenshot({ path: `${SCREENSHOTS}/01-cloud-enabled.png`, fullPage: true });
    // A brand-new account lands in the first run (§14); its own gate is
    // `web-onboarding.spec.ts`. Here it is walked at speed, because what this
    // test is about starts once the chrome is on screen.
    await walkFirstRun(page, "Browse");
    await page.screenshot({ path: `${SCREENSHOTS}/02-shell-open.png`, fullPage: true });

    // A new tab is the home page, drawn here rather than streamed; its
    // search is the tab's address field.
    const address = await openNewTab(page);
    await expect(page.getByTestId("home-page").last()).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/02a-home-page.png`, fullPage: true });
    await address.fill(fixture.origin);
    await address.press("Enter");
    // The pane of the tab that WAS active — the walkthrough left the welcome
    // overview open — is still on screen while the new one loads, so the wait
    // has to name the page rather than take whichever pane is first. The name
    // is the one S6 gave the pane for a screen reader (§11): title and
    // address, as the host reports them.
    const pane = page.getByRole("region", { name: /Cloud fixture/u });
    await expect(pane).toBeVisible({ timeout: 60_000 });
    await expect(pane.getByTestId("streamed-pane-frame")).toBeVisible({ timeout: 60_000 });
    const tabId = await pane.getAttribute("data-streamed-pane");
    expect(tabId).not.toBeNull();
    await page.screenshot({ path: `${SCREENSHOTS}/03-fixture-painted.png`, fullPage: true });

    /* ------------------------ typing into the cloud page -------------------- */

    // The pointer first: a click in the top third of the painted frame is a
    // click in the cloud page's text field, which both gives the pane the
    // outer keyboard and gives the field the inner caret.
    const frame = pane.getByTestId("streamed-pane-frame");
    await page.screenshot({ path: `${SCREENSHOTS}/03a-before-typing.png`, fullPage: true });
    const box = await frame.boundingBox();
    expect(box).not.toBeNull();
    const at = (fx: number, fy: number): { x: number; y: number } => ({
      x: (box?.width ?? 0) * fx,
      y: (box?.height ?? 0) * fy,
    });
    await frame.click({ position: at(0.5, 0.15), timeout: 30_000 });
    await page.keyboard.type(TYPED, { delay: 20 });
    await page.screenshot({ path: `${SCREENSHOTS}/03b-typed-into-field.png`, fullPage: true });
    // …and the bottom half is the Save button, so the submit is a real click
    // travelling the same path.
    await frame.click({ position: at(0.5, 0.8), timeout: 30_000 });
    await expect
      .poll(() => typed, { timeout: 60_000, message: "the fixture never received the typed note" })
      .toContain(TYPED);
    await page.screenshot({ path: `${SCREENSHOTS}/04-typed.png`, fullPage: true });

    /* ----------------- a download, fetched into this browser ---------------- */

    // The Save above submitted the form, so that tab is showing `/typed` now.
    // A fresh tab on the fixture is where the rest of §11 happens.
    await openTab(page, `${fixture.origin}/tools`);
    // The pane of the tab that was already open is still on screen while the
    // new one loads, so the wait has to be for THIS page rather than for a
    // pane. The name is the one S6 gave the pane for a screen reader (§11) —
    // the tab's title and address — which makes it exactly the right handle.
    await expect(page.getByRole("region", { name: /Cloud tools/u })).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${SCREENSHOTS}/04a-tools-tab.png`, fullPage: true });
    const capability = page
      .getByRole("region", { name: /Cloud tools/u })
      .getByTestId("streamed-pane-frame");
    await expect(capability).toBeVisible({ timeout: 60_000 });
    const capabilityBox = await capability.boundingBox();
    expect(capabilityBox).not.toBeNull();
    const on = (fx: number, fy: number): { x: number; y: number } => ({
      x: (capabilityBox?.width ?? 0) * fx,
      y: (capabilityBox?.height ?? 0) * fy,
    });

    // The middle-left band is the download link. What follows proves the whole
    // path of §11's downloads row: the worker takes the bytes, the shell's own
    // chip lists them, and "Open" mints a one-use URL this browser fetches.
    await capability.click({ position: on(0.5, 0.25), timeout: 30_000 });
    await expect.poll(() => clicks, { timeout: 30_000, message: "the download link was never clicked" }).toContain("get");

    // The bytes themselves, off the worker's own disk: a download that lists
    // but arrives corrupted is worse than one that never lists.
    const kept = await findDownloadedFile(stateDir, "payload.txt");
    expect(kept, "the worker never wrote the download").not.toBeNull();
    expect(await readFile(String(kept), "utf8")).toBe(PAYLOAD);

    const chip = page.getByTestId("downloads-chip").first();
    await expect(chip).toBeVisible({ timeout: 60_000 });
    await chip.click();
    const row = page.getByTestId("download-row").first();
    await expect(row).toContainText("payload.txt", { timeout: 60_000 });
    await expect(row).toHaveAttribute("data-state", "completed", { timeout: 60_000 });
    await page.screenshot({ path: `${SCREENSHOTS}/05-download-listed.png`, fullPage: true });

    // And "Open" fetches it into THIS browser over the session's own download
    // route — one use, sixty seconds, bound to this viewer (§11). The fetch
    // carries the viewer's key in a header, which is why it is a `fetch` and
    // not a `window.open`: a key in a URL is a key in the browser's history.
    // The bytes therefore arrive as a blob and are saved from an anchor, so
    // the download Playwright sees is a `blob:` one with the file's name.
    const fromOpener = page.waitForEvent("download", { timeout: 60_000 }).catch(() => null);
    await row.getByRole("button", { name: "payload.txt" }).click();
    const fetched = await fromOpener;
    expect(fetched, "the shell never fetched the download into this browser").not.toBeNull();
    expect(fetched?.suggestedFilename()).toBe("payload.txt");
    const landed = await fetched?.path();
    expect(await readFile(String(landed), "utf8")).toBe(PAYLOAD);

    /* ------------------ an upload, picked in this browser ------------------- */

    // The middle-right band is the cloud page's file input. Clicking it opens
    // a picker HERE, in the person's own browser, because that is where the
    // person and their files are — but only after the person asks for it.
    // A file dialog needs transient activation, and a socket callback has
    // none: `input.click()` from one is refused, and then neither `change`
    // nor `cancel` fires, so the page waits for an upload nobody was asked
    // for. The request raises an affordance and the person's click on it is
    // what opens the picker.
    await capability.click({ position: on(0.5, 0.75), timeout: 30_000 });
    const prompt = page.getByTestId("stream-file-prompt");
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    const chooser = page.waitForEvent("filechooser", { timeout: 60_000 });
    await page.getByTestId("stream-file-choose").click();
    await (await chooser).setFiles({
      name: "picked.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(UPLOADED),
    });
    await expect
      .poll(() => uploads, { timeout: 60_000, message: "the fixture never received the picked file" })
      .toContain(`picked.txt:${String(Buffer.byteLength(UPLOADED))}`);
    // The offer is gone once it has been answered, not left on screen.
    await expect(prompt).toBeHidden({ timeout: 30_000 });
    await page.screenshot({ path: `${SCREENSHOTS}/06-uploaded.png`, fullPage: true });

    /* --------------------- the viewer goes, the session stays --------------- */

    await page.reload();
    // A kept session comes back behind its PIN now, not straight into the app.
    await enterPin(page);

    // (a) THE SESSION IS BACK. This route shows a curtain until `connect()`
    // resolves, and `connect()` resolves on the host's `ready` frame — after
    // this browser has proved the Space key — so a mounted chrome with no
    // curtain left IS the shell reporting ready. The tab is then listed under
    // the title the page it ended on carries, which is state that can only
    // have come back from the host.
    await expect(page.getByTestId("new-tab-button").first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("browse-curtain")).toHaveCount(0, { timeout: 60_000 });
    const listed = page.locator(`[data-tab-id="${String(tabId)}"]`).first();
    await expect(listed).toBeVisible({ timeout: 60_000 });
    await expect(listed).toContainText(`Typed: ${TYPED}`, { timeout: 60_000 });
    // The session came back with both tabs and the newer one selected, so the
    // first is chosen before its pane is asked for: a tab that is listed but
    // will not paint when picked is not a tab that survived.
    await listed.click();
    const restored = page.locator(`[data-streamed-pane="${String(tabId)}"]`);
    await expect(restored).toBeVisible({ timeout: 60_000 });

    // (b) THE PANE PAINTED — which a visible pane does NOT say: the pane is
    // visible while it is still showing "Opening…", and a screenshot of that
    // was what this walk used to end on. So: the placeholder gone, `aria-busy`
    // false, a `src` that is really a frame, and an <img> the browser DECODED
    // to a non-zero natural size — a broken or empty one is 0x0.
    await expect(restored.getByTestId("streamed-pane-waiting")).toHaveCount(0, { timeout: 60_000 });
    await expect(restored).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
    await expect
      .poll(async () => (await paintedFrame(restored))?.width ?? 0, {
        timeout: 60_000,
        message: "the restored pane never decoded a screencast frame",
      })
      .toBeGreaterThan(0);
    const firstFrame = await paintedFrame(restored);
    expect(firstFrame, "the restored pane is showing no image at all").not.toBeNull();
    expect(firstFrame?.height ?? 0).toBeGreaterThan(0);
    expect(firstFrame?.head).toBe("data:image/jpeg;base64,");
    expect(firstFrame?.seq ?? 0).toBeGreaterThan(0);
    await page.screenshot({ path: `${SCREENSHOTS}/07-same-tab-after-reload.png`, fullPage: true });

    // …and a picture is only proof that it is LIVE if it can show something
    // that did not exist when it was painted. The restored tab is the
    // fixture's `/typed` page: its middle band is a text field, so what is
    // typed there now cannot be in any frame from before the reload. The
    // pane's own frame counter must advance and the bytes must change with it
    // — a screencast that never restarted leaves both where they were.
    const back = restored.getByTestId("streamed-pane-frame");
    const backBox = await back.boundingBox();
    expect(backBox).not.toBeNull();
    const again = (fx: number, fy: number): { x: number; y: number } => ({
      x: (backBox?.width ?? 0) * fx,
      y: (backBox?.height ?? 0) * fy,
    });
    await back.click({ position: again(0.5, 0.37), timeout: 30_000 });
    await page.keyboard.type(TYPED_AGAIN, { delay: 20 });
    await expect
      .poll(
        async () => {
          const now = await paintedFrame(restored);
          return now !== null && now.seq > (firstFrame?.seq ?? 0) && now.mark !== firstFrame?.mark;
        },
        { timeout: 60_000, message: "no fresh frame arrived after the cloud page changed" },
      )
      .toBe(true);
    await page.screenshot({ path: `${SCREENSHOTS}/08-typed-after-reload.png`, fullPage: true });

    // (c) AND INPUT STILL CROSSES THE SOCKET. The bottom half is Save, so the
    // second note travels the whole path the first one did — pointer and keys
    // through a socket dialled after the reload, the host, CDP and the page —
    // and the fixture records it the same way.
    await back.click({ position: again(0.5, 0.75), timeout: 30_000 });
    await expect
      .poll(() => typed, {
        timeout: 60_000,
        message: "the fixture never received the note typed after the reload",
      })
      .toContain(TYPED_AGAIN);
    // The shell's own view of the tab followed that navigation as well: the
    // pane's accessible name is the title and address as the HOST reports
    // them, so it changing is the snapshot channel alive after the reconnect.
    await expect(restored).toHaveAttribute("aria-label", new RegExp(`^Typed: ${TYPED_AGAIN} \u2014 `, "u"), {
      timeout: 60_000,
    });
    await page.screenshot({ path: `${SCREENSHOTS}/09-saved-after-reload.png`, fullPage: true });
    expect(typed).toContain(TYPED);
  } catch (error) {
    const log = stack.logs();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nControl at ${controlUrl}, runner at ${runnerUrl}, web at ${webUrl}\nControl log:\n${log.control.slice(-6_000)}\nRunner log:\n${log.runner.slice(-4_000)}\nWeb output:\n${log.web.slice(-8_000)}`,
    );
  } finally {
    await stack.close();
    await fixture.close();
  }
});
