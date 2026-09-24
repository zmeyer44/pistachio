import { describe, expect, it } from "vitest";
import {
  matchSpeechWords,
  normalizeSpeechToken,
  speechWords,
  timedWordAt,
  wordTimeline,
} from "../src/read-aloud.js";

describe("speechWords", () => {
  it("splits on whitespace and counts paragraphs at each newline", () => {
    const text = "One two.\nThree";
    expect(speechWords(text)).toEqual([
      { start: 0, end: 3, paragraph: 0 },
      { start: 4, end: 8, paragraph: 0 },
      { start: 9, end: 14, paragraph: 1 },
    ]);
  });
});

describe("wordTimeline", () => {
  const text = "Alpha beta. Gamma delta\nEpsilon zeta";

  it("spreads each piece's seconds over its words and keeps pieces contiguous", () => {
    const timeline = wordTimeline(text, [
      { charStart: 0, charEnd: 23, seconds: 10 },
      { charStart: 24, charEnd: 36, seconds: 4 },
    ]);
    expect(timeline).toHaveLength(6);
    expect(timeline[0]?.at).toBe(0);
    // Words never overlap and each starts where the last ended.
    for (let index = 1; index < timeline.length; index += 1) {
      expect(timeline[index]?.at).toBeCloseTo(timeline[index - 1]?.until ?? -1, 6);
    }
    expect(timeline[3]?.until).toBeCloseTo(10, 6);
    expect(timeline[4]?.at).toBeCloseTo(10, 6);
    expect(timeline[5]?.until).toBeCloseTo(14, 6);
  });

  it("gives a word ending a sentence longer than its letters alone", () => {
    const timeline = wordTimeline("aaaa. bbbb cccc", [{ charStart: 0, charEnd: 15, seconds: 10 }]);
    const [stop, plain] = timeline;
    expect((stop?.until ?? 0) - (stop?.at ?? 0)).toBeGreaterThan((plain?.until ?? 0) - (plain?.at ?? 0));
  });

  it("leaves out the words no piece has spoken yet", () => {
    const timeline = wordTimeline(text, [{ charStart: 0, charEnd: 11, seconds: 3 }]);
    expect(timeline).toHaveLength(2);
  });
});

describe("timedWordAt", () => {
  const timeline = wordTimeline("a b c d", [{ charStart: 0, charEnd: 7, seconds: 4 }]);

  it("finds the word that has started most recently", () => {
    expect(timedWordAt(timeline, -1)).toBe(-1);
    expect(timedWordAt(timeline, 0)).toBe(0);
    expect(timedWordAt(timeline, timeline[1]!.at)).toBe(1);
    expect(timedWordAt(timeline, timeline[2]!.until - 0.001)).toBe(2);
    expect(timedWordAt(timeline, 3.99)).toBe(3);
    // Past the end, the last word stays lit until the next piece arrives.
    expect(timedWordAt(timeline, 9)).toBe(3);
    expect(timedWordAt([], 1)).toBe(-1);
  });
});

describe("normalizeSpeechToken", () => {
  it("folds case, punctuation and typographic quotes", () => {
    expect(normalizeSpeechToken("“Hello,”")).toBe("hello");
    expect(normalizeSpeechToken("Café!")).toBe("café");
    expect(normalizeSpeechToken("—")).toBe("");
  });
});

describe("matchSpeechWords", () => {
  const page = "Title Here. Intro line, with words. The body starts here and goes on. Footer".split(" ");

  it("maps each clip word to its page token in order", () => {
    const clip = ["The", "body", "starts", "here", "and", "goes", "on."];
    const matched = matchSpeechWords(clip, clip.map(() => 0), page);
    expect([...matched]).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });

  it("skips a page token the clip lacks and a clip word the page lacks", () => {
    const clip = ["The", "body", "[1]", "starts", "here"];
    const withMark = [...page.slice(0, 8), "†", ...page.slice(8)];
    const matched = matchSpeechWords(clip, clip.map(() => 0), withMark);
    expect([...matched]).toEqual([6, 7, -1, 9, 10]);
  });

  it("looks for each paragraph after the last, then from the top", () => {
    const clip = ["Intro", "line,", "with", "words.", "Title", "Here."];
    const paragraphs = [0, 0, 0, 0, 1, 1];
    const matched = matchSpeechWords(clip, paragraphs, page);
    expect([...matched.slice(0, 4)]).toEqual([2, 3, 4, 5]);
    // A two-word paragraph is too short to be trusted before the cursor.
    expect([...matched.slice(4)]).toEqual([-1, -1]);
    const longer = ["Intro", "line,", "with", "words.", "Title", "Here.", "Intro", "line,"];
    const rewound = matchSpeechWords(longer, [0, 0, 0, 0, 1, 1, 1, 1], page);
    expect([...rewound.slice(4)]).toEqual([0, 1, 2, 3]);
  });

  it("gives up on a paragraph after a run of misses and finds the next", () => {
    const clip = ["The", "body", ...Array.from({ length: 10 }, (_, index) => `missing${String(index)}`), "Footer"];
    const paragraphs = [...clip.slice(0, -1).map(() => 0), 1];
    const matched = matchSpeechWords(clip, paragraphs, page);
    expect(matched[0]).toBe(6);
    expect(matched[1]).toBe(7);
    expect(matched[matched.length - 1]).toBe(13);
  });

  it("leaves a clip that is nowhere on the page unmatched", () => {
    const clip = ["nothing", "like", "this"];
    expect([...matchSpeechWords(clip, [0, 0, 0], page)]).toEqual([-1, -1, -1]);
  });
});
