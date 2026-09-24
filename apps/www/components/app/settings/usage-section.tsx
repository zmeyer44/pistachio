"use client";

/**
 * Settings → Model usage: what the agent, memory, and read-aloud have spent
 * through the account, as control's meter reports it (`GET /v1/ai-usage`).
 * The models come with the account, so this is the one place a person sees
 * the figures — the gateway's own, in UTC — for today and the month, and
 * the month by model.
 */

import type { ReactNode } from "react";
import {
  type AiUsageSummary,
  formatTokens,
  formatUsd,
  kindLabel,
  modelUsageLabel,
  Note,
  Section,
  Table,
  usageLine,
} from "@pistachio/web-account";

export function UsageSection({ usage, error }: { usage: AiUsageSummary | null; error: string | null }): ReactNode {
  const monthStarted =
    usage === null
      ? ""
      : new Date(usage.since.month).toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" });

  return (
    <Section note="The models come with your account; these are the gateway's own figures, in UTC.">
      {usage === null && error === null ? (
        <p className="pa-caption">Reading the meter…</p>
      ) : usage === null ? (
        <Note tone="alert">{error}</Note>
      ) : (
        <>
          <dl className="pa-facts" data-testid="usage-facts">
            <div>
              <dt>
                Today
                <span className="pa-help block">{usageLine(usage.day)}</span>
              </dt>
              <dd className="pa-num">{formatUsd(usage.day.costUsd)}</dd>
            </div>
            <div>
              <dt>
                This month
                <span className="pa-help block">{usageLine(usage.month)} · since {monthStarted}</span>
              </dt>
              <dd className="pa-num">{formatUsd(usage.month.costUsd)}</dd>
            </div>
          </dl>
          {usage.models.length === 0 ? null : (
            <Table
              caption="This month by model, most requests first. Kept for 90 days."
              head={
                <>
                  <th scope="col">Model</th>
                  <th scope="col">Kind</th>
                  <th scope="col" className="pa-n">
                    Requests
                  </th>
                  <th scope="col" className="pa-n">
                    Tokens in
                  </th>
                  <th scope="col" className="pa-n">
                    Tokens out
                  </th>
                  <th scope="col" className="pa-n">
                    Cost
                  </th>
                </>
              }
            >
              {usage.models.map((row) => (
                <tr key={`${row.kind}:${row.modelId ?? ""}`}>
                  <th scope="row" className="pa-mono font-normal">
                    {modelUsageLabel(row)}
                  </th>
                  <td>{kindLabel(row.kind)}</td>
                  <td className="pa-n">{row.requests}</td>
                  <td className="pa-n">{formatTokens(row.inputTokens)}</td>
                  <td className="pa-n">{formatTokens(row.outputTokens)}</td>
                  <td className="pa-n">{formatUsd(row.costUsd)}</td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </Section>
  );
}
