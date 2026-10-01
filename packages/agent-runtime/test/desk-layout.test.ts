/**
 * The desk's layout model (docs/desk-layout.md §3), against a fake
 * evaluator, so what is pinned here is the CONTRACT rather than any real
 * model's opinion.
 *
 * What leaves the device: windows as title, host, kind and a place in words,
 * under labels — never an id or a URL. What comes back: a probability per
 * move, per window as the main work, and (a window just out) per partner,
 * keyed by the shell's ids again. How the shell decides: a window coming or
 * going moves the others only on a clear opinion for a move other than
 * keep; asked, the likeliest move, or with no opinion, tile. And how
 * failure reads: a malformed request, a thrown error, a nonsense answer
 * are all null.
 */

import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModel } from "ai";
import { evaluateDeskLayout } from "../src/desk-layout.js";
import {
  DESK_LAYOUT_LIMITS,
  NO_PARTNER,
  decideDeskLayout,
  sanitizeDeskLayoutRequest,
  type DeskLayoutEvaluation,
  type DeskLayoutMove,
  type DeskLayoutRequest,
  type DeskLayoutWindow,
} from "../src/desk-layout-contract.js";

type EvaluationModelV4 = Exclude<Experimental_EvaluationModel, string>;
type EvaluationCall = Parameters<EvaluationModelV4["doEvaluate"]>[0];
type EvaluationAnswerResult = Awaited<ReturnType<EvaluationModelV4["doEvaluate"]>>;

function fakeModel(answer: (options: EvaluationCall) => Promise<EvaluationAnswerResult>): { model: EvaluationModelV4; calls: EvaluationCall[] } {
  const calls: EvaluationCall[] = [];
  return {
    calls,
    model: {
      specificationVersion: "v4",
      provider: "typesafe-ai",
      modelId: "jev",
      supportedQuestionTypes: ["choice", "score", "boolean"],
      doEvaluate(options) {
        calls.push(options);
        return answer(options);
      },
    },
  };
}

/** Answers each question with the given spread (keys are the model's option names). */
function answering(spreads: Record<string, Record<string, number>>): (options: EvaluationCall) => Promise<EvaluationAnswerResult> {
  return async () => ({
    answers: Object.fromEntries(
      Object.entries(spreads).map(([id, spread]) => [id, { type: "choice" as const, choice: Object.entries(spread).sort((a, b) => b[1] - a[1])[0]![0], probabilities: spread }]),
    ),
    warnings: [],
  });
}

function win(id: string, title: string, extra: Partial<DeskLayoutWindow> = {}): DeskLayoutWindow {
  return { id, title, site: "example.com", kind: "page", place: "the left half of the desk", inUse: false, opened: false, ...extra };
}

const OPENED: DeskLayoutRequest = {
  trigger: "opened",
  windows: [
    win("tab-inbox-7f3a", "Inbox - Gmail", { inUse: false }),
    win("tab-invoice-91c2", "Invoice #2048 - QuickBooks", { place: "the right half of the desk" }),
    win("tab-vendor-0b11", "Atlas Medical Supply - Vendor record", { opened: true, inUse: true, place: "the bottom-left quarter of the desk" }),
  ],
  gone: [],
  moves: ["keep", "pair", "tile", "focus"],
  fillers: [],
};

function evaluation(moves: Partial<Record<DeskLayoutMove, number>>, extra: Partial<DeskLayoutEvaluation> = {}): DeskLayoutEvaluation {
  return { moves: { keep: 0, fill: 0, pair: 0, tile: 0, focus: 0, ...moves }, main: {}, partner: null, confidence: 0.8, latencyMs: 200, ...extra };
}

