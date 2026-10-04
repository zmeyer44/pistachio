import { describe, expect, it } from "vitest";
import { applySettingsPatch, DEFAULT_SETTINGS, sanitizeSettings } from "../src/settings.js";
import {
  dangerFilterLists,
  DEFAULT_SHIELDS,
  effectiveFilterLists,
  FILTER_LIST_IDS,
  FILTER_LISTS,
  isShieldsRequest,
  matchingShieldsLevel,
  mergeShieldsPatch,
  sanitizeShields,
  SHIELDS_PRESETS,
  shieldsExceptionFor,
  shieldsSiteKey,
} from "../src/shields.js";
import { isBrowserControlCommand } from "../src/browser-controls.js";

describe("Shields settings", () => {
  it("default to Standard: uBlock Origin's lists, on", () => {
    expect(DEFAULT_SETTINGS.shields.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.shields.level).toBe("standard");
    expect(effectiveFilterLists(DEFAULT_SHIELDS)).toEqual([
      "ubo-filters",
      "easylist",
      "ubo-quick-fixes",
      "ubo-unbreak",
      "easyprivacy",
      "ubo-privacy",
      "peter-lowe",
      "ubo-badware",
      "urlhaus",
    ]);
    expect(dangerFilterLists(DEFAULT_SHIELDS)).toEqual(["ubo-badware", "urlhaus"]);
  });

  it("fill a file written before Shields existed with the defaults", () => {
    const { shields: _omitted, ...older } = DEFAULT_SETTINGS;
    expect(sanitizeSettings(older).shields).toEqual(DEFAULT_SHIELDS);
  });

  it("let a preset own its knobs, whatever the file says", () => {
    const tampered = sanitizeShields({ ...DEFAULT_SHIELDS, level: "standard", blocking: "off", fingerprinting: "strict" });
    expect(tampered.blocking).toBe(SHIELDS_PRESETS.standard.blocking);
    expect(tampered.fingerprinting).toBe(SHIELDS_PRESETS.standard.fingerprinting);
    const custom = sanitizeShields({ ...DEFAULT_SHIELDS, level: "custom", blocking: "off" });
    expect(custom.blocking).toBe("off");
  });

  it("drop values that are not one of a knob's choices, one knob at a time", () => {
    const settings = sanitizeShields({ level: "custom", blocking: "nuclear", https: "strict", lists: { easylist: "yes", "adguard-base": true }, customFilters: 7 });
    expect(settings.blocking).toBe(DEFAULT_SHIELDS.blocking);
    expect(settings.https).toBe("strict");
    expect(settings.lists.easylist).toBe(true);
    expect(settings.lists["adguard-base"]).toBe(true);
    expect(settings.customFilters).toBe("");
  });

  it("keep the person's filters across presets", () => {
    const withFilters = mergeShieldsPatch(DEFAULT_SHIELDS, { customFilters: "||mine.example^" });
    expect(withFilters.level).toBe("standard");
    expect(mergeShieldsPatch(withFilters, { level: "strict" }).customFilters).toBe("||mine.example^");
  });
});

describe("merging a settings patch", () => {
  it("makes one changed knob a custom choice", () => {
    const next = mergeShieldsPatch(DEFAULT_SHIELDS, { https: "strict" });
    expect(next.level).toBe("custom");
    expect(next.https).toBe("strict");
    expect(next.blocking).toBe("standard");
  });

  it("reads knobs that land exactly on a preset as that preset", () => {
    const custom = mergeShieldsPatch(DEFAULT_SHIELDS, { https: "strict" });
    expect(mergeShieldsPatch(custom, { https: "upgrade" }).level).toBe("standard");
    expect(matchingShieldsLevel({ ...DEFAULT_SHIELDS, ...SHIELDS_PRESETS.strict })).toBe("strict");
  });

  it("takes a named preset's knobs, and a named Custom keeps the current ones", () => {
    const strict = mergeShieldsPatch(DEFAULT_SHIELDS, { level: "strict" });
    expect(strict).toMatchObject({ level: "strict", blocking: "aggressive", crossSiteCookies: "all", https: "strict" });
    expect(mergeShieldsPatch(strict, { level: "custom" })).toMatchObject({ level: "custom", blocking: "aggressive" });
  });

  it("goes through applySettingsPatch the same way", () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { shields: { fingerprinting: "off" } });
    expect(next.shields).toMatchObject({ level: "custom", fingerprinting: "off" });
    expect(applySettingsPatch(next, { shields: { enabled: false } }).shields).toMatchObject({ level: "custom", enabled: false });
  });
});

describe("which lists load", () => {
  it("adds the lists a knob brings, and nothing while blocking is off", () => {
    const strict = mergeShieldsPatch(DEFAULT_SHIELDS, { level: "strict" });
    const lists = effectiveFilterLists(strict);
    expect(lists).toContain("easylist-cookie");
    expect(lists).toContain("ubo-cookie-annoyances");
    expect(lists).toContain("adguard-url-tracking");
    const off = mergeShieldsPatch(DEFAULT_SHIELDS, { blocking: "off" });
    expect(effectiveFilterLists(off)).toEqual([]);
    // Dangerous pages are still stopped with blocking off.
    expect(dangerFilterLists(off)).toEqual(["ubo-badware", "urlhaus"]);
    expect(dangerFilterLists({ ...off, enabled: false })).toEqual([]);
  });

  it("names every list once, each with an https source", () => {
    expect(new Set(FILTER_LIST_IDS).size).toBe(FILTER_LISTS.length);
    for (const list of FILTER_LISTS) for (const url of list.urls) expect(url.startsWith("https://"), url).toBe(true);
  });
});

describe("sites", () => {
  it("keys a site by hostname without www, and covers its subdomains", () => {
    expect(shieldsSiteKey("https://www.Example.com/path")).toBe("example.com");
    expect(shieldsSiteKey("shop.example.com")).toBe("shop.example.com");
    expect(shieldsSiteKey("not a host")).toBe("");
    // Local and intranet addresses can have Shields down too.
    expect(shieldsSiteKey("http://[::1]:3000/")).toBe("[::1]");
    expect(shieldsSiteKey("http://intranet/wiki")).toBe("intranet");
    expect(shieldsSiteKey("intranet")).toBe("intranet");
    expect(shieldsExceptionFor("[::1]", ["[::1]"])).toBe("[::1]");
    expect(shieldsSiteKey("http://exa mple/")).toBe("");
    expect(shieldsExceptionFor("shop.example.com", ["example.com"])).toBe("example.com");
    expect(shieldsExceptionFor("example.com", ["shop.example.com"])).toBeNull();
    expect(shieldsExceptionFor("notexample.com", ["example.com"])).toBeNull();
  });

  it("validates the wire", () => {
    expect(isShieldsRequest({ type: "setSite", site: "example.com", enabled: false })).toBe(true);
    expect(isShieldsRequest({ type: "setSite", site: 3, enabled: false })).toBe(false);
    expect(isShieldsRequest({ type: "nope" })).toBe(false);
    expect(isBrowserControlCommand({ type: "setShields", enabled: true })).toBe(true);
    expect(isBrowserControlCommand({ type: "setShields" })).toBe(false);
  });
});
