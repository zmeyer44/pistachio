/**
 * The desk's smart layout, the half that runs (docs/desk-layout.md): it
 * hears a window come out or leave (the engine's onLayoutMoment), or the
 * person ask (⌘⌥L, the More card), describes the desk to the layout model,
 * and — when the model's opinion and `decideDeskLayout` say so — lays the
 * windows out anew, with a notice to undo it.
 *
 * Three rules keep it from fighting the person:
 *  - Only the latest question counts. A window coming or going while one is
 *    out supersedes it (main aborts the call), and a close is held a moment
 *    so three tabs closed in a row are one question.
 *  - An answer about a desk that has changed since is dropped: the layout
 *    is stamped when asked (layoutView().stamp) and must be the same when
 *    the answer comes. A window in hand stops it too (applyLayout).
 *  - Nothing moves on its own while the desk's agent is at work (it lays the
 *    desk out itself), or with the Feel's Layout set to By hand — asked again
 *    when the answer comes, as either may have changed while it was awaited.
 *
 * And a question, and the Undo of what it did, belong to the group whose
 * desk they were about: the engine passes from group to group in place,
 * and another group's desk is not theirs to move.
 *
 * The engine and the host are interfaces, so a test drives it without a
 * DOM, a model, or a timer of its own.
 */

import {
  decideDeskLayout,
  type DeskLayoutDecision,
  type DeskLayoutEvaluation,
  type DeskLayoutGone,
  type DeskLayoutRequest,
  type DeskLayoutTrigger,
} from "@pistachio/shell-contracts/desk-layout";
import type { Rect } from "../../lib/desk/geometry";
import {
  changesLayout,
  fillGaps,
  focusLayout,
  offeredMoves,
  pairedLayout,
  placeWords,
  tiledLayout,
} from "../../lib/desk/smart-layout";
import type { DeskLayoutMoment, DeskLayoutSnapshot, DeskLayoutView } from "./desk-engine";

/** How long a close waits for another before the desk is asked about both. */
export const CLOSE_SETTLE_MS = 180;
/** The most windows the model is asked about (DESK_LAYOUT_LIMITS.windows). */
const MOST_WINDOWS = 12;

export interface SmartArrangeEngine {
  onLayoutMoment(listener: (moment: DeskLayoutMoment) => void): () => void;
  layoutView(): DeskLayoutView;
  applyLayout(layout: ReadonlyMap<string, Rect>): DeskLayoutSnapshot | null;
  restoreLayout(snapshot: DeskLayoutSnapshot): void;
}

/** What a window is, for the model: its latest title and site, kept after it has gone. */
export interface WindowWords {
  title: string;
  site: string;
  kind: "page" | "document";
}

export interface SmartArrangeHost {
  /** Windows coming and going may move the others (the Feel's Layout is Smart). */
  auto(): boolean;
  /** The desk's agent is at work: what comes and goes is its doing. */
  busy(): boolean;
  /** The layout model through main, or null where there is none (then: keep, or asked, tile). */
  judge: ((request: DeskLayoutRequest) => Promise<DeskLayoutEvaluation | null>) | null;
  /** The group whose desk this is now (the engine passes from group to group in place). */
  group(): string | null;
  /** A window's words, the latest known — a window just closed is no tab any more. */
  describe(id: string): WindowWords | null;
  /** Say what the desk did, with a way back (null: nothing to undo). */
  notify(message: string, undo: (() => void) | null): void;
  /** A timer (injectable for tests); returns its cancel. */
  later(run: () => void, ms: number): () => void;
}

/** A question waiting, or out: a window came out, some left, or the person asked. */
type Moment = DeskLayoutMoment | { trigger: "asked" };

export class SmartArranger {
  readonly #engine: SmartArrangeEngine;
  readonly #host: SmartArrangeHost;
  readonly #off: () => void;
  /** A close held for the next (CLOSE_SETTLE_MS), on the desk of `group`. */
  #held: { moment: Extract<Moment, { trigger: "closed" }>; group: string | null; cancel: () => void } | null = null;
  /** The question out now; a newer one makes an older one's answer worthless. */
  #serial = 0;
  #destroyed = false;

