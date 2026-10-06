import { describe, expect, it } from "vitest";
import {
  bounceDestination,
  CHROME_USER_AGENT_HOSTS,
  chromeUserAgent,
  httpsUpgradeFor,
  isCrossSite,
  referrerFor,
  siteOf,
  stripTrackingParams,
  wantsChromeUserAgent,
} from "../src/main/shields/url-rules";

describe("tracking parameters", () => {
  it("removes click identifiers and keeps everything else as written", () => {
    expect(stripTrackingParams("https://shop.example/item?id=42&fbclid=abc&color=red#reviews", "standard")).toBe(
      "https://shop.example/item?id=42&color=red#reviews",
    );
    expect(stripTrackingParams("https://example.com/?gclid=1&msclkid=2", "standard")).toBe("https://example.com/");
    expect(stripTrackingParams("https://example.com/search?q=a+b%20c&yclid=9", "standard")).toBe("https://example.com/search?q=a+b%20c");
  });

  it("leaves campaign tags to strict", () => {
    const url = "https://news.example/story?utm_source=newsletter&utm_medium=email&id=7";
    expect(stripTrackingParams(url, "standard")).toBeNull();
    expect(stripTrackingParams(url, "strict")).toBe("https://news.example/story?id=7");
  });

  it("removes site-specific parameters only on the site that coins them", () => {
    expect(stripTrackingParams("https://www.youtube.com/watch?v=dQw4&si=share123", "standard")).toBe("https://www.youtube.com/watch?v=dQw4");
    expect(stripTrackingParams("https://example.com/?si=keep", "standard")).toBeNull();
    expect(stripTrackingParams("https://x.com/user/status/1?s=20&t=abc", "standard")).toBe("https://x.com/user/status/1");
  });

  it("answers null when there is nothing to remove, or when it is off", () => {
    expect(stripTrackingParams("https://example.com/?page=2", "strict")).toBeNull();
    expect(stripTrackingParams("https://example.com/?fbclid=1", "off")).toBeNull();
    expect(stripTrackingParams("not a url?fbclid=1", "standard")).toBeNull();
  });
});

describe("bounce tracking", () => {
  it("skips redirect pages straight to their destination", () => {
    expect(bounceDestination("https://www.google.com/url?q=https://example.com/a&sa=D")).toBe("https://example.com/a");
    expect(bounceDestination("https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.org%2Fpage&h=AT0")).toBe("https://example.org/page");
    expect(bounceDestination("https://www.youtube.com/redirect?event=video_description&q=https%3A%2F%2Fexample.net")).toBe("https://example.net/");
    expect(bounceDestination("https://href.li/?https://example.com/x")).toBe("https://example.com/x");
  });

  it("leaves pages alone when the destination is missing, not a web address, or the same host", () => {
    expect(bounceDestination("https://www.google.com/url?sa=D")).toBeNull();
    expect(bounceDestination("https://l.facebook.com/l.php?u=javascript:alert(1)")).toBeNull();
    expect(bounceDestination("https://www.google.com/url?q=https://www.google.com/maps")).toBeNull();
    expect(bounceDestination("https://example.com/url?q=https://elsewhere.com")).toBeNull();
  });
});

describe("sites", () => {
  it("groups hosts by registrable domain", () => {
    expect(siteOf("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteOf("a.b.example.com")).toBe("example.com");
    expect(isCrossSite("https://cdn.example.com/x.js", "https://www.example.com/")).toBe(false);
    expect(isCrossSite("https://tracker.net/p.gif", "https://www.example.com/")).toBe(true);
    // Private suffixes are sites of their own: two GitHub Pages users are not one site.
    expect(isCrossSite("https://alice.github.io/", "https://bob.github.io/")).toBe(true);
  });
});

describe("referrers", () => {
  it("trims cross-site referrers to the origin and leaves same-site ones", () => {
    expect(referrerFor("https://www.example.com/private/path?q=1", "https://ads.net/x", "trim")).toBe("https://www.example.com/");
    expect(referrerFor("https://www.example.com/private/path", "https://img.example.com/x", "trim")).toBeUndefined();
    expect(referrerFor("https://www.example.com/", "https://ads.net/x", "trim")).toBeUndefined();
    expect(referrerFor("https://www.example.com/a", "https://ads.net/x", "strip")).toBeNull();
    expect(referrerFor("https://www.example.com/a", "https://ads.net/x", "default")).toBeUndefined();
  });
});

describe("HTTPS upgrades", () => {
  it("upgrades public hosts on the default port", () => {
    expect(httpsUpgradeFor("http://example.com/path?q=1", new Set())).toBe("https://example.com/path?q=1");
  });

  it("leaves private, local, numeric, ported, and already-failed hosts alone", () => {
    for (const url of [
      "http://localhost/",
      "http://192.168.1.10/",
      "http://printer.local/",
      "http://intranet/",
      "http://example.com:8080/",
      "http://site.test/",
      "https://example.com/",
    ]) {
      expect(httpsUpgradeFor(url, new Set()), url).toBeNull();
    }
    expect(httpsUpgradeFor("http://legacy.example.org/", new Set(["legacy.example.org"]))).toBeNull();
  });
});

describe("user agent", () => {
  it("reports Chrome's user agent without the app's and Electron's tokens", () => {
    const electron =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Pistachio/0.0.29 Chrome/150.0.7871.224 Electron/43.4.1 Safari/537.36";
    expect(chromeUserAgent(electron)).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    );
    expect(chromeUserAgent(chromeUserAgent(electron))).toBe(chromeUserAgent(electron));
  });

  it("is Chrome's only on the listed hosts and below them", () => {
    expect(CHROME_USER_AGENT_HOSTS).toContain("accounts.google.com");
    expect(wantsChromeUserAgent("https://accounts.google.com/v3/signin/identifier", CHROME_USER_AGENT_HOSTS)).toBe(true);
    expect(wantsChromeUserAgent("https://ACCOUNTS.GOOGLE.COM/", CHROME_USER_AGENT_HOSTS)).toBe(true);
    expect(wantsChromeUserAgent("https://eu.accounts.google.com/", CHROME_USER_AGENT_HOSTS)).toBe(true);
    for (const url of ["https://www.google.com/", "https://accounts.google.com.evil.example/", "https://notaccounts.google.com/", "https://challenges.cloudflare.com/", "not a url"]) {
      expect(wantsChromeUserAgent(url, CHROME_USER_AGENT_HOSTS), url).toBe(false);
    }
  });
});
