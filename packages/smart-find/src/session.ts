/**
 * One smart find over one document, from the host's side
 * (docs/smart-find.md §4). The host — the desktop's BrowserController, the
 * cloud worker's ShellHost — supplies how to run a script in the page and
 * which model to ask; everything between a typed description and a painted,
 * steppable list of matches is here, once, for both.
 */
import type { Experimental_EvaluationModel } from "ai";
import { IDLE_SMART_FIND, type SmartFindProgress } from "@pistachio/shell-contracts/browser-controls";
import {
  SMART_FIND_LIMITS,
  type SmartFindCollection,
  type SmartFindMatch,
  type SmartFindPaint,
  type SmartFindPainted,
  type SmartFindSpan,
} from "./contract.js";
import { orderMatches, selectMatches } from "./policy.js";
import { focusSentences, rankPassages } from "./rank.js";

/** The page, as the session needs it. Every method may reject; none may hang. */
export interface SmartFindPage {
  collect(known: number | null): Promise<SmartFindCollection | { generation: number; unchanged: true } | null>;
  paint(paint: SmartFindPaint): Promise<SmartFindPainted | null>;
  clear(): Promise<void>;
}

export interface SmartFindView {
  query: string;
  matches: number;
  /** 1-based, 0 for none — `FindState.activeMatchOrdinal`. */
  activeMatchOrdinal: number;
  smart: SmartFindProgress;
}

export interface SmartFindSessionOptions {
  page: SmartFindPage;
  /** Read per search: signing out or turning the model off takes effect at once. Null = unavailable. */
  model: () => Experimental_EvaluationModel | null;
  onChange: (view: SmartFindView) => void;
}

