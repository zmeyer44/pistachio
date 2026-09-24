/**
 * Which way a console request goes — answered from what is already in the
 * conversation, or worked in the live browser — as judged by a System One
 * evaluation model (TypeSafe's Jev, through the Vercel AI Gateway:
 * docs/console-routing.md). The wire shapes and the bounds alone.
 *
 * Every message to the console used to start the browser agent, whose
 * first rule is to list the tabs: "shorten that" or "what did the page say
 * about returns?" paid for two browser round trips before a word came
 * back. The router puts one cheap question ahead of the turn — does
 * replying need the web, or only what is here? — and the host picks the
 * path. The model chooses between two readings and writes nothing; the
 * worst a wrong answer can do is send a request down the slower path, or
 * down the quick one, which hands itself back to the browser path the
 * moment the model there finds it needs a page (runner.ts `use_browser`).
 *
 * No `ai` import, no Node, no DOM here: the shapes are importable from
 * anywhere. The evaluator beside it — ./turn-route.ts — is what a host
 * calls.
 */

/**
 * The three readings. Ids are the model's option names. `page` is the
 * middle one: a question about the page in view, answered by reading it
 * once — the host reads the tab itself and runs the answer path with the
 * text in hand, so no browser action and no tool step is taken.
 */
export const TURN_ROUTES = ["answer", "page", "browse"] as const;
export type TurnRoute = (typeof TURN_ROUTES)[number];

/** One earlier exchange in the thread, clipped: who said it and what. */
export interface TurnRouteExchange {
  who: "person" | "assistant";
  said: string;
}

/**
 * What the router reads. Deliberately thin — a large state full of
 * irrelevant detail distracts a literal reader — and free of anything
 * that would leak what was browsed: the page is a title and a host, never
 * a URL.
 */
export interface TurnRouteRequest {
  /** The person's words for this turn, trimmed and clipped. */
  message: string;
  /** What they attached, by kind ("image", "pdf", "text"); empty when nothing. */
  attachments: string[];
  /** The last few exchanges, oldest first. Empty on a fresh thread. */
  conversation: TurnRouteExchange[];
  /** Whether this thread has already acted in the browser: an earlier turn read or touched a page. */
  browserUsed: boolean;
  /**
   * The web page the person is looking at, when there is one. Null when
   * the tab in view is not a web page (the home page, a settings page):
   * then the `page` reading is not offered at all.
   */
  currentPage: { title: string; host: string } | null;
  /**
   * The non-browser things the quick path can still do, in plain words
   * the model reads as part of the "answer" option: "remember things",
   * "set reminders", "read the person's calendar". Empty when none.
   */
  tools: string[];
}

/** What the model thought, before the host decides. */
export interface TurnRouteEvaluation {
  /** P(each route); sums to ~1. */
  routes: Record<TurnRoute, number>;
  /** How sure the model is, 0–1 (its own figure when it sends one). */
  confidence: number;
  latencyMs: number;
}

/** The host's decision, with the evaluation it was made from when a model was asked. */
export interface TurnRouteDecision {
  route: TurnRoute;
  /** Why this route: the model decided, nobody was asked, or the model gave no opinion. */
  basis: "model" | "skipped" | "unavailable";
  evaluation: TurnRouteEvaluation | null;
}

export const TURN_ROUTE_LIMITS = {
  /**
   * One request must not wait long on its router: past this, browse. The
   * model answers in ~250 ms (p90 ~310 ms measured); the room above that
   * is for one retry of a transient gateway error, which the SDK makes
   * after a 2 s backoff.
   */
  timeoutMs: 4_000,
  messageChars: 2_000,
  exchangeChars: 320,
  exchanges: 6,
  /**
   * P(answer) + P(page) at or above which a quick path is taken — the two
   * are one path with and without the page in hand, and the better of
   * them wins. Below it the browser path runs, as it always did: a
   * misroute there costs time, a misroute the other way costs one short
   * call before the hand-back.
   */
  answerFloor: 0.6,
} as const;

/** The route the host takes for an evaluation, or for none. */
export function decideTurnRoute(evaluation: TurnRouteEvaluation | null): TurnRouteDecision {
  if (evaluation === null) return { route: "browse", basis: "unavailable", evaluation: null };
  const { answer, page } = evaluation.routes;
  const route: TurnRoute = answer + page < TURN_ROUTE_LIMITS.answerFloor ? "browse" : page > answer ? "page" : "answer";
  return { route, basis: "model", evaluation };
}

/** Clipped, trimmed, and bounded: what may be sent, whatever came in. */
export function sanitizeTurnRouteRequest(request: TurnRouteRequest): TurnRouteRequest {
  const limits = TURN_ROUTE_LIMITS;
  return {
    message: clip(request.message.trim(), limits.messageChars),
    attachments: [...new Set(request.attachments.map((kind) => kind.trim()).filter((kind) => kind !== ""))].slice(0, 8),
    conversation: request.conversation
      .slice(-limits.exchanges)
      .map((exchange) => ({ who: exchange.who, said: clip(exchange.said.trim(), limits.exchangeChars) }))
      .filter((exchange) => exchange.said !== ""),
    browserUsed: request.browserUsed,
    currentPage:
      request.currentPage === null
        ? null
        : { title: clip(request.currentPage.title.trim(), 160), host: clip(request.currentPage.host.trim(), 120) },
    tools: [...new Set(request.tools.map((tool) => tool.trim()).filter((tool) => tool !== ""))].slice(0, 12),
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
