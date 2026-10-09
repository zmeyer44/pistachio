import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Locator } from "@playwright/test";
import type { DesktopSettings } from "@pistachio/shell-contracts/settings";
import { pageFirst, shellReady } from "./windows";
import { captureEnabled, launchApp } from "./app";
import { snapshot } from "./desk-harness";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/customization");

/** The window, once `settling`'s finite animations have finished. */
async function captureWindow(app: ElectronApplication, filename: string, settling: Locator): Promise<void> {
  if (!captureEnabled) return;
  await settle(settling);
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Pistachio");
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

async function settle(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    const finite = element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function storedSettings(userData: string): Promise<DesktopSettings | null> {
  try {
    return JSON.parse(await readFile(join(userData, "settings.json"), "utf8")) as DesktopSettings;
  } catch {
    return null;
  }
}

async function nativeWindowBaseColor(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Pistachio");
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.getBackgroundColor();
  });
}

async function installNativeMaterialRecorder(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Pistachio");
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const state = globalThis as typeof globalThis & { __pistachioVibrancyChanges?: Array<string | null> };
    state.__pistachioVibrancyChanges = [];
    const setVibrancy = window.setVibrancy.bind(window);
    window.setVibrancy = (type, options) => {
      state.__pistachioVibrancyChanges?.push(type);
      setVibrancy(type, options);
    };
  });
}

async function nativeVibrancyChanges(app: ElectronApplication): Promise<Array<string | null>> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __pistachioVibrancyChanges?: Array<string | null> };
    return state.__pistachioVibrancyChanges ?? [];
  });
}

