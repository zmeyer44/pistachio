/**
 * The person's own AI plan in the shell (docs/ai-plans.md §5), pure: what a
 * change of state is worth saying and what its button does
 * (lib/ai-plans/use-ai-plans.ts `planNotice`), and how main's snapshot is
 * folded in — a limit reached or a sign-in lapsed is said once, when it
 * happens, and never for what was already so when the window opened.
 */

import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_AI_PLANS_SNAPSHOT, parseAiPlanRequest, planInUse, summarizePlanUsage, type AiPlanView } from "@pistachio/shell-contracts/ai-plans";
import { foldAiPlans, planNotice, useAiPlans } from "../src/lib/ai-plans/use-ai-plans";
import { useAppStore } from "../src/store";

function plan(overrides: Partial<AiPlanView> = {}): AiPlanView {
  return {
    provider: "chatgpt",
    status: "ready",
    chosen: true,
    inUse: true,
    email: "person@example.com",
    connectedAt: "2026-11-17T10:00:00.000Z",
    lastUsedAt: null,
    trouble: null,
    model: "gpt-5.6-terra",
    models: [{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra" }],
    usage: [],
    welcome: false,
    unconfirmedSignOut: false,
    ...overrides,
  };
}

const off = plan({ status: "off", inUse: false, connectedAt: null, model: null, models: [] });
const connecting = plan({ status: "connecting", inUse: false, connectedAt: null, model: null, models: [] });

afterEach(() => {
  useAiPlans.setState({ snapshot: EMPTY_AI_PLANS_SNAPSHOT, loaded: false, unsupported: null, error: null, busy: {} });
  useAppStore.setState({ notices: [], overlay: "none" });
});

describe("what a change of the plan's state is worth saying", () => {
  it("says nothing for the first snapshot, nor for no change", () => {
    expect(planNotice(null, plan({ status: "limit", inUse: false }), false)).toBeNull();
    expect(planNotice(plan(), plan({ lastUsedAt: "2026-11-17T11:00:00.000Z" }), false)).toBeNull();
  });

  it("says a later sign-in connected; the first ever is the welcome sheet's to say", () => {
    expect(planNotice(connecting, plan(), false)).toMatchObject({ tone: "success", action: null, message: "Connected: the chat is using your ChatGPT plan" });
    expect(planNotice(connecting, plan({ welcome: true }), false)).toBeNull();
    // A pause the person lifted themselves needs no telling.
    expect(planNotice(plan({ status: "limit", inUse: false }), plan(), false)).toBeNull();
  });

  it("says a limit with Manage usage first, a lapsed sign-in with Sign in, and usage not available with the way to Settings", () => {
    expect(planNotice(plan(), plan({ status: "limit", inUse: false }), false)).toMatchObject({
      tone: "warning",
      message: "ChatGPT plan: usage limit reached",
      action: { label: "Manage usage", request: { type: "manageUsage", provider: "chatgpt" } },
    });
    expect(planNotice(plan(), plan({ status: "signIn", inUse: false }), false)).toMatchObject({ action: { label: "Sign in", request: { type: "connect", provider: "chatgpt" } } });
    expect(planNotice(plan(), plan({ status: "ineligible", inUse: false }), false)).toMatchObject({ action: { label: "Open settings", open: "settings" } });
  });

  it("says why a sign-in did not finish — unless Settings is there to say it", () => {
    const failed = { ...off, trouble: { kind: "declined" as const, message: "ChatGPT sign-in was cancelled.", at: "2026-11-17T10:00:00.000Z" } };
    expect(planNotice(connecting, failed, false)).toMatchObject({ message: "ChatGPT sign-in was cancelled.", tone: "warning" });
    expect(planNotice(connecting, failed, true)).toBeNull();
    // Cancelled from the page itself: nothing went wrong, nothing to say.
    expect(planNotice(connecting, off, false)).toBeNull();
  });
});

describe("main's snapshot, folded in", () => {
  it("raises a notice when a limit is reached, and none for what was already so", () => {
    // The window opens on a plan already at its limit: the composer and Settings show it; it is not news.
    foldAiPlans({ plans: [plan({ status: "limit", inUse: false })] });
    expect(useAppStore.getState().notices).toHaveLength(0);
    foldAiPlans({ plans: [plan()] });
    foldAiPlans({ plans: [plan({ status: "limit", inUse: false })] });
    const notices = useAppStore.getState().notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ message: "ChatGPT plan: usage limit reached", tone: "warning" });
    expect(useAiPlans.getState().snapshot.plans[0]?.status).toBe("limit");
  });

  it("brings Settings → AI plan up for the first sign-in's confirmation, wherever the person was", () => {
    foldAiPlans({ plans: [connecting] });
    foldAiPlans({ plans: [plan({ welcome: true })] });
    expect(useAppStore.getState()).toMatchObject({ overlay: "settings", settingsSection: "plan" });
    expect(useAppStore.getState().notices).toHaveLength(0);
  });
});

describe("the contract", () => {
  it("takes only requests it knows, about plans it knows", () => {
    expect(parseAiPlanRequest({ type: "get" })).toEqual({ type: "get" });
    expect(parseAiPlanRequest({ type: "connect", provider: "chatgpt", fresh: true, extra: 1 })).toEqual({ type: "connect", provider: "chatgpt", fresh: true });
    expect(parseAiPlanRequest({ type: "choose", provider: "chatgpt", chosen: false })).toEqual({ type: "choose", provider: "chatgpt", chosen: false });
    expect(parseAiPlanRequest({ type: "model", provider: "chatgpt", model: "gpt-6.1-sol" })).toEqual({ type: "model", provider: "chatgpt", model: "gpt-6.1-sol" });
    for (const bad of [null, "connect", { type: "connect" }, { type: "connect", provider: "claude" }, { type: "choose", provider: "chatgpt" }, { type: "model", provider: "chatgpt", model: "" }, { type: "token", provider: "chatgpt" }]) {
      expect(parseAiPlanRequest(bad)).toBeNull();
    }
  });

  it("sums Pistachio's own count, and names the plan in use", () => {
    const usage = [
      { day: "2026-11-15", requests: 4, inputTokens: 1000, outputTokens: 200 },
      { day: "2026-11-16", requests: 0, inputTokens: 0, outputTokens: 0 },
      { day: "2026-11-17", requests: 9, inputTokens: 5000, outputTokens: 800 },
    ];
    expect(summarizePlanUsage(usage)).toEqual({ requests: 13, tokens: 7000, peakRequests: 9, activeDays: 2 });
    expect(planInUse({ plans: [plan()] })?.provider).toBe("chatgpt");
    expect(planInUse({ plans: [plan({ status: "limit", inUse: false })] })).toBeNull();
  });
});
