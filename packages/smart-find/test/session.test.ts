import type { Experimental_EvaluationModel } from "ai";
import { describe, expect, it } from "vitest";
import type { SmartFindCollection, SmartFindPaint } from "../src/contract.js";
import { scriptedFindModel } from "../src/scripted.js";
import { SmartFindSession, type SmartFindPage, type SmartFindView } from "../src/session.js";

const PASSAGES = [
  "Welcome to the store. We sell nuts of every kind.",
  "Shipping takes three to five days. Damaged parcels are replaced free of charge.",
  "Refunds are issued to the original card. A refund takes five working days to arrive.",
  "Our founders started the company in a garage.",
];

class FakePage implements SmartFindPage {
  generation = 1;
  dirty = true;
  collects = 0;
  paints: SmartFindPaint[] = [];
  cleared = 0;
  stale: string[] = [];
  passages = PASSAGES;
  collect(known: number | null): Promise<SmartFindCollection | { generation: number; unchanged: true } | null> {
    if (known === this.generation && !this.dirty) return Promise.resolve({ generation: known, unchanged: true });
    this.collects += 1;
    if (this.collects > 1) this.generation += 1;
    this.dirty = false;
    return Promise.resolve({
      generation: this.generation,
      truncated: false,
      passages: this.passages.map((text, i) => ({ id: `b${i}`, block: `b${i}`, text })),
    });
  }
  paint(paint: SmartFindPaint) {
    this.paints.push(paint);
    return Promise.resolve(paint.generation === this.generation ? { stale: this.stale } : null);
  }
  clear() {
    this.cleared += 1;
    return Promise.resolve();
  }
}

const SCRIPT = { "money back": ["refund"], "broken in the post": ["damaged"], "nothing like this": [] };

function harness(model: Experimental_EvaluationModel | null = scriptedFindModel(SCRIPT)) {
  const page = new FakePage();
  const views: SmartFindView[] = [];
  const session = new SmartFindSession({ page, model: () => model, onChange: (view) => views.push(view) });
  const until = async (test: (view: SmartFindView) => boolean): Promise<SmartFindView> => {
    for (let i = 0; i < 200; i++) {
      const view = session.view();
      if (test(view)) return view;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`never settled: ${JSON.stringify(session.view())}`);
  };
  const settled = () => until((view) => view.smart.status === "done" && (view.matches === 0 || page.paints.some((paint) => paint.matches.some((m) => m.focus))));
  return { page, views, session, until, settled };
}

describe("SmartFindSession", () => {
  it("reads, ranks, paints the match and then brightens its key sentence", async () => {
    const { page, views, session, settled } = harness();
    session.search("money back", true);
    const view = await settled();
    expect(views.map((v) => v.smart.status)).toEqual(expect.arrayContaining(["reading", "ranking", "done"]));
    expect(view).toMatchObject({ query: "money back", matches: 1, activeMatchOrdinal: 1 });
    expect(view.smart).toMatchObject({ searched: 4, total: 4, weak: false, stale: false });
    // The scripted model picks the first sentence holding the needle.
    expect(view.smart.excerpt).toBe("Refunds are issued to the original card.");
    const last = page.paints.at(-1)!;
    expect(last.matches).toEqual([{ ids: ["b2"], focus: { id: "b2", start: 0, end: 40 } }]);
    expect(page.paints[0]).toMatchObject({ active: 0, scroll: true });
  });

  it("steps through matches on the same description, wrapping, without asking again", async () => {
    const { page, session, settled } = harness(scriptedFindModel({ days: ["days"] }));
    session.search("days", true);
    expect((await settled()).matches).toBe(2);
    const collects = page.collects;
    session.search("days", true);
    expect(session.view().activeMatchOrdinal).toBe(2);
    session.search("days", true);
    expect(session.view().activeMatchOrdinal).toBe(1);
    session.search("days", false);
    expect(session.view().activeMatchOrdinal).toBe(2);
    expect(page.collects).toBe(collects);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(page.paints.at(-1)).toMatchObject({ active: 1, scroll: true });
  });

  it("reuses the page reading for a second description, and re-reads once the page has changed", async () => {
    const { page, session, settled } = harness();
    session.search("money back", true);
    await settled();
    session.search("broken in the post", true);
    expect((await settled()).smart.excerpt).toBe("Damaged parcels are replaced free of charge.");
    expect(page.collects).toBe(1);
    page.dirty = true;
    session.search("money back", true);
    await settled();
    expect(page.collects).toBe(2);
  });

  it("says so when nothing matches", async () => {
    const { page, session, until } = harness();
    session.search("nothing like this", true);
    const view = await until((v) => v.smart.status === "done");
    expect(view).toMatchObject({ matches: 0, activeMatchOrdinal: 0 });
    expect(page.paints.at(-1)?.matches).toEqual([]);
  });

  it("is unavailable without a model and unreadable without text, and sends nothing in either case", async () => {
    const none = harness(null);
    none.session.search("money back", true);
    expect((await none.until((v) => v.smart.status !== "idle")).smart.status).toBe("unavailable");
    expect(none.page.collects).toBe(0);

    const empty = harness();
    empty.page.passages = [];
    empty.session.search("money back", true);
    expect((await empty.until((v) => v.smart.status !== "reading" && v.smart.status !== "idle")).smart.status).toBe("unreadable");
  });

  it("reports failure when every batch fails, and the same description again retries", async () => {
    let fail = true;
    const inner = scriptedFindModel(SCRIPT) as Exclude<Experimental_EvaluationModel, string>;
    const { session, until, settled } = harness({
      ...inner,
      doEvaluate: (options) => (fail ? Promise.reject(new Error("down")) : inner.doEvaluate(options)),
    });
    session.search("money back", true);
    await until((v) => v.smart.status === "failed");
    fail = false;
    session.search("money back", true);
    expect((await settled()).matches).toBe(1);
  });

  it("a newer description supersedes an older one: the older never paints", async () => {
    const { page, session, settled } = harness();
    session.search("money back", true);
    session.search("broken in the post", true);
    const view = await settled();
    expect(view.query).toBe("broken in the post");
    expect(page.paints.every((paint) => paint.matches.every((m) => m.ids[0] === "b1"))).toBe(true);
  });

  it("marks the matches stale when the page changed under them, and then searches again instead of stepping", async () => {
    const { page, session, settled, until } = harness();
    page.stale = ["b2"];
    session.search("money back", true);
    await settled();
    expect((await until((v) => v.smart.stale)).smart.stale).toBe(true);
    page.stale = [];
    page.dirty = true;
    session.search("money back", true);
    await until((v) => v.smart.status === "done" && !v.smart.stale);
    expect(page.collects).toBe(2);
  });

  it("editing the text takes the highlights down but keeps the reading; closing clears the page", async () => {
    const { page, session, settled } = harness();
    session.search("money back", true);
    await settled();
    session.edit("money ba");
    expect(session.view()).toMatchObject({ matches: 0, smart: { status: "idle" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(page.paints.at(-1)?.matches).toEqual([]);
    expect(page.cleared).toBe(0);
    await session.close();
    expect(page.cleared).toBe(1);
  });
});
