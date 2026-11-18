/**
 * A conversation's history, made fit to continue on another model source
 * (docs/ai-plans.md §3, "A thread that changes hands").
 *
 * A thread can be taken up on the person's plan after turns on Pistachio's
 * models, and the other way about — a limit reached, a switch in Settings.
 * Two things in the history belong to the route that wrote them and to no
 * other: **reasoning**, which travels sealed for that route alone, and the
 * **item ids** the provider library keeps on what the model wrote (in
 * `providerOptions`), which the other route never issued. Sent across, the
 * first cannot be opened and the second names nothing; either fails the
 * request. What was said, what was called and what came back all stay.
 *
 * Applied once, at the turn where the source changes; a thread that stays
 * on one source is never touched.
 */

import type { ModelMessage } from "ai";

/** The source of every turn before a plan could be connected, and of any thread that does not say. */
export const PISTACHIO_MODELS = "pistachio";

export function portableHistory(messages: readonly ModelMessage[]): ModelMessage[] {
  const portable: ModelMessage[] = [];
  for (const message of messages) {
    // What the person and the system wrote is no route's: left exactly as it is.
    if (message.role !== "assistant" && message.role !== "tool") {
      portable.push(message);
      continue;
    }
    const { providerOptions: _route, ...rest } = message;
    if (typeof rest.content === "string") {
      portable.push(rest as ModelMessage);
      continue;
    }
    const parts = (rest.content as Array<{ type: string; providerOptions?: unknown; providerMetadata?: unknown }>)
      .filter((part) => part.type !== "reasoning")
      .map(({ providerOptions: _options, providerMetadata: _metadata, ...part }) => part);
    // A message that was only thought has nothing left to say.
    if (parts.length === 0) continue;
    portable.push({ ...rest, content: parts } as ModelMessage);
  }
  return portable;
}
