import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { expect, test, type ElectronApplication, type Frame, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { demoToneWav } from "../../src/main/demo-page";
import { launchApp } from "./app";
import { capturePage, closeApp, pageAt } from "./chrome-harness";
import { openTabs } from "./desk-harness";
import { shellPage } from "./windows";

/**
 * Settings → General → Default playback speed, as only the real app has it:
 * the page preload asks main as each source starts, in every frame of the
 * page, and a speed set from the media card is the person's from then on.
 * Which media takes the default is the unit test's (shell-contracts
 * test/media.test.ts).
 */

const WAV = Buffer.from(demoToneWav());

/** The offline tone with byte ranges, so Chromium knows its length; and the two documents. */
function serve(frameOrigin: () => string) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    if (path === "/test.wav") {
      const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), WAV.length - 1) : WAV.length - 1;
      response.writeHead(match ? 206 : 200, {
        "content-type": "audio/wav",
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
        ...(match ? { "content-range": `bytes ${start}-${end}/${WAV.length}` } : {}),
      });
      response.end(WAV.subarray(start, end + 1));
      return;
    }
    // Quiet, not muted: a muted loop is a backdrop, and keeps its speed.
    const player = `<audio id="player" loop src="/test.wav"></audio><script>document.getElementById("player").volume = 0.05</script>`;
    const body =
      path === "/frame"
        ? `<!doctype html><title>Embedded player</title>${player}`
        : `<!doctype html><title>Listening</title><h1>Listening</h1>${player}<iframe src="${frameOrigin()}/frame"></iframe>`;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(body);
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The fixture did not start");
  return `http://127.0.0.1:${String(address.port)}`;
}

function rate(target: Page | Frame): Promise<number> {
  return target.locator("#player").evaluate((audio) => (audio as HTMLAudioElement).playbackRate);
}

/** Load `source` into the player and play it until a little of it has been heard. */
async function play(target: Page | Frame, source?: string): Promise<void> {
  await target.locator("#player").evaluate(async (audio, next) => {
    const player = audio as HTMLAudioElement;
    if (next !== undefined) player.src = next;
    await player.play();
  }, source);
  await expect
    .poll(() => target.locator("#player").evaluate((audio) => (audio as HTMLAudioElement).currentTime))
    .toBeGreaterThan(0.3);
}

