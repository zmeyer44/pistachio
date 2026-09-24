/**
 * Live accuracy check of smart find: the real Jev through the real gateway,
 * over the pages in `fixtures.ts`. Skipped unless PISTACHIO_FIND_LIVE=1 and
 * the workspace has a gateway key in `.env`. It costs about a cent and sends
 * only the synthetic text in the fixtures.
 *
 * What it guards is the WORDING of the questions in `rank.ts` and the
 * thresholds in `contract.ts` — the model reads only those words. It asserts
 * a floor, not the measured figure; the figure is printed for
 * docs/smart-find.md §10.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createGateway } from "ai";
import { describe, expect, it } from "vitest";
import { SMART_FIND_LIMITS, type SmartFindPassage } from "../src/contract.js";
import { selectMatches } from "../src/policy.js";
import { focusSentences, rankPassages } from "../src/rank.js";
import { FIXTURES } from "./fixtures.js";

const envPath = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find((path) => existsSync(path));
const live = process.env["PISTACHIO_FIND_LIVE"] === "1";
if (envPath !== undefined && live) process.loadEnvFile(envPath);
const key = process.env["AI_GATEWAY_API_KEY"];

describe.skipIf(!live || key === undefined)("smart find (live Jev)", () => {
  it("lands on the passage a description means, and on nothing when the page has no answer", { timeout: 180_000 }, async () => {
    const model = createGateway({ apiKey: key! }).evaluationModel(process.env["PISTACHIO_INTENT_MODEL"] ?? "typesafe-ai/jev");
    let asked = 0;
    let first = 0;
    let listed = 0;
    let absent = 0;
    let quiet = 0;
    const times: number[] = [];
    const lines: string[] = [];
    for (const page of FIXTURES) {
      const passages: SmartFindPassage[] = page.passages.map((text, i) => ({ id: `b${i}`, block: `b${i}`, text }));
      for (const query of page.queries) {
        const started = performance.now();
        const scores = new Map<string, number>();
        for await (const batch of rankPassages(query.search, passages, { model })) {
          expect(batch.failed, `${page.name}: "${query.search}" batch failed`).toBe(false);
          for (const score of batch.scores) scores.set(score.id, score.probability);
        }
        times.push(performance.now() - started);
        const { matches, weak } = selectMatches(passages, scores, true);
        const ids = matches.map((match) => Number(match.ids[0]!.slice(1)));
        const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, p]) => `${id}=${p.toFixed(2)}`).join(" ");
        if (query.answer === null) {
          absent += 1;
          const ok = matches.length === 0 || weak;
          if (ok) quiet += 1;
          lines.push(`${ok ? "ok  " : "MISS"} [${page.name}] "${query.search}" → expected nothing; ${top}`);
          continue;
        }
        asked += 1;
        const accepted = [query.answer, ...(query.also ?? [])];
        const hitFirst = !weak && ids[0] !== undefined && accepted.includes(ids[0]);
        const hitListed = ids.includes(query.answer);
        if (hitFirst) first += 1;
        if (hitListed) listed += 1;
        lines.push(`${hitFirst ? "ok  " : hitListed ? "list" : "MISS"} [${page.name}] "${query.search}" → b${query.answer}${weak ? " (weak)" : ""}; ${top}`);
      }
    }
    const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
    console.log(
      [
        ...lines,
        `best match correct: ${first}/${asked} (${Math.round((100 * first) / asked)} %)`,
        `answer among matches: ${listed}/${asked}`,
        `no confident match when the page has no answer: ${quiet}/${absent}`,
        `median search ${Math.round(median)} ms (threshold ${SMART_FIND_LIMITS.match}, closest ${SMART_FIND_LIMITS.closest})`,
      ].join("\n"),
    );
    expect(first / asked).toBeGreaterThanOrEqual(0.8);
    expect(quiet / absent).toBeGreaterThanOrEqual(0.85);
  });

  it("picks the sentence that holds the answer", { timeout: 30_000 }, async () => {
    const model = createGateway({ apiKey: key! }).evaluationModel(process.env["PISTACHIO_INTENT_MODEL"] ?? "typesafe-ai/jev");
    const text = FIXTURES[0]!.passages[3]!;
    const found = await focusSentences("what if I change my mind a month later", [{ id: "b3", block: "b3", text }], { model });
    const span = found.get("b3")!;
    expect(text.slice(span.start, span.end)).toContain("non-refundable");
  });
});
