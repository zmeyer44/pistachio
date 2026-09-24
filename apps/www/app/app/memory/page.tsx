"use client";

import { useMemo, type ReactNode } from "react";
import type { MemoryRecord } from "@pistachio/sync-protocol";
import { Empty, Intro, Note, Page, Section, Table, useSession, When } from "@pistachio/web-account";

const BUCKET_ORDER = ["profile", "preference", "location", "project", "contact", "account", "routine", "episode", "other"];

export default function MemoryPage(): ReactNode {
  const { workspace, hubState } = useSession();

  const grouped = useMemo(() => {
    const buckets = new Map<string, MemoryRecord[]>();
    for (const entry of workspace.memory) {
      const list = buckets.get(entry.bucket) ?? [];
      list.push(entry);
      buckets.set(entry.bucket, list);
    }
    return [...buckets.entries()].sort(
      (a, b) => BUCKET_ORDER.indexOf(a[0]) - BUCKET_ORDER.indexOf(b[0]),
    );
  }, [workspace.memory]);

  return (
    <Page>
      <Intro
        title="Memory"
        lede="What the agent has learned about you, so its work needs less explaining. Every fact is here, and every fact is yours to remove."
      />

      <Note>
        Reading this is the point: an agent that remembers you should be one you can audit. Facts are edited and forgotten
        on your Mac, in Settings under Memory, because that is where the record is authoritative.
      </Note>

      {workspace.memory.length === 0 ? (
        <Empty title={hubState === "connected" ? "It has not learned anything yet" : "Waiting for your devices"}>
          <p>Facts appear as you work with the agent, or when you fill in your profile on a Mac.</p>
        </Empty>
      ) : (
        grouped.map(([bucket, entries]) => (
          <Section key={bucket} heading={bucket.charAt(0).toUpperCase() + bucket.slice(1)}>
            <Table
              caption={`${String(entries.length)} fact${entries.length === 1 ? "" : "s"} the agent holds under ${bucket}.`}
              head={
                <>
                  <th scope="col">Fact</th>
                  <th scope="col">How it knows</th>
                  <th scope="col" className="pa-n">Confidence</th>
                  <th scope="col" className="pa-n">Learned</th>
                </>
              }
            >
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row" style={{ fontWeight: 400 }}>
                    {entry.label === null ? null : <span className="pa-caption">{entry.label}: </span>}
                    {entry.content}
                  </th>
                  <td className="pa-caption">
                    {entry.source.kind === "user" ? "You said so" : entry.source.kind === "learned" ? "Inferred" : "Agent"}
                    {entry.mentions > 1 ? ` · mentioned ${String(entry.mentions)} times` : ""}
                  </td>
                  <td className="pa-n">{Math.round(entry.confidence * 100)}%</td>
                  <td className="pa-n">
                    <When iso={entry.createdAt} relative />
                  </td>
                </tr>
              ))}
            </Table>
          </Section>
        ))
      )}
    </Page>
  );
}
