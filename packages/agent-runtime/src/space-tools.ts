/**
 * The agent's reach to the spaces (docs/primitives.md §2): which there are,
 * one sent away, one brought back, one closed into the archive — the same
 * verbs a space's menu and an extension's `pistachio.spaces.*` reach, through
 * the same table in main.
 *
 * Host-supplied, like the desk tools: the desktop builds a `SpaceToolHost`
 * over main's away service and its browser, and a run without one (the
 * cloud, an extension's author turn, a turn a reminder started) has none of
 * these tools and never reads of them. The host answers in the model's
 * terms — a space by its name, a time as an instant and as the sentence a
 * person would say — so this package stays ignorant of how main keeps a
 * space while it is away.
 */

import { tool } from "ai";
import { z } from "zod";
import type { SpaceToolRequest } from "@pistachio/protocol";
import type { AiAgentRunCallbacks } from "./runner.js";
import { parseInstant } from "./views/reminders.js";

/** A space on the rail, as the model reads it. */
export interface SpaceToolView {
  id: string;
  title: string;
  tabCount: number;
  /** The space in front — at a desk, the one this turn works in. */
  current: boolean;
}

/** A space that is away. `by`: "you" (the agent), "the person", or the name of the extension that sent it. */
export interface AwaySpaceToolView {
  id: string;
  title: string;
  tabCount: number;
  /** ISO instants. `until` null: away until someone asks. */
  since: string;
  until: string | null;
  by: string;
}

/**
 * What sending a space away or bringing one back came to. `back`: when it
 * returns, as a person would say it ("Sun 8:00 AM", "when you ask"), or
 * that it is back. Refused, `reason` is main's own sentence, to pass on.
 */
export type SpaceToolOutcome = { ok: true; title: string; until: string | null; back: string } | { ok: false; reason: string };

export interface SpaceToolHost {
  /** The spaces of the Profile in front, in the rail's order, and those that are away. */
  list(): { spaces: SpaceToolView[]; away: AwaySpaceToolView[] };
  /** Send a space away: until `until` (an instant, ms), or — null — until someone asks. */
  sendAway(spaceId: string, until: number | null): Promise<SpaceToolOutcome>;
  /** Bring an away space back onto the rail; never in front. */
  bringBack(spaceId: string): Promise<SpaceToolOutcome>;
  /** Close a space into the archive, whole: the person's own *Close space*. `back` says how it is restored. */
  close(spaceId: string): Promise<SpaceToolOutcome>;
}

export const SPACE_RULES = `
Space rules:
- The person's tabs live in spaces, each a named set on the rail. To put one out of the way — for now, or until a time — send it away with space_send_away: it leaves the rail whole, its tabs asleep and kept exactly as they are, and comes back as itself. Call spaces_list first and use the id it returns; name a space to the person by its title, never its id.
- With a time (at or inMinutes) the space comes back by itself, so never pair it with a reminder. A reminder is for telling the person something or doing work at a time, not for a space's coming and going. A relative time uses inMinutes; a specific one uses at as an ISO instant with the offset shown in the current time above.
- space_bring_back returns an away space to the rail without taking the person to it; say that it is back.
- space_close is for a space the person is done with: its tabs close and it is filed in the archive, from which they can restore it for about a month. For "out of the way for now" or "until later", send it away instead — an away space never lapses. Say where it went and that it can be restored.
- A recurring wish ("every Sunday", "weekdays after six") is not this tool's: do the first one if asked, and say that keeping it up needs an extension, which they can have made with /extension. Never fake it with reminders.
- If a space cannot go or come back, the tool says why in a sentence: tell the person that, and do not work around it.
`;

function spaceLabel(request: SpaceToolRequest): string {
  switch (request.name) {
    case "spaces.list":
      return "Looking at the spaces";
    case "space.sendAway":
      return "Sending a space away";
    case "space.bringBack":
      return "Bringing a space back";
    case "space.close":
      return "Closing a space";
  }
}

function spaceDetail(request: SpaceToolRequest): string {
  switch (request.name) {
    case "spaces.list":
      return "";
    case "space.sendAway":
      return request.until === null ? "Until asked for" : `Until ${request.until}`;
    case "space.bringBack":
    case "space.close":
      return "";
  }
}

/**
 * When a space is to come back, from the tool's two fields: `inMinutes`
 * from now; else `at`, an ISO date-time read as a reminder's is (with an
 * offset it is what it says, without one it is in the person's zone —
 * views/reminders parseInstant); neither, null: until asked. A time that
 * cannot be read is the model's to fix, in words it can act on; one that
 * has passed is main's to refuse, in its own.
 */
