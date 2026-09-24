/**
 * The model-backed half of the first-run walkthrough
 * (docs/web-browser-design.md §14): the two calls both hosts make, with the
 * models handed in rather than looked up, so a browser tab and a Mac run the
 * same code over the same `/v1/ai/*` proxy.
 *
 * What is pinned here is what the wizard depends on: transcription says
 * plainly when nothing can listen, falls back to a chat model that hears
 * audio, and never returns a stray empty string; extraction NEVER throws —
 * a dead model, a refusal, an answer with nothing in it all land on the
 * heuristic read the person is about to edit.
 */

import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, MockTranscriptionModelV4 } from "ai/test";
import {
  extractIntake,
  heuristicIntake,
  INTAKE_SCHEMA,
  intakePrompt,
  MAX_INTAKE_FACTS,
  NO_SPEECH_MODEL,
  sanitizeOnboardingIntake,
  transcribeIntroduction,
} from "../src/onboarding-intake.js";

/** What the mock's `doGenerate` must answer with, named so the literal below is checked against it. */
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

const AUDIO = new Uint8Array([1, 2, 3, 4]);
const INTRO = "Hi, my name is Ada Lovelace. I write compilers and I read about engines.";

function transcriber(text: string): MockTranscriptionModelV4 {
  return new MockTranscriptionModelV4({
    doGenerate: async () => ({
      text,
      segments: [],
      language: "en",
      durationInSeconds: 3,
      warnings: [],
      response: { timestamp: new Date(0), modelId: "test", headers: {} },
    }),
  });
}

function failingTranscriber(reason: string): MockTranscriptionModelV4 {
  return new MockTranscriptionModelV4({
    doGenerate: () => Promise.reject(new Error(reason)),
  });
}

/** A chat model that answers with one text part. */
function chatModel(answer: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: (): Promise<GenerateResult> =>
      Promise.resolve({
        content: [{ type: "text" as const, text: answer }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
  });
}

/** A chat model the gateway will not answer for. */
function brokenModel(reason: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doGenerate: () => Promise.reject(new Error(reason)) });
}

describe("transcribeIntroduction", () => {
  it("says voice is unavailable when nothing can listen", async () => {
    await expect(
      transcribeIntroduction({ model: null, audio: AUDIO, mediaType: "audio/webm" }),
    ).rejects.toThrow(NO_SPEECH_MODEL);
  });

  it("returns what the transcription endpoint heard", async () => {
    await expect(
      transcribeIntroduction({ model: transcriber(`  ${INTRO}  `), audio: AUDIO, mediaType: "audio/webm" }),
    ).resolves.toBe(INTRO);
  });

  it("falls back to a chat model that hears audio", async () => {
    const heard = await transcribeIntroduction({
      model: failingTranscriber("no transcription for this model"),
      fallbackModel: chatModel(INTRO),
      audio: AUDIO,
      mediaType: "audio/webm",
    });
    expect(heard).toBe(INTRO);
  });

  it("hands the recording to the chat model as a file part", async () => {
    const model = chatModel(INTRO);
    await transcribeIntroduction({ model: null, fallbackModel: model, audio: AUDIO, mediaType: "audio/mp4" });
    const parts = model.doGenerateCalls[0]?.prompt[0]?.content;
    expect(Array.isArray(parts) ? parts.map((part) => part.type) : []).toContain("file");
  });

  it("reports every failure in one sentence that offers typing instead", async () => {
    const error = await transcribeIntroduction({
      model: failingTranscriber("endpoint is off"),
      fallbackModel: brokenModel("gateway said no"),
      audio: AUDIO,
      mediaType: "audio/webm",
    }).then(
      () => new Error("the transcription should have failed"),
      (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
    );
    expect(error.message).toContain("endpoint is off");
    expect(error.message).toContain("Type your introduction instead.");
  });

  it("treats an empty transcript as a failure rather than an answer", async () => {
    await expect(
      transcribeIntroduction({ model: transcriber("   "), audio: AUDIO, mediaType: "audio/webm" }),
    ).rejects.toThrow(/the transcription came back empty/u);
  });
});

describe("extractIntake", () => {
  it("reads the name and bio off the text when no model can be reached", async () => {
    const intake = await extractIntake({ model: null, transcript: INTRO });
    expect(intake.name).toBe("Ada Lovelace");
    expect(intake.about).toContain("compilers");
    expect(intake.facts).toEqual([]);
  });

  it("keeps what the model said, dropping anything sensitive", async () => {
    const answer = {
      name: "Ada",
      about: "Writes compilers.",
      facts: [
        { content: "Lives in London", bucket: "location", kind: "static", label: "home" },
        { content: "Her password is hunter2", bucket: "other", kind: "static", label: null },
      ],
    };
    const intake = await extractIntake({
      model: chatModel(JSON.stringify(answer)),
      transcript: INTRO,
      now: new Date("2026-09-10T00:00:00.000Z"),
    });
    expect(intake.name).toBe("Ada");
    expect(intake.facts.map((fact) => fact.content)).toEqual(["Lives in London"]);
  });

  it("never throws: a model that fails leaves the heuristic read", async () => {
    const intake = await extractIntake({ model: brokenModel("gateway down"), transcript: INTRO });
    expect(intake.name).toBe("Ada Lovelace");
  });

  it("never throws: an answer with nothing in it leaves the heuristic read", async () => {
    const empty = JSON.stringify({ name: null, about: null, facts: [] });
    const intake = await extractIntake({ model: chatModel(empty), transcript: INTRO });
    expect(intake.name).toBe("Ada Lovelace");
    expect(intake.about).toContain("compilers");
  });

  it("asks nothing of a model when there is no transcript", async () => {
    const model = chatModel("{}");
    const intake = await extractIntake({ model, transcript: "   " });
    expect(intake).toEqual({ transcript: "", name: "", about: "", facts: [] });
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

describe("the intake shape", () => {
  it("is flat, so any provider's structured output can fill it", () => {
    const parsed = INTAKE_SCHEMA.parse({ name: null, about: null, facts: [] });
    expect(parsed.facts).toEqual([]);
    expect(INTAKE_SCHEMA.safeParse({ name: null, about: null }).success).toBe(false);
  });

  it("caps the facts one introduction may yield", () => {
    const facts = Array.from({ length: MAX_INTAKE_FACTS + 1 }, (_, at) => ({
      content: `fact ${String(at)}`,
      bucket: "other" as const,
      kind: "static" as const,
      label: null,
    }));
    expect(INTAKE_SCHEMA.safeParse({ name: null, about: null, facts }).success).toBe(false);
    expect(sanitizeOnboardingIntake({ transcript: INTRO, facts }).facts).toHaveLength(MAX_INTAKE_FACTS);
  });

  it("names the day in the prompt, so 'last week' means something", () => {
    expect(intakePrompt(INTRO, new Date("2026-09-10T12:00:00.000Z"))).toContain("Today is 2026-09-10.");
  });

  it("does not read a filler word as a name", () => {
    expect(heuristicIntake("I'm just getting started here.").name).toBe("");
  });
});
