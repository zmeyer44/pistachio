import { useMemo } from "react";
import type { AgentToolOutput, RunSummary } from "@pistachio/protocol";
import { turnSources, type CitedSource } from "../../lib/chat-sources";
import { traceTurns, turnOutputs, turnReplyIndex, type TraceTurn } from "../../lib/run";

/** Where each turn's trace, outputs and sources sit in the thread, by message index. */
export interface ThreadLayout {
  /** One trace per model turn, keyed by the message each sits under. */
  tracesAt: Map<number, TraceTurn[]>;
  /** What each turn made, under the reply that finished it. */
  outputsAt: Map<number, AgentToolOutput[]>;
  /** What a turn made while its reply is not written yet, by turn. */
  pendingOutputs: Map<number, AgentToolOutput[]>;
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
    const outputsAt = new Map<number, AgentToolOutput[]>();
    const pendingOutputs = new Map<number, AgentToolOutput[]>();
    const sourcesAt = new Map<number, CitedSource[]>();
    let pendingSources: CitedSource[] = [];
    for (const turn of traceTurns({ messages, toolCalls, subagents })) {
      const turns = tracesAt.get(turn.anchor);
      if (turns === undefined) tracesAt.set(turn.anchor, [turn]);
      else turns.push(turn);
      const reply = turnReplyIndex(messages, turn.turn);
      const outputs = turnOutputs(turn.toolCalls);
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
