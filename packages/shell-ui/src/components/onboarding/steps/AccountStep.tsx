import { useState } from "react";
import { Check, CircleUserRound, Copy, KeyRound, ShieldCheck } from "lucide-react";
import type { AccountState } from "@pistachio/shell-contracts/ipc";
import { accountStep } from "../../../lib/account";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { MockWindow, StageNotice } from "../parts";

/** What the wizard holds for this step; the wizard owns the submit. */
export interface AccountDraft {
  mode: "sign-in" | "sign-up";
  email: string;
  password: string;
  /** The password again, when making an account: it seals the keys and cannot be reset. */
  confirm: string;
}

/**
 * The account step's stage: one small form inside the mock window, and
 * afterwards the one thing that must not be missed — the recovery code a
 * new account is given, shown exactly once.
 *
 * The step is the wizard's first, and it is required: Pistachio is not used
 * without an account (docs/onboarding.md, "The account"). The agent's models
 * come with it, so the spoken introduction right after depends on it; and
 * the import step fills a Profile with sessions that travel to the person's
 * other devices under the keys this step makes. The same stage is the whole
 * of the sign-in screen a Mac shows when it finished the walkthrough and is
 * signed out.
 *
 * Three stages, by what `accountStep` says is still owed: the form, the
 * enrollment alone (the account exists, this Mac's keys do not), and done.
 */
export function AccountStep({
  draft,
  onDraft,
  account,
  recoveryCode,
  error,
  busy,
}: {
  draft: AccountDraft;
  onDraft: (next: AccountDraft) => void;
  account: AccountState;
  /** Shown once, when enrollment minted one. */
  recoveryCode: string | null;
  error: string | null;
  busy: boolean;
}) {
  const stage = accountStep(account);
  const creating = draft.mode === "sign-up";

  if (stage === "done") {
    return (
      <MockWindow testId="onboarding-account" className="max-h-full">
        <div className="flex flex-col gap-5 px-8 pb-8">
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <span className="grid size-14 place-items-center rounded-full bg-green-100 text-green-900">
              <ShieldCheck className="size-6" aria-hidden="true" />
            </span>
            <p className="text-label-14 font-medium text-gray-1000" data-testid="onboarding-account-done">
              This Mac is enrolled as {account.email ?? "your account"}
            </p>
            <p className="max-w-[38ch] text-label-12 text-gray-700">
              Its keys were made here and stay here. What you sign into converges with your other devices, sealed —
              nobody but your machines can open it.
            </p>
          </div>
          {recoveryCode === null ? null : <RecoveryCode code={recoveryCode} />}
        </div>
      </MockWindow>
    );
  }

  // The account exists and only this Mac's keys are missing: asking for the
  // email and password again would invite a sign-up control has to refuse,
  // and would make a retry look like a mistake the person made.
  if (stage === "enroll") {
    return (
      <MockWindow testId="onboarding-account" className="max-h-full">
        <div className="flex flex-col gap-5 px-8 pb-8">
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <span className="grid size-14 place-items-center rounded-full bg-amber-100 text-amber-1000">
              <KeyRound className="size-6" aria-hidden="true" />
            </span>
            <p className="text-label-14 font-medium text-gray-1000" data-testid="onboarding-account-enroll">
              Signed in as {account.email ?? "your account"}
            </p>
            <p className="max-w-[38ch] text-label-12 text-gray-700">
              This Mac still has to enroll its own keys before it can be used. Nothing else is asked for — the account
              is already there.
            </p>
          </div>
          {error === null ? null : <StageNotice tone="warning">{error}</StageNotice>}
        </div>
      </MockWindow>
    );
  }

  // Sign-in seals this Mac's key material with the system keychain and is
  // refused without it (§10.1, D20), so the form says what is in the way
  // instead of offering a submit that could only fail. Where the account
  // services themselves could not start, main says that in `error`.
  const blocked = account.encryptionAvailable
    ? null
    : (account.error ??
      "The system keychain is unavailable, and without it Pistachio would have to keep your account keys in the clear — so it does not sign in at all. Unlock the login keychain (Keychain Access), or run Pistachio as the logged-in user, then open it again.");

  return (
    <MockWindow testId="onboarding-account" className="max-h-full">
      <div className="scroll-thin flex max-h-[calc(100vh-200px)] flex-col gap-5 overflow-y-auto px-8 pb-8">
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <span className="grid size-14 place-items-center rounded-full bg-alpha-100 text-gray-1000">
            <CircleUserRound className="size-6" aria-hidden="true" />
          </span>
          <p className="text-label-14 font-medium text-gray-1000">
            {creating ? "Create your Pistachio account" : "Sign in to Pistachio"}
          </p>
          <p className="max-w-[38ch] text-label-12 text-gray-700">
            {creating
              ? "An email and a password. This Mac is enrolled as the account's first device in the same pass."
              : "Signing in unwraps this account's Profile keys here and enrolls this Mac as one of its devices."}
          </p>
        </div>
        {blocked === null ? null : <StageNotice tone="warning">{blocked}</StageNotice>}
        <Input
          label="Email"
          type="email"
          autoComplete="username"
          spellCheck={false}
          autoFocus
          value={draft.email}
          disabled={busy || blocked !== null}
          data-testid="onboarding-account-email"
          onChange={(event) => onDraft({ ...draft, email: event.target.value })}
          className="w-full"
        />
        <Input
          label="Password"
          type="password"
          autoComplete={creating ? "new-password" : "current-password"}
          value={draft.password}
          disabled={busy || blocked !== null}
          description={creating ? "At least 8 characters." : undefined}
          data-testid="onboarding-account-password"
          onChange={(event) => onDraft({ ...draft, password: event.target.value })}
          className="w-full"
        />
        {creating ? (
          <Input
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            value={draft.confirm}
            disabled={busy || blocked !== null}
            data-testid="onboarding-account-confirm"
            onChange={(event) => onDraft({ ...draft, confirm: event.target.value })}
            className="w-full"
          />
        ) : null}
        {error === null ? null : <StageNotice tone="warning">{error}</StageNotice>}
        <div className="flex items-center justify-between gap-3">
          <span className="text-label-12 text-gray-700">{creating ? "Already have an account?" : "New to Pistachio?"}</span>
          <Button
            variant="tertiary"
            size="sm"
            disabled={busy}
            data-testid="onboarding-account-switch"
            // The password typed for one is not carried into the other: a
            // confirmation that was never asked for would otherwise be owed.
            onClick={() => onDraft({ ...draft, mode: creating ? "sign-in" : "sign-up", password: "", confirm: "" })}
          >
            {creating ? "Sign in instead" : "Create an account"}
          </Button>
        </div>
      </div>
    </MockWindow>
  );
}

/** The code, once, with the warning that makes "once" survivable. */
function RecoveryCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2.5">
      <StageNotice tone="warning">
        Write this recovery code down now. It is shown once, and without it a forgotten password means your synced
        sessions can never be opened again.
      </StageNotice>
      <div className="flex items-start gap-2 rounded-md bg-background-200 px-3.5 py-3 shadow-border">
        <code
          data-testid="onboarding-recovery-code"
          className="min-w-0 flex-1 font-mono text-label-13 leading-5 break-all text-gray-1000 select-all"
        >
          {code}
        </code>
        <Button
          variant="secondary"
          size="sm"
          prefix={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          onClick={() => {
            void navigator.clipboard.writeText(code).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