export function spaceReturnInstant(at: string | null, inMinutes: number | null, now: Date, timezone: string): number | null {
  if (inMinutes !== null) {
    if (!Number.isFinite(inMinutes) || inMinutes < 1) throw new Error("inMinutes must be at least 1");
    return now.getTime() + Math.round(inMinutes) * 60_000;
  }
  if (at === null || at.trim() === "") return null;
  const instant = parseInstant(at, timezone);
  if (instant === null) throw new Error(`at is not an ISO 8601 date-time like 2026-08-27T16:00:00-06:00: ${at}`);
  return instant.getTime();
}

const SPACE_ID = z.string().min(1).max(128).describe("A space's id, from spaces_list.");

export function spaceTools(host: SpaceToolHost, timezone: string, now: () => Date, callbacks: AiAgentRunCallbacks) {
  // A refusal — the space is shared live, the time has passed — is a failed step in the trace and a sentence for the
  // model, as a bad schedule is for a reminder: never an exception out of the run.
  const perform = async <T,>(request: SpaceToolRequest, work: () => Promise<T> | T, summary: (value: T) => string) => {
    const toolId = callbacks.toolStarted(request, spaceLabel(request), spaceDetail(request));
    callbacks.changed();
    try {
      const value = await work();
      callbacks.toolCompleted(toolId, { summary: summary(value), data: value });
      callbacks.changed();
      return value;
    } catch (error: unknown) {
      callbacks.toolFailed(toolId, error);
      callbacks.changed();
      return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
    }
  };
  const act = (request: SpaceToolRequest, work: () => Promise<SpaceToolOutcome>, summary: (done: Extract<SpaceToolOutcome, { ok: true }>) => string) =>
    perform(
      request,
      async () => {
        const outcome = await work();
        if (!outcome.ok) throw new Error(outcome.reason);
        return outcome;
      },
      summary,
    );
  return {
    spaces_list: tool({
      description:
        "List the person's spaces: each one on the rail (id, title, tab count, which is in front) and each that is away (who sent it, since when, and when it is due back, if it has a time).",
      inputSchema: z.object({}),
      execute: async () =>
        perform({ name: "spaces.list" }, () => host.list(), (listed) => {
          const here = `${String(listed.spaces.length)} space${listed.spaces.length === 1 ? "" : "s"}`;
          return listed.away.length === 0 ? here : `${here}, ${String(listed.away.length)} away`;
        }),
    }),
    space_send_away: tool({
      description:
        "Send a space away: it leaves the rail whole, its tabs asleep and kept as they are, and comes back as itself — at a time (at, or inMinutes from now) by itself, or, with both null, when the person or you ask.",
      inputSchema: z.object({
        spaceId: SPACE_ID,
        at: z.string().nullable().describe("When it comes back: an ISO 8601 instant with offset, e.g. 2026-08-30T08:00:00-06:00. Null with inMinutes, or to leave it away until asked."),
        inMinutes: z.number().nullable().describe("Minutes from now until it comes back. Prefer it for relative times; else null."),
      }),
      execute: async ({ spaceId, at, inMinutes }) => {
        let until: number | null;
        try {
          until = spaceReturnInstant(at, inMinutes, now(), timezone);
        } catch (error: unknown) {
          return perform({ name: "space.sendAway", spaceId, until: null }, () => {
            throw error;
          }, () => "");
        }
        return act(
          { name: "space.sendAway", spaceId, until: until === null ? null : new Date(until).toISOString() },
          () => host.sendAway(spaceId, until),
          (done) => (done.until === null ? `Sent ${done.title} away` : `Sent ${done.title} away until ${done.back}`),
        );
      },
    }),
    space_bring_back: tool({
      description: "Bring an away space back onto the rail, as it was. It is not brought in front: the person stays where they are.",
      inputSchema: z.object({ spaceId: SPACE_ID }),
      execute: async ({ spaceId }) => act({ name: "space.bringBack", spaceId }, () => host.bringBack(spaceId), (done) => `Brought ${done.title} back`),
    }),
    space_close: tool({
      description:
        "Close a space the person is done with: its tabs close and the space is filed in the archive as one entry, from which they can restore it as it was. Not for putting a space out of the way for a while — that is space_send_away.",
      inputSchema: z.object({ spaceId: SPACE_ID }),
      execute: async ({ spaceId }) => act({ name: "space.close", spaceId }, () => host.close(spaceId), (done) => `Closed ${done.title}`),
    }),
  };
}
