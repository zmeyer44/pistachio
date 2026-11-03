/**
 * Extensions (docs/extensions.md §2): the Ledge at the foot of the sidebar's
 * card, the extensions page it opens, and a folder of the person's own
 * written into the dev folder — it appears waiting for approval (a notice
 * with Review, the page's Review), the approval sheet turns it on, its icon
 * stands on the Ledge and its declared `/` command is in the Bar's menu.
 *
 * The shell's half (packages/shell-ui/src/components/extensions,
 * lib/extensions) draws all of it from main's snapshot alone; the second
 * test needs main's half (apps/desktop/src/main/extensions: the registry,
 * the dev folder's watcher, the sheet's lines) and is skipped until it lands.
 * What the shell decides by itself — the Ledge's order and room, its dots,
 * the sheet's lines, the Bar's rows — is unit-tested
 * (packages/shell-ui/test/extensions-ledge.test.ts, desk-slash-commands.test.ts).
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { launchDesk, reachBar, screenshots, settled } from "./desk-harness";

const capture = screenshots("extensions");

/** The fixture: a Pistachio extension with a panel and a `/` command its worker answers (§3). */
const HELLO_ID = "dev.e2e.hello";
const HELLO = {
  "pistachio.json": JSON.stringify(
    {
      api: 1,
      id: HELLO_ID,
      name: "Hello panel",
      version: "1.0.0",
      description: "A panel and a / command, for the extensions spec.",
      permissions: ["notifications"],
      worker: { type: "web", main: "worker.js" },
      panel: { file: "panel.html", width: 320 },
      bar: { commands: [{ name: "hello", description: "Say hello from the fixture", arg: { hint: "a name" }, run: { event: true } }] },
    },
    null,
    2,
  ),
  "panel.html": `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Hello panel</title></head>
  <body><main id="hello">Hello from the panel.</main></body>
</html>
`,
  "worker.js": `pistachio.bar.onCommand("hello", ({ arg }) => {
  pistachio.ui.toast({ title: \`Hello, \${arg || "you"}\` });
});
`,
};

async function writeFixture(folder: string): Promise<string> {
  const dir = join(folder, "hello");
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(HELLO)) await writeFile(join(dir, name), content);
  return dir;
}

