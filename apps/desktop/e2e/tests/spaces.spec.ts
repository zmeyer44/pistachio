import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { WebContentsView } from "electron";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { sidebarMenuItem } from "./footer";
import { shellPage } from "./windows";

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

async function forkFixture(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
    });
    response.end(`<!doctype html><html><head><title>Fork fixture</title></head><body>
      <label>Memo <input name="memo" value="initial"></label>
    </body></html>`);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind");
  return { server, url: `http://127.0.0.1:${String(address.port)}/case` };
}

async function activeSnapshot(app: ElectronApplication): Promise<ShellSnapshot> {
  const shell = await shellPage(app);
  return shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot());
}

async function visiblePageState(app: ElectronApplication): Promise<{ sessionCookie: string | null; draft: string | null; memo: string }> {
  return app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("window unavailable");
    const view = window.contentView.children.find(
      (child) => "webContents" in child && "getVisible" in child && child.getVisible() && (child as WebContentsView).webContents.getURL().startsWith("http://127.0.0.1:"),
    ) as WebContentsView | undefined;
    if (view === undefined) throw new Error("visible human tab unavailable");
    const page = await view.webContents.executeJavaScript(`({
      draft: localStorage.getItem("draft"),
      memo: document.querySelector('[name="memo"]')?.value ?? "",
    })`);
    const cookie = (await view.webContents.session.cookies.get({ url: view.webContents.getURL() })).find((item) => item.name === "fork-session");
    return { ...page, sessionCookie: cookie?.value ?? null };
  });
}

test("a Space fork carries selected sessions and context once, records lineage, and then diverges", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const fixture = await forkFixture();
  const userData = await mkdtemp(join(tmpdir(), "pistachio-spaces-e2e-"));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    let snapshot = await activeSnapshot(app);
    if (snapshot.activeTabId === null) throw new Error("active tab unavailable");
    await shell.evaluate(
      ({ tabId, url }) => (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(tabId, url),
      { tabId: snapshot.activeTabId, url: fixture.url },
    );
    await expect
      .poll(async () => {
        const current = await activeSnapshot(app);
        return current.tabs.find((tab) => tab.id === current.activeTabId)?.url ?? "";
      })
      .toBe(fixture.url);
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = window?.contentView.children.find(
        (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().startsWith("http://127.0.0.1:"),
      ) as WebContentsView | undefined;
      if (view === undefined) throw new Error("human tab unavailable");
      await view.webContents.session.cookies.set({
        url: view.webContents.getURL(),
        name: "fork-session",
        value: "source-secret",
        path: "/",
        httpOnly: true,
        sameSite: "lax",
      });
      await view.webContents.executeJavaScript(`(() => {
        localStorage.setItem("draft", "carried once");
        const memo = document.querySelector('[name="memo"]');
        if (memo) memo.value = "ready to branch";
      })()`);
    });

    // The sidebar has no fork button; the shortcut opens the fork dialog.
    await shell.keyboard.press("Meta+Shift+F");
    const dialog = shell.getByTestId("space-fork-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("fork-space-name").fill("Freight variance");
    await dialog.getByTestId("fork-space-purpose").fill("Investigate the related carrier charge");
    await dialog.getByTestId("confirm-fork-space").click();
    await expect(dialog).toHaveCount(0);
    await expect(shell.getByTestId("sidebar-chrome").getByRole("button", { name: "Space: Freight variance" })).toBeVisible();

    snapshot = await activeSnapshot(app);
    const child = snapshot.spaces.find((space) => space.id === snapshot.activeSpaceId);
    expect(child).toMatchObject({ name: "Freight variance", parentSpaceId: "work", purpose: "Investigate the related carrier charge" });
    expect(snapshot.tabs).toHaveLength(1);
    expect(await visiblePageState(app)).toEqual({ sessionCookie: "source-secret", draft: "carried once", memo: "ready to branch" });

    // The same menu switches Spaces: the others are its "Switch to" rows.
    await (await sidebarMenuItem(shell, "space-chip-work")).click();
    await expect(shell.getByTestId("sidebar-chrome").getByRole("button", { name: "Space: Operations" })).toBeVisible();
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = window?.contentView.children.find(
        (child) => "webContents" in child && "getVisible" in child && child.getVisible() && (child as WebContentsView).webContents.getURL().startsWith("http://127.0.0.1:"),
      ) as WebContentsView | undefined;
      if (view === undefined) throw new Error("parent tab unavailable");
      await view.webContents.executeJavaScript(`localStorage.setItem("draft", "parent changed")`);
    });
    if (child === undefined) throw new Error("child Space unavailable");
    await (await sidebarMenuItem(shell, `space-chip-${child.id}`)).click();
    await expect(shell.getByTestId("sidebar-chrome").getByRole("button", { name: "Space: Freight variance" })).toBeVisible();
    expect((await visiblePageState(app)).draft).toBe("carried once");
  } finally {
    await app.close();
    await new Promise<void>((resolveClose) => fixture.server.close(() => resolveClose()));
  }
});
