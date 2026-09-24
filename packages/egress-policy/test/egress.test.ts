/**
 * The required-test list for identity egress routing, as executable tests.
 * The release gates being defended here are "zero silent egress fallback to
 * direct" and "local/private traffic never proxied".
 */

import { describe, expect, it } from "vitest";
import {
  bypassPatternsFor,
  decideEgress,
  defaultSpaceEgress,
  explain,
  isLoopbackHost,
  isPrivateHost,
  matchHostedCheckout,
  proxyConfigFor,
  suggestBypassOnChallenge,
  type EgressGateway,
  type NetworkContext,
  type SpaceEgressConfig,
} from "../src/index.js";

const workSpace = (over: Partial<SpaceEgressConfig> = {}): SpaceEgressConfig => ({
  ...defaultSpaceEgress("work"),
  policy: "identity",
  ...over,
});

const net = (over: Partial<NetworkContext> = {}): NetworkContext => ({
  gateway: "up",
  vpnRoutes: [],
  vpnActive: false,
  ...over,
});

const GATEWAY: EgressGateway = { host: "gw.example", port: 8443 };

describe("per-space policy", () => {
  it("routes a work space through the identity IP and a personal space direct", () => {
    expect(decideEgress("github.com", workSpace(), net()).route).toBe("gateway");
    expect(decideEgress("github.com", defaultSpaceEgress("personal"), net()).route).toBe("direct");
  });
});

describe("local and private traffic is never proxied", () => {
  it("classifies loopback hosts", () => {
    for (const h of ["localhost", "dev.localhost", "127.0.0.1", "127.10.0.5", "::1"]) {
      expect(isLoopbackHost(h)).toBe(true);
      expect(decideEgress(h, workSpace(), net()).route).toBe("direct");
    }
  });

  it("classifies RFC1918, CGNAT, link-local and IPv6 private ranges", () => {
    const priv = [
      "10.0.0.1",
      "192.168.1.10",
      "172.16.4.4",
      "172.31.255.255",
      "169.254.1.1",
      "100.64.0.1",
      "fd12:3456::1",
      "fe80::1",
      "build-server", // bare LAN hostname
    ];
    for (const h of priv) {
      expect(isPrivateHost(h), h).toBe(true);
      expect(decideEgress(h, workSpace(), net()).route, h).toBe("direct");
    }
  });

  it("does not misclassify public addresses as private", () => {
    for (const h of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "github.com", "2606:4700::1111"]) {
      expect(isPrivateHost(h), h).toBe(false);
    }
    expect(decideEgress("8.8.8.8", workSpace(), net()).route).toBe("gateway");
  });

  it("keeps corporate VPN routes off the gateway and says so", () => {
    const context = net({ vpnActive: true, vpnRoutes: ["corp.example.com"] });
    const d = decideEgress("wiki.corp.example.com", workSpace(), context);
    expect(d.route).toBe("direct");
    expect(d.reason).toBe("vpn_route");
    expect(d.explanation).toContain("direct on this network");
    // A non-VPN host in the same session still uses the identity IP.
    expect(decideEgress("github.com", workSpace(), context).route).toBe("gateway");
  });
});

describe("fail-closed behavior (release gate: zero silent fallback)", () => {
  it("blocks rather than silently going direct when the gateway is down", () => {
    const d = decideEgress("github.com", workSpace(), net({ gateway: "down" }));
    expect(d.route).toBe("blocked");
    expect(d.reason).toBe("gateway_down_failclosed");
    expect(d.explanation).toContain("rather than reveal your real IP");
  });

  it("goes direct only after the explicit one-click override", () => {
    const d = decideEgress(
      "github.com",
      workSpace({ temporaryDirectOverride: true }),
      net({ gateway: "down" }),
    );
    expect(d.route).toBe("direct");
    expect(d.reason).toBe("gateway_down_override");
    expect(d.explanation).toContain("at your request");
  });

  it("still serves local and media traffic while the gateway is down", () => {
    const down = net({ gateway: "down" });
    expect(decideEgress("localhost", workSpace(), down).route).toBe("direct");
    expect(decideEgress("youtube.com", workSpace(), down).route).toBe("direct");
  });
});

