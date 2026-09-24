import { CircleUserRound, KeyRound } from "lucide-react";
import type { AccountState } from "@pistachio/shell-contracts/ipc";
import { accountStep } from "../../lib/account";
import { Input } from "../ui/input";
import { MockWindow, StageNotice } from "./parts";

/** What the wizard holds for the form; the wizard owns the submit. */
export interface SignInDraft {
  email: string;
  password: string;
}

/**
 * The about step's other stage: one small sign-in form inside the mock
 * window, reached from the "Or sign in" under the introduction.
 *
 * The walkthrough never makes an account — that is Settings → Account's
 * job, which has the room for a recovery code that must not be missed.
 * Signing in to one that exists mints no code (main/account/auth-service.ts:
 * only an account's first enrollment does), so this is the whole of it: an
 * email, a password, and this Mac enrolled in the same pass. It is offered
 * here because this is the moment the answer matters — the agent's models
 * come with the account, so the spoken introduction is one sign-in away.
 */
export function SignInPanel({
  draft,
  onDraft,
  account,
  error,
  busy,
}: {
  draft: SignInDraft;
  onDraft: (next: SignInDraft) => void;
  account: AccountState;
  error: string | null;
  busy: boolean;
}) {
  // Signed in and only this Mac's keys are missing: asking for the email and
  // password again would make a retry look like a mistake the person made.
  if (accountStep(account) === "enroll") {
    return (
      <MockWindow testId="onboarding-sign-in-panel" className="max-h-full">
        <div className="flex flex-col gap-5 px-8 pb-8">
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <span className="grid size-14 place-items-center rounded-full bg-amber-100 text-amber-1000">
              <KeyRound className="size-6" aria-hidden="true" />
            </span>
            <p className="text-label-14 font-medium text-gray-1000" data-testid="onboarding-sign-in-enroll">
              Signed in as {account.email ?? "your account"}
            </p>
            <p className="max-w-[38ch] text-label-12 text-gray-700">
              This Mac still has to enroll its own keys before anything syncs. Nothing else is asked for.
            </p>
          </div>
          {error === null ? null : <StageNotice tone="warning">{error}</StageNotice>}
        </div>
      </MockWindow>
    );
  }

  return (
    <MockWindow testId="onboarding-sign-in-panel" className="max-h-full">
      <div className="flex flex-col gap-5 px-8 pb-8">
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <span className="grid size-14 place-items-center rounded-full bg-alpha-100 text-gray-1000">
            <CircleUserRound className="size-6" aria-hidden="true" />
          </span>
          <p className="text-label-14 font-medium text-gray-1000">Sign in to Pistachio</p>
          <p className="max-w-[38ch] text-label-12 text-gray-700">
            Signing in unwraps this account&rsquo;s Space keys here and enrolls this Mac as one of its devices.
          </p>
        </div>
        <Input
          label="Email"
          type="email"
          autoComplete="username"
          spellCheck={false}
          autoFocus
          value={draft.email}
          disabled={busy}
          data-testid="onboarding-sign-in-email"
          onChange={(event) => onDraft({ ...draft, email: event.target.value })}
          className="w-full"
        />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          value={draft.password}
          disabled={busy}
          data-testid="onboarding-sign-in-password"
          onChange={(event) => onDraft({ ...draft, password: event.target.value })}
          className="w-full"
        />
        {error === null ? null : <StageNotice tone="warning">{error}</StageNotice>}
      </div>
    </MockWindow>
  );
}