describe("asking the layout model", () => {
  it("sends windows under labels with their titles, hosts and places, and maps the answers back to the shell's ids", async () => {
    const { model, calls } = fakeModel(
      answering({
        move: { keep: 0.2, pair: 0.7, tile: 0.05, focus: 0.05 },
        main: { w1: 0.1, w2: 0.8, w3: 0.1 },
        partner: { w1: 0.05, w2: 0.9, none: 0.05 },
      }),
    );
    const result = await evaluateDeskLayout({ model, request: OPENED });
    expect(result).not.toBeNull();
    expect(result!.moves).toEqual({ keep: 0.2, fill: 0, pair: 0.7, tile: 0.05, focus: 0.05 });
    expect(result!.main).toEqual({ "tab-inbox-7f3a": 0.1, "tab-invoice-91c2": 0.8, "tab-vendor-0b11": 0.1 });
    expect(result!.partner).toEqual({ "tab-inbox-7f3a": 0.05, "tab-invoice-91c2": 0.9, [NO_PARTNER]: 0.05 });
    // One call, three questions; the partner question offers every window but the new one, and none.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(Object.keys(call.questions)).toEqual(["move", "main", "partner"]);
    const partner = call.questions["partner"]!;
    expect(partner.type === "choice" && Object.keys(partner.criteria)).toEqual(["w1", "w2", "none"]);
    // Nothing the shell calls a window by reaches the model; titles and places do.
    const sent = JSON.stringify(call);
    expect(sent).not.toContain("tab-");
    expect(sent).toContain("Atlas Medical Supply - Vendor record");
    expect(sent).toContain("the bottom-left quarter of the desk");
    expect(sent).toContain("text to judge");
  });

  it("asks no partner question unless a window came out, and offers only the moves the shell offered", async () => {
    const { model, calls } = fakeModel(answering({ move: { tile: 0.3, focus: 0.7 }, main: { w1: 0.9, w2: 0.1 } }));
    const asked: DeskLayoutRequest = { trigger: "asked", windows: [win("a", "Draft - Google Docs"), win("b", "Sources - Wikipedia")], gone: [], moves: ["tile", "focus"], fillers: [] };
    const result = await evaluateDeskLayout({ model, request: asked });
    expect(result!.partner).toBeNull();
    expect(Object.keys(calls[0]!.questions)).toEqual(["move", "main"]);
    const move = calls[0]!.questions["move"]!;
    expect(move.type === "choice" && Object.keys(move.criteria)).toEqual(["tile", "focus"]);
  });

  it("answers null for a request not worth asking, a failure, or an answer with no choice", async () => {
    const { model, calls } = fakeModel(answering({ move: { keep: 1 }, main: { w1: 1 } }));
    expect(await evaluateDeskLayout({ model, request: { ...OPENED, windows: [] } })).toBeNull();
    expect(calls).toHaveLength(0);
    const failing = fakeModel(() => Promise.reject(new Error("gateway refused")));
    expect(await evaluateDeskLayout({ model: failing.model, request: OPENED })).toBeNull();
    const nonsense = fakeModel(async () => ({ answers: { move: { type: "boolean", probability: 0.5 } }, warnings: [] }) as unknown as EvaluationAnswerResult);
    expect(await evaluateDeskLayout({ model: nonsense.model, request: OPENED })).toBeNull();
  });
});

describe("what may be asked", () => {
  it("keeps the request bounded and well-formed", () => {
    const many = Array.from({ length: DESK_LAYOUT_LIMITS.windows + 1 }, (_, index) => win(`w${String(index)}`, `Page ${String(index)}`));
    expect(sanitizeDeskLayoutRequest({ ...OPENED, windows: many })).toBeNull();
    expect(sanitizeDeskLayoutRequest({ ...OPENED, windows: [OPENED.windows[0], OPENED.windows[0]] })).toBeNull();
    // A window came out: exactly one of them is it.
    expect(sanitizeDeskLayoutRequest({ ...OPENED, windows: OPENED.windows.map((window) => ({ ...window, opened: false })) })).toBeNull();
    // A close with nothing gone is no close.
    expect(sanitizeDeskLayoutRequest({ ...OPENED, trigger: "closed", gone: [] })).toBeNull();
    // Each move only where it means something.
    const closed = sanitizeDeskLayoutRequest({
      trigger: "closed",
      windows: [win("a", "A")],
      gone: [{ title: "B", site: "", place: "the right half of the desk", how: "closed" }],
      moves: ["keep", "fill", "pair", "tile"],
      fillers: ["A"],
    });
    expect(closed!.moves).toEqual(["keep", "fill", "tile"]);
    const asked = sanitizeDeskLayoutRequest({ trigger: "asked", windows: [win("a", "A")], gone: [], moves: ["keep", "fill", "tile"], fillers: [] });
    expect(asked!.moves).toEqual(["tile"]);
    expect(asked!.fillers).toEqual([]);
    // Titles are clipped and their whitespace folded.
    const long = sanitizeDeskLayoutRequest({ ...OPENED, windows: [win("a", `x\n\n${"y".repeat(400)}`), ...OPENED.windows.slice(1)] });
    expect(long!.windows[0]!.title.length).toBe(DESK_LAYOUT_LIMITS.titleChars);
    expect(long!.windows[0]!.title.startsWith("x y")).toBe(true);
  });
});

