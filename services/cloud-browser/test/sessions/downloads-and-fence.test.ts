/**
 * Two promises the branch made and did not keep: §11's twenty-four-hour
 * retention sweep for a session's downloads, and W7's "every agent tool call
 * carries the generation it was issued under".
 */

import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserBackend } from "@pistachio/agent-runtime";
import { DOWNLOAD_RETENTION_MS, SessionDownloads } from "../../src/sessions/downloads.js";
import { fencedBrowser, isControlLost, type ControlFence } from "../../src/runs/control-fence.js";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pistachio-sweep-"));
  dirs.push(dir);
  return dir;
}

describe("a session's downloads on the shared worker", () => {
  it("sweeps the bytes of a session that is no longer here, not only the ones it remembers", async () => {
    const dir = await stateDir();
    const root = join(dir, USER, "downloads");
    const downloads = new SessionDownloads({ userId: USER, stateDir: dir });
    // Left behind by a session that was suspended, ended, or served by a
    // process that has since restarted. Nothing in memory names it, and the
    // only sweep there was ran over the records — so these bytes stayed on a
    // disk shared with other people's sessions for ever.
    await downloads.reserve("seed.bin");
    await writeFile(join(root, "old-file.bin"), "old bytes");
    await writeFile(join(root, "fresh-file.bin"), "fresh bytes");
    const stale = new Date(Date.now() - DOWNLOAD_RETENTION_MS - 60_000);
    await utimes(join(root, "old-file.bin"), stale, stale);

    await downloads.sweepDirectory();
    expect((await readdir(root)).sort()).toEqual(["fresh-file.bin"]);
  });

  it("binds a minted URL to the viewer that asked for it", async () => {
    const dir = await stateDir();
    const downloads = new SessionDownloads({ userId: USER, stateDir: dir });
    const reserved = await downloads.reserve("report.pdf");
    await writeFile(reserved.path, "%PDF-1.4\n");
    const record = downloads.adopt({
      tabId: "web:1",
      pageUrl: "https://example.com/",
      fileName: "report.pdf",
      path: reserved.path,
      bytes: 9,
    });
    const token = downloads.mint(record.id, "the-viewer's-own-key");
    expect(token).not.toBeNull();
    // The token in the address is half the credential. A URL forwarded into a
    // chat message, a log, or another viewer's browser opens nothing.
    expect(await downloads.redeem(record.id, token!, "somebody-else's-key")).toBeNull();
    expect(await downloads.redeem(record.id, token!, "")).toBeNull();
    expect(await downloads.redeem(record.id, token!, "the-viewer's-own-key")).not.toBeNull();
    // …and one use only.
    expect(await downloads.redeem(record.id, token!, "the-viewer's-own-key")).toBeNull();
  });
});

/** A backend that records what actually reached it. */
function spyBackend(landed: string[]): BrowserBackend {
  return {
    kind: "cloud",
    listTabs: () => [],
    openTab: async () => "cloud:1",
    focusTab: async () => undefined,
    navigate: async () => undefined,
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
    inspect: async () => ({ title: "", url: "", text: "", controls: [] }),
    click: async (_tabId: string, target: string) => {
      landed.push(`click:${target}`);
    },
    type: async (_tabId: string, target: string, value: string) => {
      landed.push(`type:${target}=${value}`);
      return value;
    },
    press: async () => undefined,
    scroll: async () => undefined,
    screenshot: async () => "data:image/png;base64,",
  };
}

describe("the control fence over agent tool calls (W7)", () => {
  it("refuses a click the person's takeover overtook", async () => {
    const landed: string[] = [];
    const fence: ControlFence = { holder: "agent", generation: 7 };
    let dropped = 0;
    const browser = fencedBrowser(spyBackend(landed), () => fence, () => {
      dropped += 1;
    });

    // The model dispatched this while the agent held the wheel…
    const inFlight = browser.click("cloud:1", "#buy");
    // …and the person took control before it reached Playwright. Aborting the
    // turn does not unmake a promise already in flight, which is exactly the
    // "a released agent lands a keystroke behind the person's" case W7 exists
    // to prevent.
    fence.holder = "human";
    fence.generation = 8;
    await expect(inFlight).rejects.toSatisfy(isControlLost);
    expect(landed).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("refuses every later call of a turn the person has taken over", async () => {
    const landed: string[] = [];
    const fence: ControlFence = { holder: "human", generation: 9 };
    const browser = fencedBrowser(spyBackend(landed), () => fence);
    await expect(browser.type("cloud:1", "#field", "the agent's text")).rejects.toSatisfy(isControlLost);
    await expect(browser.navigate("cloud:1", "https://example.com/")).rejects.toSatisfy(isControlLost);
    expect(landed).toEqual([]);
  });

  it("lets the agent act, and read, while it holds the wheel", async () => {
    const landed: string[] = [];
    const fence: ControlFence = { holder: "agent", generation: 3 };
    const browser = fencedBrowser(spyBackend(landed), () => fence);
    await browser.click("cloud:1", "#ok");
    expect(landed).toEqual(["click:#ok"]);
    // Reads are never fenced: refusing them would make the turn that resumes
    // after a release start blind.
    fence.holder = "human";
    await expect(browser.inspect("cloud:1")).resolves.toMatchObject({ title: "" });
  });
});
