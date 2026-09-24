import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { judgeTidy, nameTabGroup } from "../src/tab-tidy.js";
import {
  tidyAnswerFromModel,
  tidyGroupName,
  tidyModelState,
  tidyPlan,
  tidySummaryText,
  type TidyAnswer,
  type TidyInput,
  type TidySummary,
  type TidyTabCandidate,
} from "../src/tab-tidy-contract.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const tab = (id: string, idleHours: number, eligible = idleHours >= 12): TidyTabCandidate => ({
  id,
  title: `${id} title`,
  url: `https://${id}.example/page?token=secret#frag`,
  lastActiveAt: NOW - idleHours * HOUR,
  eligible,
});

const input = (tabs: TidyTabCandidate[], groups: TidyInput["groups"] = []): TidyInput => ({ now: NOW, tabs, groups });
const answer = (partial: Partial<TidyAnswer>): TidyAnswer => ({ groups: [], joins: [], archive: [], ...partial });

describe("tidyPlan", () => {
  it("archives every idle tab and groups nothing when there is no model answer", () => {
    const plan = tidyPlan(input([tab("a", 1), tab("b", 20), tab("c", 30)]), null);
    expect(plan).toEqual({ archiveTabs: ["b", "c"], archiveGroups: [], newGroups: [], joins: [] });
  });

  it("never archives a tab that is not idle, whatever the model says", () => {
    const plan = tidyPlan(input([tab("fresh", 1), tab("stale", 20)]), answer({ archive: ["fresh", "stale"] }));
    expect(plan.archiveTabs).toEqual(["stale"]);
  });

  it("archives an idle tab the model left alone: for an idle tab the choice is group or archive", () => {
    const plan = tidyPlan(input([tab("stale", 20)]), answer({}));
    expect(plan.archiveTabs).toEqual(["stale"]);
  });

  it("keeps an idle tab that is grouped with a tab still in use", () => {
    const plan = tidyPlan(input([tab("fresh", 1), tab("stale", 20)]), answer({ groups: [{ title: "Lisbon trip", tabIds: ["fresh", "stale"] }] }));
    expect(plan.newGroups).toEqual([{ title: "Lisbon trip", tabIds: ["fresh", "stale"] }]);
    expect(plan.archiveTabs).toEqual([]);
  });

  it("archives a group of tabs that have ALL gone idle together, under its title", () => {
    const plan = tidyPlan(input([tab("a", 20), tab("b", 40), tab("c", 1)]), answer({ groups: [{ title: "Desk research", tabIds: ["a", "b"] }] }));
    expect(plan.archiveGroups).toEqual([{ title: "Desk research", tabIds: ["a", "b"] }]);
    expect(plan.newGroups).toEqual([]);
    expect(plan.archiveTabs).toEqual([]);
  });

  it("drops groups that are too small, untitled, or named like an existing group", () => {
    const plan = tidyPlan(
      input([tab("a", 1), tab("b", 1), tab("c", 1), tab("d", 1), tab("e", 1)], [{ id: "g", title: "Work", tabCount: 3 }]),
      answer({
        groups: [
          { title: "Solo", tabIds: ["a"] },
          { title: "   ", tabIds: ["a", "b"] },
          { title: "work", tabIds: ["a", "b"] },
          { title: "Real", tabIds: ["c", "d", "ghost"] },
        ],
      }),
    );
    expect(plan.newGroups).toEqual([{ title: "Real", tabIds: ["c", "d"] }]);
  });

  it("gives a tab ONE outcome: joins win, then the first group that names it", () => {
    const plan = tidyPlan(
      input([tab("a", 1), tab("b", 1), tab("c", 1)], [{ id: "g", title: "Work", tabCount: 2 }]),
      answer({
        joins: [{ groupId: "g", tabIds: ["a"] }, { groupId: "nope", tabIds: ["b"] }],
        groups: [{ title: "Pair", tabIds: ["a", "b", "c"] }],
      }),
    );
    expect(plan.joins).toEqual([{ groupId: "g", tabIds: ["a"] }]);
    expect(plan.newGroups).toEqual([{ title: "Pair", tabIds: ["b", "c"] }]);
  });

  it("does not let an undersized group swallow its tab's other chances", () => {
    const plan = tidyPlan(
      input([tab("a", 1), tab("b", 1)]),
      answer({ groups: [{ title: "Lonely", tabIds: ["a"] }, { title: "Pair", tabIds: ["a", "b"] }] }),
    );
    expect(plan.newGroups).toEqual([{ title: "Pair", tabIds: ["a", "b"] }]);
  });

  it("caps new groups per run and trims titles", () => {
    const tabs = Array.from({ length: 20 }, (_, i) => tab(`t${i}`, 1));
    const groups = Array.from({ length: 10 }, (_, i) => ({ title: `Group ${i} ${"x".repeat(60)}`, tabIds: [`t${i * 2}`, `t${i * 2 + 1}`] }));
    const plan = tidyPlan(input(tabs), answer({ groups }));
    expect(plan.newGroups).toHaveLength(8);
    expect(plan.newGroups.every((group) => group.title.length <= 40)).toBe(true);
  });

  it("survives a malformed answer", () => {
    const broken = { groups: [null, { title: 3, tabIds: "a" }], joins: "x", archive: [1, null] } as unknown as TidyAnswer;
    expect(tidyPlan(input([tab("a", 20)]), broken).archiveTabs).toEqual(["a"]);
  });
});

