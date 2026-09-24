import { computeRecordIdHex, type CdpCookie, type CookieIdentity } from "@pistachio/sync-protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PlaywrightBrowserRuntime } from "../src/browser/runtime.js";
import { PlaywrightCookieApplier } from "../src/sync/applier.js";
import { browserContextIdFor, CdpCookieJar, PlaywrightCookieCapture, projectCdpCookie, type CookieJarReader } from "../src/sync/capture.js";
import { CHROMIUM, describeChromium } from "./helpers/chromium.js";
import { attrs, identity, testSpaceKeys } from "./helpers/keys.js";

const SPACE = "work";
const NOW = 1_700_000_000_000;

function cdp(overrides: Partial<CdpCookie> & Pick<CdpCookie, "name" | "domain">): CdpCookie {
  return { value: "v", path: "/", expires: -1, secure: true, httpOnly: false, session: true, ...overrides };
}

class FakeJar implements CookieJarReader {
  cookies: CdpCookie[] = [];
  reads = 0;
  async read(): Promise<CdpCookie[]> {
    this.reads += 1;
    return this.cookies.map((cookie) => ({ ...cookie }));
  }
}

describe("cookie capture diff", () => {
  it("projects CDP cookies through the shared cookie map", () => {
    const projected = projectCdpCookie(SPACE, cdp({ name: "sid", domain: ".example.com", expires: 1_800_000_000, session: false, sameSite: "None" }));
    expect(projected?.identity).toEqual(identity(SPACE, ".example.com", "sid"));
    expect(projected?.projection).toEqual({ value: "v", expiresSec: 1_800_000_000, persistent: true, secure: true, httpOnly: false, sameSite: "no_restriction" });
    expect(projectCdpCookie(SPACE, cdp({ name: "p", domain: "example.com", partitionKey: { topLevelSite: "https://top.example" } }))).toBeNull();
    expect(projectCdpCookie(SPACE, cdp({ name: "u", domain: "example.com" }))?.projection.sameSite).toBe("unspecified");
  });

  it("reports expiry as 'expired', removals as 'explicit', new cookies as 'explicit', and changes as 'overwrite'", async () => {
    const keys = await testSpaceKeys(SPACE);
    const jar = new FakeJar();
    const clock = { now: NOW };
    const localChange = vi.fn(async () => null);
    const capture = new PlaywrightCookieCapture({ spaceId: SPACE, jar, idKey: keys.idKey, now: () => clock.now, isHydrating: () => false });
    capture.attach({ localChange });
    const expiring = cdp({ name: "sid", domain: "example.com", expires: NOW / 1000 + 60, session: false });
    const session = cdp({ name: "tmp", domain: ".example.com", value: "s" });
    jar.cookies = [expiring, session];
    await capture.seedBaseline();
    expect(localChange).not.toHaveBeenCalled();
    expect(capture.baseline.size).toBe(2);

    // Nothing changed: no local change.
    await capture.diff();
    expect(localChange).not.toHaveBeenCalled();

    // The persistent cookie vanished after its expiry: 'expired'.
    clock.now = NOW + 120_000;
    jar.cookies = [session];
    await capture.diff();
    expect(localChange).toHaveBeenCalledTimes(1);
    expect(localChange).toHaveBeenLastCalledWith(identity(SPACE, "example.com", "sid"), null, true, "expired");

    // The session cookie vanished before any expiry: 'explicit'.
    jar.cookies = [];
    await capture.diff();
    expect(localChange).toHaveBeenLastCalledWith(identity(SPACE, ".example.com", "tmp"), null, true, "explicit");

    // A new cookie: 'explicit' write with its attributes.
    const fresh = cdp({ name: "new", domain: "example.com", value: "1", httpOnly: true, sameSite: "Lax" });
    jar.cookies = [fresh];
    await capture.diff();
    expect(localChange).toHaveBeenLastCalledWith(identity(SPACE, "example.com", "new"), attrs("1", { httpOnly: true, sameSite: "lax" }), false, "explicit");

    // A changed value: 'overwrite'.
    jar.cookies = [{ ...fresh, value: "2" }];
    await capture.diff();
    expect(localChange).toHaveBeenLastCalledWith(identity(SPACE, "example.com", "new"), attrs("2", { httpOnly: true, sameSite: "lax" }), false, "overwrite");
    expect(localChange).toHaveBeenCalledTimes(4);

    // A partitioned cookie is never captured.
    jar.cookies = [{ ...fresh, value: "2" }, cdp({ name: "chips", domain: "example.com", partitionKey: { topLevelSite: "https://top.example" } })];
    await capture.diff();
    expect(localChange).toHaveBeenCalledTimes(4);
  });

  it("skips diffs while hydrating and coalesces scheduled diffs", async () => {
    const keys = await testSpaceKeys(SPACE);
    const jar = new FakeJar();
    let hydrating = true;
    const localChange = vi.fn(async () => null);
    const capture = new PlaywrightCookieCapture({ spaceId: SPACE, jar, idKey: keys.idKey, now: () => NOW });
    capture.attach({ localChange }, () => hydrating);
    jar.cookies = [cdp({ name: "a", domain: "example.com" })];
    await capture.diff();
    expect(localChange).not.toHaveBeenCalled();
    hydrating = false;
    const before = jar.reads;
    capture.scheduleDiff();
    capture.scheduleDiff();
    capture.scheduleDiff();
    await capture.drain();
    expect(jar.reads - before).toBe(1);
    expect(localChange).toHaveBeenCalledTimes(1);
    capture.detach();
    capture.scheduleDiff();
    await capture.drain();
    expect(localChange).toHaveBeenCalledTimes(1);
  });
});

describeChromium("cookie capture over a real jar", () => {
  const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });

  beforeAll(async () => {
    await runtime.browser();
  });

  afterAll(async () => {
    await runtime.close();
  });

  it("an applied 'unspecified' record reads back without SameSite and produces no local change", async () => {
    const browser = await runtime.browser();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, ignoreHTTPSErrors: false });
    try {
      const page = await context.newPage();
      const jar = new CdpCookieJar(await runtime.cdp(), await browserContextIdFor(page));
      const keys = await testSpaceKeys(SPACE);
      const localChange = vi.fn(async () => null);
      const capture = new PlaywrightCookieCapture({ spaceId: SPACE, jar, idKey: keys.idKey, now: () => Date.now() });
      capture.attach({ localChange }, () => false);
      const applier = new PlaywrightCookieApplier({ store: context, jar, capture, spaceId: SPACE, idKey: keys.idKey });
      await capture.seedBaseline();
      const id: CookieIdentity = identity(SPACE, "example.com", "plain");
      await applier.apply({ identity: id, attributes: attrs("x", { sameSite: "unspecified" }), deleted: false }, "WRITE");
      const raw = (await jar.read()).find((cookie) => cookie.name === "plain");
      expect(raw?.sameSite).toBeUndefined();
      // Playwright's own reader would say Lax; the capture reads raw CDP.
      expect((await context.cookies()).find((cookie) => cookie.name === "plain")?.sameSite).toBe("Lax");
      await capture.diff();
      expect(localChange).not.toHaveBeenCalled();
      expect(capture.baseline.has(await computeRecordIdHex(keys.idKey, id))).toBe(true);
    } finally {
      await context.close();
    }
  });
});
