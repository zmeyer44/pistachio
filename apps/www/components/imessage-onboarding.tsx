"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, BrandMark } from "./primitives";
import { Button } from "./ui/button";
import { ControlError, getIMessageOnboarding, PIN_LENGTH, useSession } from "@pistachio/web-account";

type TicketState =
  | { kind: "loading" }
  | { kind: "ready"; token: string; phone: string; expiresAt: string }
  /** Control answered: the link is spent, expired, or malformed. */
  | { kind: "invalid"; message: string }
  /** Control did not answer (offline, CORS, wrong API origin) or is degraded; the link may be fine. */
  | { kind: "unreachable"; message: string; detail: string | null };

/** Only a definitive answer from control means the link itself is bad. */
function ticketFailure(cause: unknown): TicketState {
  if (cause instanceof ControlError) {
    if (cause.status === 503) {
      return {
        kind: "unreachable",
        message: "iMessage setup is temporarily unavailable. Try again in a moment.",
        detail: null,
      };
    }
    return {
      kind: "invalid",
      message:
        "This secure link has expired or was already used. Send Pistachio another message to get a new one.",
    };
  }
  return {
    kind: "unreachable",
    message:
      "This browser couldn't reach Pistachio's servers, so the link hasn't been checked yet. Check your connection and try again.",
    detail: cause instanceof Error ? cause.message : null,
  };
}

function Field({
  label,
  type,
  value,
  autoComplete,
  minLength,
  onChange,
}: {
  label: string;
  type: "email" | "password";
  value: string;
  autoComplete: string;
  minLength?: number;
  onChange(value: string): void;
}): ReactNode {
  const id = `onboarding-${type}`;
  return (
    <label htmlFor={id} className="flex flex-col gap-2 text-12 text-ink">
      {label}
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        minLength={minLength}
        required
        onChange={(event) => onChange(event.target.value)}
        className="h-12 rounded-lg border border-green/25 bg-paper px-3 text-16 text-ink outline-none transition focus:border-green focus:ring-3 focus:ring-green/10"
      />
    </label>
  );
}

function SecureBadge(): ReactNode {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-green/15 bg-paper/80 px-3 py-1.5 text-12 text-ink backdrop-blur">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-green/35" />
        <span className="relative inline-flex size-2 rounded-full bg-green" />
      </span>
      Number verified by this private link
    </div>
  );
}