test.describe.serial("the default playback speed", { tag: ["@media", "@settings"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let pageServer: Server;
  let frameServer: Server;
  let pageUrl: string;
  let frameOrigin = "";
  let app: ElectronApplication;
  let shell: Page;
  let page: Page;
  let frame: Frame;
  let tabId: string;

  test.beforeAll(async () => {
    // Another port is another origin: the frame is another site's embed.
    frameServer = createServer(serve(() => frameOrigin));
    frameOrigin = await listen(frameServer);
    pageServer = createServer(serve(() => frameOrigin));
    pageUrl = `${await listen(pageServer)}/`;
    ({ app } = await launchApp({ settings: { media: { defaultPlaybackRate: 1.5 } }, name: "default-playback-rate" }));
    shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    [tabId] = (await openTabs(shell, [pageUrl])) as [string];
    page = await pageAt(app, pageUrl);
    await expect.poll(() => page.frames().some((candidate) => candidate.url().startsWith(frameOrigin))).toBe(true);
    frame = page.frames().find((candidate) => candidate.url().startsWith(frameOrigin))!;
  });

  test.afterAll(async () => {
    await closeApp(app);
    await Promise.all([pageServer, frameServer].map((server) => new Promise<void>((done) => server.close(() => done()))));
  });

  test("audio on the page, and in another site's frame on it, starts at the default", async () => {
    await play(page);
    await expect.poll(() => rate(page)).toBe(1.5);
    await play(frame);
    await expect.poll(() => rate(frame)).toBe(1.5);
  });

  test("audio played outside the document, or inside a closed shadow root, starts at the default too", async () => {
    // Neither one's events reach the window: the page world tells the preload as play() is called.
    await page.evaluate(async () => {
      const players = window as unknown as { detached: HTMLAudioElement; shadowed: HTMLAudioElement };
      players.detached = new Audio("/test.wav?detached");
      const host = document.createElement("div");
      document.body.append(host);
      players.shadowed = document.createElement("audio");
      players.shadowed.src = "/test.wav?shadowed";
      host.attachShadow({ mode: "closed" }).append(players.shadowed);
      for (const audio of [players.detached, players.shadowed]) {
        audio.loop = true;
        audio.volume = 0.05;
        await audio.play();
      }
    });
    const rates = () =>
      page.evaluate(() => {
        const players = window as unknown as { detached: HTMLAudioElement; shadowed: HTMLAudioElement };
        return [players.detached.playbackRate, players.shadowed.playbackRate];
      });
    await expect.poll(rates).toEqual([1.5, 1.5]);
    // The page's own play() still answers as the built-in does.
    expect(await page.evaluate(() => HTMLMediaElement.prototype.play.length)).toBe(0);

    // Started by the browser itself — autoplay, no play() call — inside a closed shadow root.
    const autoplayed = () =>
      page.evaluate(() => {
        const players = window as unknown as { autoplayed?: HTMLAudioElement };
        if (players.autoplayed === undefined) {
          const host = document.createElement("div");
          document.body.append(host);
          players.autoplayed = document.createElement("audio");
          players.autoplayed.volume = 0.05;
          players.autoplayed.loop = true;
          players.autoplayed.autoplay = true;
          players.autoplayed.src = "/test.wav?autoplayed";
          host.attachShadow({ mode: "closed" }).append(players.autoplayed);
        }
        return { playing: !players.autoplayed.paused, rate: players.autoplayed.playbackRate };
      });
    await expect.poll(autoplayed).toEqual({ playing: true, rate: 1.5 });

    await page.evaluate(() => {
      const players = window as unknown as { detached: HTMLAudioElement; shadowed: HTMLAudioElement; autoplayed: HTMLAudioElement };
      players.detached.pause();
      players.shadowed.pause();
      players.autoplayed.pause();
    });
  });

  test("a speed chosen in Settings starts the next source, and leaves what is playing", async () => {
    await shell.keyboard.press("Meta+,");
    const settings = shell.getByTestId("settings-page");
    await expect(settings.getByRole("heading", { name: "General" })).toBeVisible();
    const speed = settings.getByTestId("default-playback-rate");
    await speed.scrollIntoViewIfNeeded();
    await expect(speed).toHaveValue("1.5");
    await speed.selectOption("1.25");
    await capturePage(settings, "default-playback-rate", "settings-row.png");
    await expect
      .poll(() =>
        shell.evaluate(async () => {
          const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
          return (await api.getSettings()).media.defaultPlaybackRate;
        }),
      )
      .toBe(1.25);
    await shell.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    await play(page, "/test.wav?next");
    await expect.poll(() => rate(page)).toBe(1.25);
    // A default is where playback starts, not a hand on what is already playing.
    expect(await rate(frame)).toBe(1.5);
  });

  test("a speed set on the media card stays the person's for that player", async () => {
    await shell.evaluate(
      async (id) => {
        const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
        await api.controlMedia(id, { type: "setRate", rate: 1 });
      },
      tabId,
    );
    await expect.poll(() => rate(page)).toBe(1);
    await play(page, "/test.wav?again");
    expect(await rate(page)).toBe(1);
  });

  test("Read aloud starts at the default", async () => {
    // Offline, the clip is the Mac's own voice; the player is a page like any other.
    await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      await api.readAloudText("A default speed is where listening starts, and the voice reading a page starts there too.", "Speed check");
    });
    await expect.poll(() => app.windows().some((candidate) => candidate.url().startsWith("pistachio://read-aloud/"))).toBe(true);
    const player = app.windows().find((candidate) => candidate.url().startsWith("pistachio://read-aloud/"))!;
    await expect.poll(() => rate(player), { timeout: 15_000 }).toBe(1.25);
  });
});