export class SmartFindSession {
  readonly #page: SmartFindPage;
  readonly #model: SmartFindSessionOptions["model"];
  readonly #onChange: SmartFindSessionOptions["onChange"];
  #collection: SmartFindCollection | null = null;
  #query = "";
  #progress: SmartFindProgress = IDLE_SMART_FIND;
  #matches: SmartFindMatch[] = [];
  #focus = new Map<string, SmartFindSpan>();
  #active = -1;
  /** The person has stepped: nothing at or before the active match may move. */
  #pinned = false;
  #run = 0;
  #abort: AbortController | null = null;
  #painting: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: SmartFindSessionOptions) {
    this.#page = options.page;
    this.#model = options.model;
    this.#onChange = options.onChange;
  }

  view(): SmartFindView {
    return {
      query: this.#query,
      matches: this.#matches.length,
      activeMatchOrdinal: this.#active + 1,
      smart: this.#progress,
    };
  }

  /**
   * A new description searches; the same one again steps through what it
   * found — or searches again when it found nothing, failed, or the page has
   * changed under it.
   */
  search(query: string, forward: boolean): void {
    if (this.#closed) return;
    const text = query.trim().slice(0, SMART_FIND_LIMITS.query);
    const settled = this.#progress.status === "done" || this.#progress.status === "ranking";
    if (text !== "" && text === this.#query && settled && this.#matches.length > 0 && !this.#progress.stale) {
      this.#pinned = true;
      const count = this.#matches.length;
      this.#active = (Math.max(0, this.#active) + (forward ? 1 : -1) + count) % count;
      this.#refreshExcerpt();
      this.#emit();
      void this.#paint(this.#run, true);
      return;
    }
    void this.#start(text);
  }

  /** The text changed but nothing was asked: drop the old answer, keep the page reading. */
  edit(query: string): void {
    if (this.#closed || query.trim() === this.#query) return;
    this.#cancel();
    this.#query = "";
    this.#reset(IDLE_SMART_FIND);
    this.#emit();
    // An empty paint takes the highlights down and leaves the reading in place.
    void this.#paint(this.#run, false);
  }

  /** The document is gone (navigation, crash): there is nothing to clear and nothing to keep. */
  invalidate(): void {
    this.#cancel();
    this.#collection = null;
    this.#query = "";
    this.#reset(IDLE_SMART_FIND);
    this.#emit();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cancel();
    this.#collection = null;
    await this.#page.clear().catch(() => undefined);
  }

  #cancel(): void {
    this.#run += 1;
    this.#abort?.abort();
    this.#abort = null;
  }

  #reset(progress: SmartFindProgress): void {
    this.#progress = progress;
    this.#matches = [];
    this.#focus = new Map();
    this.#active = -1;
    this.#pinned = false;
  }

  #emit(): void {
    if (!this.#closed) this.#onChange(this.view());
  }

  async #start(query: string): Promise<void> {
    this.#cancel();
    const run = this.#run;
    const stale = (): boolean => run !== this.#run;
    this.#query = query;
    if (query === "") {
      this.#reset(IDLE_SMART_FIND);
      this.#emit();
      await this.#page.clear().catch(() => undefined);
      this.#collection = null;
      return;
    }
    const model = this.#model();
    if (model === null) {
      this.#reset({ ...IDLE_SMART_FIND, status: "unavailable" });
      this.#emit();
      return;
    }
    const abort = new AbortController();
    this.#abort = abort;
    this.#reset({ ...IDLE_SMART_FIND, status: "reading" });
    this.#emit();

    const read = await this.#page.collect(this.#collection?.generation ?? null).catch(() => null);
    if (stale()) return;
    if (read !== null && !("unchanged" in read)) this.#collection = read;
    else if (read === null || this.#collection === null || this.#collection.generation !== read.generation) this.#collection = null;
    const collection = this.#collection;
    if (collection === null || collection.passages.length === 0) {
      this.#progress = { ...IDLE_SMART_FIND, status: "unreadable" };
      this.#emit();
      return;
    }

    const { passages, truncated } = collection;
    this.#progress = { ...IDLE_SMART_FIND, status: "ranking", total: passages.length, truncated };
    this.#emit();
    const scores = new Map<string, number>();
    let searched = 0;
    for await (const batch of rankPassages(query, passages, { model, signal: abort.signal })) {
      if (stale()) return;
      for (const score of batch.scores) scores.set(score.id, score.probability);
      searched += batch.scores.length;
      const before = this.#matches[this.#active]?.ids[0];
      const ordered = orderMatches(this.#matches, this.#active, this.#pinned, selectMatches(passages, scores, false).matches);
      const changed = ordered.matches.length !== this.#matches.length || ordered.matches[ordered.active]?.ids[0] !== before;
      this.#matches = ordered.matches;
      this.#active = ordered.active;
      this.#progress = { ...this.#progress, searched };
      this.#refreshExcerpt();
      this.#emit();
      if (changed) await this.#paint(run, !this.#pinned);
    }
    if (stale()) return;
    if (searched === 0) {
      this.#reset({ ...IDLE_SMART_FIND, status: "failed", total: passages.length, truncated });
      this.#emit();
      return;
    }

    const selection = selectMatches(passages, scores, true);
    const before = this.#matches[this.#active]?.ids[0];
    const ordered = orderMatches(this.#matches, this.#active, this.#pinned, selection.matches);
    this.#matches = ordered.matches;
    this.#active = ordered.active;
    this.#progress = { ...this.#progress, status: "done", weak: selection.weak };
    this.#refreshExcerpt();
    this.#emit();
    await this.#paint(run, !this.#pinned && this.#matches[this.#active]?.ids[0] !== before);
    if (stale() || this.#matches.length === 0) return;

    // The key sentence of each match: asked about the best part of each, and
    // only now, so the paragraph is already on screen while this is out.
    const byId = new Map(passages.map((passage) => [passage.id, passage]));
    const best = this.#matches.map(
      (match) => byId.get(match.ids.reduce((a, b) => ((scores.get(b) ?? 0) > (scores.get(a) ?? 0) ? b : a)))!,
    );
    const focus = await focusSentences(query, best, { model, signal: abort.signal }).catch(() => null);
    if (stale() || focus === null) return;
    this.#focus = focus;
    this.#refreshExcerpt();
    this.#emit();
    await this.#paint(run, !this.#pinned);
  }

  #focusOf(match: SmartFindMatch): (SmartFindSpan & { id: string }) | undefined {
    for (const id of match.ids) {
      const span = this.#focus.get(id);
      if (span !== undefined) return { id, ...span };
    }
    return undefined;
  }

  #refreshExcerpt(): void {
    const match = this.#matches[this.#active];
    const passages = this.#collection?.passages ?? [];
    let excerpt = "";
    if (match !== undefined) {
      const focus = this.#focusOf(match);
      const passage = passages.find((candidate) => candidate.id === (focus?.id ?? match.ids[0]));
      const text = passage === undefined ? "" : focus === undefined ? passage.text : passage.text.slice(focus.start, focus.end);
      excerpt = text.length > SMART_FIND_LIMITS.excerpt ? `${text.slice(0, SMART_FIND_LIMITS.excerpt - 1).trimEnd()}…` : text;
    }
    if (excerpt !== this.#progress.excerpt) this.#progress = { ...this.#progress, excerpt };
  }

  /** Paints run one after another, so an older one can never land on top of a newer. */
  #paint(run: number, scroll: boolean): Promise<void> {
    const next = this.#painting.then(async () => {
      const collection = this.#collection;
      if (run !== this.#run || collection === null) return;
      const painted = await this.#page
        .paint({
          generation: collection.generation,
          matches: this.#matches.map((match) => ({ ids: match.ids, focus: this.#focusOf(match) })),
          active: this.#active,
          scroll,
          weak: this.#progress.weak,
        })
        .catch(() => null);
      if (run !== this.#run) return;
      const isStale = painted === null || painted.stale.length > 0;
      if (isStale !== this.#progress.stale) {
        this.#progress = { ...this.#progress, stale: isStale };
        this.#emit();
      }
    });
    this.#painting = next.catch(() => undefined);
    return this.#painting;
  }
}
