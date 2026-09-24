/**
 * Settings → Account: the one place this Mac's relationship with the control
 * plane is set up and taken apart (docs/cloud-sync-design.md §10.1).
 *
 * Two pages in one, chosen by `accountStep`. Signed out — or revoked, which
 * leaves the state saying "enrolled" but the token gone — it is a form:
 * email and password, with the failure beside the field that caused it.
 * Enrolled, it is a set of facts about the account and four irreversible
 * actions — a recovery code that is shown exactly once, a password change
 * that re-seals every Space wrapper, and sign-out.
 *
 * Nothing here is optimistic. Every button reports what main answered,
 * because each one either succeeded on the control plane or did not, and a
 * switch that flips ahead of the network would be a claim about someone
 * else's machine.
 */

import { useEffect, useState } from "react";
import { LogOut, MessageCircle, ShieldAlert, Unlink } from "lucide-react";
import type { AiUsageSummary, IMessageLinkChallenge, IMessageLinkStatus } from "@pistachio/shell-contracts/ipc";
import {
  accountStateLabel,
  accountStateTone,
  accountStep,
  controlErrorCode,
  formatUsd,
  modelUsageLabel,
  usageLine,
} from "../../../lib/account";
import { useAsyncAction } from "../../../lib/action";
import { useAppStore } from "../../../store";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Note } from "../../ui/note";
import { ConfirmDialog } from "../dialogs";
import { Block, Group, LoadFailed, OneTimeSecret, Page, Row, Unavailable, useLoadFailure, useUnavailable } from "../parts";
import { shellApi } from "../../../api";

export function AccountPage() {
  // W12, the guard this page never got: `getAccount` IS probed by the
  // initial load, and a cloud host refuses it — the account is the web app's
  // own page, signed in as this person, talking to control directly (§11).
  // Without this the shell in a browser tab offered "Sign in and enroll this
  // Mac" and a live email/password form whose submit could never work.
  const unavailable = useUnavailable("getAccount");
  const failed = useLoadFailure("getAccount");
  if (unavailable !== null) {
    return <Unavailable title="Account" description="Who this browser is signed in as." reason={unavailable} section="account" />;
  }
  if (failed !== null) {
    return <LoadFailed title="Account" description="Who this browser is signed in as." reason={failed} />;
  }
  return <AccountPageBody />;
}

function AccountPageBody() {
  const account = useAppStore((state) => state.account);
  // The step, not the state: a revoked Mac still reports `state: "enrolled"`
  // with its token gone, and the enrolled page has no button that would work
  // for it — the banner's "sign in again below" has to point at a form.
  const step = accountStep(account);

  return (
    <Page
      title="Account"
      description="An account lets your Macs and the cloud browser share sessions. Everything travels sealed under keys this Mac derives from your password — control stores ciphertext only."
    >
      {account.revoked ? <RevokedBanner /> : null}
      {account.encryptionAvailable ? null : <KeychainUnavailable />}
      {step === "sign-in" && account.state === "anonymous" ? <AnonymousCard /> : null}
      {step === "sign-in" ? <SignedOut /> : <Enrolled />}
      {/* Signing out was the only way off a revoked device; it stays offered
          beside the form, because forgetting the account here is still what
          clears this Mac's keys and its Spaces' cookie jars. */}
      {account.revoked ? <SignOutCard /> : null}
    </Page>
  );
}

/* ------------------------------- banners -------------------------------- */

function RevokedBanner() {
  return (
    <Group type="error" title="This device was revoked" note="Its enrollment is no longer accepted by the control plane.">
      <Block>
        <Note type="error" icon={<ShieldAlert aria-hidden="true" />}>
          Sync stopped and the hub closed this device&rsquo;s socket. Your Spaces, tabs, and the sessions already on this
          Mac were left alone. Sign in again below to enroll a fresh key for this Mac.
        </Note>
      </Block>
    </Group>
  );
}

