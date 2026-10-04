import { FiltersEngine, Request } from "@ghostery/adblocker";
import { describe, expect, it } from "vitest";
import { compileEngines, engineEnv, withoutTrustedRules } from "../src/main/shields/compile";

const ADS = `! Title: test ads
||ads.example.net^
||tracker.example.org^$third-party
/banner-ad.$image
||cdn.example.com/ads/*$script,important
example.com##.sponsored
##.ad-slot
@@||ads.example.net/allowed.js^
`;

const SECURITY = `! Title: test security
||malware.example^
||phish.example^$doc
`;

function load(bytes: Uint8Array): FiltersEngine {
  const engine = FiltersEngine.deserialize(bytes);
  engine.updateEnv(engineEnv());
  return engine;
}

function request(url: string, sourceUrl: string, type: string) {
  return Request.fromRawDetails({ url, sourceUrl, type: type as never });
}

describe("the compiled engines", () => {
  const output = compileEngines({
    lists: [{ id: "ads", text: ADS, trusted: false }],
    dangerLists: [{ id: "security", text: SECURITY, trusted: false }],
    customFilters: "||mine.example^\nnot a valid filter $$$###",
    resources: null,
  });
  const engine = load(output.engine);
  const danger = load(output.danger!);

  it("blocks what the lists name and lets exceptions through", () => {
    expect(engine.match(request("https://ads.example.net/x.js", "https://news.example/", "script")).match).toBe(true);
    expect(engine.match(request("https://ads.example.net/allowed.js", "https://news.example/", "script")).match).toBe(false);
    expect(engine.match(request("https://news.example/banner-ad.png", "https://news.example/", "image")).match).toBe(true);
    expect(engine.match(request("https://news.example/article.js", "https://news.example/", "script")).match).toBe(false);
  });

  it("applies $third-party relative to the requesting page", () => {
    expect(engine.match(request("https://tracker.example.org/p.gif", "https://news.example/", "image")).match).toBe(true);
    expect(engine.match(request("https://tracker.example.org/p.gif", "https://www.example.org/", "image")).match).toBe(false);
  });

  it("knows which matches insist ($important), for Standard's first-party leniency", () => {
    const result = engine.match(request("https://cdn.example.com/ads/a.js", "https://www.example.com/", "script"));
    expect(result.match).toBe(true);
    expect(result.filter?.isImportant()).toBe(true);
  });

  it("compiles the person's own filters and reports the lines it could not read", () => {
    expect(engine.match(request("https://mine.example/t.js", "https://news.example/", "script")).match).toBe(true);
    expect(output.customErrors).toEqual(["not a valid filter $$$###"]);
  });

  it("hides elements by hostname and by the DOM's classes", () => {
    const specific = engine.getCosmeticsFilters({
      url: "https://www.example.com/",
      hostname: "www.example.com",
      domain: "example.com",
      getBaseRules: true,
      getInjectionRules: true,
      getRulesFromHostname: true,
      getRulesFromDOM: false,
    });
    expect(specific.styles).toContain(".sponsored");
    const generic = engine.getCosmeticsFilters({
      url: "https://news.example/",
      hostname: "news.example",
      domain: "news.example",
      classes: ["ad-slot", "story"],
      getBaseRules: false,
      getInjectionRules: false,
      getRulesFromHostname: false,
      getRulesFromDOM: true,
    });
    expect(generic.styles).toContain(".ad-slot");
  });

  it("stops dangerous pages with the danger engine alone", () => {
    expect(danger.match(request("https://malware.example/", "https://malware.example/", "main_frame")).match).toBe(true);
    expect(danger.match(request("https://phish.example/login", "https://phish.example/login", "main_frame")).match).toBe(true);
    expect(danger.match(request("https://news.example/", "https://news.example/", "main_frame")).match).toBe(false);
    // An ad server is a request to keep out, never a page to warn about.
    expect(danger.match(request("https://ads.example.net/", "https://ads.example.net/", "main_frame")).match).toBe(false);
    expect(output.dangerFilters).toBe(2);
  });
});

describe("big lists", () => {
  it("compiles a list larger than a function call can take as arguments", () => {
    // AdGuard Tracking Protection carries ~325,000 network filters.
    const text = Array.from({ length: 330_000 }, (_, i) => `||t${String(i)}.example^`).join("\n");
    const output = compileEngines({ lists: [{ id: "huge", text, trusted: false }], dangerLists: [], customFilters: "", resources: null });
    expect(output.networkFilters).toBe(330_000);
  }, 120_000);
});

describe("trust", () => {
  it("resolves scriptlet aliases before deciding what an untrusted list may run", () => {
    const resources = JSON.stringify({
      scriptlets: [
        { name: "trusted-replace-node-text.js", aliases: ["rpnt.js", "replace-node-text.js"], dependencies: [], body: "function trustedReplaceNodeText() { window.__rewrote = true; }", requiresTrust: true },
        { name: "trusted-prevent-xhr.js", aliases: [], dependencies: [], body: "function trustedPreventXhr() {}" },
        { name: "set-constant.js", aliases: ["set.js"], dependencies: [], body: "function setConstant() {}" },
      ],
      redirects: [],
    });
    const scripts = (trusted: boolean) => {
      const output = compileEngines({
        lists: [{ id: "list", text: "example.com##+js(rpnt, script, a, b)\nexample.com##+js(replace-node-text, script, a, b)\nexample.com##+js(trusted-prevent-xhr, ads)\nexample.com##+js(set, ads, false)", trusted }],
        dangerLists: [],
        customFilters: "",
        resources,
      });
      return load(output.engine).getCosmeticsFilters({ url: "https://example.com/", hostname: "example.com", domain: "example.com", getBaseRules: false, getInjectionRules: true, getRulesFromHostname: true, getRulesFromDOM: false }).scripts.join("\n");
    };
    const untrusted = scripts(false);
    expect(untrusted).toContain("setConstant");
    expect(untrusted).not.toContain("trustedReplaceNodeText");
    expect(untrusted).not.toContain("trustedPreventXhr");
    expect(scripts(true)).toContain("trustedReplaceNodeText");
  });

  it("drops trusted-only rules from lists uBlock Origin does not maintain", () => {
    const text = [
      "example.com##+js(trusted-set-cookie, consent, yes)",
      "example.com##+js(set-constant, ads, false)",
      "||example.com^$replace=/ad/x/",
      "example.com#%#//scriptlet('trusted-click-element', '.accept')",
      "||plain.example^",
    ].join("\n");
    expect(withoutTrustedRules(text).split("\n")).toEqual(["example.com##+js(set-constant, ads, false)", "||plain.example^"]);
  });
});