describe("tidyModelState", () => {
  it("anonymises ids and cuts addresses to host and path", () => {
    const { state, tabIds } = tidyModelState(input([tab("real-id", 3)]));
    expect(state.tabs).toEqual([{ id: "t0", title: "real-id title", site: "real-id.example", path: "/page", idleHours: 3, idle: false }]);
    expect(JSON.stringify(state)).not.toContain("secret");
    expect(tabIds.get("t0")).toBe("real-id");
  });

  it("maps a model answer back and drops ids it was never given", () => {
    const { tabIds, groupIds } = tidyModelState(input([tab("a", 1), tab("b", 2)], [{ id: "grp", title: "Work", tabCount: 1 }]));
    const mapped = tidyAnswerFromModel(
      { groups: [{ title: "Pair", tabIds: ["t0", "t1", "t9"] }], joins: [{ groupId: "g0", tabIds: ["t1"] }, { groupId: "g7", tabIds: ["t0"] }], archive: ["t0", "zzz"] },
      tabIds,
      groupIds,
    );
    expect(mapped).toEqual({ groups: [{ title: "Pair", tabIds: ["a", "b"] }], joins: [{ groupId: "grp", tabIds: ["b"] }], archive: ["a"] });
  });
});

describe("judgeTidy", () => {
  const modelAnswering = (text: string): MockLanguageModelV3 =>
    new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });

  it("returns the model's answer in the host's ids", async () => {
    const model = modelAnswering(JSON.stringify({ groups: [{ title: "Pair", tabIds: ["t0", "t1"] }], joins: [], archive: [] }));
    const result = await judgeTidy(input([tab("a", 1), tab("b", 2)]), { model });
    expect(result).toEqual({ groups: [{ title: "Pair", tabIds: ["a", "b"] }], joins: [], archive: [] });
  });

  it("resolves null — never throws — when the model fails or answers nonsense", async () => {
    expect(await judgeTidy(input([tab("a", 1)]), { model: modelAnswering("not json") })).toBeNull();
    expect(await judgeTidy(input([]), { model: modelAnswering("{}") })).toBeNull();
  });
});

describe("naming a group", () => {
  const modelAnswering = (text: string, seen?: (prompt: string) => void): MockLanguageModelV3 =>
    new MockLanguageModelV3({
      doGenerate: async (options) => {
        seen?.(JSON.stringify(options.prompt));
        return {
          content: [{ type: "text", text }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
  const tabs = [
    { title: "Lisbon to Porto – Google Flights", url: "https://www.google.com/travel/flights?q=secret-token" },
    { title: "Alfama apartments", url: "https://www.airbnb.com/s/Alfama--Lisbon/homes#frag" },
  ];

  it("returns the model's name, tidied, and never sends a query string", async () => {
    let prompt = "";
    const name = await nameTabGroup(tabs, ["Q3 board deck"], { model: modelAnswering(JSON.stringify({ title: '  “Lisbon trip”. ' }), (seen) => (prompt = seen)) });
    expect(name).toBe("Lisbon trip");
    expect(prompt).toContain("airbnb.com");
    expect(prompt).toContain("Q3 board deck");
    expect(prompt).not.toContain("secret-token");
    expect(prompt).not.toContain("frag");
  });

  it("resolves null — never throws — for nonsense, nothing, or the placeholder said back", async () => {
    expect(await nameTabGroup(tabs, [], { model: modelAnswering("not json") })).toBeNull();
    expect(await nameTabGroup([], [], { model: modelAnswering(JSON.stringify({ title: "Anything" })) })).toBeNull();
    expect(await nameTabGroup(tabs, [], { model: modelAnswering(JSON.stringify({ title: "New group" })) })).toBeNull();
  });

  it("makes a name fit to show", () => {
    expect(tidyGroupName("  'Standing desk research!' ")).toBe("Standing desk research");
    expect(tidyGroupName("x".repeat(90))).toHaveLength(40);
    expect(tidyGroupName("   ")).toBeNull();
    expect(tidyGroupName(7)).toBeNull();
    expect(tidyGroupName("Untitled group")).toBeNull();
  });
});

describe("tidySummaryText", () => {
  const summary = (partial: Partial<TidySummary>): TidySummary => ({
    runId: "r",
    spaceId: "work",
    trigger: "auto",
    archivedTabs: 0,
    newGroups: 0,
    joinedTabs: 0,
    favoritesReset: 0,
    usedModel: true,
    firstRun: false,
    ...partial,
  });

  it("says what a run did, in one line", () => {
    expect(tidySummaryText(summary({ archivedTabs: 6, newGroups: 2 }))).toBe("Archived 6 tabs · made 2 groups");
    expect(tidySummaryText(summary({ archivedTabs: 1 }))).toBe("Archived 1 tab");
    expect(tidySummaryText(summary({ favoritesReset: 2 }))).toBe("Reset 2 favorites");
    expect(tidySummaryText(summary({}))).toBe("Tabs are already tidy");
  });
});
