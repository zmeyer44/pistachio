/**
 * The walkthrough's contracts, through the surface `@pistachio/shell-contracts/onboarding`
 * promises. The intake half — `heuristicIntake`, `sanitizeOnboardingIntake`,
 * `MAX_INTAKE_FACTS` and the shapes — is IMPLEMENTED in
 * `@pistachio/agent-runtime/onboarding`, beside the model calls that produce
 * it, and re-exported here (docs/web-browser-design.md §14). These cases
 * stay: they are what this package promises, and they now also hold the
 * re-export to being complete.
 */

import { describe, expect, it } from "vitest";
import {
  brandGradient,
  catalogColorsFor,
  paletteOf,
} from "../src/brand-colors.js";
import {
  FAVORITE_APPS,
  favoriteApp,
  heuristicIntake,
  isWelcomeUrl,
  MAX_INTAKE_FACTS,
  customFavoriteFrom,
  SUGGESTED_FAVORITES,
  ONBOARDING_STEPS,
  sanitizeOnboardingCompletion,
  sanitizeOnboardingIntake,
  spaceNameFor,
  WELCOME_TABS,
} from "../src/onboarding.js";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/settings.js";

describe("the favorites catalog", () => {
  it("has unique ids, loadable addresses, and at least one brand colour each", () => {
    const ids = new Set(FAVORITE_APPS.map((app) => app.id));
    expect(ids.size).toBe(FAVORITE_APPS.length);
    expect(FAVORITE_APPS.length).toBeGreaterThanOrEqual(SUGGESTED_FAVORITES * 3);
    for (const app of FAVORITE_APPS) {
      expect(() => new URL(app.url)).not.toThrow();
      expect(new URL(app.url).protocol).toBe("https:");
      expect(app.colors.length).toBeGreaterThan(0);
      for (const color of app.colors) expect(color).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it("keeps a brand's own palette: Figma carries five colours, YouTube one", () => {
    expect(favoriteApp("figma")?.colors).toHaveLength(5);
    expect(favoriteApp("youtube")?.colors).toEqual(["#FF0000"]);
    expect(favoriteApp("nope")).toBeNull();
  });
});

describe("welcome tabs", () => {
  it("lead with the overview and live on the app's own scheme", () => {
    expect(WELCOME_TABS[0]?.id).toBe("overview");
    for (const tab of WELCOME_TABS) expect(isWelcomeUrl(tab.url)).toBe(true);
    expect(isWelcomeUrl("https://example.com/welcome")).toBe(false);
    expect(isWelcomeUrl("pistachio://reminders")).toBe(false);
    expect(isWelcomeUrl("not a url")).toBe(false);
  });

  it("has four steps in order", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "about",
      "import",
      "favorites",
      "appearance",
    ]);
  });
});

describe("heuristicIntake", () => {
  it("finds a name after the usual introductions and keeps the rest as the bio", () => {
    const intake = heuristicIntake(
      "Hi, my name is Priya Natarajan. I'm a product designer in Austin and I run most mornings.",
    );
    expect(intake.name).toBe("Priya Natarajan");
    expect(intake.about).toBe(
      "I'm a product designer in Austin and I run most mornings.",
    );
    expect(intake.facts).toEqual([]);
  });

  it('reads "I\'m X" only when X looks like a name', () => {
    expect(heuristicIntake("I'm Alex and I work on data pipelines.").name).toBe(
      "Alex",
    );
    expect(heuristicIntake("I'm a backend engineer at a fintech.").name).toBe(
      "",
    );
    expect(heuristicIntake("I'm really into climbing.").name).toBe("");
  });

  it("returns an empty intake for an empty transcript", () => {
    expect(heuristicIntake("   ")).toEqual({
      transcript: "",
      name: "",
      about: "",
      facts: [],
    });
  });
});

describe("sanitizeOnboardingIntake", () => {
  it("bounds every field and drops facts that repeat or say nothing", () => {
    const intake = sanitizeOnboardingIntake({
      transcript: "x".repeat(10_000),
      name: "  Sam   Rivera ",
      about: 7,
      facts: [
        {
          content: "Lives in Lisbon",
          bucket: "location",
          kind: "static",
          label: "Home",
        },
        { content: "lives in lisbon", bucket: "location" },
        { content: "", bucket: "other" },
        {
          content: "Uses Linear at work",
          bucket: "not-a-bucket",
          kind: "nope",
          label: "",
        },
        "garbage",
      ],
    });
    expect(intake.transcript).toHaveLength(4_000);
    expect(intake.name).toBe("Sam Rivera");
    expect(intake.about).toBe("");
    expect(intake.facts).toEqual([
      {
        content: "Lives in Lisbon",
        bucket: "location",
        kind: "static",
        label: "Home",
      },
      {
        content: "Uses Linear at work",
        bucket: "other",
        kind: "static",
        label: null,
      },
    ]);
  });

  it("caps the facts", () => {
    const facts = Array.from({ length: 20 }, (_, index) => ({
      content: `Fact ${String(index)}`,
    }));
    expect(sanitizeOnboardingIntake({ facts }).facts).toHaveLength(
      MAX_INTAKE_FACTS,
    );
  });
});