  constructor(engine: SmartArrangeEngine, host: SmartArrangeHost) {
    this.#engine = engine;
    this.#host = host;
    this.#off = engine.onLayoutMoment((moment) => this.#heard(moment));
  }

  destroy(): void {
    this.#destroyed = true;
    this.#serial += 1;
    this.#held?.cancel();
    this.#held = null;
    this.#off();
  }

  /** The person asked (⌘⌥L, the More card): the desk laid out the way the model thinks best, whatever the Feel's Layout. */
  ask(): Promise<void> {
    this.#held?.cancel();
    this.#held = null;
    return this.#run({ trigger: "asked" }, this.#host.group());
  }

  #heard(moment: DeskLayoutMoment): void {
    // Whatever was being asked is about a desk that is not this one any more.
    this.#serial += 1;
    if (!this.#host.auto() || this.#host.busy()) {
      this.#held?.cancel();
      this.#held = null;
      return;
    }
    const group = this.#host.group();
    if (moment.trigger === "opened") {
      this.#held?.cancel();
      this.#held = null;
      void this.#run(moment, group);
      return;
    }
    // A close waits a moment for the next: several in a row are one question — on one desk (a close held on another group's is forgotten).
    const held = this.#held?.group === group ? this.#held : null;
    this.#held?.cancel();
    const gathered = { trigger: "closed" as const, gone: [...(held?.moment.gone ?? []), ...moment.gone] };
    this.#held = {
      moment: gathered,
      group,
      cancel: this.#host.later(() => {
        this.#held = null;
        void this.#run(gathered, group);
      }, CLOSE_SETTLE_MS),
    };
  }

  /** The desk the question was about is still up (`group`'s), and may still be moved: by its own accord only while Layout is Smart and the agent is not at work. */
  #mayMove(moment: Moment, group: string | null): boolean {
    if (this.#destroyed || this.#host.group() !== group) return false;
    return moment.trigger === "asked" || (this.#host.auto() && !this.#host.busy());
  }

  async #run(moment: Moment, group: string | null): Promise<void> {
    if (!this.#mayMove(moment, group)) return;
    const serial = (this.#serial += 1);
    const view = this.#engine.layoutView();
    const asked = moment.trigger === "asked";
    if (view.windows.size === 0 || view.windows.size > MOST_WINDOWS) {
      if (asked) this.#host.notify(view.windows.size === 0 ? "No windows to arrange" : "Too many windows to arrange", null);
      return;
    }
    const built = this.#request(moment, view);
    if (built === null) return;
    const evaluation = this.#host.judge === null ? null : await this.#host.judge(built.request).catch(() => null);
    if (serial !== this.#serial || !this.#mayMove(moment, group)) return;
    const now = this.#engine.layoutView();
    // The desk changed while the model thought: its answer is about another desk.
    if (now.stamp !== view.stamp) return;
    const decision = decideDeskLayout(built.request, evaluation);
    const layout = this.#layout(decision, moment, now);
    if (layout === null || !changesLayout(now.windows, layout)) {
      if (asked) this.#host.notify(decision.move === "keep" ? "The desk is laid out well already" : "The windows are laid out that way already", null);
      return;
    }
    const undo = this.#engine.applyLayout(layout);
    if (undo === null) return;
    this.#host.notify(this.#say(decision, moment, built.fillers), () => {
      // Clicked once the desk has passed to another group, it would lay this one out as that one was.
      if (this.#host.group() === group) this.#engine.restoreLayout(undo);
    });
  }

  /** The question, in the model's words: the windows, what happened, and the moves the desk can make. */
  #request(moment: Moment, view: DeskLayoutView): { request: DeskLayoutRequest; fillers: string[] } | null {
    const trigger: DeskLayoutTrigger = moment.trigger;
    const all = [...view.windows.values(), ...view.others];
    const opened = moment.trigger === "opened" ? moment.id : null;
    if (opened !== null && !view.windows.has(opened)) return null;
    // The window a new one split (it stood elsewhere before).
    const split =
      moment.trigger === "opened" && moment.how === "split"
        ? ([...moment.before].find(([id, rect]) => id !== opened && view.windows.has(id) && changesLayout(new Map([[id, rect]]), new Map([[id, view.windows.get(id)!]])))?.[0] ?? null)
        : null;
    const windows: DeskLayoutRequest["windows"] = [];
    for (const [id, rect] of view.windows) {
      const words = this.#host.describe(id) ?? { title: "", site: "", kind: "page" as const };
      let place = placeWords(rect, view.bounds, all.filter((other) => other !== rect));
      if (id === opened && moment.trigger === "opened") {
        const beside = split === null ? null : (this.#host.describe(split)?.title ?? null);
        place +=
          moment.how === "split" && beside !== null
            ? `, beside "${short(beside, 40)}", the two sharing what was its place`
            : moment.how === "hole"
              ? ", in the space that was empty"
              : moment.how === "free"
                ? ", over the other windows"
                : "";
      }
      windows.push({ id, title: words.title, site: words.site, kind: words.kind, place, inUse: id === view.inUse, opened: id === opened });
    }
    const gaps = moment.trigger === "closed" ? moment.gone.map((gone) => gone.rect) : [];
    const gone: DeskLayoutGone[] =
      moment.trigger === "closed"
        ? moment.gone.map((entry) => {
            const words = this.#host.describe(entry.id);
            return { title: words?.title ?? "", site: words?.site ?? "", place: placeWords(entry.rect, view.bounds), how: entry.how };
          })
        : [];
    const moves = offeredMoves(trigger, view.windows, view.bounds, {
      gaps,
      ...(moment.trigger === "opened" ? { before: moment.before, opened: moment.id, how: moment.how === "first" ? "free" : moment.how } : {}),
    });
    if (moves.filter((move) => move !== "keep").length === 0) return null;
    const filled = moves.includes("fill") ? fillGaps(view.windows, gaps) : null;
    const fillers =
      filled === null
        ? []
        : [...filled].filter(([id, rect]) => changesLayout(new Map([[id, view.windows.get(id)!]]), new Map([[id, rect]]))).map(([id]) => this.#host.describe(id)?.title ?? "");
    return { request: { trigger, windows, gone, moves, fillers }, fillers };
  }

  /** Where every window goes for the decision, by the desk's own rules (lib/desk/smart-layout.ts). */
  #layout(decision: DeskLayoutDecision, moment: Moment, view: DeskLayoutView): Map<string, Rect> | null {
    switch (decision.move) {
      case "keep":
        return null;
      case "fill":
        return moment.trigger === "closed" ? fillGaps(view.windows, moment.gone.map((gone) => gone.rect)) : null;
      case "pair":
        return moment.trigger === "opened" && decision.partner !== null ? pairedLayout(moment.before, moment.id, decision.partner) : null;
      case "tile":
        return tiledLayout(view.windows, view.bounds, decision.main);
      case "focus":
        return decision.main === null ? null : focusLayout(view.windows, view.bounds, decision.main);
    }
  }

  /** What the notice says the desk did. */
  #say(decision: DeskLayoutDecision, moment: Moment, fillers: readonly string[]): string {
    const title = (id: string | null): string => `“${short(id === null ? "" : (this.#host.describe(id)?.title ?? ""), 32) || "the window"}”`;
    switch (decision.move) {
      case "fill":
        return fillers.length === 1 ? `${`“${short(fillers[0]!, 32)}”`} filled the gap` : "The windows beside it filled the gap";
      case "pair":
        return `Put ${title(moment.trigger === "opened" ? moment.id : null)} beside ${title(decision.partner)}`;
      case "focus":
        return `Gave ${title(decision.main)} the main place`;
      default:
        return "Tiled the windows";
    }
  }
}

function short(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
