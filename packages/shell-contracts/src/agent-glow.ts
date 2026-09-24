/**
 * The agent-control glow: the light the chrome's highlight ring casts INTO
 * the page.
 *
 * The ring itself is chrome-side (renderer/src/styles.css, the
 * `.browser-pane-grid[data-agent-driving]` pseudo-elements) and it stops at
 * the pane's edge on purpose — a tab's WebContentsView covers its pane box
 * exactly, and nothing the shell paints can appear above a native view. So
 * the spill inward is not something the shell can draw: it is a stylesheet
 * main injects into the driven page (main/browser-controller.ts
 * `setAgentGlow`), painting the same comet on the page's own viewport edges.
 *
 * The two are kept in step without any message passing. Both animations run
 * at AGENT_RING_PERIOD_MS, and both start with a negative delay taken from
 * the SAME wall clock (`agentRingDelayMs`), so each is anchored to a whole
 * multiple of the period in absolute time rather than to the moment it
 * happened to mount. A page that navigates mid-run re-injects and lands back
 * on the comet's current phase instead of restarting the sweep.
 */

import type { RunSummary } from "@pistachio/protocol";

/**
 * Whether the agent is driving right now — the one condition every half of
 * the light keys off, so none can outlast the others. The shell puts the
 * ring up on it (renderer/src/lib/run.ts re-exports this), main lights the
 * page on it (main/index.ts `publish`), and the live view of a cloud run
 * feeds it the status the cloud browser reports (renderer/src/lib/cloud.ts).
 *
 * Deliberately narrow. `ready` and `capturing` mean a run exists but nothing
 * is touching the page yet, and every paused status hands the page back; a
 * finished turn has already set `completed` and returned control by the time
 * its answer is published, so the light goes out with the answer rather than
 * after it.
 */
export function agentIsDriving(run: Pick<RunSummary, "control" | "status"> | null): boolean {
  return run !== null && run.control === "agent" && run.status === "running";
}

/**
 * The one tab in THIS browser the agent is driving, or null.
 *
 * The light is not a busy indicator: it marks the page the agent is acting
 * on, and only while the person is looking at that page. So the answer is a
 * tab, not a boolean, and the callers put the light on that tab alone —
 * main lights only its pane (browser-controller.ts `setAgentGlow`), and only
 * when that pane is on screen; the shell rings only that pane
 * (components/ContentArea.tsx).
 *
 * The agent works tab by tab: every browser tool names the tab it touches
 * (`AgentToolCall.tabId`), and it can open others and move between them
 * mid-run. The tab it is on is the one its latest tool touched; before it
 * has touched any, the tab the run started in. A cloud run's tabs live in
 * the cloud browser (its `humanTabId` is null), so it never lights a pane
 * here however busy it is — its live view is where that run is watched.
 */
export function agentDrivenTabId(run: RunSummary | null): string | null {
  if (run === null || !agentIsDriving(run) || run.executor?.kind === "cloud") return null;
  for (let index = run.toolCalls.length - 1; index >= 0; index -= 1) {
    const tabId = run.toolCalls[index]?.tabId ?? null;
    if (tabId !== null) return tabId;
  }
  return run.humanTabId;
}

/**
 * One trip of the comet around the edge. Mirrored by the `2.6s` in
 * styles.css `agent-ring-spin` — change both together.
 */
export const AGENT_RING_PERIOD_MS = 2600;

/** How far the light reaches in from the page's edge. */
const GLOW_REACH_PX = 88;

/** The fade-in when the agent takes the wheel; matches the ring's own. */
const GLOW_FADE_MS = 320;

/**
 * Where each comet's head sits in the sweep. Two of them, half a turn apart,
 * so the page is lit on both sides at once and no edge waits most of a lap
 * for the light. The same pair the ring carries (styles.css).
 */
const COMET_HEADS = [165, 345] as const;

const DEFAULT_COLORS = ["#88C999", "#67BFB4", "#98B9EF"] as const;

/**
 * The animation delay that puts a sweep starting NOW onto the phase shared by
 * everything else keyed to the same clock. Negative: the animation begins
 * part-way through its cycle.
 */
export function agentRingDelayMs(now: number): number {
  return -(((now % AGENT_RING_PERIOD_MS) + AGENT_RING_PERIOD_MS) % AGENT_RING_PERIOD_MS);
}

/**
 * A CSS colour safe to paste into a stylesheet bound for a web page. The
 * palette comes from settings on disk, which the page must never be able to
 * turn into a rule of its own.
 */
function safeColor(value: string | undefined, fallback: string): string {
  return value !== undefined && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback;
}