test.describe.serial("extensions: the Ledge, the page, a folder of one's own", { tag: ["@extensions"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let devFolder: string;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    devFolder = await mkdtemp(join(tmpdir(), "pistachio-extensions-dev-"));
    ({ app, shell } = await launchDesk({ name: "extensions" }));
    // The dev folder this run's (off until the page's switch turns Developer mode on).
    await shell.evaluate(
      (folder) => (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ extensions: { developerMode: false, devFolder: folder } }),
      devFolder,
    );
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("the empty Ledge sits at the card's foot, and opens the extensions page", async () => {
    const ledge = shell.getByTestId("ledge");
    await expect(ledge).toBeVisible();
    // Inside the card, at its foot: below the views, in the row the footer's pills share.
    const card = await shell.getByTestId("space-card").boundingBox();
    const strip = await ledge.boundingBox();
    expect(card).not.toBeNull();
    expect(strip).not.toBeNull();
    expect(strip!.y + strip!.height).toBeLessThanOrEqual(card!.y + card!.height + 1);
    expect(strip!.y).toBeGreaterThan(card!.y + card!.height - 60);
    // Nothing pinned: one dashed slot and the word.
    const empty = shell.getByTestId("ledge-empty");
    await expect(empty).toHaveText("Extensions");
    await capture(app, shell, "01-empty-ledge.png");

    await empty.click();
    const page = shell.getByTestId("extensions-page");
    await expect(page).toBeVisible();
    await expect(shell.getByTestId("extensions-search")).toHaveAttribute("placeholder", "Search extensions, or describe one to make");
    await expect(page.getByTestId("extensions-installed")).toBeVisible();
    await expect(page.getByTestId("extensions-yours")).toBeVisible();
    // Something typed: the two ways on, to make it or to find it in the store.
    await shell.getByTestId("extensions-search").fill("tab counter");
    await expect(page.getByTestId("extensions-make")).toHaveText("Make “tab counter” with Pistachio");
    await expect(page.getByTestId("extensions-store-search")).toHaveText("Search the Chrome Web Store for “tab counter”");
    await shell.getByTestId("extensions-search").fill("");
    await capture(app, shell, "02-extensions-page.png");
  });

  test("a folder dropped in the dev folder waits for approval, the sheet turns it on, and it is on the Ledge and in the Bar", async () => {
    // ── 1. Developer mode on (the page's switch), the fixture written: it appears, waiting for the person ─
    await expect(shell.getByTestId("extensions-page")).toBeVisible();
    await shell.getByTestId("extensions-yours").getByRole("switch", { name: "Developer mode" }).click();
    await expect(shell.getByTestId("extensions-yours").getByRole("switch", { name: "Developer mode" })).toHaveAttribute("aria-checked", "true");
    await writeFixture(devFolder);
    const row = shell.locator(`[data-testid="extensions-installed-row"][data-extension-id="${HELLO_ID}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("Waiting for your approval");
    // Said once, as a notice — never a sheet popping up unbidden.
    await expect(shell.getByTestId("extension-sheet")).toHaveCount(0);
    await capture(app, shell, "03-waiting.png");

    // ── 2. Review: the sheet, as §2 lays it out ─
    await row.getByTestId("extensions-review").click();
    const sheet = shell.getByTestId("extension-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("extension-sheet-name")).toHaveText("Hello panel");
    await expect(sheet.getByTestId("extension-sheet-source")).toContainText("Yours · ");
    await expect(sheet.getByTestId("extension-sheet-adds")).toContainText("/hello");
    await capture(app, shell, "04-sheet.png");
    await sheet.getByTestId("extension-sheet-turn-on").click();
    await expect(sheet).toHaveCount(0);

    // ── 3. On: its icon on the Ledge, no dot; its command in the Bar's `/` menu, in the Extensions group ─
    const icon = shell.locator(`[data-testid="ledge-icon"][data-extension-id="${HELLO_ID}"]`);
    await expect(icon).toBeVisible();
    await expect(icon).not.toHaveAttribute("data-dot", /.+/);
    await expect(shell.getByTestId("ledge-empty")).toHaveCount(0);
    await reachBar(shell);
    const input = shell.getByTestId("desk-bar-input");
    await input.fill("/hel");
    const command = shell.locator('[data-testid="desk-command"][data-command="hello"]');
    await expect(command).toBeVisible();
    await expect(command).toHaveAttribute("data-extension-id", HELLO_ID);
    await expect(command).toContainText("Say hello from the fixture");
    await input.fill("");
    await capture(app, shell, "05-on-the-ledge.png");

    // ── 4. Its icon opens its panel beside the sidebar: the shell's head, the slot main fills ─
    await icon.click();
    const panel = shell.getByTestId("extension-panel-card");
    await expect(panel).toHaveAttribute("data-shown", "");
    await expect(panel).toContainText("Hello panel");

    // ── 5. Its partition is sealed (§4): WebRTC, which neither the CSP nor webRequest sees, reaches nothing — a TURN
    // server named to the panel's RTCPeerConnection hears no connection, and the partition's proxy is the black hole ─
    const hits: string[] = [];
    const turn = createServer((socket) => {
      hits.push(socket.remoteAddress ?? "?");
      socket.destroy();
    });
    await new Promise<void>((resolve) => turn.listen(0, "127.0.0.1", resolve));
    const address = turn.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);
    const sealed = await app.evaluate(
      async ({ webContents, session }, { id, port }) => {
        const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(`pistachio-ext://${id}/`));
        if (contents === undefined) throw new Error("no view of the extension's");
        const gathering = (await contents.executeJavaScript(
          `new Promise((resolve) => {
            const pc = new RTCPeerConnection({ iceServers: [{ urls: ["turn:127.0.0.1:${String(port)}?transport=tcp"], username: "secret", credential: "x" }] });
            pc.createDataChannel("probe");
            pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") resolve("complete"); };
            setTimeout(() => resolve(pc.iceGatheringState), 6000);
            pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch((error) => resolve("offer failed: " + String(error)));
          })`,
          true,
        )) as string;
        const proxy = await session.fromPartition(`persist:pistachio-ext-${id}`).resolveProxy("https://example.com/");
        return { gathering, proxy };
      },
      { id: HELLO_ID, port },
    );
    turn.close();
    expect(sealed).toEqual({ gathering: "complete", proxy: "SOCKS5 127.0.0.1:1" });
    expect(hits).toEqual([]);

    await shell.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  });
});
