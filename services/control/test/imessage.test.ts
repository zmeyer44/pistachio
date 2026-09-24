import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { AgentQuestion } from "@pistachio/protocol";
import { generateSpaceRootSecret, wrapRootSecretToDevice } from "@pistachio/sync-protocol";
import {
  formatIMessageCompletion,
  formatIMessageCredentialRequest,
  formatIMessageOnboarding,
  formatIMessageQuestion,
  normalizePhoneNumber,
  parseIMessageQuestionAnswer,
} from "../src/imessage.js";
import * as schema from "../src/db/schema.js";
import { authed, desktopAccount, enableCloud, fakeRunner, json, jsonInit, makeHarness, type Harness } from "./helpers.js";

const choiceQuestion: AgentQuestion = {
  id: "question-1",
  prompt: "**Which pack** should I buy?",
  description: "Choose one for the order.",
  choices: [
    { value: "small", label: "Small pack", description: "6 rolls" },
    { value: "large", label: "Large pack", description: "12 rolls" },
  ],
};

const textQuestion: AgentQuestion = {
  id: "question-2",
  prompt: "What ZIP code should I use?",
  description: "Enter it exactly.",
  choices: [],
  input: { type: "text", placeholder: "ZIP code" },
};

function webhookBody(deliveryId: string, text = "2", phone = "+12125550123"): Record<string, unknown> {
  return {
    type: "new-message",
    data: {
      guid: deliveryId,
      text,
      isFromMe: false,
      chats: [{ guid: `iMessage;-;${phone}` }],
      handle: { address: phone },
    },
  };
}