function mix(color: string, percent: number): string {
  return `color-mix(in oklch, ${color} ${String(percent)}%, transparent)`;
}

export interface AgentGlowOptions {
  /** The theme's gradient colours, in paint order (@pistachio/shell-contracts/appearance). */
  colors: readonly string[];
  /** The pane's corner radius, so the light stops where the page's card does. */
  radius: number;
  /** `agentRingDelayMs(Date.now())` at injection time. */
  delayMs: number;
}

/**
 * The stylesheet injected into a page the agent is driving.
 *
 * It hangs on `html::after`: a pseudo-element is invisible to the page's own
 * scripts and queries, so nothing the page does can see it, and being fixed
 * to the viewport it neither reflows the document nor scrolls with it. Every
 * declaration is `!important` and the element takes no pointer events — the
 * page below stays exactly as interactive as it was.
 */
export function agentGlowCss(options: AgentGlowOptions): string {
  const first = safeColor(options.colors[0], DEFAULT_COLORS[0]);
  const second = safeColor(options.colors[1], first);
  const third = safeColor(options.colors[2], second);
  const radius = Math.max(0, Math.min(64, Math.round(options.radius)));
  const delay = Math.round(options.delayMs);
  const reach = `${String(GLOW_REACH_PX)}px`;
  // One comet: a head at its brightest, a short fall past it, and a tail back
  // through the palette to nothing. The head angles are the ring's own
  // (styles.css) — that is what keeps the two lined up — but the fall past
  // the head is longer here: the ring is a 3px band, where a short fall is a
  // crisp front, while this one is GLOW_REACH_PX deep, where the same angle
  // would cut a hard line across the page.
  const comet = (head: number): string =>
    [
      `transparent ${String(head - 105)}deg`,
      `${mix(third, 34)} ${String(head - 83)}deg`,
      `${third} ${String(head - 45)}deg`,
      `${second} ${String(head - 19)}deg`,
      `${first} ${String(head)}deg`,
      `transparent ${String(head + 15)}deg`,
    ].join(",\n      ");
  // One edge's falloff: solid at the boundary, most of it spent in the first
  // handful of pixels so the light reads as spill off the ring rather than a
  // vignette. The four are unioned, which pools them a little in the corners.
  const edge = (direction: string): string =>
    `linear-gradient(to ${direction}, #000 0, rgba(0, 0, 0, 0.66) 11px, rgba(0, 0, 0, 0.22) 34px, transparent ${reach})`;
  return `
@property --pistachio-agent-glow-angle {
  syntax: "<angle>";
  initial-value: 0deg;
  inherits: false;
}

@keyframes pistachio-agent-glow-spin {
  to { --pistachio-agent-glow-angle: 360deg; }
}

@keyframes pistachio-agent-glow-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

html::after {
  content: "" !important;
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
  border-radius: ${String(radius)}px !important;
  /* The steady half: light pooling just inside every edge, which is what
     the ring's continuous base (styles.css ::before) casts. */
  box-shadow:
    inset 0 0 11px ${mix(first, 34)},
    inset 0 0 36px ${mix(first, 26)} !important;
  /* The travelling half: both comets, on the ring's own stops and on a box
     that is the ring's own box, so each bright head sits directly inside the
     highlight rather than trailing it. */
  background-image:
    conic-gradient(
      from var(--pistachio-agent-glow-angle),
      transparent 0deg,
      ${comet(COMET_HEADS[0])},
      ${comet(COMET_HEADS[1])}
    ) !important;
  mask-image: ${edge("right")}, ${edge("left")}, ${edge("bottom")}, ${edge("top")} !important;
  mask-composite: add !important;
  mask-repeat: no-repeat !important;
  opacity: 0.9 !important;
  animation:
    pistachio-agent-glow-spin ${String(AGENT_RING_PERIOD_MS)}ms linear ${String(delay)}ms infinite,
    pistachio-agent-glow-in ${String(GLOW_FADE_MS)}ms ease-out both !important;
}

@media (prefers-reduced-motion: reduce) {
  /* Still lit, just no longer chasing — the same concession styles.css makes. */
  html::after {
    animation: pistachio-agent-glow-in ${String(GLOW_FADE_MS)}ms ease-out both !important;
  }
}

@media print {
  html::after { display: none !important; }
}
`;
}

/**
 * Laid over the glow to take it off for one frame. The agent looks at the
 * page through `capturePage`, and a tinted band around every edge is the
 * app's own chrome bleeding into what the model reads as the page.
 */
export const AGENT_GLOW_SUPPRESS_CSS = `html::after { display: none !important; }`;
