/**
 * The desk as the agent reads and arranges it (docs/desk-agent.md §2): its
 * zones and boxes, which are percents of the desk — the room windows have
 * beside the dock and above the Bar — and the word a window's chip says
 * while the agent works in it. Pure, so the desk's own tests pin it.
 */

import type { AgentToolCall, RunSummary } from "@pistachio/protocol";
import type { DeskPercentBox, DeskZone } from "@pistachio/shell-contracts/desk-agent";
import { centeredRect, clampRect, DESK_GAP, zoneRect, type Rect } from "./geometry";

/** Where a zone puts a window: a half (top and bottom too), a quarter, the middle, or the whole desk. */
export function deskZoneRect(zone: DeskZone, bounds: Rect, gap = DESK_GAP): Rect {
  const halfH = (bounds.h - gap) / 2;
  switch (zone) {
    case "full":
      return { ...bounds };
    case "center":
      return centeredRect(bounds);
    case "top":
      return { x: bounds.x, y: bounds.y, w: bounds.w, h: halfH };
    case "bottom":
      return { x: bounds.x, y: bounds.y + halfH + gap, w: bounds.w, h: halfH };
    default:
      return zoneRect(zone, bounds, gap);
  }
}

/** A box on the desk as percents of it, to a tenth. */
export function percentBox(rect: Rect, bounds: Rect): DeskPercentBox {
  const share = (value: number, of: number): number => Math.round((value / Math.max(1, of)) * 1_000) / 10;
  return { x: share(rect.x - bounds.x, bounds.w), y: share(rect.y - bounds.y, bounds.h), w: share(rect.w, bounds.w), h: share(rect.h, bounds.h) };
}

/** A box the agent gave, on the desk: kept inside it, and no smaller than a window may be. */
export function boxRect(box: DeskPercentBox, bounds: Rect): Rect {
  return clampRect(
    {
      x: bounds.x + (box.x / 100) * bounds.w,
      y: bounds.y + (box.y / 100) * bounds.h,
      w: (box.w / 100) * bounds.w,
      h: (box.h / 100) * bounds.h,
    },
    bounds,
  );
}

/** What the agent is doing in a window, in a word: its chip, from the tool it is running. */
export function agentVerb(name: AgentToolCall["name"]): string {
  switch (name) {
    case "page.inspect":
    case "context.read":
      return "Reading";
    case "page.screenshot":
    case "desk.state":
      return "Looking";
    case "page.click":
      return "Clicking";
    case "page.type":
    case "page.press":
      return "Typing";
    case "page.scroll":
      return "Scrolling";
    case "page.navigate":
    case "page.back":
    case "page.forward":
    case "page.reload":
    case "tab.open":
      return "Opening";
    case "desk.arrange":
    case "desk.ungroup":
      return "Arranging";
    case "desk.note":
    case "context.save":
      return "Noting";
    default:
      return "Working";
  }
}

/**
 * The agent's latest word for the desk: the tool it is running now, or
 * when it is between tools, thinking. Null while it is not acting.
 */
export function agentActivity(run: RunSummary | null): string | null {
  if (run === null || run.status !== "running" || run.control !== "agent") return null;
  const latest = run.toolCalls.at(-1);
  return latest !== undefined && latest.status === "running" ? agentVerb(latest.name) : "Thinking";
}
