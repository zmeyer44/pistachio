import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { IMessageThreadRouteRequest } from "@pistachio/protocol";
import { sealRunEvent } from "../src/runs/events.js";
import { IMessageThreadRouter, routingHistory } from "../src/runs/imessage-router.js";
import { answer, scriptedModel } from "../src/testing/scripted-model.js";
import { USER_A, testSpaceKeys } from "./helpers/keys.js";

async function request(): Promise<{ input: IMessageThreadRouteRequest; sealKey: CryptoKey }> {
  const runId = randomUUID();
  const keys = await testSpaceKeys("work");
  const firstId = randomUUID();
  const secondId = randomUUID();
  const input: IMessageThreadRouteRequest = {
    candidate: {
      runId,
      userId: USER_A,
      spaceId: "work",
      intent: "Book dinner at Lilia",
      status: "completed",
      createdAt: "2026-09-04T17:00:00.000Z",
      updatedAt: "2026-09-04T17:03:00.000Z",
      completedAt: "2026-09-04T17:03:00.000Z",
      lastIMessageAt: "2026-09-04T17:00:00.000Z",
    },
    incoming: {
      text: "Actually, make it 7:30",
      receivedAt: "2026-09-04T17:05:00.000Z",
    },
    events: [
      {
        eventId: "command-1",
        at: "2026-09-04T17:00:00.000Z",
        event: { t: "cmd.message", text: "Book dinner at Lilia" },
      },
      {
        eventId: firstId,
        at: "2026-09-04T17:00:01.000Z",
        event: await sealRunEvent(keys.sealKey, runId, "work", firstId, {
          t: "message",
          message: {
            id: "message-1",
            at: "2026-09-04T17:00:01.000Z",
            role: "user",
            content: "Book dinner at Lilia",
          },
        }),
      },
      {
        eventId: secondId,
        at: "2026-09-04T17:03:00.000Z",
        event: await sealRunEvent(keys.sealKey, runId, "work", secondId, {
          t: "message",
          message: {
            id: "message-2",
            at: "2026-09-04T17:03:00.000Z",
            role: "assistant",
            content: "I found an opening at 7 pm.",
          },
        }),
      },
    ],
  };
  return { input, sealKey: keys.sealKey };
}

describe("iMessage thread router", () => {
  it("opens timestamped conversation messages and removes processed command duplicates", async () => {
    const { input, sealKey } = await request();
    expect(await routingHistory(sealKey, input)).toEqual([
      {
        at: "2026-09-04T17:00:01.000Z",
        role: "user",
        content: "Book dinner at Lilia",
      },
      {
        at: "2026-09-04T17:03:00.000Z",
        role: "assistant",
        content: "I found an opening at 7 pm.",
      },
    ]);
  });

  it("keeps control's append order so a runner clock behind control still pairs the duplicate", async () => {
    const { input, sealKey } = await request();
    const [command, sealedCopy, reply] = input.events;
    if (command === undefined || sealedCopy === undefined || reply === undefined) throw new Error("fixture");
    // The runner stamped its sealed copy with a clock 2 s behind control.
    const keys = await testSpaceKeys("work");
    const skewed = await sealRunEvent(keys.sealKey, input.candidate.runId, "work", sealedCopy.eventId, {
      t: "message",
      message: { id: "message-1", at: "2026-09-04T16:59:58.000Z", role: "user", content: "Book dinner at Lilia" },
    });
    const history = await routingHistory(sealKey, {
      ...input,
      events: [command, { ...sealedCopy, event: skewed }, reply],
    });
    expect(history.map((item) => [item.role, item.content])).toEqual([
      ["user", "Book dinner at Lilia"],
      ["assistant", "I found an opening at 7 pm."],
    ]);
  });

  it("stops before the model call when control has already given up", async () => {
    const { input, sealKey } = await request();
    const modelFactory = vi.fn(() => ({
      model: scriptedModel([answer('{"decision":"continue","confidence":1,"reason":"same"}')]) as unknown as LanguageModel,
      modelName: "router-test",
    }));
    const router = new IMessageThreadRouter({ modelFactory, spaceKeyFor: async () => sealKey });
    await expect(router.route(input, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(modelFactory).not.toHaveBeenCalled();
  });

  it("uses structured model output and rejects low-confidence continuation", async () => {
    const { input, sealKey } = await request();
    const route = async (decision: "continue" | "new", confidence: number) => {
      const model = scriptedModel([
        answer(JSON.stringify({ decision, confidence, reason: "The requested time modifies the reservation." })),
      ]);
      const router = new IMessageThreadRouter({
        modelFactory: () => ({ model: model as unknown as LanguageModel, modelName: "router-test" }),
        spaceKeyFor: async () => sealKey,
      });
      return router.route(input);
    };
    await expect(route("continue", 0.95)).resolves.toEqual({ decision: "continue", confidence: 0.95 });
    await expect(route("continue", 0.4)).resolves.toEqual({ decision: "new", confidence: 0.4 });
    await expect(route("new", 0.9)).resolves.toEqual({ decision: "new", confidence: 0.9 });
  });

  it("fails closed when history cannot be opened with the candidate Space key", async () => {
    const { input } = await request();
    const wrong = await testSpaceKeys("work", 0x99);
    const router = new IMessageThreadRouter({
      modelFactory: () => ({
        model: scriptedModel([answer('{"decision":"continue","confidence":1,"reason":"same"}')]) as unknown as LanguageModel,
        modelName: "router-test",
      }),
      spaceKeyFor: async () => wrong.sealKey,
    });
    await expect(router.route(input)).rejects.toThrow();
  });
});
