import { describe, expect, it } from "vitest";
import type {
  WatchtowerRawBlock,
  WatchtowerRawCapture,
  WatchtowerRegionRule,
} from "@pistachio/agent-runtime/watchtower";
import {
  applyRegions,
  buildRegions,
  judgeLocally,
  rulesFrom,
  sane,
  specificSignature,
} from "../src/regions.js";

const block = (text: string, path: string[], linkChars = 0): WatchtowerRawBlock => ({ text, path, linkChars });
const prose = (n: number) => `Paragraph ${n}. ${"The restored lathe needed new bearings and a careful alignment of the headstock. ".repeat(3)}`;

/** A video page: title and description, a recommendations column, a merch shelf, an ad. */
const videoPage = (): WatchtowerRawBlock[] => [
  block("# Rebuilding a 1940s lathe", ["div#columns", "div#primary", "div#title"]),
  block("Workshop Channel · 2.1M subscribers", ["div#columns", "div#primary", "div#owner"]),
  ...[1, 2, 3].map((n) => block(prose(n), ["div#columns", "div#primary", "div#description"])),
  block("Sponsored · Oneleet — SOC 2 built for founders, trusted by startups everywhere and then some more words", ["div#columns", "div#primary", "div.promo-slot"], 20),
  ...Array.from({ length: 12 }, (_, n) =>
    block(`### The Riemann Hypothesis, explained part ${n}`, ["div#columns", "div#secondary", "ytd-compact-video.item"], 44),
  ),
  ...[1, 2, 3, 4].map((n) => block(`I rebuilt one of these last year, comment ${n}. ${"Great detail on the scraping. ".repeat(4)}`, ["div#columns", "div#primary", "div#comments", "div.thread"])),
];

