import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { shellPage } from "./windows";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { SidebarState } from "@pistachio/shell-contracts/sidebar";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/sidebar");

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", executableSuffix),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

/** The shelf lives in the chrome, so the shell capture shows the whole sidebar. */
async function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  await new Promise((done) => setTimeout(done, 400));
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

async function storedShelf(userData: string): Promise<SidebarState | null> {
  try {
    const raw = JSON.parse(await readFile(join(userData, "sidebar.json"), "utf8")) as Record<string, unknown>;
    const spaces = raw["spaces"];
    if (typeof spaces === "object" && spaces !== null) return (spaces as Record<string, SidebarState>)["work"] ?? null;
    return raw as unknown as SidebarState;
  } catch {
    return null;
  }
}

/** Right-click a row and pick a menu item by name. */
async function pick(shell: Page, target: ReturnType<Page["locator"]>, item: string | RegExp): Promise<void> {
  await target.click({ button: "right" });
  const menu = shell.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: item }).click();
  await expect(menu).toHaveCount(0);
}

test("the sidebar keeps favorites, pins, and folders, and the organization's links lead the grid", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-sidebar-"));
  // Start in the sidebar layout with one preset link, as a managed install would.
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({
      layout: { mode: "sidebar", sidebar: "pinned" },
      workspace: { presetLinks: [{ title: "Invoice portal", url: "pistachio://demo/invoices" }] },
    }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const sidebar = shell.getByTestId("sidebar-chrome");
    await expect(sidebar).toBeVisible();

    // The column, top to bottom: address, the grid with the organization's
    // tile, the space header, an empty pinned section, "New tab", the tab.
    await expect(sidebar.getByTestId("sidebar-address")).toBeVisible();
    const preset = sidebar.getByTestId("preset-tile");
    await expect(preset).toHaveCount(1);
    await expect(preset).toHaveAttribute("aria-label", "Invoice portal");
    await expect(preset).not.toHaveAttribute("data-live");
    await expect(sidebar.getByTestId("sidebar-menu-button")).toHaveAttribute("aria-label", "Space: Operations");
    await expect(sidebar.getByTestId("pinned-tab")).toHaveCount(0);
    await expect(sidebar.getByTestId("new-tab-button")).toBeVisible();

    // The section headers fold their rows away and bring them back.
    const liveHeader = sidebar.getByTestId("section-header-live");
    await expect(liveHeader).toHaveAttribute("aria-expanded", "true");
    const liveBody = sidebar.locator("#sidebar-section-live").locator("..");
    await liveHeader.click();
    await expect(liveHeader).toHaveAttribute("aria-expanded", "false");
    await expect(liveBody).toHaveAttribute("aria-hidden", "true");
    await expect.poll(async () => (await liveBody.boundingBox())?.height ?? -1).toBe(0);
    await liveHeader.click();
    await expect(liveHeader).toHaveAttribute("aria-expanded", "true");
    await expect(liveBody).toHaveAttribute("aria-hidden", "false");
    await expect.poll(async () => (await liveBody.boundingBox())?.height ?? 0).toBeGreaterThan(20);
    await expect(sidebar.getByTestId("human-tab")).toHaveCount(1);
    await captureShell(app, "01-shelf.png");

    // A preset opens as its own tab, bound to the tile: the tile lights up and
    // the day's tabs gain one. Clicking it again shows that tab, not another.
    await preset.click();
    await expect(preset).toHaveAttribute("data-live", "");
    await expect(preset).toHaveAttribute("aria-pressed", "true");
    await expect(sidebar.getByTestId("human-tab")).toHaveCount(1);
    await preset.click();
    await expect(sidebar.getByTestId("human-tab")).toHaveCount(1);
    // Closing the page keeps the tile. (⌘W is main's before-input-event,
    // which a synthetic key press never reaches; the menu is the same close.)
    await pick(shell, preset, "Close tab");
    await expect(preset).not.toHaveAttribute("data-live");
    await expect(preset).toHaveCount(1);
    // And it cannot be removed — the organization put it there.
    await preset.click({ button: "right" });
    const presetMenu = shell.getByTestId("context-menu");
    await expect(presetMenu).toContainText("Provided by your organization");
    await expect(presetMenu.getByRole("menuitem", { name: /Remove/ })).toHaveCount(0);
    await shell.keyboard.press("Escape");
    await expect(presetMenu).toHaveCount(0);

    // PIN. The day's tab moves above the divider as a pin — still live, still
    // the active card — and the day's list empties.
    const dayTab = sidebar.getByTestId("human-tab").first();
    await pick(shell, dayTab, "Pin tab");
    const pin = sidebar.getByTestId("pinned-tab");
    await expect(pin).toHaveCount(1);
    await expect(pin).toHaveAttribute("data-live", "");
    await expect(pin).toHaveAttribute("aria-selected", "true");
    await expect(sidebar.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(0);
    await captureShell(app, "02-pinned.png");

    // Closing from the row's hover control leaves the pin, dimmed, and a
    // click brings it back. Keep this on the direct control rather than the
    // context menu so pinned rows cannot silently regress to a no-op.
    await pin.hover();
    await pin.getByRole("button", { name: /^Close / }).click();
    await expect(pin).toHaveCount(1);
    await expect(pin).not.toHaveAttribute("data-live");
    await pin.click();
    await expect(pin).toHaveAttribute("data-live", "");

    // Unpin is a separate hover action: it removes the kept entry while its
    // open page returns to the day's tabs. Pin it again for the folder flow.
    await pin.hover();
    await pin.getByRole("button", { name: /^Unpin / }).click();
    await expect(pin).toHaveCount(0);
    const returnedTab = sidebar.getByTestId("human-tab").first();
    await expect(returnedTab).toHaveCount(1);
    await pick(shell, returnedTab, "Pin tab");
    await expect(pin).toHaveCount(1);
    await expect(pin).toHaveAttribute("data-live", "");

    // FOLDER. Created from the space header, named in place, then the pin
    // is moved in from its menu; the folder collapses and expands.
    await sidebar.getByTestId("new-tab-button").hover();
    await sidebar.getByTestId("new-folder-button").click();
    const nameInput = sidebar.getByTestId("folder-name-input");
    await expect(nameInput).toBeFocused();
    await nameInput.fill("Finance");
    await nameInput.press("Enter");
    const folder = sidebar.getByTestId("pinned-folder");
    await expect(folder).toHaveCount(1);
    await expect(folder).toHaveAttribute("aria-label", "Folder: Finance");
    await pick(shell, pin, "Move to “Finance”");
    await expect(pin).toHaveAttribute("data-folder-id", /.+/);
    await expect(pin).toHaveCSS("margin-left", "18px");
    await captureShell(app, "03-folder.png");
    await folder.click();
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await expect(pin).toHaveCount(0);
    await folder.click();
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    await expect(pin).toHaveCount(1);

    // Folder-only deletion keeps its pins by promoting them to the top level.
    await pick(shell, folder, /^Delete folder$/);
    await expect(folder).toHaveCount(0);
    await expect(pin).toHaveCount(1);
    await expect(pin).toHaveAttribute("data-folder-id", "");

    // Recreate the folder so the destructive variant can be exercised after
    // the rest of the pin/favorite flow.
    await sidebar.getByTestId("new-tab-button").hover();
    await sidebar.getByTestId("new-folder-button").click();
    await expect(nameInput).toBeFocused();
    await nameInput.fill("Finance");
    await nameInput.press("Enter");
    await pick(shell, pin, "Move to “Finance”");
    await expect(pin).toHaveAttribute("data-folder-id", /.+/);

    // FAVORITE. The pin becomes a tile beside the organization's, and its
    // page follows: the tile is live, the pin is gone.
    await pick(shell, pin, "Add to favorites");
    const favorite = sidebar.getByTestId("favorite-tile");
    await expect(favorite).toHaveCount(1);
    await expect(favorite).toHaveAttribute("data-live", "");
    await expect(sidebar.getByTestId("pinned-tab")).toHaveCount(0);
    await captureShell(app, "04-favorite.png");

    // The shelf is on disk, and the folder survived the pin leaving it.
    await expect
      .poll(async () => {
        const shelf = await storedShelf(userData);
        return shelf === null ? null : { favorites: shelf.favorites.length, folders: shelf.entries.filter((e) => e.kind === "folder").map((e) => (e.kind === "folder" ? e.name : "")) };
      })
      .toEqual({ favorites: 1, folders: ["Finance"] });

    // Removing the favorite frees its page back into the day's tabs — beside
    // the tab main opened when the pin's page was closed as the last one.
    await pick(shell, favorite, "Remove from favorites");
    await expect(sidebar.getByTestId("favorite-tile")).toHaveCount(0);
    await expect(sidebar.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(2);

    // Pin one open page, put it in the folder, then delete both folder and
    // contents. The pin disappears while its page returns to Live tabs.
    await shell.keyboard.press("Meta+d");
    await expect(sidebar.getByTestId("pinned-tab")).toHaveCount(1);
    await pick(shell, sidebar.getByTestId("pinned-tab"), "Move to “Finance”");
    await pick(shell, folder, "Delete folder and pins");
    await expect(sidebar.getByTestId("pinned-folder")).toHaveCount(0);
    await expect(sidebar.getByTestId("pinned-tab")).toHaveCount(0);
    await expect(sidebar.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(2);
  } finally {
    await app.close();
  }
});

test("tabs support range and additive selection with bulk context-menu actions", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-sidebar-selection-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }));

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      await api.createTab("pistachio://demo/invoices?selection=second");
      await api.createTab("pistachio://demo/invoices?selection=third");
    });

    const sidebar = shell.getByTestId("sidebar-chrome");
    const liveTabs = sidebar.locator('#sidebar-section-live [data-testid="human-tab"]');
    await expect(liveTabs).toHaveCount(3);

    // A plain click establishes the anchor. Shift selects the visible range;
    // Command toggles one member out without activating it.
    await liveTabs.first().click();
    await liveTabs.last().click({ modifiers: ["Shift"] });
    await expect(sidebar.locator('#sidebar-section-live [data-multi-selected]')).toHaveCount(3);
    await liveTabs.nth(1).click({ modifiers: ["Meta"] });
    await expect(sidebar.locator('#sidebar-section-live [data-multi-selected]')).toHaveCount(2);
    await captureShell(app, "05-multi-selected.png");

    await liveTabs.first().click({ button: "right" });
    let menu = shell.getByTestId("context-menu");
    await expect(menu).toContainText("2 tabs selected");
    await expect(menu.getByRole("menuitem", { name: "Pin selected tabs" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Close selected tabs" })).toBeVisible();
    await captureShell(app, "06-multi-select-menu.png");
    await menu.getByRole("menuitem", { name: "New folder with selected tabs" }).click();

    const pins = sidebar.getByTestId("pinned-tab");
    await expect(pins).toHaveCount(2);
    await expect(liveTabs).toHaveCount(1);
    const folderName = sidebar.getByTestId("folder-name-input");
    await expect(folderName).toBeFocused();
    await folderName.fill("Selected tabs");
    await folderName.press("Enter");

    // The same range model spans pinned rows. Their bulk menu exposes Unpin,
    // which removes the pins while returning both pages to Live tabs.
    await pins.first().click();
    await pins.last().click({ modifiers: ["Shift"] });
    await expect(sidebar.locator('[data-testid="pinned-tab"][data-multi-selected]')).toHaveCount(2);
    await pins.first().click({ button: "right" });
    menu = shell.getByTestId("context-menu");
    await menu.getByRole("menuitem", { name: "Unpin selected tabs" }).click();
    await expect(pins).toHaveCount(0);
    await expect(liveTabs).toHaveCount(3);

    // Individual additive selection works after the rows change identity,
    // and Close applies only to the selected open tabs.
    await liveTabs.first().click({ modifiers: ["Meta"] });
    await liveTabs.last().click({ modifiers: ["Meta"] });
    await expect(sidebar.locator('#sidebar-section-live [data-multi-selected]')).toHaveCount(2);
    await liveTabs.first().click({ button: "right" });
    menu = shell.getByTestId("context-menu");
    await menu.getByRole("menuitem", { name: "Close selected tabs" }).click();
    await expect(liveTabs).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("a folder takes a colour and an emoji from its menu, and keeps them on disk", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-folder-style-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }));

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const sidebar = shell.getByTestId("sidebar-chrome");
    // The new-folder control shows on the "New tab" row's hover.
    await sidebar.getByTestId("new-tab-button").hover();
    await sidebar.getByTestId("new-folder-button").click();
    const nameInput = sidebar.getByTestId("folder-name-input");
    await nameInput.fill("Travel");
    await nameInput.press("Enter");
    const folder = sidebar.getByTestId("pinned-folder");
    const mark = folder.getByTestId("folder-mark");
    const menu = shell.getByTestId("context-menu");
    // A new folder is the plain icon in the chrome's own ink.
    await expect(mark).not.toHaveAttribute("data-group-color");
    await expect(mark.locator("svg")).toHaveCount(1);

    // A colour, from the same swatches a tab group has — after "none", which is where it starts.
    await folder.click({ button: "right" });
    await expect(menu.getByTestId("group-color-none")).toHaveAttribute("aria-checked", "true");
    await captureShell(app, "07-folder-style-menu.png");
    await menu.getByTestId("group-color-purple").click();
    await expect(menu).toHaveCount(0);
    await expect(mark).toHaveAttribute("data-group-color", "purple");
    await captureShell(app, "08-folder-colour.png");

    // An emoji from the grid replaces the icon; the colour stays, behind it.
    await folder.click({ button: "right" });
    await expect(menu.getByTestId("group-color-purple")).toHaveAttribute("aria-checked", "true");
    await menu.getByTestId("menu-emoji-choice").filter({ hasText: "✈️" }).click();
    await expect(menu).toHaveCount(0);
    await expect(mark).toHaveText("✈️");
    await expect(mark.locator("svg")).toHaveCount(0);
    await expect(mark).toHaveAttribute("data-group-color", "purple");

    // Any other emoji, typed: words do nothing, an emoji is taken at once.
    await folder.click({ button: "right" });
    const field = menu.getByTestId("menu-emoji-input");
    await field.fill("beach");
    await expect(menu).toBeVisible();
    await field.fill("🏝️");
    await expect(menu).toHaveCount(0);
    await expect(mark).toHaveText("🏝️");
    await captureShell(app, "09-folder-emoji.png");
    await expect
      .poll(async () => (await storedShelf(userData))?.entries.find((entry) => entry.kind === "folder"))
      .toMatchObject({ name: "Travel", color: "purple", emoji: "🏝️" });

    // The custom one shows in the field next time; the first cell puts the icon back, "none" the ink.
    await folder.click({ button: "right" });
    await expect(field).toHaveValue("🏝️");
    await menu.getByTestId("menu-emoji-reset").click();
    await expect(mark.locator("svg")).toHaveCount(1);
    await folder.click({ button: "right" });
    await menu.getByTestId("group-color-none").click();
    await expect(mark).not.toHaveAttribute("data-group-color");
    await expect
      .poll(async () => (await storedShelf(userData))?.entries.find((entry) => entry.kind === "folder"))
      .toMatchObject({ color: null, emoji: null });
  } finally {
    await app.close();
  }
});

