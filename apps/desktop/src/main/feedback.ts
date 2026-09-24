/**
 * The console's feedback popover, main's half: turn what the person typed
 * into a report that carries the conversation they were looking at, and
 * post it to `${PISTACHIO_API_URL}/feedback` (apps/www in development).
 *
 * Everything but the send is pure and tested; the send takes its fetch so
 * the tests can stand in for the service.
 */

import { randomUUID } from "node:crypto";
import { sanitizeFeedbackInput, type FeedbackInput, type FeedbackReport } from "@pistachio/protocol";
import type { FeedbackOutcome } from "@pistachio/shell-contracts/ipc";
import { loadWorkspaceEnvironment, modelName } from "./model-provider";

export const FEEDBACK_TIMEOUT_MS = 10_000;

/** What main knows about the moment the person hit Send. */
export interface FeedbackContext {
  app: Omit<FeedbackReport["app"], "model">;
  browser: FeedbackReport["browser"];
  run: FeedbackReport["run"];
}

/** `${PISTACHIO_API_URL}/feedback`, or null when there is nowhere to send. */
export function feedbackEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env["PISTACHIO_API_URL"]?.trim() ?? "";
  if (base === "") return null;
  try {
    return new URL(`${base.replace(/\/+$/, "")}/feedback`).href;
  } catch {
    return null;
  }
}

export function buildFeedbackReport(
  input: FeedbackInput,
  context: FeedbackContext,
  model: string,
  now: Date = new Date(),
  id: string = randomUUID(),
): FeedbackReport {
  return {
    version: 1,
    id,
    sentAt: now.toISOString(),
    message: input.message,
    reaction: input.reaction,
    app: { ...context.app, model },
    browser: context.browser,
    run: context.run,
  };
}

export async function postFeedback(
  report: FeedbackReport,
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedbackOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Couldn't reach ${endpoint}: ${reason}` };
  }
  if (!response.ok) return { ok: false, error: `${endpoint} answered ${String(response.status)}.` };
  return { ok: true };
}

/** The IPC handler's whole job: check the input, find the endpoint, send. */
export async function submitFeedback(
  value: unknown,
  context: FeedbackContext,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedbackOutcome> {
  const input = sanitizeFeedbackInput(value);
  if (input === null) return { ok: false, error: "Write a few words first." };
  loadWorkspaceEnvironment();
  const endpoint = feedbackEndpoint(env);
  if (endpoint === null) return { ok: false, error: "Set PISTACHIO_API_URL to the API that receives feedback." };
  return postFeedback(buildFeedbackReport(input, context, modelName()), endpoint, fetchImpl);
}
