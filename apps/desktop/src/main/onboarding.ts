/**
 * The model-backed half of onboarding, on a Mac: turning a spoken
 * introduction into text, and text into the name, bio, and facts that seed
 * the agent's memory (@pistachio/shell-contracts/onboarding).
 *
 * The logic itself is `@pistachio/agent-runtime/onboarding`, because the web
 * app runs the same two calls over its own device token
 * (docs/web-browser-design.md §14) and neither host should own a copy. What
 * is left here is what only this process knows: which models this Mac can
 * reach (model-provider.ts), the workspace `.env`, and that under Playwright
 * there is deliberately nothing to reach at all.
 *
 * Both are best-effort in the way memory's learner is. Transcription needs a
 * model — the transcription endpoint first, then any chat model that hears
 * audio — and says so plainly when there is none (this Mac is not signed
 * in), so the wizard can offer typing. Extraction falls back to a heuristic
 * read of the text (`heuristicIntake`) when no model answers; the person
 * edits the result before anything is written, whichever produced it.
 */

import type { LanguageModel } from "ai";
import {
  extractIntake as readIntroduction,
  NO_SPEECH_MODEL,
  transcribeIntroduction as runTranscription,
} from "@pistachio/agent-runtime/onboarding";
import { heuristicIntake, type OnboardingIntake } from "@pistachio/shell-contracts/onboarding";
import { aiAvailable, configuredModel, configuredTranscriptionModel, loadWorkspaceEnvironment } from "./model-provider";

export { transcriptionModelName } from "./model-provider";
export { NO_SPEECH_MODEL };

/** Offline under Playwright unless a live agent was asked for, like the embedder and read-aloud. */
function offline(env: NodeJS.ProcessEnv): boolean {
  return env["PISTACHIO_E2E"] === "1" && env["PISTACHIO_AGENT_LIVE"] !== "1";
}

/**
 * Speech to text. Rejects with NO_SPEECH_MODEL when nothing can listen, and
 * with what went wrong otherwise — both readable enough to show.
 */
export async function transcribeIntroduction(
  audio: Uint8Array,
  mediaType: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (offline(env)) throw new Error(NO_SPEECH_MODEL);
  loadWorkspaceEnvironment();
  if (!aiAvailable()) throw new Error(NO_SPEECH_MODEL);
  return runTranscription({
    model: configuredTranscriptionModel(),
    // A chat model that takes audio, for when the transcription endpoint is
    // unavailable for the chosen model.
    fallbackModel: configuredModel(),
    audio,
    mediaType,
  });
}

/**
 * Name, bio, and facts from an introduction. A model when one is
 * configured; the heuristic otherwise, or when the model fails or returns
 * nothing usable. Never throws.
 */
export async function extractIntake(
  transcript: string,
  options: { model?: LanguageModel; env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<OnboardingIntake> {
  const env = options.env ?? process.env;
  if (offline(env)) return heuristicIntake(transcript);
  let model: LanguageModel | null = options.model ?? null;
  if (model === null) {
    try {
      loadWorkspaceEnvironment();
      model = configuredModel();
    } catch {
      // Not signed in: the heuristic read is what prefills the fields.
      return heuristicIntake(transcript);
    }
  }
  return readIntroduction({ model, transcript, ...(options.now === undefined ? {} : { now: options.now }) });
}
