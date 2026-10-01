/**
 * Main's side of the desk's layout model (src/main/desk-layout.ts): one
 * live question per window — a newer one answers the older null at once —
 * nothing asked without a model or with a request not worth asking, and the
 * scripted stand-in the e2e suite runs the real evaluator over.
 */

import { describe, expect, it } from "vitest";
import { evaluateDeskLayout } from "@pistachio/agent-runtime/desk-layout";
import type { DeskLayoutEvaluation, DeskLayoutRequest } from "@pistachio/shell-contracts/desk-layout";
import { DeskLayoutJudge, scriptedLayoutModel, type DeskLayoutJudgement } from "../src/main/desk-layout";

const REQUEST: DeskLayoutRequest = {
  trigger: "opened",
  windows: [
    { id: "a", title: "Inbox - Gmail", site: "mail.google.com", kind: "page", place: "the top-left quarter of the desk", inUse: false, opened: false },
    { id: "b", title: "Invoice #2048 - QuickBooks", site: "qbo.intuit.com", kind: "page", place: "the right half of the desk", inUse: false, opened: false },
    { id: "c", title: "Atlas Medical Supply - Vendor record", site: "northstar.demo", kind: "page", place: "the bottom-left quarter of the desk", inUse: true, opened: true },
  ],
  gone: [],
  moves: ["keep", "pair", "tile", "focus"],
  fillers: [],
};

const ANSWER: DeskLayoutEvaluation = { moves: { keep: 0.1, fill: 0, pair: 0.9, tile: 0, focus: 0 }, main: { b: 1 }, partner: { b: 1 }, confidence: 0.9, latencyMs: 1 };
const MODEL = {} as never;

describe("the desk's layout judge", () => {
  it("answers the latest question per window; the one it superseded is null at once", async () => {
    const pending: Array<{ judgement: DeskLayoutJudgement; resolve: (value: DeskLayoutEvaluation | null) => void }> = [];
    const judge = new DeskLayoutJudge({
      model: () => MODEL,
      evaluate: (judgement) => new Promise((resolve) => pending.push({ judgement, resolve })),
    });
    const first = judge.judge(1, REQUEST);
    const second = judge.judge(1, REQUEST);
    // Another window's question is its own.
    const other = judge.judge(2, REQUEST);
    expect(await first).toBeNull();
    expect(pending[0]!.judgement.abortSignal.aborted).toBe(true);
    pending[1]!.resolve(ANSWER);
    pending[2]!.resolve(ANSWER);
    expect(await second).toEqual(ANSWER);
    expect(await other).toEqual(ANSWER);
  });

  it("asks nothing without a model, or about a request not worth asking", async () => {
    let asked = 0;
    const evaluate = (): Promise<DeskLayoutEvaluation | null> => {
      asked += 1;
      return Promise.resolve(ANSWER);
    };
    expect(await new DeskLayoutJudge({ model: () => null, evaluate }).judge(1, REQUEST)).toBeNull();
    expect(await new DeskLayoutJudge({ model: () => MODEL, evaluate }).judge(1, { ...REQUEST, windows: [] })).toBeNull();
    expect(asked).toBe(0);
  });
});

describe("the scripted layout model", () => {
  it("exists only for a spec that scripts it", () => {
    expect(scriptedLayoutModel({ PISTACHIO_LAYOUT_SCRIPT: "{}" })).toBeNull();
    expect(scriptedLayoutModel({ PISTACHIO_E2E: "1" })).toBeNull();
    expect(scriptedLayoutModel({ PISTACHIO_E2E: "1", PISTACHIO_LAYOUT_SCRIPT: "not json" })).toBeNull();
  });

  it("answers the evaluator's own questions as scripted, windows named by part of a title", async () => {
    const model = scriptedLayoutModel({
      PISTACHIO_E2E: "1",
      PISTACHIO_LAYOUT_SCRIPT: JSON.stringify({ opened: { move: "pair", partner: "Invoice", main: "Invoice" }, asked: { move: "focus", main: "Vendor" } }),
    })!;
    const opened = await evaluateDeskLayout({ model, request: REQUEST });
    expect(opened!.moves.pair).toBeGreaterThan(0.9);
    expect(opened!.partner!["b"]).toBeGreaterThan(0.9);
    expect(opened!.main["b"]).toBeGreaterThan(0.9);
    const asked = await evaluateDeskLayout({
      model,
      request: { ...REQUEST, trigger: "asked", windows: REQUEST.windows.map((window) => ({ ...window, opened: false })), moves: ["tile", "focus"] },
    });
    expect(asked!.moves.focus).toBeGreaterThan(0.9);
    expect(asked!.main["c"]).toBeGreaterThan(0.9);
    // A trigger with no script: keep.
    const closed = await evaluateDeskLayout({
      model,
      request: { ...REQUEST, trigger: "closed", windows: REQUEST.windows.slice(0, 2), gone: [{ title: "X", site: "", place: "the bottom-left quarter of the desk", how: "closed" }], moves: ["keep", "tile"] },
    });
    expect(closed!.moves.keep).toBeGreaterThan(0.9);
  });
});
