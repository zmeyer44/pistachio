import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS, type SettingsSection } from "@pistachio/shell-contracts/settings";
import { ADDRESS_INTENT_LIMITS } from "@pistachio/shell-contracts/address-intent";
import { rankFuzzy, STRONG_FUZZY_SCORE } from "../src/lib/fuzzy";
import { SETTINGS_INTENTS, settingsIntentEntryId, settingsIntentKeywords } from "../src/lib/settings-intents";

describe("the settings intent catalog", () => {
  it("reaches every settings section from at least one intent", () => {
    const covered = new Set(SETTINGS_INTENTS.map((intent) => intent.section));
    const missing = (Object.keys(SETTINGS_SECTIONS) as SettingsSection[]).filter((section) => !covered.has(section));
    // A settings page nobody can ask for is a page nobody finds.
    expect(missing).toEqual([]);
  });

  it("gives every intent its own id", () => {
    const ids = SETTINGS_INTENTS.map((intent) => intent.id);
    expect(new Set(ids).size).toBe(ids.length);
    const rows = SETTINGS_INTENTS.map(settingsIntentEntryId);
    expect(new Set(rows).size).toBe(rows.length);
  });

  it("keeps one canonical row per section under the plain settings:<section> id", () => {
    const canonical = SETTINGS_INTENTS.map(settingsIntentEntryId).filter((id) => !id.startsWith("settings-intent:"));
    // The id the rest of the app — and the e2e suite — knows a section by.
    expect(canonical).toContain("settings:shortcuts");
    expect(canonical).toContain("settings:general");
    expect(canonical).toContain("settings:privacy/spaces");
    expect(new Set(canonical).size).toBe(Object.keys(SETTINGS_SECTIONS).length);
  });

  it("stays inside the lengths the request clips to", () => {
    for (const intent of SETTINGS_INTENTS) {
      expect(intent.title.length, intent.id).toBeLessThanOrEqual(ADDRESS_INTENT_LIMITS.maxLabelChars);
      expect(intent.title.length, intent.id).toBeLessThanOrEqual(80);
      expect(intent.description.length, intent.id).toBeLessThanOrEqual(ADDRESS_INTENT_LIMITS.maxDetailChars);
      expect(intent.keywords.length, intent.id).toBeGreaterThan(0);
    }
  });

  it("still answers a plain section name with that section's canonical row", () => {
    // The rows are now named for errands ("Theme & colors"), not for pages,
    // so asking for a page by name has to keep working through the keywords
    // — this is what the palette's e2e specs press ↵ on.
    const candidates = SETTINGS_INTENTS.map((intent) => ({
      item: settingsIntentEntryId(intent),
      text: intent.title,
      keywords: settingsIntentKeywords(intent),
      priority: 10,
    }));
    for (const [section, label] of Object.entries(SETTINGS_SECTIONS) as Array<[SettingsSection, string]>) {
      const top = rankFuzzy(label, candidates)[0];
      expect(top?.item, label).toBe(`settings:${section || "general"}`);
      // And decisively enough that it outranks a web search for the words.
      expect(top?.score ?? 0, label).toBeGreaterThanOrEqual(STRONG_FUZZY_SCORE);
    }
  });

  it("describes each page with one positive sentence that starts with a verb", () => {
    for (const intent of SETTINGS_INTENTS) {
      // The model reads these literally: no questions, no "if you want to",
      // and a capital letter through a full stop.
      expect(intent.description, intent.id).toMatch(/^[A-Z][^?]*\.$/);
      expect(intent.description, intent.id).not.toMatch(/\b(never|cannot|without ever|don't|do not)\b/i);
    }
  });
});
