/**
 * The person's own AI plan as the shell knows it (docs/ai-plans.md §5), and
 * the only place that talks to the host about it. Its own zustand store
 * beside the shell's, as extensions' is (lib/extensions/use-extensions.ts):
 * Settings → AI plan, the line beside the composer and the account page's
 * invitation all read this one copy of main's snapshot.
 *
 * There is no token here and no sign-in: main opens the page in the
 * person's browser and keeps what comes back. What the shell does is show
 * the state, and say a change of it once — the moment it happens, wherever
 * the person is:
 *
 * - connected (a later sign-in: the first is the welcome sheet's to say);
 * - a usage limit reached, with *Manage usage*;
 * - a sign-in that lapsed or was disconnected, with *Sign in*;
 * - plan usage not available for the account;
 * - a sign-in that did not finish, when Settings is not there to say it.
 *
 * `planNotice` decides which, purely, from two snapshots: the test's.
 */

import { create } from "zustand";
import {
  AI_PLAN_NAMES,
  EMPTY_AI_PLANS_SNAPSHOT,
  type AiPlanProvider,
  type AiPlanRequest,
  type AiPlanView,
  type AiPlansSnapshot,
} from "@pistachio/shell-contracts/ai-plans";
import { isShellUnsupported } from "@pistachio/shell-contracts/socket";
import { nativeApi, shellApi } from "../../api";
import { useAppStore } from "../../store";
import { share } from "../share";

interface AiPlansState {
  snapshot: AiPlansSnapshot;
  /** A snapshot has come from main. */
  loaded: boolean;
  /** This host keeps no plan sign-in and never will: its reason. */
  unsupported: string | null;
  /** The last refusal that was not `unsupported`. */
  error: string | null;
  /** A request is on its way, by plan: the button that asked waits. */
  busy: Partial<Record<AiPlanProvider, AiPlanRequest["type"]>>;
}

export const useAiPlans = create<AiPlansState>(() => ({
  snapshot: EMPTY_AI_PLANS_SNAPSHOT,
  loaded: false,
  unsupported: null,
  error: null,
  busy: {},
}));

/** One plan's view, or null before main has said (or on a host with none). */
export function useAiPlan(provider: AiPlanProvider): AiPlanView | null {
  return useAiPlans((state) => state.snapshot.plans.find((plan) => plan.provider === provider) ?? null);
}

/** The plan the next turn runs on, if the chat is on one. */
export function usePlanInUse(): AiPlanView | null {
  return useAiPlans((state) => state.snapshot.plans.find((plan) => plan.inUse) ?? null);
}

/** A plan the chat is meant to be on but cannot run on right now: what the composer says instead of sending into a refusal. */
export function useStalledPlan(): AiPlanView | null {
  return useAiPlans((state) => state.snapshot.plans.find((plan) => plan.chosen && (plan.status === "limit" || plan.status === "signIn" || plan.status === "ineligible")) ?? null);
}

function refusalMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/u, "");
}

/** What a change of state is worth saying, and what its button does; null when nothing is. */
export interface PlanNotice {
  message: string;
  tone: "success" | "warning";
  action: { label: string; request: AiPlanRequest } | { label: string; open: "settings" } | null;
}

/**
 * The notice a change from `before` to `after` earns. Never for the first
 * snapshot (`before` null): what was already so when the window opened is
 * the settings page's and the composer's to show, not news.
 */
