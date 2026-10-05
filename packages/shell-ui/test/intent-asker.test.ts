import { beforeEach, describe, expect, it } from "vitest";
import type { AddressIntent, AddressIntentRanking, AddressIntentRequest } from "@pistachio/shell-contracts/address-intent";
import { forgetIntentAnswers, IntentAsker } from "../src/lib/use-address-intent";

/**
 * The asking behind the address bar (docs/smart-suggestions.md §7), without
 * React or a host: what is sent and when, what an answer to earlier words is
 * allowed to change, and that the choice between the two searches belongs to
 * the sentence rather than to the keystroke.
 */

function request(query: string): AddressIntentRequest {
  return { query, currentPage: null, recentPages: [], candidates: [] };
}

function reading(query: string, intents: Partial<Record<AddressIntent, number>>): AddressIntentRanking {
  return {
    query,
    intents: { web_search: 0, ai_prompt: 0, open_page: 0, browser_command: 0, ...intents },
    intentConfidence: 0.9,
    targets: {},
    targetConfidence: 0,
    latencyMs: 200,
  };
}

const PROMPT = { ai_prompt: 0.85, web_search: 0.15 };
const SEARCH = { ai_prompt: 0.02, web_search: 0.98 };

/** A host that answers only when the test says to, and an asker over it. */
function bar() {
  const asked: string[] = [];
  const waiting = new Map<string, (ranking: AddressIntentRanking | null) => void>();
  const asker = new IntentAsker(
    (ask) => {
      asked.push(ask.query);
      return new Promise((resolve) => waiting.set(ask.query, resolve));
    },
    () => undefined,
  );
  return {
    asker,
    asked,
    type: (query: string | null) => asker.want(query === null ? null : request(query)),
    answer: async (query: string, intents: Partial<Record<AddressIntent, number>> | null) => {
      waiting.get(query)?.(intents === null ? null : reading(query, intents));
      // The asker hears it a few microtasks later.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

beforeEach(() => forgetIntentAnswers());

describe("asking the intent model", () => {
  it("asks at once, then one question at a time: the next is whatever is typed when the last comes back", async () => {
    const { asker, asked, type, answer } = bar();
    type("how");
    type("how d");
    type("how does");
    expect(asked).toEqual(["how"]);

    await answer("how", PROMPT);
    // "how d" was never worth a question: nobody is looking at it any more.
    expect(asked).toEqual(["how", "how does"]);
    expect(asker.state.settled).toBe(false);

    await answer("how does", PROMPT);
    expect(asker.state).toMatchObject({ query: "how does", settled: true, aiLeads: true });
    expect(asker.state.ranking?.query).toBe("how does");
    expect(asked).toEqual(["how", "how does"]);
  });

  it("lets an answer to earlier words choose between the searches, and name nothing", async () => {
    const { asker, type, answer } = bar();
    type("how does this comp");
    type("how does this company work");
    await answer("how does this comp", PROMPT);
    // Typed straight through and sent with ↵ now, this is a prompt — though
    // its own answer is still out.
    expect(asker.state).toMatchObject({ query: "how does this company work", settled: false, ranking: null, aiLeads: true });
  });

  it("holds the choice from one keystroke to the next", async () => {
    const { asker, type, answer } = bar();
    type("why is the sky");
    await answer("why is the sky", PROMPT);
    type("why is the sky b");
    // Awaiting an answer is not a reason to hand ↵ back to the web search.
    expect(asker.state).toMatchObject({ settled: false, ranking: null, aiLeads: true });
    type("why is the sk");
    expect(asker.state.aiLeads).toBe(true);
  });

  it("does not move the choice for a reading in between", async () => {
    const { asker, type, answer } = bar();
    type("how does this");
    await answer("how does this", PROMPT);
    type("how does this company");
    // On its own this would not have taken ↵; it does not lose it either.
    await answer("how does this company", { ai_prompt: 0.45, web_search: 0.55 });
    expect(asker.state).toMatchObject({ settled: true, aiLeads: true });

    type("how does this company stock");
    await answer("how does this company stock", SEARCH);
    expect(asker.state).toMatchObject({ settled: true, aiLeads: false });
  });

  it("starts from nothing when the words are a new thought", async () => {
    const { asker, type, answer } = bar();
    type("explain tls");
    await answer("explain tls", PROMPT);
    type("nba scores");
    expect(asker.state).toMatchObject({ query: "nba scores", settled: false, aiLeads: false });
    // An answer about the old words has nothing to say about these.
    type("explain tls handshakes");
    type("weather tomorrow");
    await answer("nba scores", SEARCH);
    await answer("weather tomorrow", SEARCH);
    expect(asker.state.aiLeads).toBe(false);
  });

  it("ignores an answer to earlier words once the words as they stand have their own", async () => {
    const { asker, asked, type, answer } = bar();
    type("what time is it in tokyo");
    await answer("what time is it in tokyo", SEARCH);
    type("what time");
    type("what time is it in tokyo");
    // Back to words already answered: from memory, with nothing sent.
    expect(asker.state).toMatchObject({ settled: true, aiLeads: false });
    await answer("what time", PROMPT);
    expect(asker.state.aiLeads).toBe(false);
    expect(asked).toEqual(["what time is it in tokyo", "what time"]);
  });

  it("forgets everything when the bar stops asking", async () => {
    const { asker, type, answer } = bar();
    type("explain tls");
    await answer("explain tls", PROMPT);
    type(null);
    expect(asker.state).toMatchObject({ query: null, ranking: null, settled: false, aiLeads: false });
    type("explain tls h");
    expect(asker.state.aiLeads).toBe(false);
  });

  it("remembers an answer, and never a silence", async () => {
    const { asker, asked, type, answer } = bar();
    type("explain tls");
    // Superseded, timed out, no model: nobody answered.
    await answer("explain tls", null);
    expect(asker.state).toMatchObject({ settled: true, ranking: null, aiLeads: false });
    // The same words are not asked about twice in a row…
    type("explain tls");
    expect(asked).toEqual(["explain tls"]);
    // …but typed again later they are asked again, and this time kept.
    type("explain tl");
    await answer("explain tl", SEARCH);
    type("explain tls");
    expect(asked).toEqual(["explain tls", "explain tl", "explain tls"]);
    await answer("explain tls", PROMPT);
    type("explain tl");
    type("explain tls");
    expect(asker.state).toMatchObject({ settled: true, aiLeads: true });
    expect(asked).toEqual(["explain tls", "explain tl", "explain tls"]);
  });

  it("keeps the choice it had when a question goes unanswered", async () => {
    const { asker, type, answer } = bar();
    type("why is the sky blue");
    await answer("why is the sky blue", PROMPT);
    type("why is the sky blue today");
    await answer("why is the sky blue today", null);
    expect(asker.state).toMatchObject({ settled: true, ranking: null, aiLeads: true });
  });

  it("says nothing more once the bar is gone", async () => {
    const changes: boolean[] = [];
    let land: (ranking: AddressIntentRanking | null) => void = () => undefined;
    const asker = new IntentAsker(
      () => new Promise((resolve) => (land = resolve)),
      (state) => changes.push(state.settled),
    );
    asker.want(request("explain tls"));
    asker.stop();
    land(reading("explain tls", PROMPT));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).toEqual([false]);
  });
});