function KeychainUnavailable() {
  return (
    <Group type="warning" title="The system keychain is unavailable" note="Sign-in is refused while it stays that way.">
      <Block>
        <Note type="warning">
          Account keys are sealed with Electron&rsquo;s <code className="font-mono">safeStorage</code>, which needs the
          macOS keychain. Without it Pistachio would have to keep your key material in the clear, so it refuses to sign
          in at all. Unlock the login keychain (Keychain Access) or run Pistachio as the logged-in user, then reopen this
          page.
        </Note>
      </Block>
    </Group>
  );
}

/* ------------------------------ signed out ------------------------------ */

/**
 * Nobody signed in, and the models work anyway: control gave this Mac an
 * anonymous account (docs/anonymous-accounts.md) with a monthly allowance,
 * which is the `cap` its meter reports.
 */
function AnonymousCard() {
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void shellApi().getAiUsage().then(
      (next) => {
        if (!cancelled) setUsage(next);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const allowance = usage?.cap.monthlyUsd ?? null;
  return (
    <Group
      title="Using Pistachio without an account"
      note="The agent, memory, and read-aloud work on this Mac within a monthly allowance. An account lifts it and adds sync, the vault, integrations, and the cloud browser."
      footer="Create an account below and it is this same one, upgraded: what this Mac has done and used so far comes with it."
    >
      <Row
        label="This month"
        note={
          usage === null
            ? "Reading the meter…"
            : usage.cap.reached
              ? "The allowance is used up: model calls are refused until the month turns, or until you create an account."
              : usageLine(usage.month)
        }
      >
        {usage === null ? (
          <Badge variant="gray-subtle" size="sm">Checking</Badge>
        ) : (
          <Badge variant={usage.cap.reached ? "red-subtle" : "gray-subtle"} size="sm" data-testid="anonymous-allowance">
            {allowance === null ? formatUsd(usage.month.costUsd) : `${formatUsd(usage.month.costUsd)} of ${formatUsd(allowance)}`}
          </Badge>
        )}
      </Row>
    </Group>
  );
}

function SignedOut() {
  const encryptionAvailable = useAppStore((state) => state.account.encryptionAvailable);
  const anonymous = useAppStore((state) => state.account.state === "anonymous");
  const signUp = useAppStore((state) => state.signUp);
  const signIn = useAppStore((state) => state.signIn);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldError, setFieldError] = useState<"email" | "password" | "confirm" | null>(null);
  const { busy, error, setError, run } = useAsyncAction();

  const creating = mode === "sign-up";
  const submit = async () => {
    if (busy) return;
    setError(null);
    setFieldError(null);
    if (!email.includes("@") || email.trim() === "") {
      setFieldError("email");
      setError("Enter the email address for the account.");
      return;
    }
    if (password.length < 8) {
      setFieldError("password");
      setError("Choose a password of at least 8 characters.");
      return;
    }
    if (creating && confirm !== password) {
      setFieldError("confirm");
      setError("The two passwords do not match. This one seals your Space keys, so it cannot be recovered later.");
      return;
    }
    const signedIn = await run(async () => {
      const result = await (creating ? signUp(email.trim(), password) : signIn(email.trim(), password));
      return result.ok ? null : result.error;
    });
    if (!signedIn) return;
    setPassword("");
    setConfirm("");
  };

  return (
    <Group
      title={creating ? "Create an account" : "Sign in"}
      note={
        creating
          ? "Your password derives the key that wraps every Space secret. Pistachio cannot reset it for you; the recovery code minted after enrollment is the only other way in."
          : "Signing in unwraps this account's Space keys on this Mac. Enrolling the machine is the next step."
      }
      footer={
        creating
          ? "One account, any number of Macs. Each machine enrolls its own key pair."
          : anonymous
            ? "No account yet? Create one — it takes an email and a password. Signing in to one you already have brings this Mac, and what it has used, into it."
            : "No account yet? Create one — it takes an email and a password."
      }
      footerAction={
        <Button
          variant="tertiary"
          size="sm"
          disabled={busy}
          onClick={() => {
            setMode(creating ? "sign-in" : "sign-up");
            setError(null);
            setFieldError(null);
            setConfirm("");
          }}
        >
          {creating ? "I have an account" : "Create an account"}
        </Button>
      }
    >
      <Block>
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            label="Email"
            type="email"
            autoComplete="username"
            spellCheck={false}
            value={email}
            disabled={!encryptionAvailable || busy}
            error={fieldError === "email" ? error : null}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full max-w-96"
            data-testid="account-email"
          />
          <Input
            label="Password"
            type="password"
            autoComplete={creating ? "new-password" : "current-password"}
            value={password}
            disabled={!encryptionAvailable || busy}
            error={fieldError === "password" ? error : null}
            description={creating ? "At least 8 characters." : undefined}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full max-w-96"
            data-testid="account-password"
          />
          {creating ? (
            <Input
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              disabled={!encryptionAvailable || busy}
              error={fieldError === "confirm" ? error : null}
              onChange={(event) => setConfirm(event.target.value)}
              className="w-full max-w-96"
              data-testid="account-confirm"
            />
          ) : null}
          {error === null || fieldError !== null ? null : (
            <Note type="error" size="sm" data-testid="account-error">
              {error}
            </Note>
          )}
          <span>
            <Button type="submit" size="sm" loading={busy} disabled={!encryptionAvailable} data-testid="account-submit">
              {creating ? "Create account" : "Sign in"}
            </Button>
          </span>
        </form>
      </Block>
    </Group>
  );
}

/* ------------------------------- enrolled ------------------------------- */

function Enrolled() {
  const account = useAppStore((state) => state.account);
  const enrolled = accountStep(account) === "done";
  // Enrolling flips `account.state`, which unmounts `EnrollCard` in the same
  // commit. The code is shown exactly once and cannot be asked for again, so
  // it has to live on a component that survives that flip.
  const [enrollCode, setEnrollCode] = useState<string | null>(null);

  return (
    <>
      <Group title="This account" note="What control knows about you, and what this Mac holds for it.">
        <Row label="Email" note="The address the account signs in with.">
          <span className="text-label-13 text-gray-900">{account.email ?? "unknown"}</span>
        </Row>
        <Row label="State" note={enrolled ? "This Mac's key pair is enrolled and accepted." : "Signed up, but this Mac has not enrolled its keys yet."}>
          <Badge
            variant={
              accountStateTone(account) === "green"
                ? "green-subtle"
                : accountStateTone(account) === "amber"
                  ? "amber-subtle"
                  : accountStateTone(account) === "red"
                    ? "red-subtle"
                    : "gray-subtle"
            }
            size="sm"
          >
            {accountStateLabel(account)}
          </Badge>
        </Row>
        <Row label="Control plane" note="Where enrollment, wrappers, and hosted runs live.">
          <span className="font-mono text-label-12 break-all text-gray-900">{account.controlUrl}</span>
        </Row>
        <DeviceNameRow />
      </Group>

      {enrolled ? null : <EnrollCard onEnrolled={setEnrollCode} />}
      {enrolled ? <ModelUsageCard /> : null}
      {enrolled ? <IMessageCard /> : null}
      {enrollCode === null ? null : (
        <Group
          title="Save your recovery code"
          note="Shown once. It is the only way back into your synced sessions if you forget your password."
        >
          <Block>
            <RecoveryCodeBlock code={enrollCode} />
          </Block>
        </Group>
      )}
      {enrolled ? <RecoveryCodeCard /> : null}
      {enrolled ? <ChangePasswordCard /> : null}
      <SignOutCard />
    </>
  );
}

/**
 * What control's answer means, by its error code rather than by whether the
 * code happens to appear somewhere in the flattened message — a path or an
 * explanation that contains one of these words is not that failure.
 */
function imessageError(error: unknown): string {
  switch (controlErrorCode(error)) {
    case "invalid_phone":
      return "Enter a valid mobile number, including the country code when outside the US.";
    case "invalid_code":
      return "That code is wrong or has expired.";
    case "phone_already_linked":
      return "That number is already linked to another Pistachio account.";
    case "rate_limited":
      return "Too many codes were requested. Wait ten minutes and try again.";
    case "otp_delivery_failed":
      return "The verification text could not be sent. Try again in a moment.";
    case "imessage_unavailable":
      return "iMessage linking is not configured on this Pistachio service.";
    default:
      return "iMessage could not be updated. Check your connection and try again.";
  }
}

/**
 * The account's model meter, read once on mount. Models come with the
 * account, so this is the one place a person sees what the agent, memory,
 * and read-aloud have spent on their behalf — the gateway's own figures,
 * for today and the month, and the month by model.
 */
function ModelUsageCard() {
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void shellApi().getAiUsage().then(
      (next) => {
        if (cancelled) return;
        if (next === null) setError("Enroll this Mac to read the meter.");
        else setUsage(next);
      },
      () => {
        if (!cancelled) setError("The meter could not be read. Check your connection and try again.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const monthStarted = usage === null ? "" : new Date(usage.since.month).toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" });

  return (
    <Group
      title="Model usage"
      note="What the agent, memory, and read-aloud have spent through your account. The models come with it; these are the gateway's own figures, in UTC."
      footer={usage === null ? undefined : `Since ${monthStarted}. Kept for 90 days.`}
    >
      {usage === null && error === null ? (
        <Row label="Today" note="Reading the meter…">
          <Badge variant="gray-subtle" size="sm">Checking</Badge>
        </Row>
      ) : usage === null ? (
        <Block>
          <Note type="warning" size="sm">{error}</Note>
        </Block>
      ) : (
        <>
          <Row label="Today" note={usageLine(usage.day)}>
            <span className="font-mono text-label-13 text-gray-900" data-testid="ai-usage-day">{formatUsd(usage.day.costUsd)}</span>
          </Row>
          <Row label="This month" note={usageLine(usage.month)}>
            <span className="font-mono text-label-13 text-gray-900" data-testid="ai-usage-month">{formatUsd(usage.month.costUsd)}</span>
          </Row>
          <Row
            label="Monthly cap"
            note={
              usage.cap.monthlyUsd === null
                ? "No cap. Set one on the web app under Settings → Plan & billing."
                : usage.cap.reached
                  ? "Reached: model calls are refused on every device until the month turns or the cap is raised on the web app."
                  : "Once the month's cost reaches it, model calls are refused on every device. Change it on the web app."
            }
          >
            <Badge variant={usage.cap.reached ? "red-subtle" : usage.cap.monthlyUsd === null ? "gray-subtle" : "green-subtle"} size="sm">
              {usage.cap.monthlyUsd === null ? "None" : `${formatUsd(usage.cap.monthlyUsd)} / month`}
            </Badge>
          </Row>
          {usage.models.length === 0 ? null : (
            <Block label="By model" note="This month, most requests first.">
              <ul className="flex flex-col gap-2" data-testid="ai-usage-models">
                {usage.models.map((row) => (
                  <li key={`${row.kind}:${row.modelId ?? ""}`} className="flex items-baseline justify-between gap-4">
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-label-12 text-gray-1000">{modelUsageLabel(row)}</span>
                      <span className="block text-label-12 text-gray-700">{usageLine(row)}</span>
                    </span>
                    <span className="shrink-0 font-mono text-label-12 text-gray-900">{formatUsd(row.costUsd)}</span>
                  </li>
                ))}
              </ul>
            </Block>
          )}
        </>
      )}
    </Group>
  );
}

function IMessageCard() {
  const [status, setStatus] = useState<IMessageLinkStatus | null>(null);
  const [phone, setPhone] = useState("");
  const [challenge, setChallenge] = useState<IMessageLinkChallenge | null>(null);
  const [code, setCode] = useState("");
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  // Every one of these rejects rather than resolving a failure, so the codes
  // control sends are turned into sentences in one place.
  const { busy, error, setError, run } = useAsyncAction(imessageError);

  useEffect(() => {
    let cancelled = false;
    void shellApi().getIMessageLink().then(
      (next) => {
        if (!cancelled) setStatus(next);
      },
      (cause: unknown) => {
        if (!cancelled) setError(imessageError(cause));
      },
    );
    return () => {
      cancelled = true;
    };
    // `setError` is the action's own state setter, stable for the component's
    // life; the effect still runs once, on mount.
  }, [setError]);

  const sendCode = async () => {
    if (busy || phone.trim() === "") return;
    await run(async () => {
      setChallenge(await shellApi().startIMessageLink(phone));
      setCode("");
      return null;
    });
  };

  const verify = async () => {
    if (busy || challenge === null || !/^\d{6}$/u.test(code)) return;
    await run(async () => {
      setStatus(await shellApi().verifyIMessageLink(challenge.challengeId, code));
      setChallenge(null);
      setCode("");
      setPhone("");
      return null;
    });
  };

  const unlink = () =>
    run(async () => {
      setStatus(await shellApi().unlinkIMessage());
      setConfirmingUnlink(false);
      return null;
    });

  return (
    <>
      <Group
        title="iMessage"
        note="Get agent questions and finished results by text, then reply without opening Pistachio."
        footer="Only questions and final results are sent. Reasoning traces, tool activity, and ordinary progress messages stay in Pistachio."
        footerHighlight
      >
        {status === null && error === null ? (
          <Row label="Phone number" note="Checking the connection with the control plane…">
            <Badge variant="gray-subtle" size="sm">Checking</Badge>
          </Row>
        ) : status?.linked ? (
          <Row label="Connected number" note={`Verified ${status.verifiedAt === null ? "for this account" : new Date(status.verifiedAt).toLocaleDateString()}. Replies answer the newest pending agent question.`}>
            <span className="flex items-center gap-2">
              <span className="font-mono text-label-13 text-gray-900" data-testid="imessage-linked-phone">{status.phone}</span>
              <Button variant="secondary" size="sm" onClick={() => setConfirmingUnlink(true)}>Disconnect…</Button>
            </span>
          </Row>
        ) : status?.available === false ? (
          <Block>
            <Note type="warning" size="sm">BlueBubbles is not configured on this Pistachio service, so phone linking is unavailable.</Note>
          </Block>
        ) : challenge === null ? (
          <Block label="Connect your phone" note="We’ll text a six-digit code to verify that the number belongs to you.">
            <form
              className="flex items-end gap-2 @max-md:items-stretch @max-md:flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                void sendCode();
              }}
            >
              <Input
                label="Mobile number"
                type="tel"
                autoComplete="tel"
                value={phone}
                disabled={busy}
                placeholder="+1 212 555 0123"
                onChange={(event) => setPhone(event.target.value)}
                className="w-full max-w-80"
                data-testid="imessage-phone"
              />
              <Button type="submit" size="sm" loading={busy} disabled={phone.trim() === ""}>Send code</Button>
            </form>
          </Block>
        ) : (
          <Block label={`Enter the code sent to ${challenge.phone}`} note="The code expires after ten minutes.">
            <form
              className="flex items-end gap-2 @max-md:items-stretch @max-md:flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                void verify();
              }}
            >
              <Input
                label="Verification code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                disabled={busy}
                placeholder="000000"
                onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
                className="w-full max-w-52 font-mono tracking-[0.18em]"
                data-testid="imessage-code"
              />
              <Button type="submit" size="sm" loading={busy} disabled={!/^\d{6}$/u.test(code)}>Verify number</Button>
              <Button type="button" variant="tertiary" size="sm" disabled={busy} onClick={() => setChallenge(null)}>Use another number</Button>
            </form>
          </Block>
        )}
        {error === null ? null : (
          <Block><Note type="error" size="sm">{error}</Note></Block>
        )}
      </Group>
      {confirmingUnlink ? (
        <ConfirmDialog
          icon={<Unlink aria-hidden="true" />}
          title="Disconnect iMessage?"
          subtitle={status?.phone ?? "This phone number"}
          does={["Stops new agent questions and finished results from being sent to this number.", "Removes the verified number from this account."]}
          doesNot={["Does not stop or delete any agent run.", "Does not remove messages already in the Messages app."]}
          confirmLabel="Disconnect"
          busy={busy}
          error={error}
          onClose={() => {
            setConfirmingUnlink(false);
            setError(null);
          }}
          onConfirm={() => void unlink()}
          testId="imessage-unlink-dialog"
        >
          <Note size="sm" icon={<MessageCircle aria-hidden="true" />}>You can reconnect this or another number at any time.</Note>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function DeviceNameRow() {
  const deviceId = useAppStore((state) => state.account.deviceId);
  const deviceName = useAppStore((state) => state.account.deviceName);
  const enrolled = useAppStore((state) => state.account.state === "enrolled");
  const renameDevice = useAppStore((state) => state.renameDevice);
  const [draft, setDraft] = useState<string | null>(null);
  const { busy, error, setError, run } = useAsyncAction();

  const save = async () => {
    if (deviceId === null || draft === null) return;
    const name = draft.trim();
    if (name === "") {
      setError("A device needs a name.");
      return;
    }
    if (await run(() => renameDevice(deviceId, name))) setDraft(null);
  };

  if (draft === null) {
    return (
      <Row
        label="This Mac"
        note={
          enrolled
            ? `How this machine is named in the device list${deviceId === null ? "" : ` · ${deviceId}`}`
            : "Naming happens on the control plane, so it waits until this Mac is enrolled."
        }
      >
        <span className="flex items-center gap-2">
          <span className="text-label-13 text-gray-900">{deviceName}</span>
          <Button
            variant="tertiary"
            size="sm"
            disabled={deviceId === null || !enrolled}
            onClick={() => setDraft(deviceName)}
          >
            Rename
          </Button>
        </span>
      </Row>
    );
  }
  return (
    <Block label="This Mac" note="The name your other devices see in their device list.">
      <div className="flex flex-wrap items-start gap-2">
        <Input
          autoFocus
          value={draft}
          maxLength={64}
          error={error}
          disabled={busy}
          aria-label="Device name"
          onChange={(event) => setDraft(event.target.value)}
          className="w-64"
          containerClassName="w-64"
        />
        <Button size="sm" loading={busy} onClick={() => void save()}>
          Save
        </Button>
        <Button
          variant="tertiary"
          size="sm"
          disabled={busy}
          onClick={() => {
            setDraft(null);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </Block>
  );
}

function EnrollCard({ onEnrolled }: { onEnrolled: (code: string | null) => void }) {
  const enrollDevice = useAppStore((state) => state.enrollDevice);
  const { busy, error, run } = useAsyncAction();

  const enroll = () =>
    run(async () => {
      const result = await enrollDevice();
      if (!result.ok) return result.error;
      onEnrolled(result.value.recoveryCode);
      return null;
    });

  return (
    <Group
      title="Enroll this Mac"
      note="Enrollment registers this machine's signing and agreement keys with the account. Only then does anything sync."
      footer="The keys never leave this Mac; control sees their public halves."
      footerAction={
        <Button size="sm" loading={busy} onClick={() => void enroll()} data-testid="account-enroll">
          Enroll this Mac
        </Button>
      }
    >
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

function RecoveryCodeCard() {
  const generateRecoveryCode = useAppStore((state) => state.generateRecoveryCode);
  const [code, setCode] = useState<string | null>(null);
  const { busy, error, run } = useAsyncAction();

  const generate = () =>
    run(async () => {
      const result = await generateRecoveryCode();
      if (!result.ok) return result.error;
      setCode(result.value);
      return null;
    });

  return (
    <Group
      title="Recovery code"
      note="A second way to unwrap your Space keys if you forget the password. Generating one retires the previous code."
      footer={code === null ? "Shown once, right here. Nothing keeps a copy — not this Mac, not control." : "Keep it somewhere a password manager cannot lose."}
      footerHighlight={code !== null}
      footerAction={
        <Button variant="secondary" size="sm" loading={busy} onClick={() => void generate()} data-testid="account-recovery">
          {code === null ? "Generate a recovery code" : "Generate another"}
        </Button>
      }
    >
      {error === null ? null : (
        <Block>
          <Note type="error" size="sm">
            {error}
          </Note>
        </Block>
      )}
      {code === null ? null : (
        <Block>
          <RecoveryCodeBlock code={code} />
        </Block>
      )}
    </Group>
  );
}

/** The code, once, with the warning that makes "once" survivable. */
function RecoveryCodeBlock({ code }: { code: string }) {
  return (
    <OneTimeSecret
      value={code}
      testId="recovery-code"
      warning={
        <>
          This is the only time this code is shown. Write it down now — Pistachio cannot show it again, and without it a
          forgotten password means the sealed sessions on the control plane can never be opened.
        </>
      }
    />
  );
}

function ChangePasswordCard() {
  const changePassword = useAppStore((state) => state.changePassword);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, setError, run } = useAsyncAction();

  const save = async () => {
    setError(null);
    setDone(false);
    if (next.length < 8) {
      setError("Choose a password of at least 8 characters.");
      return;
    }
    if (!(await run(() => changePassword(current, next)))) return;
    setCurrent("");
    setNext("");
    setDone(true);
  };

  return (
    <Group
      title="Change password"
      note="Every Space wrapper is re-sealed under the new password from this Mac. Devices that are offline pick the new wrappers up when they next reach control."
      footer={done ? "Password changed and every wrapper re-sealed." : "Your recovery code keeps working; only password wrappers are replaced."}
      footerHighlight={done}
      footerAction={
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          disabled={current === "" || next === ""}
          onClick={() => void save()}
          data-testid="account-change-password"
        >
          Change password
        </Button>
      }
    >
      <Block>
        <div className="flex flex-col gap-3.5">
          <Input
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={current}
            disabled={busy}
            onChange={(event) => setCurrent(event.target.value)}
            className="w-full max-w-96"
          />
          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            value={next}
            disabled={busy}
            description="At least 8 characters."
            onChange={(event) => setNext(event.target.value)}
            className="w-full max-w-96"
          />
          {error === null ? null : (
            <Note type="error" size="sm">
              {error}
            </Note>
          )}
        </div>
      </Block>
    </Group>
  );
}

function SignOutCard() {
  const signOut = useAppStore((state) => state.signOut);
  const [open, setOpen] = useState(false);
  const { busy, error, setError, run } = useAsyncAction();

  const confirm = async () => {
    if (await run(() => signOut())) setOpen(false);
  };

  return (
    <>
      <Group
        title="Sign out of this Mac"
        note="Forgets the account here: keys, tokens, and every Space's cookie jar. Your Spaces, tabs, and settings stay."
        footer="The account and your other devices are untouched."
        footerAction={
          <Button variant="error" size="sm" prefix={<LogOut aria-hidden="true" />} onClick={() => setOpen(true)} data-testid="account-sign-out">
            Sign out…
          </Button>
        }
      >
        {null}
      </Group>
      {open ? (
        <ConfirmDialog
          icon={<LogOut aria-hidden="true" />}
          title="Sign out of this Mac?"
          subtitle="You will be signed out of every site in every Space on this machine."
          does={[
            "Deletes this Mac's account keys, device token, and Space secrets.",
            "Clears every Space's cookies, storage, and cache, then reloads its tabs.",
            "Stops sync; nothing more is published or pulled from this machine.",
          ]}
          doesNot={[
            "Does not delete your account, your Spaces, your tabs, or your settings.",
            "Does not sign out your other devices or the cloud browser.",
            "Does not remove anything already published — signing in again restores it.",
          ]}
          confirmLabel="Sign out"
          busy={busy}
          error={error}
          onClose={() => {
            setOpen(false);
            setError(null);
          }}
          onConfirm={() => void confirm()}
          testId="sign-out-dialog"
        />
      ) : null}
    </>
  );
}
