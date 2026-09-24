"use client";

/**
 * Settings → Plan & billing.
 *
 * What there is to control: the account's monthly spend cap on the model
 * meter (`PUT /v1/ai-usage/cap`). Once the month's cost reaches it, every
 * model call on every device is refused until the month turns or the cap
 * moves — the agent says so, plainly. No cap is the default.
 *
 * What there is not: a payment method or an invoice. Billing was left out
 * of this control plane on purpose (docs/cloud-sync-design.md §7), so model
 * usage is carried by the operator's gateway key and the cap is the
 * account's own ceiling on that, not a charge. The section says so rather
 * than showing a card form that goes nowhere.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  type AiUsageSummary,
  Button,
  capFraction,
  capTone,
  Field,
  formatUsd,
  Note,
  parseCapInput,
  Section,
  setAiUsageCap,
  Status,
  useSession,
} from "@pistachio/web-account";

export function BillingSection({
  usage,
  onUsage,
}: {
  usage: AiUsageSummary | null;
  /** The refreshed summary, after the cap moved. */
  onUsage: (next: AiUsageSummary) => void;
}): ReactNode {
  const { token } = useSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The field opens on what is set, not on what was last typed.
  useEffect(() => {
    if (editing) setDraft(usage?.cap.monthlyUsd ?? "");
  }, [editing, usage?.cap.monthlyUsd]);

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (token === null || busy) return;
    const cap = parseCapInput(draft);
    if (cap === undefined) {
      setError("Enter an amount in dollars, or leave it blank for no cap.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onUsage(await setAiUsageCap(token, cap));
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The cap could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (token === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      onUsage(await setAiUsageCap(token, null));
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The cap could not be removed.");
    } finally {
      setBusy(false);
    }
  };

  const fraction = usage === null ? null : capFraction(usage.month.costUsd, usage.cap.monthlyUsd);
  const tone = capTone(fraction);

  return (
    <Section note="Once the month's spend reaches the cap, model calls are refused on every device until the month turns or the cap moves.">
      <dl className="pa-facts" data-testid="billing-facts">
        <div>
          <dt>Plan</dt>
          <dd>Included models, metered</dd>
        </div>
        <div>
          <dt>Payment method</dt>
          <dd className="pa-caption">None on this service</dd>
        </div>
        <div>
          <dt>
            Monthly cap
            {usage === null ? null : (
              <span className="pa-help block">
                {usage.cap.monthlyUsd === null
                  ? "No cap. Every model call goes through."
                  : `${formatUsd(usage.month.costUsd)} of ${formatUsd(usage.cap.monthlyUsd)} used this month.`}
              </span>
            )}
          </dt>
          <dd>
            {usage === null ? (
              <span className="pa-caption">…</span>
            ) : usage.cap.reached ? (
              <Status tone="alert">Reached — calls are refused</Status>
            ) : usage.cap.monthlyUsd === null ? (
              <Status>No cap</Status>
            ) : (
              <Status tone="good">{formatUsd(usage.cap.monthlyUsd)} / month</Status>
            )}
          </dd>
        </div>
      </dl>

      {fraction === null ? null : (
        <span className="pa-meter" data-tone={tone === "ok" ? undefined : tone} role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={fraction} aria-label="Share of the monthly cap used">
          <span style={{ width: `${String(Math.round(fraction * 100))}%` }} />
        </span>
      )}

      {usage?.cap.reached ? (
        <Note tone="alert">
          The cap was reached, so the agent, memory search, and read-aloud are paused on every device until {" "}
          {new Date(new Date(usage.since.month).getTime()).toLocaleDateString(undefined, { month: "long", timeZone: "UTC" })} ends
          or the cap is raised.
        </Note>
      ) : null}

      {error === null ? null : <Note tone="alert">{error}</Note>}

      {editing ? (
        <form className="pa-section max-w-md" onSubmit={(event) => void save(event)} data-testid="cap-form">
          <Field
            label="Monthly cap, in dollars"
            help="Applies to every device on the account, on the gateway's own cost figures, per calendar month in UTC. Blank means no cap."
            type="text"
            inputMode="decimal"
            placeholder="25"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Saving…" : "Save cap"}
            </Button>
            {usage?.cap.monthlyUsd === null ? null : (
              <Button type="button" variant="alert" disabled={busy} onClick={() => void remove()}>
                Remove cap
              </Button>
            )}
            <Button type="button" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button type="button" disabled={usage === null} onClick={() => setEditing(true)}>
            {usage?.cap.monthlyUsd === null ? "Set a cap…" : "Change cap…"}
          </Button>
        </div>
      )}

      <p className="pa-caption">
        There is nothing to pay here: this control plane carries no payment method and issues no invoices. The cap is a
        ceiling you set on the meter, not a charge.
      </p>
    </Section>
  );
}