export function planNotice(before: AiPlanView | null, after: AiPlanView, settingsShowsIt: boolean): PlanNotice | null {
  if (before === null || before.status === after.status) return null;
  const names = AI_PLAN_NAMES[after.provider];
  switch (after.status) {
    case "ready":
      // The first sign-in ever is confirmed by its own sheet; a pause the person lifted needs no telling.
      if (before.status !== "connecting" || after.welcome) return null;
      return { message: `Connected: the chat is using your ${names.plan}`, tone: "success", action: null };
    case "limit":
      return { message: `${names.plan}: usage limit reached`, tone: "warning", action: { label: "Manage usage", request: { type: "manageUsage", provider: after.provider } } };
    case "signIn":
      return { message: `Your ${names.product} connection needs a new sign-in`, tone: "warning", action: { label: "Sign in", request: { type: "connect", provider: after.provider } } };
    case "ineligible":
      return { message: `${names.plan} usage isn't available for this account`, tone: "warning", action: { label: "Open settings", open: "settings" } };
    case "off":
      // A sign-in that came back without one: Settings says why when it is the page in view.
      if (before.status !== "connecting" || after.trouble === null || settingsShowsIt) return null;
      return { message: after.trouble.message, tone: "warning", action: { label: "Open settings", open: "settings" } };
    case "connecting":
      return null;
  }
}

/** A snapshot from main, folded in. Exported for the specs' sake (and a test's). */
export function foldAiPlans(next: AiPlansSnapshot): void {
  const state = useAiPlans.getState();
  const previous = state.snapshot;
  const snapshot = share(previous, next);
  useAiPlans.setState(snapshot === previous ? { loaded: true } : { loaded: true, snapshot });
  const app = useAppStore.getState();
  const settingsShowsIt = app.overlay === "settings" && app.settingsSection === "plan";
  for (const plan of snapshot.plans) {
    const before = state.loaded ? (previous.plans.find((candidate) => candidate.provider === plan.provider) ?? null) : null;
    // The first sign-in's confirmation is a sheet on the settings page: it is brought up for it, wherever the person was.
    if (before !== null && plan.welcome && !before.welcome && !settingsShowsIt) app.openSettings("plan");
    const notice = planNotice(before, plan, settingsShowsIt);
    if (notice === null) continue;
    const action = notice.action;
    app.showNotice(notice.message, {
      tone: notice.tone,
      ...(action === null
        ? {}
        : { action: { label: action.label, run: () => ("request" in action ? void aiPlanRequest(action.request) : useAppStore.getState().openSettings("plan")) } }),
    });
  }
}

/** One subscription per window, whatever starts it. */
let started = false;

/** Subscribe this window to main's snapshot, once (App.tsx), and ask for what it has. */
export function startAiPlans(): void {
  if (started) return;
  started = true;
  try {
    shellApi().onAiPlans(foldAiPlans);
  } catch (cause) {
    started = false;
    useAiPlans.setState(isShellUnsupported(cause) ? { unsupported: refusalMessage(cause) } : { error: refusalMessage(cause) });
    return;
  }
  // (The web's host keeps no plan sign-in and refuses the member; asking would only record that, which the settings page does.)
  if (nativeApi() !== null) void aiPlanRequest({ type: "get" });
}

/**
 * Ask main for something about the plan. Never throws into React: a refusal
 * is recorded (`unsupported` for a host that will never answer, `error`
 * otherwise) and null comes back. The answer's snapshot is folded in, as
 * the one main publishes is.
 */
export async function aiPlanRequest(request: AiPlanRequest): Promise<AiPlansSnapshot | null> {
  const provider = "provider" in request ? request.provider : null;
  if (provider !== null) useAiPlans.setState((state) => ({ busy: { ...state.busy, [provider]: request.type }, error: null }));
  try {
    const response = await shellApi().aiPlans(request);
    foldAiPlans(response.snapshot);
    return response.snapshot;
  } catch (cause) {
    useAppStore.getState().noteRefusal("aiPlans", cause);
    useAiPlans.setState(isShellUnsupported(cause) ? { unsupported: refusalMessage(cause) } : { error: refusalMessage(cause) });
    return null;
  } finally {
    if (provider !== null) {
      useAiPlans.setState((state) => {
        const { [provider]: _done, ...busy } = state.busy;
        return { busy };
      });
    }
  }
}

/** Start a sign-in from anywhere: Settings → AI plan is where it is watched, so that is opened too. */
export function connectPlan(provider: AiPlanProvider, options: { fresh?: boolean } = {}): void {
  useAppStore.getState().openSettings("plan");
  void aiPlanRequest({ type: "connect", provider, ...(options.fresh === true ? { fresh: true } : {}) });
}