describe("iMessage plain-text boundary", () => {
  it("normalizes phones and deterministically renders and parses rich questions", () => {
    expect(normalizePhoneNumber("(212) 555-0123")).toBe("+12125550123");
    expect(normalizePhoneNumber("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhoneNumber("212-555-0123 ext 9")).toBeNull();
    expect(formatIMessageQuestion(choiceQuestion)).toBe(
      "Pistachio needs your input\n\nWhich pack should I buy?\n\nChoose one for the order.\n\n1. Small pack — 6 rolls\n2. Large pack — 12 rolls\n\nReply with a number, or in your own words.",
    );
    expect(parseIMessageQuestionAnswer(choiceQuestion, "2")).toEqual({ ok: true, value: "large" });
    expect(parseIMessageQuestionAnswer(choiceQuestion, "small PACK")).toEqual({ ok: true, value: "small" });
    expect(parseIMessageQuestionAnswer(choiceQuestion, "option 1.")).toEqual({ ok: true, value: "small" });
    // Anything that is not a number or an option name reaches the agent verbatim.
    expect(parseIMessageQuestionAnswer(choiceQuestion, "the big one, 12 rolls")).toEqual({ ok: true, value: "the big one, 12 rolls" });
    expect(parseIMessageQuestionAnswer(choiceQuestion, "7")).toEqual({ ok: true, value: "7" });
    expect(parseIMessageQuestionAnswer(choiceQuestion, "   ")).toEqual({ ok: false, reason: "empty" });

    expect(formatIMessageQuestion(textQuestion)).toContain("Reply with your answer.");
    expect(parseIMessageQuestionAnswer(textQuestion, " 10001 ")).toEqual({ ok: true, value: "10001" });
    expect(formatIMessageCompletion("## Done\n\n[Receipt](https://example.com/r)")).toBe(
      "Pistachio finished your task:\n\nDone\n\nReceipt (https://example.com/r)",
    );
    expect(formatIMessageOnboarding("https://pistachio.run/onboarding/imessage#secret")).toContain(
      "secure link expires in 30 minutes and works once",
    );
    expect(formatIMessageCredentialRequest({
      siteOrigin: "https://checkout.example",
      fieldLabels: ["Card number", "**Security code**"],
      captureUrl: "https://pistachio.run/credential-capture/abc",
      expiresAt: "2026-09-04T18:30:00.000Z",
    })).toBe(
      "Pistachio needs secure information for:\n\nhttps://checkout.example\n\nRequested fields: Card number, Security code\n\nOpen the secure form:\nhttps://pistachio.run/credential-capture/abc\n\nDo not reply with sensitive information. This link expires at 2026-09-04T18:30:00.000Z.",
    );
  });

  it("spends the OTP attempt budget atomically, so parallel guesses cannot multiply it", async () => {
    const messages: string[] = [];
    const h = await makeHarness({
      imessage: {
        serverUrl: "http://bluebubbles.test",
        password: "bb-password",
        webhookSecret: "webhook-secret",
        otpSecret: "otp-secret-for-tests",
        fetch: async (_input, init) => {
          messages.push(String((JSON.parse(String(init?.body ?? "{}")) as { message?: unknown }).message ?? ""));
          return new Response('{"status":200}', { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    });
    const account = await desktopAccount(h);
    const start = async (): Promise<{ challengeId: string; code: string }> => {
      const started = await h.request("/v1/imessage/link/start", jsonInit("POST", { phone: "(212) 555-0123" }, account.token));
      expect(started.status).toBe(202);
      const { challengeId } = await json<{ challengeId: string }>(started);
      const code = /\b(\d{6})\b/u.exec(messages.at(-1) ?? "")?.[1] ?? "";
      expect(code).toMatch(/^\d{6}$/u);
      return { challengeId, code };
    };
    const verify = (challengeId: string, code: string): Promise<Response> =>
      h.request("/v1/imessage/link/verify", jsonInit("POST", { challengeId, code }, account.token));

    const first = await start();
    // Ten simultaneous wrong guesses against a five-attempt budget.
    const guesses = await Promise.all(Array.from({ length: 10 }, (_, i) => verify(first.challengeId, String(100000 + i))));
    expect(guesses.map((r) => r.status)).toEqual(Array<number>(10).fill(403));
    expect(await h.db.select().from(schema.imessageChallenges)).toHaveLength(0);
    // The right code no longer helps: the budget is spent.
    expect((await verify(first.challengeId, first.code)).status).toBe(403);

    // A fresh challenge still verifies normally.
    const second = await start();
    expect((await verify(second.challengeId, second.code)).status).toBe(200);
  });

  it("links a phone with an OTP, sends a question, and turns its reply into cmd.answer", async () => {
    const sent: Array<{ path: string; password: string | null; body: Record<string, unknown> }> = [];
    const h = await makeHarness({
      imessage: {
        serverUrl: "http://bluebubbles.test/base/",
        password: "bb-password",
        webhookSecret: "webhook-secret",
        otpSecret: "otp-secret-for-tests",
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          sent.push({
            path: url.pathname,
            password: url.searchParams.get("password"),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
          });
          return new Response('{"status":200}', { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    });
    const account = await desktopAccount(h);

    const initial = await json(await h.request("/v1/imessage/link", authed(account.token)));
    expect(initial).toEqual({ available: true, linked: false, phone: null, verifiedAt: null });

    expect(
      (
        await h.request(
          "/v1/imessage/webhook?secret=webhook-secret",
          jsonInit("POST", webhookBody("unlinked-message", "hello", "+14155550100")),
        )
      ).status,
    ).toBe(202);
    expect(await h.db.select().from(schema.imessageInboundMessages)).toHaveLength(0);
    const [invitation] = await h.db.select().from(schema.imessageOnboardingLinks);
    expect(invitation?.phoneE164).toBe("+14155550100");
    const onboardingMessage = String(sent[0]?.body["message"] ?? "");
    const onboardingToken = /\/onboarding\/imessage#([A-Za-z0-9_-]{43})/u.exec(onboardingMessage)?.[1];
    expect(onboardingToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(invitation?.secretHash).toBe(createHash("sha256").update(onboardingToken ?? "").digest("hex"));
    expect(invitation?.secretHash).not.toContain(onboardingToken);
    expect((await h.request(`/v1/imessage/onboarding/${onboardingToken ?? "bad"}`)).status).toBe(200);
    const claimed = await h.request(
      `/v1/imessage/onboarding/${onboardingToken ?? "bad"}/claim`,
      authed(account.token, "POST"),
    );
    expect(claimed.status).toBe(200);
    expect(await json(claimed)).toMatchObject({ linked: true, phone: "••• ••• 0100" });
    expect(
      (
        await h.request(
          `/v1/imessage/onboarding/${onboardingToken ?? "bad"}/claim`,
          authed(account.token, "POST"),
        )
      ).status,
    ).toBe(410);

    const started = await h.request(
      "/v1/imessage/link/start",
      jsonInit("POST", { phone: "(212) 555-0123" }, account.token),
    );
    expect(started.status).toBe(202);
    const challenge = await json<{ challengeId: string; phone: string }>(started);
    expect(challenge.phone).toBe("••• ••• 0123");
    const otpMessage = String(sent[1]?.body["message"] ?? "");
    const code = /\b(\d{6})\b/u.exec(otpMessage)?.[1];
    expect(code).toMatch(/^\d{6}$/u);
    const [storedChallenge] = await h.db.select().from(schema.imessageChallenges);
    expect(storedChallenge?.codeHash).not.toContain(code);

    expect(
      (
        await h.request(
          "/v1/imessage/link/verify",
          jsonInit("POST", { challengeId: challenge.challengeId, code: "999999" }, account.token),
        )
      ).status,
    ).toBe(403);
    const verified = await h.request(
      "/v1/imessage/link/verify",
      jsonInit("POST", { challengeId: challenge.challengeId, code }, account.token),
    );
    expect(verified.status).toBe(200);
    expect(await json(verified)).toMatchObject({ available: true, linked: true, phone: "••• ••• 0123" });

    const runId = randomUUID();
    const taskId = randomUUID();
    const startedAt = new Date().toISOString();
    expect(
      (
        await h.request(
          "/v1/runs/desktop",
          jsonInit("POST", { runId, taskId, spaceId: "work", intent: "Buy paper towels", startedAt }, account.token),
        )
      ).status,
    ).toBe(201);
    const delivered = await h.request(
      `/v1/runs/${runId}/imessage`,
      jsonInit("POST", { kind: "question", question: choiceQuestion }, account.token),
    );
    expect(delivered.status).toBe(202);
    expect(sent[2]).toMatchObject({
      path: "/base/api/v1/message/text",
      password: "bb-password",
      body: { chatGuid: "iMessage;-;+12125550123", method: "private-api" },
    });
    expect(String(sent[2]?.body["message"])).toContain("2. Large pack");

    const webhook = (deliveryId: string) =>
      h.request(
        "/v1/imessage/webhook?secret=webhook-secret",
        jsonInit("POST", webhookBody(deliveryId)),
      );
    expect((await webhook("message-guid-1")).status).toBe(202);
    expect((await webhook("message-guid-1")).status).toBe(202);
    await h.control.idle();
    const answers = await h.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId));
    expect(answers.filter((row) => (row.event as { t?: string }).t === "cmd.answer")).toHaveLength(1);
    expect(answers.find((row) => (row.event as { t?: string }).t === "cmd.answer")?.event).toEqual({
      t: "cmd.answer",
      questionId: choiceQuestion.id,
      value: "large",
    });
    expect(
      await h.db
        .select()
        .from(schema.imessagePendingQuestions)
        .where(and(eq(schema.imessagePendingQuestions.runId, runId), eq(schema.imessagePendingQuestions.questionId, choiceQuestion.id))),
    ).toHaveLength(0);
    expect(String(sent.at(-1)?.body["message"])).toBe("Got it.");
    const answerAudit = (await h.db.select().from(schema.auditEvents)).find((row) => row.kind === "run.answer");
    expect(answerAudit?.detail).toMatchObject({ via: "imessage", questionId: choiceQuestion.id });

    expect(
      (
        await h.request(
          `/v1/runs/${runId}/imessage`,
          jsonInit("POST", { kind: "question", question: choiceQuestion }, account.token),
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await h.request(
          `/v1/runs/${runId}/imessage`,
          jsonInit("POST", { kind: "resolved", questionId: choiceQuestion.id }, account.token),
        )
      ).status,
    ).toBe(202);
    expect(await h.db.select().from(schema.imessagePendingQuestions)).toHaveLength(0);
    expect((await webhook("message-guid-no-question")).status).toBe(202);
    await h.control.idle();
    expect(String(sent.at(-1)?.body["message"])).toContain("cloud browser still needs to be turned on");
  });

  it("keeps retryable answers pending, closes terminal questions, and expires abandoned rows", async () => {
    const sent: string[] = [];
    const h = await makeHarness({
      imessage: {
        serverUrl: "http://bluebubbles.test",
        password: "password",
        webhookSecret: "webhook-secret",
        otpSecret: "otp-secret-for-tests",
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { message?: unknown };
          sent.push(String(body.message ?? ""));
          return new Response(null, { status: 200 });
        },
      },
    });
    const account = await desktopAccount(h);
    await h.db.insert(schema.imessageLinks).values({
      userId: account.userId,
      phoneE164: "+12125550123",
      verifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const createRun = async (question: AgentQuestion = choiceQuestion): Promise<string> => {
      const runId = randomUUID();
      const response = await h.request(
        "/v1/runs/desktop",
        jsonInit("POST", {
          runId,
          taskId: randomUUID(),
          spaceId: "work",
          intent: "Buy paper towels",
          startedAt: new Date().toISOString(),
        }, account.token),
      );
      expect(response.status).toBe(201);
      expect(
        (
          await h.request(
            `/v1/runs/${runId}/imessage`,
            jsonInit("POST", { kind: "question", question }, account.token),
          )
        ).status,
      ).toBe(202);
      return runId;
    };
    const webhook = (deliveryId: string, text = "2") =>
      h.request(
        "/v1/imessage/webhook?secret=webhook-secret",
        jsonInit("POST", webhookBody(deliveryId, text)),
      );

    const oversizedAnswerRunId = await createRun(textQuestion);
    expect((await webhook("oversized-answer", "x".repeat(16_385))).status).toBe(202);
    await h.control.idle();
    expect(
      await h.db
        .select()
        .from(schema.imessagePendingQuestions)
        .where(eq(schema.imessagePendingQuestions.runId, oversizedAnswerRunId)),
    ).toHaveLength(1);
    expect(sent.at(-1)).toContain("non-empty answer under 16,384 characters");
    await h.db
      .delete(schema.imessagePendingQuestions)
      .where(eq(schema.imessagePendingQuestions.runId, oversizedAnswerRunId));

    const retryRunId = await createRun();
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    await h.db
      .update(schema.hostedRuns)
      .set({
        status: "waiting_for_judgment",
        pause: {
          id: "expired-pause",
          kind: "judgment",
          requestedAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: expiredAt,
          capability: null,
          payload: { questionId: choiceQuestion.id },
        },
      })
      .where(eq(schema.hostedRuns.id, retryRunId));
    expect((await webhook("retryable-answer")).status).toBe(202);
    await h.control.idle();
    expect(
      await h.db.select().from(schema.imessagePendingQuestions).where(eq(schema.imessagePendingQuestions.runId, retryRunId)),
    ).toHaveLength(1);
    expect(sent.at(-1)).toContain("couldn't apply that answer yet");

    const terminalRunId = await createRun();
    await h.db
      .update(schema.hostedRuns)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(schema.hostedRuns.id, terminalRunId));
    expect((await webhook("terminal-answer")).status).toBe(202);
    await h.control.idle();
    expect(
      await h.db.select().from(schema.imessagePendingQuestions).where(eq(schema.imessagePendingQuestions.runId, terminalRunId)),
    ).toHaveLength(0);
    // The question died with its run, so the text is a task now; this
    // account has no cloud device, so it is told to set one up.
    expect(sent.at(-1)).toContain("Your number is connected");

    await h.db
      .update(schema.imessagePendingQuestions)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(schema.imessagePendingQuestions.runId, retryRunId));
    await h.control.runMaintenance(Date.now());
    expect(
      await h.db.select().from(schema.imessagePendingQuestions).where(eq(schema.imessagePendingQuestions.runId, retryRunId)),
    ).toHaveLength(0);
  });

  it("routes linked-number follow-ups to the current thread and isolates new or unrouteable work", async () => {
    const sent: string[] = [];
    let h: Harness;
    const runner = await fakeRunner((path, init) => h.request(path, init));
    try {
      h = await makeHarness({
        runner: runner.client,
        imessage: {
          serverUrl: "http://bluebubbles.test",
          password: "password",
          webhookSecret: "webhook-secret",
          otpSecret: "otp-secret-for-tests",
          fetch: async (_input, init) => {
            const payload = JSON.parse(String(init?.body ?? "{}")) as { message?: unknown };
            sent.push(String(payload.message ?? ""));
            return new Response(null, { status: 200 });
          },
        },
      });
      const account = await desktopAccount(h);
      await h.db.insert(schema.imessageLinks).values({
        userId: account.userId,
        phoneE164: "+12125550123",
        verifiedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const cloud = await enableCloud(h, account.token);
      const cloudId = String(cloud["id"]);
      const cloudKeys = runner.identities.get(account.userId);
      if (cloudKeys === undefined) throw new Error("cloud identity missing");
      const wrapper = await wrapRootSecretToDevice(
        generateSpaceRootSecret(),
        "work",
        { deviceId: cloudId, agreementPublicKeyRaw: cloudKeys.agreementPublicKeyRaw },
        { deviceId: account.deviceId, signingKey: account.keys.signing.privateKey },
      );
      expect(
        (
          await h.request(
            "/v1/spaces/work/wrappers",
            jsonInit("PUT", {
              wrappers: [{
                kind: wrapper.kind,
                credentialId: wrapper.credentialId,
                salt: wrapper.salt,
                wrapped: wrapper.wrapped,
                senderDeviceId: wrapper.senderDeviceId,
                signature: wrapper.signature,
              }],
            }, account.token),
          )
        ).status,
      ).toBe(200);

      for (const [deliveryId, text] of [
        ["empty-task-from-imessage", ""],
        ["oversized-task-from-imessage", "x".repeat(16_385)],
      ] as const) {
        expect(
          (
            await h.request(
              "/v1/imessage/webhook?secret=webhook-secret",
              jsonInit("POST", webhookBody(deliveryId, text)),
            )
          ).status,
        ).toBe(202);
      }
      await h.control.idle();
      expect(await h.db.select().from(schema.hostedRuns).where(eq(schema.hostedRuns.userId, account.userId))).toHaveLength(0);
      expect(sent).toEqual([
        "Please send a non-empty task under 16,384 characters.",
        "Please send a non-empty task under 16,384 characters.",
      ]);
      sent.length = 0;

      const task = webhookBody("task-from-imessage", "Find a dinner reservation for Friday");
      expect(
        (
          await h.request(
            "/v1/imessage/webhook?secret=webhook-secret",
            jsonInit("POST", task),
          )
        ).status,
      ).toBe(202);
      expect(
        (
          await h.request(
            "/v1/imessage/webhook?secret=webhook-secret",
            jsonInit("POST", task),
          )
        ).status,
      ).toBe(202);
      await h.control.idle();

      const runs = await h.db.select().from(schema.hostedRuns).where(eq(schema.hostedRuns.userId, account.userId));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        spaceId: "work",
        intent: "Find a dinner reservation for Friday",
        origin: null,
      });
      expect(sent).toEqual([expect.stringContaining("I started a Pistachio task")]);

      runner.routeDecision = { decision: "continue", confidence: 0.96 };
      const followup = webhookBody("follow-up-from-imessage", "Make it outdoor seating");
      expect(
        (
          await h.request(
            "/v1/imessage/webhook?secret=webhook-secret",
            jsonInit("POST", followup),
          )
        ).status,
      ).toBe(202);
      expect(
        (
          await h.request(
            "/v1/imessage/webhook?secret=webhook-secret",
            jsonInit("POST", followup),
          )
        ).status,
      ).toBe(202);
      await h.control.idle();
      expect(await h.db.select().from(schema.hostedRuns).where(eq(schema.hostedRuns.userId, account.userId))).toHaveLength(1);
      const commands = (await h.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runs[0]?.id ?? "")))
        .filter((row) => (row.event as { t?: string }).t === "cmd.message");
      expect(commands).toHaveLength(1);
      expect(commands[0]?.event).toMatchObject({ t: "cmd.message", text: "Make it outdoor seating" });
      expect(runner.routes).toHaveLength(1);
      expect(runner.routes[0]).toMatchObject({
        candidate: {
          runId: runs[0]?.id,
          intent: "Find a dinner reservation for Friday",
          lastIMessageAt: expect.any(String),
        },
        incoming: { text: "Make it outdoor seating", receivedAt: expect.any(String) },
      });
      expect(sent.at(-1)).toContain("added that to your current Pistachio task");

      runner.routeDecision = { decision: "new", confidence: 0.91 };
      expect(
        (
          await h.request(
            "/v1/imessage/webhook?secret=webhook-secret",
            jsonInit("POST", webhookBody("new-topic-from-imessage", "Order more printer paper")),
          )
        ).status,
      ).toBe(202);
      expect(await h.db.select().from(schema.hostedRuns).where(eq(schema.hostedRuns.userId, account.userId))).toHaveLength(2);

      runner.failRoute = true;
      expect(
        (
          await h.request(
            "/v1/imessage/webhook?secret=webhook-secret",
            jsonInit("POST", webhookBody("router-down-from-imessage", "Schedule a dentist appointment")),
          )
        ).status,
      ).toBe(202);
      expect(await h.db.select().from(schema.hostedRuns).where(eq(schema.hostedRuns.userId, account.userId))).toHaveLength(3);
      expect(h.logs.some((line) => line.includes("iMessage thread routing failed"))).toBe(true);

      // A follow-up to an older thread finds it: every recent thread this
      // phone addressed is classified, not only the newest.
      runner.failRoute = false;
      runner.routes.length = 0;
      runner.routeDecision = (input) =>
        input.candidate.intent.includes("dinner")
          ? { decision: "continue", confidence: 0.93 }
          : { decision: "new", confidence: 0.88 };
      expect(
        (
          await h.request(
            "/v1/imessage/webhook?secret=webhook-secret",
            jsonInit("POST", webhookBody("older-thread-from-imessage", "Actually make the dinner for six people")),
          )
        ).status,
      ).toBe(202);
      await h.control.idle();
      expect(runner.routes.map((route) => route.candidate.intent).sort()).toEqual([
        "Find a dinner reservation for Friday",
        "Order more printer paper",
        "Schedule a dentist appointment",
      ]);
      expect(await h.db.select().from(schema.hostedRuns).where(eq(schema.hostedRuns.userId, account.userId))).toHaveLength(3);
      const dinnerCommands = (await h.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runs[0]?.id ?? "")))
        .filter((row) => (row.event as { t?: string }).t === "cmd.message")
        .map((row) => (row.event as { text: string }).text);
      expect(dinnerCommands).toEqual(["Make it outdoor seating", "Actually make the dinner for six people"]);

      // A revoked run is the person's decision to end it: a text never
      // restores its authority, however confidently the router matches it.
      expect(
        (await h.request(`/v1/runs/${runs[0]?.id ?? ""}/revoke`, jsonInit("POST", {}, account.token))).status,
      ).toBe(202);
      runner.routes.length = 0;
      runner.routeDecision = { decision: "continue", confidence: 0.99 };
      expect(
        (
          await h.request(
            "/v1/imessage/webhook?secret=webhook-secret",
            jsonInit("POST", webhookBody("after-revoke-from-imessage", "Change the dinner to Saturday")),
          )
        ).status,
      ).toBe(202);
      await h.control.idle();
      expect(runner.routes.map((route) => route.candidate.runId)).not.toContain(runs[0]?.id);
      expect(runner.routes.length).toBeGreaterThan(0);
      const [revoked] = await h.db.select().from(schema.hostedRuns).where(eq(schema.hostedRuns.id, runs[0]?.id ?? ""));
      expect(revoked?.status).toBe("revoked");
    } finally {
      await runner.close();
    }
  });
});
