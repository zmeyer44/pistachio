"use client";

/**
 * Settings → iMessage: link a phone number so agent questions and finished
 * results arrive by text, and answer them by replying.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Button,
  ControlError,
  Field,
  getIMessageLink,
  type IMessageLinkChallenge,
  type IMessageLinkStatus,
  Note,
  Section,
  startIMessageLink,
  Status,
  unlinkIMessage,
  useSession,
  verifyIMessageLink,
  When,
} from "@pistachio/web-account";

function messageOf(error: unknown): string {
  if (error instanceof ControlError) {
    switch (error.code) {
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
    }
  }
  return error instanceof Error ? error.message : "iMessage could not be updated.";
}

export function IMessageSection(): ReactNode {
  const { token } = useSession();
  const [status, setStatus] = useState<IMessageLinkStatus | null>(null);
  const [phone, setPhone] = useState("");
  const [challenge, setChallenge] = useState<IMessageLinkChallenge | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (token === null) return;
    try {
      setStatus(await getIMessageLink(token));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sendCode = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (token === null || phone.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      setChallenge(await startIMessageLink(token, phone));
      setCode("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (token === null || challenge === null || !/^\d{6}$/u.test(code) || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await verifyIMessageLink(token, challenge.challengeId, code));
      setChallenge(null);
      setPhone("");
      setCode("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (token === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await unlinkIMessage(token);
      await refresh();
      setConfirmingUnlink(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section note="Only questions and final results are sent. Reasoning traces, tool activity, and ordinary progress messages stay in Pistachio.">
        {error === null ? null : <Note tone="alert">{error}</Note>}
        {status === null && error === null ? (
          <p className="pa-caption">Checking your connection…</p>
        ) : status?.linked ? (
          <div className="pa-section rounded-lg border border-alpha-400 p-4" data-testid="imessage-linked">
            <div className="pa-row">
              <div>
                <p className="pa-label">{status.phone}</p>
                <p className="pa-caption">
                  Verified {status.verifiedAt === null ? "for this account" : <When iso={status.verifiedAt} relative />}.
                </p>
              </div>
              <Status tone="good">Connected</Status>
            </div>
            {confirmingUnlink ? (
              <div className="pa-section rounded-md border border-red-400 bg-red-100 p-3">
                <p className="pa-body">Disconnect this number? New questions and results will stop, but existing runs and messages are unchanged.</p>
                <div className="flex gap-2">
                  <Button type="button" variant="alert" disabled={busy} onClick={() => void disconnect()}>
                    {busy ? "Disconnecting…" : "Disconnect"}
                  </Button>
                  <Button type="button" disabled={busy} onClick={() => setConfirmingUnlink(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div>
                <Button type="button" variant="alert" onClick={() => setConfirmingUnlink(true)}>Disconnect…</Button>
              </div>
            )}
          </div>
        ) : status?.available === false ? (
          <Note tone="alert">BlueBubbles is not configured on this Pistachio service, so phone linking is unavailable.</Note>
        ) : challenge === null ? (
          <form className="pa-section max-w-md" onSubmit={(event) => void sendCode(event)}>
            <Field
              label="Mobile number"
              help="We’ll text a six-digit code to verify that this number belongs to you."
              type="tel"
              autoComplete="tel"
              placeholder="+1 212 555 0123"
              value={phone}
              disabled={busy}
              onChange={(event) => setPhone(event.target.value)}
              data-testid="imessage-phone"
              required
            />
            <div>
              <Button type="submit" variant="primary" disabled={busy || phone.trim() === ""}>
                {busy ? "Sending…" : "Send code"}
              </Button>
            </div>
          </form>
        ) : (
          <form className="pa-section max-w-md" onSubmit={(event) => void verify(event)}>
            <Field
              label="Verification code"
              help={`Enter the code sent to ${challenge.phone}. It expires after ten minutes.`}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="000000"
              value={code}
              disabled={busy}
              onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
              data-testid="imessage-code"
              required
            />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={busy || !/^\d{6}$/u.test(code)}>
                {busy ? "Verifying…" : "Verify number"}
              </Button>
              <Button type="button" disabled={busy} onClick={() => setChallenge(null)}>Use another number</Button>
            </div>
          </form>
        )}
      </Section>

      <Section heading="How replies work">
        <div className="pa-section pa-body">
          <p>Multiple-choice questions arrive as a numbered list. Reply with a number, the option text, or in your own words and the agent will take it from there.</p>
          <p>Free-text questions arrive as a plain question. Your next non-empty message is used as the answer.</p>
          <p>If several agents are waiting, your reply answers the most recently texted question; older questions remain available in Pistachio.</p>
        </div>
      </Section>
    </>
  );
}
