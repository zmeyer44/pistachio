import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { shellPage } from "./windows";

const screenshotDirectory = join(
  process.cwd(),
  "e2e/screenshots/single-instance",
);

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      suffix,
    ),
  ].find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function runDuplicate(
  executablePath: string,
  userData: string,
): Promise<number | null> {
  const duplicate = spawn(executablePath, ["."], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PISTACHIO_E2E: "1",
      PISTACHIO_USER_DATA: userData,
    },
    stdio: "ignore",
  });
  return new Promise<number | null>((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      duplicate.kill();
      rejectExit(new Error("Duplicate Pistachio instance did not exit"));
    }, 10_000);
    duplicate.once("error", (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
    duplicate.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
}

test("a duplicate process cannot share a durable Space session", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");

  const userData = await mkdtemp(join(tmpdir(), "pistachio-single-instance-"));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: {
      ...process.env,
      PISTACHIO_E2E: "1",
      PISTACHIO_USER_DATA: userData,
    },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await mkdir(screenshotDirectory, { recursive: true });
    await shell.screenshot({
      path: join(screenshotDirectory, "01-primary-instance.png"),
      fullPage: true,
    });

    expect(await runDuplicate(executablePath, userData)).toBe(0);
    expect(shell.isClosed()).toBe(false);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => ({
          count: BrowserWindow.getAllWindows().length,
          visible: BrowserWindow.getAllWindows()[0]?.isVisible() ?? false,
        })),
      )
      .toEqual({ count: 1, visible: true });
    await shell.screenshot({
      path: join(screenshotDirectory, "02-primary-remains-active.png"),
      fullPage: true,
    });
  } finally {
    await app.close();
  }
});
