/**
 * What a run controller binds for each connected integration, and how an
 * integration's tools land in the run's trace. Shared by every provider's
 * tool family so a Gmail call is as visible as a click.
 */

import type { ToolSet } from "ai";
import type { IntegrationAccess, IntegrationProvider, IntegrationToolRequest } from "@pistachio/protocol";
import type { AiAgentRunCallbacks } from "../runner.js";
import type { FetchLike } from "./oauth.js";

/**
 * The agent's window onto one connected account. The host mints access
 * tokens from the sealed grant — the token reaches the provider's API and
 * nothing else — and says how much the person allowed. Everything the
 * model sees about the connection is `accountLabel` and `access`.
 */
export interface IntegrationToolHost {
  provider: IntegrationProvider;
  /** The account the grant is for, as the person would name it: the Gmail address. */
  accountLabel: string;
  access: IntegrationAccess;
  /** A live access token; `fresh` asks for one minted anew after the API refused the last. */
  accessToken(options?: { fresh?: boolean }): Promise<string>;
  /** A call succeeded; the host may stamp the connection's last use. */
  used?(): void;
}

export interface IntegrationToolDeps {
  fetch?: FetchLike;
  now?: () => Date;
}

/** A provider's tool family: what the catalog entry does not say because it is code. */
export interface IntegrationDefinition {
  id: IntegrationProvider;
  /** Every model-facing tool name the family can register, for the tool-group registry. */
  toolNames: readonly string[];
  /** The tools an access level unlocks, cumulative. */
  toolNamesFor(access: IntegrationAccess): readonly string[];
  /** The prompt rules for a connected host, ending without a trailing newline. */
  rules(host: IntegrationToolHost): string;
  tools(host: IntegrationToolHost, callbacks: AiAgentRunCallbacks, deps: IntegrationToolDeps): ToolSet;
  /** The account a fresh grant is for, read from the provider with the access token. */
  accountLabel(accessToken: string, fetchImpl: FetchLike): Promise<string>;
}

/**
 * Run one integration call through the trace, shaped like the memory and
 * bookmark families: `toolStarted` before, `toolCompleted` or `toolFailed`
 * after, and a failure returned to the model as words rather than thrown
 * out of the run.
 */
export async function traced<T>(
  callbacks: AiAgentRunCallbacks,
  request: IntegrationToolRequest,
  label: string,
  detail: string,
  work: () => Promise<T>,
  summary: (value: T) => string,
  used?: () => void,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const toolId = callbacks.toolStarted(request, label, detail);
  callbacks.changed();
  try {
    const value = await work();
    callbacks.toolCompleted(toolId, { summary: summary(value), data: value });
    callbacks.changed();
    used?.();
    return { ok: true, result: value };
  } catch (error: unknown) {
    callbacks.toolFailed(toolId, error);
    callbacks.changed();
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
