/**
 * Where a credential capture may point (docs/web-browser-design.md §15).
 *
 * A capture is the one moment an agent run asks a person for a password, and
 * the pause tells them which site it is for. A capture aimed at a Pistachio
 * page would make that sentence a lie in the most useful possible way for an
 * attacker, so the target origin is refused before a capture is ever minted —
 * for BOTH sites, now that there are two.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_URL, DEFAULT_WEB_URL } from "../src/config.js";
import { originSet } from "../src/live/common.js";
import { refuseCredentialTarget } from "../src/runs/executor.js";

const WWW_URL = "https://www.example";
const BROWSER_URL = "https://app.example";
const sites = originSet([WWW_URL, BROWSER_URL]);

describe("refuseCredentialTarget", () => {
  it("never types a capture into either Pistachio site", () => {
    // www serves the capture form itself; the browser app IS the chrome the
    // person is trusting. Neither is a site anyone signs in to through a run.
    expect(refuseCredentialTarget(new URL(`${WWW_URL}/credential-capture/abc`), sites)).toBe(
      "credentials cannot be requested for a Pistachio page",
    );
    expect(refuseCredentialTarget(new URL(`${BROWSER_URL}/`), sites)).toBe(
      "credentials cannot be requested for a Pistachio page",
    );
    // The whole origin is refused, not one path on it.
    expect(refuseCredentialTarget(new URL(`${BROWSER_URL}/anything?q=1#f`), sites)).not.toBeNull();

    // And an ordinary site is exactly what a capture is for.
    expect(refuseCredentialTarget(new URL("https://shop.example/login"), sites)).toBeNull();
  });

  it("matches on the origin, so a lookalike host, port or scheme is not a Pistachio page", () => {
    // `has` on an origin string is the point: these all differ from the two
    // above, and every one of them is somebody else's site.
    for (const url of [
      "https://www.example.evil.test/login",
      "https://evil.test/https://app.example",
      "http://app.example/login",
      "https://app.example:8443/login",
    ]) {
      expect(refuseCredentialTarget(new URL(url), sites), url).toBeNull();
    }
  });

  it("refuses a page that is not on the web at all before it looks at origins", () => {
    expect(refuseCredentialTarget(new URL("about:blank"), sites)).toBe(
      "credentials can only be sent to an HTTP or HTTPS page",
    );
    expect(refuseCredentialTarget(new URL("file:///etc/passwd"), sites)).toBe(
      "credentials can only be sent to an HTTP or HTTPS page",
    );
  });

  it("covers both sites under the executor's own defaults", () => {
    // What `RunExecutor` builds when a deployment configures neither URL.
    // The browser app is a different host from www, so a guard that had kept
    // one origin would have left it wide open.
    const defaults = originSet([DEFAULT_WEB_URL, DEFAULT_BROWSER_URL]);
    expect(defaults.size).toBe(2);
    expect(refuseCredentialTarget(new URL(DEFAULT_WEB_URL), defaults)).not.toBeNull();
    expect(refuseCredentialTarget(new URL(DEFAULT_BROWSER_URL), defaults)).not.toBeNull();
  });
});