test("themes and shortcut bindings customize the live Electron window", { tag: ["@settings"] }, async () => {
  // Glass is a property of every chrome surface, the agent console included,
  // and the console opens closed by default — so ask for it on launch. The
  // home page is the demo site: the last step needs a native page WebContents
  // to send a key to, and this one is local and always there. Its pages are
  // left to the app's scheme, not Playwright's light, for the scheme step.
  const { app, userData } = await launchApp({
    settings: pageFirst({ general: { consoleOpenOnLaunch: true, homeUrl: "pistachio://demo/invoices" } }),
    name: "customization",
    colorScheme: null,
  });

  try {
    const shell = await shellReady(app);
    await installNativeMaterialRecorder(app);

    // The live preview establishes the default material before any edits.
    await shell.keyboard.press("Meta+,");
    const settings = shell.getByTestId("settings-page");
    await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(settings.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await expect(settings.getByTestId("appearance-preview")).toBeVisible();
    const desktopGlass = settings.getByRole("switch", { name: "Desktop glass" });
    await expect(desktopGlass).toHaveAttribute("aria-checked", "true");
    const glassTint = settings.getByRole("slider", { name: "Glass tint" });
    await expect(glassTint).toHaveAttribute("min", "25");
    await expect(glassTint).toHaveAttribute("max", "100");
    await expect(glassTint).toHaveValue("25");
    // Electron omits alpha from getBackgroundColor(); transparent black is
    // therefore reported as #000000 rather than its configured #00000000.
    await expect.poll(() => nativeWindowBaseColor(app)).toBe("#000000");
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset["desktopGlass"])).toBe("on");
    await expect(shell.getByTestId("chrome-layout-ground")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("chrome-layout-ground")).not.toHaveCSS("background-image", "none");
    await expect(shell.getByTestId("chrome-content-row")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("desk-surface")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("sidebar-chrome")).toHaveCSS("backdrop-filter", "none");
    await expect(shell.getByTestId("sidebar-chrome")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("agent-panel-surface")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("side-rail")).toHaveCount(0);
    await expect(shell.getByTestId("status-footer")).toHaveCount(0);
    await captureWindow(app, "01-desktop-glass-on.png", settings);

    // Turning glass off restores a genuinely opaque native window without recreating it.
    await desktopGlass.click();
    await expect(desktopGlass).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await storedSettings(userData))?.appearance.desktopGlass ?? null).toBe(false);
    await expect.poll(() => nativeWindowBaseColor(app)).not.toBe("#000000");
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset["desktopGlass"])).toBe("off");
    await expect(shell.getByTestId("chrome-layout-ground")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("chrome-content-row")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("desk-surface")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("sidebar-chrome")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("agent-panel-surface")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect.poll(() => nativeVibrancyChanges(app)).toEqual([null]);
    await captureWindow(app, "02-desktop-glass-off.png", settings);
    await desktopGlass.click();
    await expect(desktopGlass).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset["desktopGlass"])).toBe("on");
    // Re-enabling glass reinstalls AppKit's real behind-window blur. The
    // renderer remains clear and contributes only the selected tint.
    await expect.poll(() => nativeVibrancyChanges(app)).toEqual([null, "under-window"]);

    // Scheme, preset, and a direct color-stop edit must repaint and persist together.
    await settings.getByRole("radio", { name: "Dark" }).click();
    await settings.getByRole("button", { name: "Use Aurora theme" }).click();
    await settings.getByTestId("appearance-color-0").fill("#3f67d8");
    await expect(settings.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => {
        const stored = await storedSettings(userData);
        return stored === null ? null : { scheme: stored.appearance.scheme, color: stored.appearance.colors[0] };
      })
      .toEqual({ scheme: "dark", color: "#3F67D8" });
    // The OS is told the scheme, whatever its own: the window's glass, and every page's prefers-color-scheme, go dark.
    await expect.poll(() => app.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }))).toEqual({ source: "dark", dark: true });
    await expect
      .poll(() =>
        app.evaluate(({ webContents }) => {
          const tab = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("pistachio://demo/invoices"));
          return tab?.executeJavaScript(`matchMedia("(prefers-color-scheme: dark)").matches`);
        }),
      )
      .toBe(true);
    // The chrome views over the pages (the desk's notch among them) take the new appearance too, not only at load.
    await expect
      .poll(() =>
        app.evaluate(async ({ webContents }) => {
          const accents: Record<string, string> = {};
          for (const contents of webContents.getAllWebContents()) {
            const view = /#(notice|notch|shelf|pip)$/.exec(contents.getURL())?.[1];
            if (view !== undefined) accents[view] = (await contents.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue("--theme-accent").trim()`)) as string;
          }
          return accents;
        }),
      )
      .toEqual({ notice: "#3F67D8", notch: "#3F67D8", shelf: "#3F67D8", pip: "#3F67D8" });
    await captureWindow(app, "03-appearance-custom-dark.png", settings);

    // Recording is an explicit mode, so ordinary key presses cannot silently replace a binding.
    await settings.getByRole("button", { name: "Shortcuts", exact: true }).click();
    await expect(settings.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
    const newTab = settings.getByTestId("shortcut-newTab");
    await newTab.click();
    await expect(newTab).toContainText("Press shortcut");
    await captureWindow(app, "04-shortcut-recording.png", settings);

    // The recorded portable binding is immediately visible and written atomically.
    await shell.keyboard.press("Meta+K");
    await expect(newTab).toContainText("K");
    await expect.poll(async () => (await storedSettings(userData))?.shortcuts.newTab ?? null).toBe("Mod+K");
    await captureWindow(app, "05-shortcut-rebound.png", settings);

    // Focus a native webpage WebContents, not React chrome: the same binding must still route back to shell —
    // and do what ⌘T does on the desk: a new tab in the current space, out as the window in use.
    await shell.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    const tabsBefore = (await snapshot(shell)).tabs.map((tab) => tab.id);
    await app.evaluate(({ webContents }, modifier: "meta" | "control") => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("pistachio://demo/invoices"));
      if (tab === undefined) throw new Error("Demo tab is unavailable");
      tab.focus();
      tab.sendInputEvent({ type: "keyDown", keyCode: "K", modifiers: [modifier] });
      tab.sendInputEvent({ type: "keyUp", keyCode: "K", modifiers: [modifier] });
    }, process.platform === "darwin" ? "meta" : "control");
    await expect
      .poll(async () => {
        const after = await snapshot(shell);
        const made = after.tabs.filter((tab) => !tabsBefore.includes(tab.id)).map((tab) => tab.id);
        return made.length === 1 && after.activeTabId === made[0];
      })
      .toBe(true);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await captureWindow(app, "06-native-page-shortcut.png", shell.getByTestId("desk-surface"));
  } finally {
    await app.close();
  }
});