describe("media and per-site bypass", () => {
  it("bypasses high-bandwidth media by default and honors disabling it", () => {
    expect(decideEgress("googlevideo.com", workSpace(), net()).reason).toBe("media_bypass");
    expect(decideEgress("r1---sn-x.googlevideo.com", workSpace(), net()).reason).toBe(
      "media_bypass",
    );
    expect(decideEgress("googlevideo.com", workSpace({ mediaBypass: false }), net()).route).toBe(
      "gateway",
    );
  });

  it("honors an explicit per-site bypass including subdomains", () => {
    const space = workSpace({ siteBypass: ["ticketmaster.com"] });
    expect(decideEgress("ticketmaster.com", space, net()).reason).toBe("site_bypass");
    expect(decideEgress("www.ticketmaster.com", space, net()).reason).toBe("site_bypass");
    expect(decideEgress("ticketmaster.com.evil.test", space, net()).route).toBe("gateway");
  });
});

describe("hosted checkout bypass", () => {
  it("recognises a processor's own checkout domain", () => {
    expect(matchHostedCheckout("https://checkout.stripe.com/c/pay/cs_live_abc")?.label).toBe(
      "Stripe Checkout",
    );
    expect(matchHostedCheckout("https://buy.stripe.com/aEU3cx4Zq")?.host).toBe("buy.stripe.com");
    expect(decideEgress("checkout.stripe.com", workSpace(), net()).reason).toBe("hosted_checkout");
  });

  it("recognises a merchant-branded checkout domain by its path", () => {
    // The reported case: a Shopify checkout on the merchant's own domain,
    // which no host list could have known about.
    const match = matchHostedCheckout(
      "https://buy.maticrobots.com/checkouts/cn/hWNFecMbyVb6WL4UpbCn2Bpy/en-us?_r=AQAB",
    );
    expect(match).toEqual({ host: "buy.maticrobots.com", label: "Shopify checkout" });
  });

  it("leaves ordinary pages on the identity IP", () => {
    for (const url of [
      "https://maticrobots.com/products/arm",
      "https://maticrobots.com/collections/checkouts",
      "https://example.com/blog/c/payments",
      "not a url",
      "file:///etc/passwd",
    ]) {
      expect(matchHostedCheckout(url)).toBeNull();
    }
    expect(decideEgress("maticrobots.com", workSpace(), net()).route).toBe("gateway");
  });

  it("routes a detected merchant checkout host direct, subdomains included", () => {
    const space = workSpace({ detectedCheckoutHosts: ["buy.maticrobots.com"] });
    expect(decideEgress("buy.maticrobots.com", space, net()).reason).toBe("hosted_checkout");
    expect(decideEgress("cdn.buy.maticrobots.com", space, net()).reason).toBe("hosted_checkout");
    expect(decideEgress("maticrobots.com", space, net()).route).toBe("gateway");
  });

  it("keeps checkout working when the gateway is down, instead of failing closed", () => {
    // A blocked checkout is indistinguishable from a broken payment to the
    // user, and the page carries no identity worth protecting anyway.
    const down = net({ gateway: "down" });
    expect(decideEgress("checkout.stripe.com", workSpace(), down).route).toBe("direct");
    expect(decideEgress("shop.example", workSpace(), down).route).toBe("blocked");
  });

  it("honors disabling the checkout bypass", () => {
    const space = workSpace({
      checkoutBypass: false,
      detectedCheckoutHosts: ["buy.maticrobots.com"],
    });
    expect(decideEgress("checkout.stripe.com", space, net()).route).toBe("gateway");
    expect(decideEgress("buy.maticrobots.com", space, net()).route).toBe("gateway");
  });

  it("puts checkout hosts in the Chromium bypass rules, with subdomain patterns", () => {
    const cfg = proxyConfigFor(
      workSpace({ detectedCheckoutHosts: ["buy.maticrobots.com"] }),
      GATEWAY,
      net(),
    );
    // Chromium matches a bare hostname exactly, so both forms must be present
    // or the network stack disagrees with decideEgress.
    const rules = cfg.proxyBypassRules.split(";");
    expect(rules).toContain("checkout.stripe.com");
    expect(rules).toContain("*.checkout.stripe.com");
    expect(rules).toContain("buy.maticrobots.com");
    expect(rules).toContain("*.buy.maticrobots.com");
    expect(
      proxyConfigFor(workSpace({ checkoutBypass: false }), GATEWAY, net()).proxyBypassRules,
    ).not.toContain("checkout.stripe.com");
  });
});

describe("challenge detection suggests, never auto-applies", () => {
  it("suggests a bypass on challenge status codes and for known-hostile origins", () => {
    expect(suggestBypassOnChallenge("shop.example", 403, workSpace())?.host).toBe("shop.example");
    expect(suggestBypassOnChallenge("shop.example", 429, workSpace())).not.toBeNull();
    expect(suggestBypassOnChallenge("nike.com", 200, workSpace())?.reason).toContain(
      "known to challenge",
    );
  });

  it("stays quiet for healthy responses, direct spaces, and already-bypassed sites", () => {
    expect(suggestBypassOnChallenge("shop.example", 200, workSpace())).toBeNull();
    expect(
      suggestBypassOnChallenge("shop.example", 403, defaultSpaceEgress("personal")),
    ).toBeNull();
    expect(
      suggestBypassOnChallenge("shop.example", 403, workSpace({ siteBypass: ["shop.example"] })),
    ).toBeNull();
  });
});

