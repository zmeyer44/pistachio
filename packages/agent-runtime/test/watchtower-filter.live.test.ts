/**
 * Live check of Watchtower's region judge: the real Jev through the real
 * gateway, on regions shaped like the ones real pages produce. Skipped
 * unless PISTACHIO_WATCHTOWER_LIVE=1 and the workspace has a gateway key in
 * `.env`. It costs a fraction of a cent and sends only the synthetic text
 * below.
 *
 * What it guards is the WORDING of the criteria in `watchtower-filter.ts`:
 * the model reads only those descriptions, so a careless edit there shows up
 * here as an article body called chrome, or a rail called content.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createGateway } from "ai";
import { describe, expect, it } from "vitest";
import type { WatchtowerRegion } from "../src/views/watchtower.js";
import { judgeRegions, WATCHTOWER_KEPT_ROLES } from "../src/watchtower-filter.js";

const envPath = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find((path) => existsSync(path));
const live = process.env["PISTACHIO_WATCHTOWER_LIVE"] === "1";
if (envPath !== undefined && live) process.loadEnvFile(envPath);
const key = process.env["AI_GATEWAY_API_KEY"];

const region = (signature: string, excerpt: string, chars: number, linkChars: number): WatchtowerRegion => ({
  signature, excerpt, chars, linkChars, blocks: [0, 1, 2, 3], hasHeading: false,
});

describe.skipIf(!live || key === undefined)("Watchtower region judge (live Jev)", () => {
  it("tells an article and its discussion from the rails, pitches and chrome around them", { timeout: 30000 }, async () => {
    const regions = [
      region("div.layout>div.col-main>div.text", "The restored lathe needed new bearings. After stripping the headstock we found the spindle had been shimmed with brass foil decades ago, which explained the chatter at low speed.", 6200, 120),
      region("div.layout>div.col-side>div.cards", "### 10 kitchen gadgets you need this year · ### This celebrity's house will shock you · ### The best mattresses of the season · ### Watch: dog learns to skateboard", 1400, 1250),
      region("div.layout>div.col-main>div.box-b", "Get our best stories in your inbox every morning. Enter your email to subscribe. No spam, unsubscribe any time.", 180, 0),
      region("div.layout>div.thread>div.items", "jane_m · 3 hours ago · I rebuilt the same model last year and the back gears were the hard part. · tom_r · 2 hours ago · Did you scrape the ways or just stone them?", 2100, 90),
      region("div.layout>div.strip>ul.items", "- Home - About us - Careers - Privacy policy - Terms of service - Cookie settings - Contact", 140, 130),
      region("div.layout>div.col-main>div.byline-row", "By Ada Workshop · Published 12 March 2026 · 9 min read · Filed under Machining, Restoration", 110, 40),
    ];
    const started = Date.now();
    const answers = await judgeRegions(
      { host: "workshop.example", title: "Rebuilding a 1940s lathe", kind: "article" },
      regions,
      { model: createGateway({ apiKey: key }).evaluationModel(process.env["PISTACHIO_INTENT_MODEL"] ?? "typesafe-ai/jev") },
    );
    const table = answers.map((answer, i) => ({
      region: regions[i]!.signature.split(">").at(-1),
      role: answer?.role ?? "(unsure)",
      confidence: answer?.confidence.toFixed(2) ?? "",
      kept: answer ? WATCHTOWER_KEPT_ROLES.has(answer.role) : true,
    }));
    console.table(table);
    console.log(`latency ${Date.now() - started} ms`);
    const kept = (i: number): boolean => table[i]!.kept;
    // The body and the discussion must never be lost.
    expect(kept(0)).toBe(true);
    expect(kept(3)).toBe(true);
    // The rail and the footer links must be recognized with confidence.
    expect(answers[1]?.role).toBe("recommendations");
    expect(kept(4)).toBe(false);
    // The pitch is an ad or chrome; either way it goes.
    expect(kept(2)).toBe(false);
  });
});
