/**
 * The daily brief, end to end: triage the mail, build the candidates, compose
 * the page and write the headline. Pure apart from the two injected models, and
 * it never throws — with no models at all it still returns a complete brief.
 */
import type { Experimental_EvaluationModel, LanguageModel } from "ai";
import type { Spec } from "@json-render/core";
import type { ReportBuiltWith } from "../contract.js";
import { validateReportSpec } from "../validate.js";
import { buildBriefDraft } from "./candidates.js";
import { composeBrief, defaultSpec, type ComposeOptions } from "./compose.js";
import { sortEvents, type BriefMaterials } from "./materials.js";
import { triageMail } from "./triage.js";
import { writeHeadline } from "./writer.js";

export interface GenerateBriefOptions {
  /** The evaluation model (Jev): triages mail and composes the page. */
  decide: { id: string; model: Experimental_EvaluationModel } | null;
  /** The language model: writes the headline, and nothing else. */
  write: { id: string; model: LanguageModel } | null;
  signal?: AbortSignal;
  evaluate?: ComposeOptions["evaluate"];
  onError?: (error: unknown) => void;
  now?: () => number;
}

export interface GeneratedBrief {
  title: string;
  spec: Spec;
  builtWith: ReportBuiltWith;
}

export async function generateBrief(given: BriefMaterials, options: GenerateBriefOptions): Promise<GeneratedBrief> {
  // One order for everyone downstream — the draft, and the headline writer's list of meetings.
  const materials: BriefMaterials = { ...given, events: sortEvents(given.events) };
  const clock = options.now ?? (() => performance.now());
  const started = clock();
  const signal = options.signal === undefined ? {} : { signal: options.signal };

  const triage = await triageMail(materials.messages, { model: options.decide?.model ?? null, ...signal });
  const draft = buildBriefDraft(materials, triage.verdicts);

  // The page and its one sentence do not depend on each other.
  const [composed, headline] = await Promise.all([
    composeBrief(draft, {
      model: options.decide?.model ?? null,
      ...signal,
      ...(options.evaluate === undefined ? {} : { evaluate: options.evaluate }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    }),
    writeHeadline(materials, triage.verdicts, { model: options.write?.model ?? null, ...signal }),
  ]);

  let spec = composed.spec;
  if (headline !== null) {
    spec = structuredClone(spec);
    const state = (spec.state ?? {}) as { text?: { headline?: string } };
    state.text = { ...state.text, headline };
    spec.state = state;
  }
  // Belt and braces: what leaves here has passed the same check the page runs.
  let composer = composed.composer;
  if (!validateReportSpec(spec).ok) {
    spec = defaultSpec(draft);
    composer = "default";
  }

  return {
    title: draft.title,
    spec,
    builtWith: {
      composer,
      composerModel: composer === "jev" ? (options.decide?.id ?? "scripted") : null,
      writer: headline === null ? null : (options.write?.id ?? null),
      triage: triage.by,
      evaluations: composed.evaluations + (triage.by === "jev" ? 1 : 0),
      elapsedMs: Math.max(0, Math.round(clock() - started)),
    },
  };
}
