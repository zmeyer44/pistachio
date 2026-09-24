import {
  attributesForCookie,
  computeRecordIdHex,
  identityForCookie,
  portableCookieFromCdp,
  type CookieAttributes,
  type CookieIdentity,
  type CookiePlain,
} from "@pistachio/sync-protocol";
import type { BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { PlaywrightBrowserRuntime } from "../src/browser/runtime.js";
import { CookieRejectedError, PlaywrightCookieApplier } from "../src/sync/applier.js";
import { browserContextIdFor, CdpCookieJar, PlaywrightCookieCapture } from "../src/sync/capture.js";
import { CHROMIUM, describeChromium } from "./helpers/chromium.js";
import { attrs, identity, testSpaceKeys } from "./helpers/keys.js";

const SPACE = "work";
const HOUR = 3_600_000;

interface Fixture {
  name: string;
  identity: CookieIdentity;
  attributes: CookieAttributes;
}

const NOW_MS = Math.floor(Date.now() / 1000) * 1000;

const FIXTURES: Fixture[] = [
  { name: "host-only session cookie", identity: identity(SPACE, "example.com", "hs"), attributes: attrs("host-only") },
  { name: "domain cookie", identity: identity(SPACE, ".example.com", "dm"), attributes: attrs("domain", { sameSite: "strict", expiresMs: NOW_MS + HOUR, persistent: true }) },
  { name: "non-root path", identity: identity(SPACE, "example.com", "pth", "/app"), attributes: attrs("path", { sameSite: "lax" }) },
  { name: "SameSite=None secure", identity: identity(SPACE, "example.com", "none"), attributes: attrs("none", { sameSite: "no_restriction" }) },
  { name: "SameSite unspecified", identity: identity(SPACE, "example.com", "unspec"), attributes: attrs("u", { sameSite: "unspecified" }) },
  { name: "persistent httpOnly", identity: identity(SPACE, "example.com", "keep"), attributes: attrs("keep", { httpOnly: true, expiresMs: NOW_MS + 2 * HOUR, persistent: true }) },
  { name: "nonsecure host-only", identity: identity(SPACE, "example.com", "plainhttp", "/", false), attributes: attrs("nonsecure", { secure: false, sameSite: "lax" }) },
];

describeChromium("cookie parity through the applier and raw CDP read-back", () => {
  const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
  const contexts: BrowserContext[] = [];

  beforeAll(async () => {
    await runtime.browser();
  });

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => undefined)));
  });

  afterAll(async () => {
    await runtime.close();
  });

  async function harness() {
    const browser = await runtime.browser();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, ignoreHTTPSErrors: false });
    contexts.push(context);
    const page = await context.newPage();
    const jar = new CdpCookieJar(await runtime.cdp(), await browserContextIdFor(page));
    const keys = await testSpaceKeys(SPACE);
    const localChange = vi.fn(async () => null);
    const capture = new PlaywrightCookieCapture({ spaceId: SPACE, jar, idKey: keys.idKey, now: () => Date.now() });
    capture.attach({ localChange }, () => false);
    const applier = new PlaywrightCookieApplier({ store: context, jar, capture, spaceId: SPACE, idKey: keys.idKey });
    await capture.seedBaseline();
    return { context, jar, keys, capture, applier, localChange };
  }

  it.each(FIXTURES)("round-trips $name without a second publish", async (fixture) => {
    const { jar, keys, capture, applier, localChange } = await harness();
    const plain: CookiePlain = { identity: fixture.identity, attributes: fixture.attributes, deleted: false };
    await applier.apply(plain, "WRITE");
    const raw = (await jar.read()).find((cookie) => cookie.name === fixture.identity.name);
    expect(raw).toBeDefined();
    const portable = portableCookieFromCdp(raw as NonNullable<typeof raw>);
    expect(portable).not.toBeNull();
    expect(identityForCookie(SPACE, portable as NonNullable<typeof portable>)).toEqual(fixture.identity);
    const readBack = attributesForCookie(portable as NonNullable<typeof portable>);
    expect(readBack).toEqual(fixture.attributes);
    const recordId = await computeRecordIdHex(keys.idKey, fixture.identity);
    expect(capture.baseline.get(recordId)?.projection.value).toBe(fixture.attributes.value);
    await capture.diff();
    expect(localChange).not.toHaveBeenCalled();
  });

  it("throws CookieRejectedError when Chromium refuses SameSite=None without Secure, leaving the record uncommitted", async () => {
    const { jar, capture, applier, localChange } = await harness();
    const rejected: CookiePlain = {
      identity: identity(SPACE, "example.com", "insecure-none", "/", false),
      attributes: attrs("x", { secure: false, sameSite: "no_restriction" }),
      deleted: false,
    };
    await expect(applier.apply(rejected, "WRITE")).rejects.toBeInstanceOf(CookieRejectedError);
    expect((await jar.read()).some((cookie) => cookie.name === "insecure-none")).toBe(false);
    expect(capture.baseline.size).toBe(0);
    await capture.diff();
    expect(localChange).not.toHaveBeenCalled();
  });

  it("removes exactly the tombstoned cookie and leaves its siblings", async () => {
    const { jar, keys, capture, applier, localChange } = await harness();
    const target = identity(SPACE, ".example.com", "a");
    const siblings = [identity(SPACE, "example.com", "a"), identity(SPACE, ".example.com", "a", "/x"), identity(SPACE, ".example.com", "b")];
    for (const id of [target, ...siblings]) {
      await applier.apply({ identity: id, attributes: attrs(`v:${id.hostKey}${id.path}${id.name}`), deleted: false }, "WRITE");
    }
    expect(await jar.read()).toHaveLength(4);
    await applier.apply({ identity: target, attributes: null, deleted: true }, "EXPLICIT_DELETE");
    const remaining = await jar.read();
    expect(remaining.map((cookie) => `${cookie.domain}${cookie.path}${cookie.name}`).sort()).toEqual([".example.com/b", ".example.com/xa", "example.com/a"]);
    expect(capture.baseline.has(await computeRecordIdHex(keys.idKey, target))).toBe(false);
    for (const id of siblings) expect(capture.baseline.has(await computeRecordIdHex(keys.idKey, id))).toBe(true);
    await capture.diff();
    expect(localChange).not.toHaveBeenCalled();
    // A tombstone for a cookie that is already gone is a no-op.
    await applier.apply({ identity: target, attributes: null, deleted: true }, "EXPLICIT_DELETE");
    expect(await jar.read()).toHaveLength(3);
  });

  it("captures a page-set cookie as an explicit write and its overwrite as OVERWRITE", async () => {
    const { context, capture, localChange } = await harness();
    const page = await context.newPage();
    await page.goto("about:blank");
    await context.addCookies([{ name: "pageset", value: "1", domain: "example.com", path: "/", secure: true, httpOnly: false, expires: -1 }]);
    await capture.diff();
    expect(localChange).toHaveBeenCalledTimes(1);
    expect(localChange).toHaveBeenLastCalledWith(identity(SPACE, "example.com", "pageset"), attrs("1", { sameSite: "unspecified" }), false, "explicit");
    await context.addCookies([{ name: "pageset", value: "2", domain: "example.com", path: "/", secure: true, httpOnly: false, expires: -1 }]);
    await capture.diff();
    expect(localChange).toHaveBeenLastCalledWith(identity(SPACE, "example.com", "pageset"), attrs("2", { sameSite: "unspecified" }), false, "overwrite");
    await context.clearCookies({ name: "pageset" });
    await capture.diff();
    expect(localChange).toHaveBeenLastCalledWith(identity(SPACE, "example.com", "pageset"), null, true, "explicit");
  });
  it("refuses an update whose value Chromium silently dropped, instead of committing the stale one", async () => {
    const { jar, capture, applier } = await harness();
    const id = identity(SPACE, "example.com", "sid", "/", false);

    // A cookie that lands normally.
    await applier.apply({ identity: id, attributes: attrs("first"), deleted: false }, "WRITE");
    expect((await jar.read()).find((cookie) => cookie.name === "sid")?.value).toBe("first");

    // The same cookie updated to a value Chromium will not accept
    // (SameSite=None without Secure). Playwright does not throw: the write is
    // dropped and the OLD cookie still matches on name, domain and path.
    // Matching on identity alone would commit the record and set the baseline
    // from the stale read-back, so no later diff would ever notice that the
    // account and the jar disagree.
    const refused: CookiePlain = {
      identity: id,
      attributes: attrs("second", { secure: false, sameSite: "no_restriction" }),
      deleted: false,
    };
    await expect(applier.apply(refused, "WRITE")).rejects.toBeInstanceOf(CookieRejectedError);
    expect((await jar.read()).find((cookie) => cookie.name === "sid")?.value).toBe("first");
    expect(capture.baseline.size).toBe(1);
  });
});
