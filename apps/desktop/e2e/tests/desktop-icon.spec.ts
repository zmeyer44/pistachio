import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { shellReady } from "./windows";

test("desktop icon switches immediately and survives a restart", async () => {
  test.skip(process.platform !== "darwin", "This journey checks the macOS Dock API.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-icon-e2e-"));
  const options = {
    args: process.env["PISTACHIO_PACKAGED_E2E"] === "1" ? [] : ["."],
    cwd: process.cwd(),
    executablePath: process.env["PISTACHIO_ELECTRON_PATH"],
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  };
  let app = await electron.launch(options);
  const screenshots = join(process.cwd(), "e2e/screenshots/desktop-icon");
  try {
    // A fresh profile should visibly choose the white default.
    let shell = await shellReady(app);
    await shell.keyboard.press("Meta+,");
    let settings = shell.getByTestId("settings-page");
    await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(settings.getByTestId("desktop-icon-white")).toBeChecked();
    await expect(settings.getByTestId("desktop-icon-option-white")).toHaveAttribute("data-selected", "true");
    await settings.getByTestId("desktop-icon-picker").evaluate((element) => element.scrollIntoView({ block: "center" }));
    await shell.screenshot({ animations: "disabled", path: join(screenshots, "01-white-default.png") });

    // Observe the real Dock setter while preserving its native behavior.
    await app.evaluate(({ app }) => {
      const state = globalThis as typeof globalThis & { iconCalls: string[] };
      state.iconCalls = [];
      const dock = app.dock!;
      const setIcon = dock.setIcon.bind(dock);
      dock.setIcon = (icon) => {
        state.iconCalls.push(String(icon));
        setIcon(icon);
      };
    });
    await settings.getByText("Green", { exact: true }).click();
    await expect(settings.getByTestId("desktop-icon-green")).toBeChecked();
    await expect(settings.getByTestId("desktop-icon-option-green")).toHaveAttribute("data-selected", "true");
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { iconCalls: string[] }).iconCalls.at(-1))).toMatch(process.env["PISTACHIO_PACKAGED_E2E"] === "1" ? /icon-macos-green\.png$/ : /icon-macos-dev\.png$/);
    await expect.poll(async () => JSON.parse(await readFile(join(userData, "settings.json"), "utf8")).appearance.desktopIcon).toBe("green");
    await shell.screenshot({ animations: "disabled", path: join(screenshots, "02-green-selected.png") });

    // A new process must restore the saved choice, not the default.
    await app.close();
    app = await electron.launch(options);
    shell = await shellReady(app);
    await shell.keyboard.press("Meta+,");
    settings = shell.getByTestId("settings-page");
    await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(settings.getByTestId("desktop-icon-green")).toBeChecked();
    await expect(settings.getByTestId("desktop-icon-option-green")).toHaveAttribute("data-selected", "true");
    await settings.getByTestId("desktop-icon-picker").evaluate((element) => element.scrollIntoView({ block: "center" }));
    await shell.screenshot({ animations: "disabled", path: join(screenshots, "03-green-restored.png") });

    // The default remains available after opting into green.
    await settings.getByTestId("desktop-icon-white").focus();
    await settings.getByTestId("desktop-icon-white").press("Space");
    await expect(settings.getByTestId("desktop-icon-white")).toBeChecked();
    await expect(settings.getByTestId("desktop-icon-option-white")).toHaveAttribute("data-selected", "true");
    await expect.poll(async () => JSON.parse(await readFile(join(userData, "settings.json"), "utf8")).appearance.desktopIcon).toBe("white");
    await shell.screenshot({ animations: "disabled", path: join(screenshots, "04-white-selected.png") });
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
