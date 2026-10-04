import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { pageFirst, shellReady } from "./windows";
import { launchApp } from "./app";
import { captureShell as captureWindowFrame } from "./chrome-harness";

function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  return captureWindowFrame(app, "screen-share", filename);
}

/**
 * Ask for the screen from the meeting page's tab, as its share button would,
 * and settle with the error's name — or "shared" if a stream came back.
 */
function requestScreen(app: ElectronApplication, pageUrl: string): Promise<string> {
  return app.evaluate(
    async ({ webContents }, pageUrl) => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL() === pageUrl);
      if (tab === undefined) throw new Error(`No tab is showing ${pageUrl}`);
      return tab.executeJavaScript(
        `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(
          (stream) => { stream.getTracks().forEach((track) => track.stop()); return "shared"; },
          (error) => error.name)`,
        true,
      ) as Promise<string>;
    },
    pageUrl,
  );
}

// Answering "allow" would open macOS's own picker over the whole desktop, so
// this spec stays on the questions Pistachio asks; the picker itself was
// checked by hand (a Not supported error before the display-media handler).
test("a page's screen share asks about the screen, not the camera it was already allowed", { tag: ["@site", "@media"] }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Meeting</title><h1>Meeting</h1>");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Meeting test server did not bind a TCP port");
  const origin = `http://localhost:${address.port}`;
  const pageUrl = `${origin}/`;
  const { app, userData } = await launchApp({
    settings: pageFirst({ general: { homeUrl: pageUrl } }),
    // Screen share used to be read as a camera request, so a site allowed the
    // camera went straight past any question about the screen.
    files: { "site-permissions.json": { version: 1, sites: { [origin]: { camera: "allow" } } } },
    name: "screen-share",
  });
  try {
    const shell = await shellReady(app);
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }, pageUrl) => webContents.getAllWebContents().some((contents) => contents.getURL() === pageUrl && !contents.isLoading()),
          pageUrl,
        ),
      )
      .toBe(true);

    const firstAnswer = requestScreen(app, pageUrl);
    const prompt = shell.getByTestId("permission-prompt");
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText(`localhost:${address.port} wants to capture your screen`);
    await expect(prompt).not.toContainText("camera");
    await captureShell(app, "01-screen-prompt.png");

    await prompt.getByRole("button", { name: "Always allow" }).waitFor();
    await prompt.getByRole("button", { name: "Block", exact: true }).click();
    expect(await firstAnswer).toBe("NotAllowedError");
    await expect(prompt).toHaveCount(0);

    // The answer is kept as the screen's, beside the camera's own.
    await expect
      .poll(async () => JSON.parse(await readFile(join(userData, "site-permissions.json"), "utf8")).sites[origin])
      .toEqual({ camera: "allow", "display-capture": "block" });
    expect(await requestScreen(app, pageUrl)).toBe("NotAllowedError");
    await expect(prompt).toHaveCount(0);
    await captureShell(app, "02-blocked-silently.png");
  } finally {
    await app.close();
    server.close();
  }
});
