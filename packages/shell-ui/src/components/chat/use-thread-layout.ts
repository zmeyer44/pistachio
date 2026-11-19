import { useMemo } from "react";
import type { AgentToolOutput, RunSummary } from "@pistachio/protocol";
import { turnSources, type CitedSource } from "../../lib/chat-sources";
import { traceTurns, turnOutputs, turnReplyIndex, type TraceTurn } from "../../lib/run";

/**
 * A turn's output as the thread shows it. `earlier`: a later turn built or changed the same extension, so this is
 * no longer the card its approval is asked in — an extension is asked about once in a thread, under the last reply
 * that touched it (components/OutputCard.tsx).
 */
export type ThreadOutput = AgentToolOutput & { earlier?: true };

/** Each turn's outputs, in the thread's order, with the extensions a later turn touched again marked `earlier`. */
export function threadOutputs(turns: readonly (readonly AgentToolOutput[])[]): ThreadOutput[][] {
  const last = new Map<string, number>();
  turns.forEach((outputs, index) => {
    for (const output of outputs) if (output.kind === "extension") last.set(output.id, index);
  });
  return turns.map((outputs, index) => outputs.map((output) => (output.kind === "extension" && last.get(output.id) !== index ? { ...output, earlier: true as const } : output)));
}

/** Where each turn's trace, outputs and sources sit in the thread, by message index. */
export interface ThreadLayout {
  /** One trace per model turn, keyed by the message each sits under. */
  tracesAt: Map<number, TraceTurn[]>;
  /** What each turn made, under the reply that finished it. */
  outputsAt: Map<number, ThreadOutput[]>;
  /** What a turn made while its reply is not written yet, by turn. */
  pendingOutputs: Map<number, ThreadOutput[]>;
  /** The pages each turn read, keyed by the reply that finished it: its citations resolve against them. */
  sourcesAt: Map<number, CitedSource[]>;
  /** The pages the turn still in progress has read: the live reply cites them. */
  pendingSources: CitedSource[];
}

const EMPTY: ThreadLayout = { tracesAt: new Map(), outputsAt: new Map(), pendingOutputs: new Map(), sourcesAt: new Map(), pendingSources: [] };

/**
 * The thread's shape, computed once per change of the parts it reads —
 * not on the status and clock fields every publish touches. Grouping
 * walks every message for every turn, so that matters on a long thread.
 */
export function useThreadLayout(run: RunSummary | null): ThreadLayout {
  const messages = run?.messages;
  const toolCalls = run?.toolCalls;
  const subagents = run?.subagents;
  return useMemo(() => {
    if (messages === undefined || toolCalls === undefined || subagents === undefined) return EMPTY;
    const tracesAt = new Map<number, TraceTurn[]>();
    const outputsAt = new Map<number, ThreadOutput[]>();
    const pendingOutputs = new Map<number, ThreadOutput[]>();
    const sourcesAt = new Map<number, CitedSource[]>();
    let pendingSources: CitedSource[] = [];
    const turns = traceTurns({ messages, toolCalls, subagents });
    const made = threadOutputs(turns.map((turn) => turnOutputs(turn.toolCalls)));
    for (const [index, turn] of turns.entries()) {
      const traces = tracesAt.get(turn.anchor);
      if (traces === undefined) tracesAt.set(turn.anchor, [turn]);
      else traces.push(turn);
      const reply = turnReplyIndex(messages, turn.turn);
      const outputs = made[index] ?? [];
      if (outputs.length > 0) {
        if (reply === -1) pendingOutputs.set(turn.turn, outputs);
        else outputsAt.set(reply, [...(outputsAt.get(reply) ?? []), ...outputs]);
      }
      const sources = turnSources(turn.toolCalls);
      if (sources.length > 0) {
        if (reply === -1) pendingSources = sources;
        else sourcesAt.set(reply, sources);
      }
    }
    return { tracesAt, outputsAt, pendingOutputs, sourcesAt, pendingSources };
  }, [messages, toolCalls, subagents]);
}
