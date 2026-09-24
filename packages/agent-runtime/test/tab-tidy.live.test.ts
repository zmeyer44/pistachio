/**
 * Live check of Tidy's judge: the real language model through the real
 * gateway, on a sidebar shaped like a real afternoon's. Skipped unless
 * PISTACHIO_TIDY_LIVE=1 and the workspace has a gateway key in `.env`. It
 * costs a fraction of a cent and sends only the synthetic titles below.
 *
 * What it guards is the WORDING of the instructions in `tab-tidy.ts`: that
 * the model groups by task rather than by site, names groups the way a
 * person would, leaves strangers alone, and never archives a tab that is not
 * idle — though the policy would refuse that anyway.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createGateway } from "ai";
import { describe, expect, it } from "vitest";
import { judgeTidy, nameTabGroup } from "../src/tab-tidy.js";
import { tidyPlan, type TidyInput, type TidyTabCandidate } from "../src/tab-tidy-contract.js";

const envPath = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find((path) => existsSync(path));
const live = process.env["PISTACHIO_TIDY_LIVE"] === "1";
if (envPath !== undefined && live) process.loadEnvFile(envPath);
const key = process.env["AI_GATEWAY_API_KEY"];
const modelId = process.env["PISTACHIO_TIDY_MODEL"]?.trim() || "anthropic/claude-haiku-4.5";

const NOW = Date.now();
const tab = (id: string, title: string, url: string, idleHours: number): TidyTabCandidate => ({
  id,
  title,
  url,
  lastActiveAt: NOW - idleHours * 3_600_000,
  eligible: idleHours >= 12,
});

describe.skipIf(!live || key === undefined)("Tidy judge (live model)", () => {
  it("groups by task, names groups plainly, and archives only what is idle and done", { timeout: 60000 }, async () => {
    const input: TidyInput = {
      now: NOW,
      groups: [{ id: "existing", title: "Q3 board deck", tabCount: 3 }],
      tabs: [
        // A trip, across four sites — one tab still in use.
        tab("trip-1", "Lisbon to Porto – Google Flights", "https://www.google.com/travel/flights?q=lis-opo", 1),
        tab("trip-2", "Alfama apartments · Airbnb", "https://www.airbnb.com/s/Alfama--Lisbon/homes", 20),
        tab("trip-3", "The 38 Essential Lisbon Restaurants - Eater", "https://www.eater.com/maps/best-restaurants-lisbon-portugal", 22),
        tab("trip-4", "Sintra day trip from Lisbon: how to get there", "https://www.lisbonguide.example/sintra-day-trip", 2),
        // A purchase, across three shops — all of it abandoned two days ago.
        tab("desk-1", "Uplift V2 Standing Desk – UPLIFT Desk", "https://www.upliftdesk.com/uplift-v2-standing-desk", 50),
        tab("desk-2", "Jarvis Bamboo Standing Desk | Fully", "https://www.fully.com/jarvis-bamboo", 50),
        tab("desk-3", "Best standing desks 2026 - Wirecutter", "https://www.nytimes.com/wirecutter/reviews/best-standing-desk/", 51),
        // Belongs with work already gathered.
        tab("deck-1", "Q3 revenue by segment - Google Sheets", "https://docs.google.com/spreadsheets/d/abc/edit", 3),
        // Idle one-offs.
        tab("one-1", "how many ounces in a cup - Google Search", "https://www.google.com/search?q=ounces+in+a+cup", 30),
        tab("one-2", "Order confirmed — thanks for your purchase", "https://shop.example/orders/9912/confirmation", 40),
        // Fresh and unrelated to anything: should be left alone.
        tab("solo-1", "Inbox (3) - Gmail", "https://mail.google.com/mail/u/0/#inbox", 0),
        tab("solo-2", "Hacker News", "https://news.ycombinator.com/", 1),
      ],
    };
    const started = Date.now();
    const answer = await judgeTidy(input, { model: createGateway({ apiKey: key! }).languageModel(modelId), timeoutMs: 45000 });
    const elapsed = Date.now() - started;
    expect(answer).not.toBeNull();
    const plan = tidyPlan(input, answer);
    console.log(`[tidy live] ${modelId} in ${String(elapsed)} ms\n${JSON.stringify({ answer, plan }, null, 2)}`);

    const groupOf = (tabId: string): string | undefined =>
      [...plan.newGroups, ...plan.archiveGroups].find((group) => group.tabIds.includes(tabId))?.title;
    // The trip is one live group across four sites; the desk research left together.
    expect(new Set(["trip-1", "trip-2", "trip-3", "trip-4"].map(groupOf)).size).toBe(1);
    expect(plan.newGroups.some((group) => group.tabIds.includes("trip-1"))).toBe(true);
    expect(plan.archiveGroups.some((group) => ["desk-1", "desk-2", "desk-3"].every((id) => group.tabIds.includes(id)))).toBe(true);
    // The sheet joined the deck; the one-offs are archived; the strangers are untouched.
    expect(plan.joins).toEqual([{ groupId: "existing", tabIds: ["deck-1"] }]);
    expect(plan.archiveTabs.sort()).toEqual(["one-1", "one-2"]);
    expect(groupOf("solo-1")).toBeUndefined();
    expect(groupOf("solo-2")).toBeUndefined();
    // Titles a person would say.
    for (const group of [...plan.newGroups, ...plan.archiveGroups]) expect(group.title.split(/\s+/u).length).toBeLessThanOrEqual(4);
  });

  it("names a hand-made group for what its tabs are for, quickly", { timeout: 60000 }, async () => {
    const model = createGateway({ apiKey: key! }).languageModel(modelId);
    const cases: Array<{ tabs: Array<{ title: string; url: string }>; existing?: string[]; expect: RegExp }> = [
      {
        tabs: [
          { title: "Lisbon to Porto – Google Flights", url: "https://www.google.com/travel/flights" },
          { title: "Alfama apartments · Airbnb", url: "https://www.airbnb.com/s/Alfama--Lisbon/homes" },
          { title: "The 38 Essential Lisbon Restaurants - Eater", url: "https://www.eater.com/maps/best-restaurants-lisbon-portugal" },
        ],
        expect: /lisbon|portugal/iu,
      },
      { tabs: [{ title: "facebook/react: The library for web and native user interfaces", url: "https://github.com/facebook/react" }], expect: /react/iu },
      {
        tabs: [
          { title: "Uplift V2 Standing Desk – UPLIFT Desk", url: "https://www.upliftdesk.com/uplift-v2-standing-desk" },
          { title: "Best standing desks 2026 - Wirecutter", url: "https://www.nytimes.com/wirecutter/reviews/best-standing-desk/" },
        ],
        existing: ["Standing desks"],
        expect: /desk/iu,
      },
    ];
    for (const item of cases) {
      const started = Date.now();
      const name = await nameTabGroup(item.tabs, item.existing ?? [], { model, timeoutMs: 20000 });
      console.log(`[tidy live] name "${String(name)}" in ${String(Date.now() - started)} ms`);
      expect(name).not.toBeNull();
      expect(name).toMatch(item.expect);
      expect((name ?? "").split(/\s+/u).length).toBeLessThanOrEqual(4);
      for (const taken of item.existing ?? []) expect(name?.toLowerCase()).not.toBe(taken.toLowerCase());
    }
  });
});
