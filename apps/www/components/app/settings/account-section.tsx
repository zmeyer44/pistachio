"use client";

/**
 * Settings → Account: the facts control holds about this account, a
 * password change that re-seals every Space this browser holds the secrets
 * for, and the way out of this browser.
 *
 * The password change is the one thing here that is not a single request:
 * control changes the hash, then this tab uploads fresh password wrappers
 * (@pistachio/web-account, keys.ts). A session unlocked from the remembered vault has no
 * root secrets to re-seal, so it is sent to unlock first rather than left
 * with a password that opens nothing.
 */

import { useState, type FormEvent, type ReactNode } from "react";
import {
  Button,
  changePasswordAndRewrap,
  ControlError,
  Field,
  Note,
  Section,
  Status,
  useSession,
} from "@pistachio/web-account";

const FEATURE_LABELS: Record<string, string> = {
  sync: "Sync",
  "cloud-browser": "Cloud browser",
  egress: "Identity egress",
  imessage: "iMessage",
};

function passwordError(error: unknown): string {
  if (error instanceof ControlError) {
    if (error.status === 403 && error.code === "invalid_credentials") return "The current password is wrong.";
    if (error.status === 429) return "Too many attempts. Wait a few minutes and try again.";
  }
  return error instanceof Error ? error.message : "The password could not be changed.";
}

export function AccountSection(): ReactNode {
  const { account, identity, keys, token, relock, signOut } = useSession();
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canRewrap = keys !== null && keys.rootSecrets.size > 0;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (token === null || keys === null || busy) return;
    if (next.length < 8) {
      setError("Choose a password of at least 8 characters.");
      return;
    }
    if (next !== again) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePasswordAndRewrap(token, keys, current, next);
      setDone(true);
      setChanging(false);
      setCurrent("");
      setNext("");
      setAgain("");
    } catch (cause) {
      setError(passwordError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section note="What the control plane knows about you, and what this browser holds for it.">
      <dl className="pa-facts" data-testid="account-facts">
        <div>
          <dt>Email</dt>
          <dd>{account?.email ?? "unknown"}</dd>
        </div>
        <div>
          <dt>This browser</dt>
          <dd>
            <Status tone="good">Enrolled as a device</Status>
          </dd>
        </div>
        <div>
          <dt>Device id</dt>
          <dd className="pa-mono">{identity?.deviceId ?? "—"}</dd>
        </div>
        <div>
          <dt>Account id</dt>
          <dd className="pa-mono">{account?.userId ?? "—"}</dd>
        </div>
        <div>
          <dt>Enabled on this service</dt>
          <dd>{(account?.features ?? []).map((feature) => FEATURE_LABELS[feature] ?? feature).join(", ") || "—"}</dd>
        </div>
      </dl>

      {done ? <Note>Your password was changed and every Space was re-sealed under it. Other devices will ask for the new one.</Note> : null}
      {error === null ? null : <Note tone="alert">{error}</Note>}

      {changing ? (
        <form className="pa-section max-w-md" onSubmit={(event) => void submit(event)} data-testid="password-form">
          {canRewrap ? null : (
            <Note tone="alert">
              This browser is unlocked from remembered keys and holds no Space secrets to re-seal.{" "}
              <button type="button" className="underline" onClick={() => void relock({ preserveRemembered: true })}>
                Unlock with your password
              </button>{" "}
              first, then change it here.
            </Note>
          )}
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={current}
            disabled={busy || !canRewrap}
            onChange={(event) => setCurrent(event.target.value)}
            required
          />
          <Field
            label="New password"
            help="At least 8 characters. It derives the key that seals every Space, so the recovery code is the only other way in."
            type="password"
            autoComplete="new-password"
            value={next}
            disabled={busy || !canRewrap}
            onChange={(event) => setNext(event.target.value)}
            required
          />
          <Field
            label="New password, again"
            type="password"
            autoComplete="new-password"
            value={again}
            disabled={busy || !canRewrap}
            onChange={(event) => setAgain(event.target.value)}
            required
          />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy || !canRewrap || current === "" || next === "" || again === ""}>
              {busy ? "Changing…" : "Change password"}
            </Button>
            <Button type="button" disabled={busy} onClick={() => setChanging(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => setChanging(true)}>
            Change password…
          </Button>
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              if (confirm("Sign out of this browser? Your Spaces and records stay on the account; this browser forgets its keys.")) void signOut();
            }}
          >
            Sign out of this browser
          </Button>
        </div>
      )}
    </Section>
  );
}