describe("sanitizeOnboardingCompletion", () => {
  it("keeps only catalog favorites, once each, and a trimmed Space name", () => {
    const completion = sanitizeOnboardingCompletion({
      name: "Ada",
      about: "Writes compilers.",
      facts: [],
      favorites: [
        { kind: "app", id: "x" },
        { kind: "app", id: "figma" },
        { kind: "app", id: "x" },
        { kind: "app", id: "made-up" },
        "figma",
      ],
      spaceName: "  Ada  ",
      openWelcomeTabs: false,
    });
    expect(completion).toEqual({
      name: "Ada",
      about: "Writes compilers.",
      facts: [],
      favorites: [
        { kind: "app", id: "x" },
        { kind: "app", id: "figma" },
      ],
      spaceName: "Ada",
      openWelcomeTabs: false,
    });
  });

  it("keeps typed-in sites that are web addresses, once each, with the host as the title", () => {
    const completion = sanitizeOnboardingCompletion({
      favorites: [
        { kind: "site", url: "news.ycombinator.com", title: "" },
        { kind: "site", url: "https://news.ycombinator.com/" },
        { kind: "site", url: "app.example.com/inbox", title: "Work inbox" },
        { kind: "site", url: "ftp://files.example.com" },
        { kind: "site", url: "hackernews" },
        "https://not-an-object.example",
      ],
    });
    expect(completion?.favorites).toEqual([
      { kind: "site", url: "https://news.ycombinator.com/", title: "news.ycombinator.com" },
      { kind: "site", url: "https://app.example.com/inbox", title: "Work inbox" },
    ]);
  });

  it("still reads the older shape: bare catalog ids, then a list of typed-in sites", () => {
    const completion = sanitizeOnboardingCompletion({
      favorites: ["youtube", "made-up"],
      customFavorites: [{ url: "news.ycombinator.com", title: "" }],
    });
    expect(completion?.favorites).toEqual([
      { kind: "app", id: "youtube" },
      { kind: "site", url: "https://news.ycombinator.com/", title: "news.ycombinator.com" },
    ]);
  });

  it("keeps catalog apps and typed-in sites in the one order they were picked", () => {
    const completion = sanitizeOnboardingCompletion({
      favorites: [
        { kind: "app", id: "youtube" },
        { kind: "site", url: "news.ycombinator.com", title: "" },
        { kind: "app", id: "figma" },
      ],
    });
    expect(completion?.favorites).toEqual([
      { kind: "app", id: "youtube" },
      { kind: "site", url: "https://news.ycombinator.com/", title: "news.ycombinator.com" },
      { kind: "app", id: "figma" },
    ]);
  });

  it("defaults to opening the welcome tabs and refuses non-objects", () => {
    expect(sanitizeOnboardingCompletion({})?.openWelcomeTabs).toBe(true);
    expect(sanitizeOnboardingCompletion({})?.spaceName).toBeNull();
    expect(sanitizeOnboardingCompletion(null)).toBeNull();
    expect(sanitizeOnboardingCompletion("x")).toBeNull();
  });
});

describe("customFavoriteFrom", () => {
  it("gives a bare host its scheme and refuses words, spaces, and other schemes", () => {
    expect(customFavoriteFrom("  www.figma.com ")).toEqual({ url: "https://www.figma.com/", title: "figma.com" });
    expect(customFavoriteFrom("localhost:3000")).toEqual({ url: "http://localhost:3000/", title: "localhost" });
    expect(customFavoriteFrom("hackernews")).toBeNull();
    expect(customFavoriteFrom("two words.com")).toBeNull();
    expect(customFavoriteFrom("mailto:a@b.co")).toBeNull();
    expect(customFavoriteFrom("")).toBeNull();
  });
});

describe("spaceNameFor", () => {
  it("is the first name, or nothing", () => {
    expect(spaceNameFor("Grace Hopper")).toBe("Grace");
    expect(spaceNameFor("  ")).toBeNull();
  });
});

describe("settings.onboarding", () => {
  it("starts incomplete and survives a round trip", () => {
    expect(DEFAULT_SETTINGS.onboarding).toEqual({
      completed: false,
      completedAt: null,
    });
    const next = sanitizeSettings({
      onboarding: { completed: true, completedAt: "2026-08-27T10:00:00.000Z" },
    });
    expect(next.onboarding).toEqual({
      completed: true,
      completedAt: "2026-08-27T10:00:00.000Z",
    });
    expect(
      sanitizeSettings({
        onboarding: { completed: "yes", completedAt: "soon" },
      }).onboarding,
    ).toEqual({
      completed: false,
      completedAt: null,
    });
  });
});

describe("brand colours", () => {
  it("knows the catalog apps by host, subdomains included", () => {
    expect(catalogColorsFor("https://www.youtube.com/watch?v=1")).toEqual([
      "#FF0000",
    ]);
    expect(catalogColorsFor("https://music.youtube.com/")).toEqual(["#FF0000"]);
    expect(catalogColorsFor("https://example.com/")).toBeNull();
    expect(catalogColorsFor("not a url")).toBeNull();
  });

  it("reads a mark's colours off its pixels and ignores paper and ink", () => {
    const px: number[] = [];
    const put = (rgb: [number, number, number], n: number, a = 255) => {
      for (let i = 0; i < n; i++) px.push(...rgb, a);
    };
    put([255, 255, 255], 40); // paper
    put([0, 0, 0], 10); // ink
    put([255, 0, 0], 30); // the mark
    put([0, 0, 255], 20); // its second colour
    put([0, 255, 0], 1); // a stray pixel
    put([255, 0, 255], 50, 0); // transparent
    expect(paletteOf(px)).toEqual(["#ff0000", "#0000ff"]);
  });

  it("has nothing to say about a black-on-white icon", () => {
    expect(
      paletteOf([255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255]),
    ).toEqual([]);
    expect(brandGradient([])).toContain("linear-gradient");
    expect(brandGradient(["#123456"])).toBe(
      "linear-gradient(135deg, #123456, #123456)",
    );
  });
});
