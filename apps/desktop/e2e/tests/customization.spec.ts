import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator } from "@playwright/test";
import type { DesktopSettings } from "@pistachio/shell-contracts/settings";
import { pageFirst, shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/customization");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

async function captureWindow(app: ElectronApplication, filename: string): Promise<void> {
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

test("themes and shortcut bindings customize the live Electron window", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-customization-"));
  // Glass is a property of every chrome surface, the agent console included,
  // and the console opens closed by default — so ask for it on launch. The
  // home page is the demo site: the last step needs a native page WebContents
  // to send a key to, and this one is local and always there.
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify(pageFirst({ general: { consoleOpenOnLaunch: true, homeUrl: "pistachio://demo/invoices" } })),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
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
    await expect(shell.getByTestId("browser-surface")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("sidebar-chrome")).toHaveCSS("backdrop-filter", "none");
    await expect(shell.getByTestId("sidebar-chrome")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("agent-panel-surface")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("side-rail")).toHaveCount(0);
    await expect(shell.getByTestId("status-footer")).toHaveCount(0);
    await settle(settings);
    await captureWindow(app, "01-desktop-glass-on.png");

    // Turning glass off restores a genuinely opaque native window without recreating it.
    await desktopGlass.click();
    await expect(desktopGlass).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await storedSettings(userData))?.appearance.desktopGlass ?? null).toBe(false);
    await expect.poll(() => nativeWindowBaseColor(app)).not.toBe("#000000");
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset["desktopGlass"])).toBe("off");
    await expect(shell.getByTestId("chrome-layout-ground")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("chrome-content-row")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("browser-surface")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("sidebar-chrome")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(shell.getByTestId("agent-panel-surface")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect.poll(() => nativeVibrancyChanges(app)).toEqual([null]);
    await settle(settings);
    await captureWindow(app, "02-desktop-glass-off.png");
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
    await settle(settings);
    await captureWindow(app, "03-appearance-custom-dark.png");

    // Recording is an explicit mode, so ordinary key presses cannot silently replace a binding.
    await settings.getByRole("button", { name: "Shortcuts", exact: true }).click();
    await expect(settings.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
    const newTab = settings.getByTestId("shortcut-newTab");
    await newTab.click();
    await expect(newTab).toContainText("Press shortcut");
    await settle(settings);
    await captureWindow(app, "04-shortcut-recording.png");

    // The recorded portable binding is immediately visible and written atomically.
    await shell.keyboard.press("Meta+K");
    await expect(newTab).toContainText("K");
    await expect.poll(async () => (await storedSettings(userData))?.shortcuts.newTab ?? null).toBe("Mod+K");
    await settle(settings);
    await captureWindow(app, "05-shortcut-rebound.png");

    // Focus a native webpage WebContents, not React chrome: the same binding must still route back to shell.
    await shell.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await app.evaluate(({ webContents }, modifier: "meta" | "control") => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("pistachio://demo/invoices"));
      if (tab === undefined) throw new Error("Demo tab is unavailable");
      tab.focus();
      tab.sendInputEvent({ type: "keyDown", keyCode: "K", modifiers: [modifier] });
      tab.sendInputEvent({ type: "keyUp", keyCode: "K", modifiers: [modifier] });
    }, process.platform === "darwin" ? "meta" : "control");
    const urlBar = shell.getByTestId("url-bar");
    await expect(urlBar).toBeVisible();
    await settle(urlBar);
    await captureWindow(app, "06-native-page-shortcut.png");
  } finally {
    await app.close();
  }
});
