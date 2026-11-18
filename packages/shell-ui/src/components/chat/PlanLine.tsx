/**
 * The line beside a composer that says whose plan the next turn runs on,
 * when it is the person's own (docs/ai-plans.md §5).
 *
 * - **Using ChatGPT plan**, with *Manage usage* — OpenAI's wording for the
 *   line an app shows near its composer while requests use the plan.
 * - While the chat is meant to be on the plan and the plan cannot serve it
 *   — a limit reached, a sign-in lapsed, usage not available — the line says
 *   so and carries what to do, most useful first: a turn sent now would only
 *   stop on the same words.
 *
 * Nothing is drawn when the chat is on Pistachio's models: that is how it
 * always was, and needs no line.
 *
 * A press on one of its buttons leaves the keyboard where it was (the Bar's
 * rule): the composer keeps its focus and its text.
 */

import { AI_PLAN_NAMES, type AiPlanView } from "@pistachio/shell-contracts/ai-plans";
import { aiPlanRequest, connectPlan, usePlanInUse, useStalledPlan } from "../../lib/ai-plans/use-ai-plans";
import { cn } from "../../lib/cn";
import { SearchProviderLogo } from "../SearchProviderLogo";

const STALLED: Record<"limit" | "signIn" | "ineligible", string> = {
  limit: "Usage limit reached",
  signIn: "ChatGPT sign-in needed",
  ineligible: "ChatGPT plan not available here",
};

function LineButton({ testId, onClick, children }: { testId: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="shrink-0 cursor-pointer rounded-xs underline decoration-alpha-600 underline-offset-2 outline-none hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function actionsFor(plan: AiPlanView): React.ReactNode {
  const usePistachio = (
    <LineButton key="pistachio" testId="plan-line-use-pistachio" onClick={() => void aiPlanRequest({ type: "choose", provider: plan.provider, chosen: false })}>
      Use Pistachio's models
    </LineButton>
  );
  const manage = (
    <LineButton key="manage" testId="plan-line-manage-usage" onClick={() => void aiPlanRequest({ type: "manageUsage", provider: plan.provider })}>
      Manage usage
    </LineButton>
  );
  switch (plan.status) {
    case "limit":
      return [
        manage,
        <LineButton key="resume" testId="plan-line-resume" onClick={() => void aiPlanRequest({ type: "resume", provider: plan.provider })}>
          Try again
        </LineButton>,
        usePistachio,
      ];
    case "signIn":
      return [
        <LineButton key="connect" testId="plan-line-sign-in" onClick={() => connectPlan(plan.provider)}>
          Sign in
        </LineButton>,
        usePistachio,
      ];
    case "ineligible":
      return [usePistachio];
    default:
      return [manage];
  }
}

export function PlanLine({ className }: { className?: string }) {
  const inUse = usePlanInUse();
  const stalled = useStalledPlan();
  const plan = inUse ?? stalled;
  if (plan === null) return null;
  const words = inUse !== null ? AI_PLAN_NAMES[plan.provider].using : STALLED[plan.status as keyof typeof STALLED];
  return (
    <div
      role="status"
      data-testid="plan-line"
      data-status={plan.status}
      className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4", inUse !== null ? "text-gray-900" : "text-amber-900", className)}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <SearchProviderLogo provider="chatgpt" className="size-3 shrink-0" />
        <span className="truncate font-medium">{words}</span>
      </span>
      {actionsFor(plan)}
    </div>
  );
}
