/**
 * Settings → AI plan (docs/ai-plans.md §5): whose plan the agent's chat runs
 * on — the models that come with the Pistachio account, or the person's own
 * ChatGPT plan.
 *
 * The page says, for a plan: whether it is connected and as whom, whether
 * the chat is on it, what is wrong when something is and the one or two
 * things to do about it, and Pistachio's own count of what it has sent.
 * What is LEFT of a ChatGPT plan is not here and is never guessed: OpenAI
 * gives an app no such number, and its page for it is one press away
 * (*Manage usage*) wherever usage is mentioned.
 *
 * The wording of the sign-in button, the confirmation after the first
 * sign-in, the line by the composer and the limit state follow OpenAI's
 * guidelines for apps that use a ChatGPT plan (developers.openai.com/siwc,
 * "UI/UX guidelines"): **Continue with ChatGPT**, **You're using your
 * ChatGPT plan** / **Got it**, **Using ChatGPT plan**, **Usage limit
 * reached** with **Manage usage** first.
 */

import { useEffect } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  AI_PLAN_NAMES,
  CHATGPT_PLAN_HELP_URL,
  summarizePlanUsage,
  type AiPlanStatus,
  type AiPlanView,
} from "@pistachio/shell-contracts/ai-plans";
import { aiPlanRequest, useAiPlan, useAiPlans } from "../../../lib/ai-plans/use-ai-plans";
import { useAppStore } from "../../../store";
import { SearchProviderLogo } from "../../SearchProviderLogo";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Note } from "../../ui/note";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { SettingsDialog } from "../dialogs";
import { Block, Group, LoadFailed, Page, Row, Unavailable } from "../parts";

const TITLE = "AI plan";
const DESCRIPTION = "What the agent's chat runs on: the models that come with your Pistachio account, or your own ChatGPT plan.";

const STATUS_BADGE: Record<Exclude<AiPlanStatus, "off" | "connecting">, { label: string; variant: "green-subtle" | "amber-subtle" | "red-subtle" }> = {
  ready: { label: "Connected", variant: "green-subtle" },
  limit: { label: "Usage limit reached", variant: "amber-subtle" },
  ineligible: { label: "Not available", variant: "amber-subtle" },
  signIn: { label: "Sign in again", variant: "red-subtle" },
};