describe("Watchtower regions", () => {
  it("groups blocks by where they sit, one region per repeated layout part", () => {
    const regions = buildRegions(videoPage());
    const signatures = regions.map((region) => region.signature);
    expect(signatures.some((s) => s.endsWith("div#secondary>ytd-compact-video.item") || s.endsWith("div#secondary"))).toBe(true);
    const rail = regions.find((region) => region.signature.includes("div#secondary"))!;
    expect(rail.blocks).toHaveLength(12);
    expect(rail.linkChars / rail.chars).toBeGreaterThan(0.8);
    // Every block belongs to exactly one region.
    expect(regions.flatMap((region) => region.blocks).sort((a, b) => a - b)).toEqual(videoPage().map((_, i) => i));
  });

  it("keeps what the page is about, drops a named rail and an announced ad, and asks about the rest", () => {
    const regions = buildRegions(videoPage());
    const verdicts = judgeLocally(regions, new Map());
    const of = (needle: string) => verdicts[regions.findIndex((region) => region.signature.includes(needle))]!;
    expect(of("div#description")).toMatchObject({ keep: true, decided: true });
    expect(of("div#secondary")).toMatchObject({ keep: false, decided: true });
    expect(of("div.promo-slot")).toMatchObject({ keep: false, decided: true });
    expect(of("div#comments")).toMatchObject({ keep: true, decided: true });
  });

  it("leaves an unnamed link-heavy region undecided, and a remembered rule settles it", () => {
    const blocks = [
      ...[1, 2, 3, 4].map((n) => block(prose(n), ["div.layout", "div.col-a"])),
      ...Array.from({ length: 10 }, (_, n) => block(`Another headline worth a click, number ${n}`, ["div.layout", "div.col-b"], 38)),
    ];
    const regions = buildRegions(blocks);
    const index = regions.findIndex((region) => region.signature.endsWith("div.col-b"));
    expect(judgeLocally(regions, new Map())[index]).toEqual({ keep: false, decided: false });
    const rule: WatchtowerRegionRule = { signature: regions[index]!.signature, keep: false, role: "recommendations", source: "model", at: 1000 };
    expect(judgeLocally(regions, new Map([[rule.signature, rule]]), "article", 2000)[index]).toEqual({ keep: false, decided: true, source: "rule" });
    // A rule older than a month is asked about again.
    expect(judgeLocally(regions, new Map([[rule.signature, rule]]), "article", 1000 + 40 * 86400000)[index]).toMatchObject({ decided: false });
  });

  it("keeps an index page whose content IS links, and never drops an unnamed wrapper", () => {
    const front = Array.from({ length: 30 }, (_, n) => block(`${n}. A story title that is a link (example.com)`, ["table", "tbody", "tr"], 40));
    const regions = buildRegions(front);
    expect(judgeLocally(regions, new Map()).every((verdict) => verdict.keep && verdict.decided)).toBe(true);
    expect(specificSignature("div>div>div")).toBe(false);
    expect(specificSignature("div#related>a>h3")).toBe(true);
    expect(specificSignature("div#app>div>div>div>div>p")).toBe(false);
    expect(specificSignature("div>aside")).toBe(true);
    expect(specificSignature("div>ytd-watch-next")).toBe(true);
  });

  it("drops a wall of other videos even when it is most of the page, and keeps the subject", () => {
    // A watch page with a short description: the rail is 80% of the text.
    const blocks = [
      block("# Rebuilding a 1940s lathe", ["div#columns", "div#primary", "div#title"]),
      block("Workshop Channel · 2.1M subscribers", ["div#columns", "div#primary", "div#owner"]),
      ...Array.from({ length: 20 }, (_, n) =>
        block(`### Some other video entirely, part ${n} · Another Channel · 1.2M views`, ["div#columns", "div#secondary", "div#items", "yt-lockup.item", "div.meta"], 60),
      ),
    ];
    const regions = buildRegions(blocks);
    const keep = sane(regions, judgeLocally(regions, new Map(), "video").map((verdict) => verdict.keep));
    const capture = applyRegions({ url: "https://v.example/w", title: "t", description: "", creator: "", kind: "video", truncated: false, blocks, links: [] }, regions, keep);
    expect(capture.blocks).toEqual(["# Rebuilding a 1940s lathe", "Workshop Channel · 2.1M subscribers"]);
  });

  it("keeps the story cards of a front page, where links are the content, and only asks about named furniture", () => {
    const blocks = [
      block("# News", ["div.page", "h1.title"]),
      ...Array.from({ length: 12 }, (_, n) => block(`## Story headline number ${n} that is a link · A one-line summary of the story`, ["div.page", "div.grid", "a.card"], 70)),
      ...Array.from({ length: 6 }, (_, n) => block(`## Most read item ${n} in the list today`, ["div.page", "div.most-read", "a.card"], 38)),
    ];
    const regions = buildRegions(blocks);
    const verdicts = judgeLocally(regions, new Map(), "page");
    const grid = verdicts[regions.findIndex((region) => region.signature.includes("div.grid"))]!;
    const mostRead = verdicts[regions.findIndex((region) => region.signature.includes("most-read"))]!;
    expect(grid).toMatchObject({ keep: true, decided: true });
    expect(mostRead.decided === false || mostRead.keep === false).toBe(true);
  });

  it("does not believe verdicts that would throw most of a page away", () => {
    const regions = buildRegions(videoPage());
    // Everything but the ad slot dropped, the headline with it: not credible.
    const wrong = regions.map((region) => region.signature.includes("promo"));
    const kept = sane(regions, wrong);
    expect(kept.filter(Boolean).length).toBeGreaterThan(1);
    expect(kept[regions.findIndex((region) => region.signature.includes("promo"))]).toBe(false);
  });

  it("filters blocks and the links that sat in them, and remembers only nameable regions", () => {
    const raw: WatchtowerRawCapture = {
      url: "https://video.example/watch?v=1", title: "Rebuilding a 1940s lathe", description: "", creator: "Workshop Channel",
      kind: "video", truncated: false, blocks: videoPage(),
      links: [
        { url: "https://video.example/watch?v=2", text: "Riemann", block: 7 },
        { url: "https://tools.example/bearings", text: "bearings", block: 2 },
      ],
    };
    const regions = buildRegions(raw.blocks);
    const keep = judgeLocally(regions, new Map()).map((verdict) => verdict.keep);
    const capture = applyRegions(raw, regions, keep);
    expect(capture.blocks.join("\n")).not.toMatch(/Riemann|Sponsored/u);
    expect(capture.blocks[0]).toBe("# Rebuilding a 1940s lathe");
    expect(capture.links).toEqual([{ url: "https://tools.example/bearings", text: "bearings" }]);
    const rules = rulesFrom(regions, regions.map((_, i) => ({ keep: keep[i]!, role: "local" as const, source: "local" as const })), 5);
    expect(rules.every((rule) => specificSignature(rule.signature) && rule.at === 5)).toBe(true);
  });
});