describe("explain", () => {
  it("reports the decision keyed by the normalized host", () => {
    expect(explain("WWW.GitHub.com", workSpace(), net())).toEqual({
      host: "www.github.com",
      route: "gateway",
      reason: "identity",
      explanation: "Browsing through your Pistachio identity IP.",
    });
    expect(explain("localhost", workSpace(), net({ gateway: "down" }))).toMatchObject({
      host: "localhost",
      route: "direct",
      reason: "loopback",
    });
  });
});

describe("Chromium proxy config (fail-closed, no direct fallback)", () => {
  it("points a proxied space at the gateway as an https proxy with no fallback", () => {
    const cfg = proxyConfigFor(workSpace(), GATEWAY, net());
    expect(cfg.mode).toBe("fixed_servers");
    expect(cfg.proxyRules).toBe("https://gw.example:8443");
    expect(cfg.proxyRules).not.toContain("direct");
    expect(cfg.proxyRules).not.toContain(",");
  });

  it("brackets an IPv6 gateway literal", () => {
    const cfg = proxyConfigFor(workSpace(), { host: "2606:4700::1111", port: 443 }, net());
    expect(cfg.proxyRules).toBe("https://[2606:4700::1111]:443");
  });

  it("leaves a direct space unproxied", () => {
    const cfg = proxyConfigFor(defaultSpaceEgress("personal"), GATEWAY, net());
    expect(cfg.mode).toBe("fixed_servers");
    expect(cfg.proxyRules).toBe("direct://");
    expect(cfg.proxyBypassRules).toBe("");
  });

  it("bypasses local ranges, media, and VPN routes at the network stack", () => {
    const cfg = proxyConfigFor(
      workSpace({ siteBypass: ["bank.example"] }),
      GATEWAY,
      net({ vpnActive: true, vpnRoutes: ["corp.example.com"] }),
    );
    const rules = cfg.proxyBypassRules.split(";");
    expect(rules).toContain("<local>");
    expect(rules).toContain("127.0.0.1/8");
    expect(rules).toContain("192.168.0.0/16");
    for (const host of ["bank.example", "corp.example.com", "googlevideo.com"]) {
      expect(rules, host).toContain(host);
      expect(rules, host).toContain(`*.${host}`);
    }
  });

  it("emits both the bare host and its wildcard for every bypass host", () => {
    const cfg = proxyConfigFor(
      workSpace({ siteBypass: ["bank.example"], detectedCheckoutHosts: ["buy.shop.example"] }),
      GATEWAY,
      net({ vpnActive: true, vpnRoutes: ["corp.example.com"] }),
    );
    const rules = cfg.proxyBypassRules.split(";");
    const hosts = rules.filter(
      (r) => !r.startsWith("*.") && !r.startsWith("<") && !r.includes("/"),
    );
    for (const host of hosts) {
      if (host === "localhost" || host === "::1") continue;
      expect(rules, host).toContain(`*.${host}`);
    }
    // Every wildcard has its bare form, too.
    for (const rule of rules.filter((r) => r.startsWith("*."))) {
      expect(rules, rule).toContain(rule.slice(2));
    }
  });

  it("keeps the VPN routes out of the bypass list when the VPN is inactive", () => {
    const cfg = proxyConfigFor(
      workSpace(),
      GATEWAY,
      net({ vpnActive: false, vpnRoutes: ["corp.example.com"] }),
    );
    expect(cfg.proxyBypassRules).not.toContain("corp.example.com");
  });
});

describe("bypassPatternsFor", () => {
  it("emits the host and its wildcard, normalized", () => {
    expect(bypassPatternsFor(["Example.com", ".foo.bar", " baz.qux "])).toEqual([
      "example.com",
      "*.example.com",
      "foo.bar",
      "*.foo.bar",
      "baz.qux",
      "*.baz.qux",
    ]);
  });

  it("leaves IP literals and CIDR ranges alone and drops empty entries", () => {
    expect(bypassPatternsFor(["10.1.2.3", "10.0.0.0/8", "[::1]", "2606:4700::1111", ""])).toEqual([
      "10.1.2.3",
      "10.0.0.0/8",
      "[::1]",
      "2606:4700::1111",
    ]);
  });
});