export function IMessageOnboarding(): ReactNode {
  const router = useRouter();
  const { signIn, busy, error } = useSession();
  const [ticket, setTicket] = useState<TicketState>({ kind: "loading" });
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-up");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Staying unlocked now seals the keys under a PIN, but the PIN is chosen on
  // the account layer's own screen once the password has worked — so this is
  // still just the intent, and the ceremony happens on the way to `/app`.
  const [keep, setKeep] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const token = window.location.hash.replace(/^#/u, "");
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      setTicket({
        kind: "invalid",
        message:
          "This secure link is incomplete. Send Pistachio another message to get a new one.",
      });
      return;
    }
    let cancelled = false;
    setTicket({ kind: "loading" });
    void getIMessageOnboarding(token)
      .then((value) => {
        if (!cancelled) setTicket({ kind: "ready", token, ...value });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setTicket(ticketFailure(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (ticket.kind !== "ready" || busy || finishing) return;
    setFinishing(true);
    void signIn(email.trim(), password, mode, keep, ticket.token).then(
      (ok) => {
        if (!ok) {
          setFinishing(false);
          return;
        }
        // Remove the capability from browser history before entering the app.
        window.history.replaceState(window.history.state, "", "/onboarding/imessage");
        router.replace("/app");
      },
    );
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-cream text-ink">
      <div
        aria-hidden="true"
        className="absolute -top-32 -left-24 size-[420px] rounded-full bg-field/55 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="absolute right-[-140px] bottom-[-180px] size-[520px] rounded-full bg-sage/30 blur-3xl"
      />

      <header className="relative mx-auto flex w-full max-w-[1180px] items-center justify-between px-5 py-5 tab:px-8">
        <Link
          href="/"
          className="flex items-center gap-2.5"
          aria-label="Pistachio home"
        >
          <BrandMark
            name="pistachio-mark"
            className="h-[28px]"
            style={{ aspectRatio: "22 / 23" }}
          />
          <span className="text-20 font-semibold tracking-[-0.03em]">
            Pistachio
          </span>
        </Link>
        <span className="hidden text-12 text-ink tab:block">
          Onboarding from Messages
        </span>
      </header>

      <div className="relative mx-auto grid w-full max-w-[1180px] items-center gap-12 px-5 pt-8 pb-16 tab:min-h-[calc(100vh-74px)] tab:grid-cols-[1fr_440px] tab:px-8 tab:pt-0">
        <section className="max-w-[610px]">
          <SecureBadge />
          <h1 className="mt-6 text-[44px] leading-[0.98] font-medium tracking-[-0.055em] tab:text-[66px]">
            Your agent is now one message away.
          </h1>
          <p className="mt-6 max-w-[52ch] text-16 leading-7 text-ink tab:text-20">
            Connect the number that opened this link. After setup, any new
            message can start a Pistachio task—no desktop app required.
          </p>
          <ol className="mt-8 grid gap-3 text-14 text-ink tab:grid-cols-3">
            {[
              ["01", "Choose your account"],
              ["02", "We link this number"],
              ["03", "Text your first task"],
            ].map(([number, label]) => (
              <li key={number} className="border-t border-green/20 pt-3">
                <span className="mr-2 font-mono text-10 text-green/60">
                  {number}
                </span>
                {label}
              </li>
            ))}
          </ol>
        </section>

        <section className="relative rounded-[22px] border border-green/15 bg-paper/92 p-5 shadow-[0_28px_90px_rgba(0,77,38,0.14)] backdrop-blur-md tab:p-7">
          {ticket.kind === "loading" ? (
            <div className="flex min-h-[360px] items-center justify-center">
              <p className="text-14 text-ink">Checking your secure link…</p>
            </div>
          ) : ticket.kind === "invalid" ? (
            <div className="flex min-h-[360px] flex-col justify-center gap-5">
              <div
                className="flex size-11 items-center justify-center rounded-full bg-[#f7dfcf] text-[#8f3a09]"
                aria-hidden="true"
              >
                !
              </div>
              <div>
                <h2 className="text-24 tracking-[-0.03em]">
                  You’ll need a fresh link
                </h2>
                <p className="mt-2 text-14 leading-6 text-ink">
                  {ticket.message}
                </p>
              </div>
              <Link
                href="/app"
                className="text-14 font-medium underline underline-offset-4"
              >
                Continue without linking
              </Link>
            </div>
          ) : ticket.kind === "unreachable" ? (
            <div className="flex min-h-[360px] flex-col justify-center gap-5">
              <div
                className="flex size-11 items-center justify-center rounded-full bg-field text-ink"
                aria-hidden="true"
              >
                !
              </div>
              <div>
                <h2 className="text-24 tracking-[-0.03em]">
                  Couldn’t check your link
                </h2>
                <p className="mt-2 text-14 leading-6 text-ink">
                  {ticket.message}
                </p>
                {ticket.detail === null ? null : (
                  <p className="mt-2 font-mono text-10 leading-5 break-words text-ink/70">
                    {ticket.detail}
                  </p>
                )}
              </div>
              <Button type="button" onClick={() => setAttempt((count) => count + 1)}>
                Try again
                <ArrowRight size={16} />
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-10 font-medium tracking-[0.12em] text-ink uppercase">
                    Verified number
                  </p>
                  <h2 className="mt-1 text-24 tracking-[-0.03em]">
                    {ticket.phone}
                  </h2>
                </div>
                <span className="rounded-full bg-field px-2.5 py-1 text-10 font-medium">
                  Private
                </span>
              </div>

              <div
                className="mt-6 grid grid-cols-2 rounded-lg bg-tile p-1"
                role="tablist"
                aria-label="Account choice"
              >
                {(["sign-up", "sign-in"] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    role="tab"
                    aria-selected={mode === choice}
                    onClick={() => setMode(choice)}
                    className={`h-10 rounded-md text-14 transition ${mode === choice ? "bg-paper text-ink shadow-sm" : "text-ink hover:text-green"}`}
                  >
                    {choice === "sign-up" ? "Create account" : "Use existing"}
                  </button>
                ))}
              </div>

              <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
                <Field
                  label="Email"
                  type="email"
                  value={email}
                  autoComplete="email"
                  onChange={setEmail}
                />
                <Field
                  label="Password"
                  type="password"
                  value={password}
                  minLength={mode === "sign-up" ? 8 : undefined}
                  autoComplete={
                    mode === "sign-up" ? "new-password" : "current-password"
                  }
                  onChange={setPassword}
                />
                <label className="flex cursor-pointer items-start gap-2.5 text-12 text-ink">
                  <input
                    type="checkbox"
                    checked={keep}
                    onChange={(event) => setKeep(event.target.checked)}
                    className="mt-0.5 size-4 accent-green"
                  />
                  <span>
                    Keep this personal browser unlocked for 30 days, behind a {PIN_LENGTH}-digit PIN you pick next.
                  </span>
                </label>
                {error === null ? null : (
                  <p role="alert" className="text-12 leading-5 text-[#9a3d08]">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  size="lg"
                  className="mt-1 w-full"
                  disabled={busy || finishing}
                >
                  {busy || finishing
                    ? mode === "sign-up"
                      ? "Creating your agent…"
                      : "Connecting your account…"
                    : mode === "sign-up"
                      ? "Create and connect"
                      : "Sign in and connect"}
                  <ArrowRight size={16} />
                </Button>
                <p className="text-center text-10 leading-4 text-ink/75">
                  The link verifies this phone number. Your password still
                  protects your account and encrypted data.
                </p>
              </form>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