/**
 * Press on `from`, travel to a point, release — a real pointer drag through
 * the shell page. Rows FLIP-slide for 280ms after any relayout and hit-testing
 * follows the transform, so the press waits for the column to settle first —
 * or it would land on the row still sliding across the one it aims at.
 */
async function drag(shell: Page, from: ReturnType<Page["locator"]>, to: { x: number; y: number }): Promise<void> {
  await new Promise((done) => setTimeout(done, 350));
  const box = await from.boundingBox();
  if (box === null) throw new Error("drag source has no box");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await shell.mouse.move(startX, startY);
  await shell.mouse.down();
  // Past the 5px threshold first, then to the target in steps so every row
  // on the way sees a move.
  await shell.mouse.move(startX, startY + 8, { steps: 2 });
  await shell.mouse.move(to.x, to.y, { steps: 12 });
  await new Promise((done) => setTimeout(done, 80));
  await shell.mouse.up();
}

test("rows and tiles drag between the day's tabs, the pinned tree, its folders, and the favorites grid", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-sidebar-drag-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }));

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const sidebar = shell.getByTestId("sidebar-chrome");
    await expect(sidebar).toBeVisible();
    const list = sidebar.getByTestId("sidebar-tab-list");
    const dayTab = list.getByTestId("human-tab").first();
    await expect(dayTab).toBeVisible();
    // With nothing kept and no drag in flight, the grid takes no room.
    await expect(sidebar.getByTestId("favorites-grid")).toHaveCount(0);

    // A day tab dragged above the "New tab" row becomes a pin.
    const divider = await sidebar.getByTestId("new-tab-button").boundingBox();
    if (divider === null) throw new Error("no new tab row");
    await drag(shell, dayTab, { x: divider.x + 40, y: divider.y + 4 });
    const pin = sidebar.getByTestId("pinned-tab");
    await expect(pin).toHaveCount(1);
    await expect(pin).toHaveAttribute("data-live", "");
    await expect(list.getByTestId("human-tab")).toHaveCount(0);

    // A pin dropped on a folder's header goes inside it.
    await sidebar.getByTestId("new-tab-button").hover();
    await sidebar.getByTestId("new-folder-button").click();
    const nameInput = sidebar.getByTestId("folder-name-input");
    await nameInput.fill("Ops");
    await nameInput.press("Enter");
    const folder = sidebar.getByTestId("pinned-folder");
    await expect(folder).toHaveAttribute("aria-label", "Folder: Ops");
    const folderBox = await folder.boundingBox();
    if (folderBox === null) throw new Error("no folder box");
    await drag(shell, pin, { x: folderBox.x + folderBox.width / 2, y: folderBox.y + folderBox.height / 2 });
    await expect(pin).toHaveAttribute("data-folder-id", /.+/);
    await expect(pin).toHaveCSS("margin-left", "18px");

    // A pin dragged onto the grid — which, empty, appears over the address
    // row to receive it rather than pushing the list — becomes a favorite.
    const address = await sidebar.getByTestId("sidebar-address").boundingBox();
    if (address === null) throw new Error("no address row");
    await drag(shell, pin, { x: address.x + 40, y: address.y + address.height / 2 });
    const favorite = sidebar.getByTestId("favorite-tile");
    await expect(favorite).toHaveCount(1);
    await expect(favorite).toHaveAttribute("data-live", "");
    await expect(sidebar.getByTestId("pinned-tab")).toHaveCount(0);
    await captureShell(app, "05-dragged.png");

    // A favorite dragged below the "New tab" row is a day tab again; the grid
    // empties and disappears.
    const newTab = await sidebar.getByTestId("new-tab-button").boundingBox();
    if (newTab === null) throw new Error("no new tab row");
    await drag(shell, favorite, { x: newTab.x + 40, y: newTab.y + newTab.height + 20 });
    await expect(sidebar.getByTestId("favorite-tile")).toHaveCount(0);
    await expect(sidebar.getByTestId("favorites-grid")).toHaveCount(0);
    await expect(list.getByTestId("human-tab")).toHaveCount(1);
    // The folder is still there for the next page.
    await expect(folder).toHaveCount(1);
  } finally {
    await app.close();
  }
});