function when(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function compact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** The sign-in button, as OpenAI asks it be labelled: the mark, then **Continue with ChatGPT**. */
export function ContinueWithChatGpt({ onClick, loading = false, size = "sm", testId = "ai-plan-connect" }: { onClick: () => void; loading?: boolean; size?: "xs" | "sm"; testId?: string }) {
  return (
    <Button size={size} loading={loading} onClick={onClick} data-testid={testId} prefix={<SearchProviderLogo provider="chatgpt" className="size-4" />}>
      {AI_PLAN_NAMES.chatgpt.connect}
    </Button>
  );
}

/** Open ChatGPT's usage page, in the browser the person signed in with. The words are OpenAI's: **Manage usage**. */
export function ManageUsageButton({ variant = "secondary", size = "sm" }: { variant?: "default" | "secondary" | "tertiary"; size?: "xs" | "sm" }) {
  return (
    <Button variant={variant} size={size} data-testid="ai-plan-manage-usage" suffix={<ArrowUpRight aria-hidden="true" />} onClick={() => void aiPlanRequest({ type: "manageUsage", provider: "chatgpt" })}>
      Manage usage
    </Button>
  );
}

export function AiPlanPage() {
  const unsupported = useAiPlans((s) => s.unsupported);
  const error = useAiPlans((s) => s.error);
  const loaded = useAiPlans((s) => s.loaded);
  const plan = useAiPlan("chatgpt");

  // The page is also where the connection is looked at: its models are read again as it opens, which renews the
  // sign-in when that is due and finds one that ended in ChatGPT's settings.
  useEffect(() => {
    void aiPlanRequest({ type: "refresh", provider: "chatgpt" });
  }, []);

  // (No page of the dashboard's answers for this: the way out is the host's sentence alone.)
  if (unsupported !== null) return <Unavailable title={TITLE} description={DESCRIPTION} reason={unsupported} />;
  if (plan === null) {
    if (loaded || error !== null) return <LoadFailed title={TITLE} description={DESCRIPTION} reason={error ?? "The plan's state could not be read."} />;
    return (
      <Page title={TITLE} description={DESCRIPTION}>
        <Group title="Use your ChatGPT plan">
          <Row label="Checking" note="Reading whether a plan is connected…" />
        </Group>
      </Page>
    );
  }
  return (
    <Page title={TITLE} description={DESCRIPTION}>
      <ChatGptCard plan={plan} error={error} />
      {plan.status === "off" || plan.status === "connecting" ? null : <UsageCard plan={plan} />}
      <PistachioCard plan={plan} />
      {plan.welcome ? <WelcomeSheet /> : null}
    </Page>
  );
}

function ChatGptCard({ plan, error }: { plan: AiPlanView; error: string | null }) {
  const busy = useAiPlans((s) => s.busy.chatgpt ?? null);
  const connect = (fresh = false): void => void aiPlanRequest({ type: "connect", provider: "chatgpt", ...(fresh ? { fresh: true } : {}) });
  const usePistachio = (): void => void aiPlanRequest({ type: "choose", provider: "chatgpt", chosen: false });
  const connected = plan.status !== "off" && plan.status !== "connecting";
  const since = when(plan.connectedAt);
  const lastUsed = when(plan.lastUsedAt);

  return (
    <Group
      title="Use your ChatGPT plan"
      note="Complete the agent's requests in Pistachio with usage included in your ChatGPT plan, instead of the usage that comes with your Pistachio account. It is separate from anything Pistachio charges."
      footer={
        connected ? (
          <span data-testid="ai-plan-footer">
            {since === null ? "Connected on this Mac." : `Connected ${since}.`} {lastUsed === null ? "Not used yet." : `Last used ${lastUsed}.`}
          </span>
        ) : (
          <span>
            Works with every Pistachio plan.{" "}
            <a className="underline underline-offset-2" href={CHATGPT_PLAN_HELP_URL} target="_blank" rel="noreferrer">
              Learn more
            </a>
          </span>
        )
      }
      footerAction={
        connected ? (
          <Button variant="secondary" size="sm" loading={busy === "disconnect"} data-testid="ai-plan-disconnect" onClick={() => void aiPlanRequest({ type: "disconnect", provider: "chatgpt" })}>
            Sign out of ChatGPT
          </Button>
        ) : undefined
      }
    >
      {plan.status === "off" ? (
        <Row
          label="Not connected"
          note={
            plan.email === null
              ? "Sign in with ChatGPT in your browser. Pistachio never sees your password; the sign-in is kept on this Mac, in its keychain."
              : `Last connected as ${plan.email}. Signing in again takes one step in your browser.`
          }
        >
          <span className="flex flex-col items-end gap-2">
            <ContinueWithChatGpt loading={busy === "connect"} onClick={() => connect()} />
            {plan.email === null ? null : (
              <Button variant="tertiary" size="xs" data-testid="ai-plan-other-account" onClick={() => connect(true)}>
                Use a different account
              </Button>
            )}
          </span>
        </Row>
      ) : null}

      {plan.status === "connecting" ? (
        <Row label="Waiting for ChatGPT" note="Finish signing in in your browser. This page updates when you come back.">
          <span className="flex items-center gap-2">
            <Button variant="secondary" size="sm" data-testid="ai-plan-reopen" onClick={() => connect()}>
              Open the page again
            </Button>
            <Button variant="tertiary" size="sm" data-testid="ai-plan-cancel" onClick={() => void aiPlanRequest({ type: "cancel", provider: "chatgpt" })}>
              Cancel
            </Button>
          </span>
        </Row>
      ) : null}

      {connected ? (
        <>
          <Row label={plan.email ?? "ChatGPT account"} note="The ChatGPT account connected on this Mac.">
            <Badge variant={STATUS_BADGE[plan.status as keyof typeof STATUS_BADGE].variant} size="sm" data-testid="ai-plan-status" data-status={plan.status}>
              {STATUS_BADGE[plan.status as keyof typeof STATUS_BADGE].label}
            </Badge>
          </Row>

          {plan.status === "limit" ? (
            <Block>
              <Note type="warning" data-testid="ai-plan-limit" label="Usage limit reached">
                Requests on your ChatGPT plan are paused. The limit may be your plan's or the one set for Pistachio: review it in ChatGPT's settings, then try again. Pistachio isn't told when a limit lifts.
              </Note>
              <span className="mt-3 flex flex-wrap items-center gap-2">
                <ManageUsageButton variant="default" />
                <Button variant="secondary" size="sm" data-testid="ai-plan-resume" onClick={() => void aiPlanRequest({ type: "resume", provider: "chatgpt" })}>
                  Try again
                </Button>
                <Button variant="tertiary" size="sm" data-testid="ai-plan-use-pistachio" onClick={usePistachio}>
                  Use Pistachio's models
                </Button>
              </span>
            </Block>
          ) : null}

          {plan.status === "signIn" ? (
            <Block>
              <Note type="error" data-testid="ai-plan-sign-in" label="Sign in again">
                Your ChatGPT connection expired or was disconnected in ChatGPT's settings. Until you sign in again, turns on your plan stop with this message.
              </Note>
              <span className="mt-3 flex flex-wrap items-center gap-2">
                <ContinueWithChatGpt loading={busy === "connect"} onClick={() => connect()} testId="ai-plan-reconnect" />
                <Button variant="tertiary" size="sm" data-testid="ai-plan-use-pistachio" onClick={usePistachio}>
                  Use Pistachio's models
                </Button>
              </span>
            </Block>
          ) : null}

          {plan.status === "ineligible" ? (
            <Block>
              <Note type="warning" data-testid="ai-plan-ineligible" label="Not available">
                ChatGPT plan usage isn't available for this account, its workspace or its policy. Pistachio's own models still work.
              </Note>
              <span className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" data-testid="ai-plan-use-pistachio" onClick={usePistachio}>
                  Use Pistachio's models
                </Button>
                <Button variant="secondary" size="sm" data-testid="ai-plan-resume" onClick={() => void aiPlanRequest({ type: "resume", provider: "chatgpt" })}>
                  Try again
                </Button>
              </span>
            </Block>
          ) : null}

          <Row
            label="Use it for the chat"
            note={
              plan.chosen
                ? "The agent's turns run on your ChatGPT plan. If the plan can't serve one, the turn stops and says why — it never moves to Pistachio's models by itself."
                : "Connected, but the chat is using Pistachio's models."
            }
          >
            <Switch checked={plan.chosen} label="Use my ChatGPT plan for the chat" onChange={(chosen) => void aiPlanRequest({ type: "choose", provider: "chatgpt", chosen })} />
          </Row>

          {plan.models.length === 0 || plan.model === null ? null : (
            <Row label="Model" note="The models your ChatGPT account offers apps, as ChatGPT lists them.">
              <Select
                aria-label="Model"
                data-testid="ai-plan-model"
                value={plan.model}
                items={plan.models.map((model) => ({ value: model.id, label: model.name }))}
                onValueChange={(model) => void aiPlanRequest({ type: "model", provider: "chatgpt", model })}
              />
            </Row>
          )}
        </>
      ) : null}

      {/* What last went wrong, when no state above has already said it. */}
      {plan.trouble !== null && (plan.status === "off" || plan.status === "ready") ? (
        <Block>
          <Note type={plan.trouble.kind === "declined" ? "secondary" : "warning"} size="sm" data-testid="ai-plan-trouble">
            {plan.trouble.message}
          </Note>
        </Block>
      ) : null}
      {plan.unconfirmedSignOut && plan.status === "off" ? (
        <Block>
          <Note type="warning" size="sm" data-testid="ai-plan-unconfirmed">
            Signed out on this Mac, but ChatGPT didn't confirm it ended the session. To be sure, disconnect Pistachio under Apps in ChatGPT's settings.
          </Note>
        </Block>
      ) : null}
      {error === null ? null : (
        <Block>
          <Note type="error" size="sm">
            {error}
          </Note>
        </Block>
      )}
    </Group>
  );
}

/** Pistachio's own count of what it sent on the plan, and the way to the provider's page for the rest. */
function UsageCard({ plan }: { plan: AiPlanView }) {
  const total = summarizePlanUsage(plan.usage);
  return (
    <Group
      title="ChatGPT plan usage"
      note="What Pistachio has sent on your plan from this Mac over the last 30 days, by its own count."
      footer="What's left of your plan is shown by ChatGPT, not here."
      footerAction={<ManageUsageButton />}
    >
      <Row label="Total" note={total.requests === 0 ? "Nothing sent yet." : `About ${compact(total.tokens)} tokens.`}>
        <span className="font-mono text-label-13 text-gray-900" data-testid="ai-plan-usage-total">
          {total.requests === 1 ? "1 request" : `${compact(total.requests)} requests`}
        </span>
      </Row>
      <Row label="Peak per day">
        <span className="font-mono text-label-13 text-gray-900">{total.peakRequests === 1 ? "1 request" : `${compact(total.peakRequests)} requests`}</span>
      </Row>
      <Row label="Active days">
        <span className="font-mono text-label-13 text-gray-900" data-testid="ai-plan-usage-days">
          {String(total.activeDays)}
        </span>
      </Row>
    </Group>
  );
}

/** What does not move to the plan, so nobody is surprised by the account's own meter. */
function PistachioCard({ plan }: { plan: AiPlanView }) {
  const openSettings = useAppStore((s) => s.openSettings);
  return (
    <Group
      title="Pistachio's models"
      note="They come with your Pistachio account and are metered there."
      footer="Your plan covers the agent's turns in the chat. The small things around them — address-bar suggestions, tidying tabs, memory, read-aloud, pages the agent builds — stay on Pistachio's models."
      footerAction={
        <Button variant="secondary" size="sm" onClick={() => openSettings("account")}>
          See usage
        </Button>
      }
    >
      <Row label="The chat" note={plan.inUse ? "On your ChatGPT plan." : plan.chosen && plan.status !== "off" && plan.status !== "connecting" ? "Waiting on your ChatGPT plan: see above." : "On Pistachio's models."}>
        <Badge variant={plan.inUse ? "gray-subtle" : plan.chosen && plan.status !== "off" && plan.status !== "connecting" ? "amber-subtle" : "green-subtle"} size="sm" data-testid="ai-plan-chat-source">
          {plan.inUse ? AI_PLAN_NAMES.chatgpt.plan : plan.chosen && plan.status !== "off" && plan.status !== "connecting" ? "Stopped" : "Pistachio"}
        </Badge>
      </Row>
    </Group>
  );
}

/** The confirmation after the first sign-in: shown once, ever. */
function WelcomeSheet() {
  const done = (): void => void aiPlanRequest({ type: "welcomed", provider: "chatgpt" });
  return (
    <SettingsDialog
      icon={<SearchProviderLogo provider="chatgpt" className="size-4.5" />}
      title="You're using your ChatGPT plan"
      onClose={done}
      testId="ai-plan-welcome"
      footer="You can change this any time under Settings → AI plan."
      actions={
        <Button size="sm" data-testid="ai-plan-welcome-done" onClick={done} autoFocus>
          Got it
        </Button>
      }
    >
      <p className="text-copy-14 text-gray-1000">
        The agent's requests in Pistachio now use your ChatGPT plan, instead of the usage that comes with your Pistachio account.
      </p>
      <p className="text-copy-14 text-gray-900">
        You can review what Pistachio uses, and set a limit for it, in ChatGPT's settings.
      </p>
      <ManageUsageButton />
    </SettingsDialog>
  );
}