describe("what the shell does with an opinion", () => {
  it("moves nothing on a window coming or going unless a move other than keep is likely and leads keep", () => {
    expect(decideDeskLayout(OPENED, evaluation({ keep: 0.6, pair: 0.4 }), ).move).toBe("keep");
    expect(decideDeskLayout(OPENED, evaluation({ keep: 0.25, tile: 0.35, focus: 0.3, pair: 0.1 })).move).toBe("keep");
    expect(decideDeskLayout(OPENED, evaluation({ keep: 0.3, tile: 0.42, pair: 0.28 })).move).toBe("keep");
    // Laying out every window takes a surer opinion than closing a gap or pairing two.
    expect(decideDeskLayout(OPENED, evaluation({ keep: 0.2, tile: 0.45, pair: 0.35 })).move).toBe("keep");
    expect(decideDeskLayout(OPENED, evaluation({ keep: 0.2, tile: 0.6, pair: 0.2 })).move).toBe("tile");
    const pairing = evaluation({ keep: 0.25, pair: 0.45, tile: 0.3 }, { partner: { "tab-invoice-91c2": 0.9, [NO_PARTNER]: 0.1 } });
    expect(decideDeskLayout(OPENED, pairing).move).toBe("pair");
  });

  it("needs a partner for pair and a main window for focus", () => {
    const partnered = evaluation({ keep: 0.1, pair: 0.9 }, { partner: { "tab-invoice-91c2": 0.8, [NO_PARTNER]: 0.2 } });
    expect(decideDeskLayout(OPENED, partnered)).toMatchObject({ move: "pair", partner: "tab-invoice-91c2" });
    const alone = evaluation({ keep: 0.1, pair: 0.9 }, { partner: { "tab-invoice-91c2": 0.2, [NO_PARTNER]: 0.8 } });
    expect(decideDeskLayout(OPENED, alone).move).toBe("keep");
    const unsure = evaluation({ keep: 0.1, focus: 0.9 }, { main: { "tab-inbox-7f3a": 0.35, "tab-invoice-91c2": 0.35, "tab-vendor-0b11": 0.3 } });
    expect(decideDeskLayout(OPENED, unsure).move).toBe("keep");
    const sure = evaluation({ keep: 0.1, focus: 0.9 }, { main: { "tab-inbox-7f3a": 0.1, "tab-invoice-91c2": 0.85, "tab-vendor-0b11": 0.05 } });
    expect(decideDeskLayout(OPENED, sure)).toMatchObject({ move: "focus", main: "tab-invoice-91c2", partner: null });
  });

  it("asked, makes the likeliest move however unsure, tiles when it cannot focus, and tiles with no opinion at all", () => {
    const asked: DeskLayoutRequest = { trigger: "asked", windows: OPENED.windows.map((window) => ({ ...window, opened: false })), gone: [], moves: ["tile", "focus"], fillers: [] };
    expect(decideDeskLayout(asked, evaluation({ tile: 0.45, focus: 0.55 }, { main: { "tab-invoice-91c2": 0.9 } }))).toMatchObject({ move: "focus", main: "tab-invoice-91c2" });
    expect(decideDeskLayout(asked, evaluation({ tile: 0.45, focus: 0.55 })).move).toBe("tile");
    expect(decideDeskLayout(asked, null)).toMatchObject({ move: "tile", basis: "unavailable" });
    expect(decideDeskLayout(OPENED, null)).toMatchObject({ move: "keep", basis: "unavailable" });
  });
});
