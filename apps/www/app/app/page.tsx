"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { ThreadListItem } from "@pistachio/protocol";
import {
  Button,
  createRun,
  Empty,
  errorDetailOf,
  Intro,
  listRuns,
  Note,
  Page,
  Section,
  Status,
  Table,
  TextArea,
  useSession,
  When,
} from "@pistachio/web-account";

function statusTone(status: string): "good" | "alert" | undefined {
  if (status === "completed") return "good";
  if (status === "failed" || status === "revoked" || status === "rejected") return "alert";
  return undefined;
}

export default function AgentPage(): ReactNode {
  const { token, spaces, keys, enableCloud, relock, error: sessionError, errorDetail: sessionErrorDetail } = useSession();
  const [runs, setRuns] = useState<ThreadListItem[]>([]);
  const [intent, setIntent] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const runnable = useMemo(
    () =>
      spaces
        .filter((space) => space.cloudEnabled)
        .map((space) => ({ id: space.id, name: space.name })),
    [spaces],
  );

  useEffect(() => {
    if (spaceId === "" && runnable[0] !== undefined) setSpaceId(runnable[0].id);
  }, [runnable, spaceId]);

  const refresh = useCallback(async (): Promise<void> => {
    if (token === null) return;
    const lists = await Promise.all(
      spaces.map((space) => listRuns(token, space.id).catch(() => ({ runs: [] as ThreadListItem[] }))),
    );
    const all = lists.flatMap((list) => list.runs);
    all.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    setRuns(all);
  }, [token, spaces]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = (event: FormEvent): void => {
    event.preventDefault();
    if (token === null || spaceId === "" || intent.trim() === "") return;
    setBusy(true);
    setError(null);
    void createRun(token, { spaceId, intent: intent.trim() })
      .then(async () => {
        setIntent("");
        await refresh();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "The run could not be started.");
        setErrorDetail(errorDetailOf(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const setupCloud = (): void => {
    const first = spaces[0];
    if (first === undefined || busy) return;
    setBusy(true);
    setError(null);
    const work = (keys?.rootSecrets.size ?? 0) === 0
      ? relock({ preserveRemembered: true, enableCloudAfterUnlock: true })
      : enableCloud(first.id);
    void work
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "The cloud browser could not be turned on.");
        setErrorDetail(errorDetailOf(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Page>
      <Intro
        title="Agent"
        lede="Ask for something and the cloud browser does it in your signed-in sessions, whether or not your Mac is awake."
      />

      {runnable.length === 0 ? (
        <Section heading="Nothing can run yet">
          <Empty title="No Space has the cloud browser turned on">
            <p>
              Turn it on here to run tasks from the web or iMessage, even when no Mac is awake.
            </p>
            {error === null && sessionError === null ? null : (
              <Note tone="alert" detail={error === null ? sessionErrorDetail : errorDetail}>
                {error ?? sessionError}
              </Note>
            )}
            <Button type="button" variant="primary" disabled={busy || spaces.length === 0} onClick={setupCloud}>
              {busy
                ? "Turning on…"
                : (keys?.rootSecrets.size ?? 0) === 0
                  ? "Unlock to turn on"
                  : "Turn on cloud browser"}
            </Button>
          </Empty>
        </Section>
      ) : (
        <Section heading="Ask for something">
          <form onSubmit={start} className="pa-section">
            <TextArea
              label="What should it do?"
              help="It runs in the Space you choose, using the sessions that Space is signed in to."
              value={intent}
              placeholder="Reorder the coffee I bought last month"
              onChange={(event) => setIntent(event.target.value)}
              required
            />
            {runnable.length === 1 ? null : (
              <div className="pa-field">
                <label htmlFor="space">Space</label>
                <select
                  id="space"
                  className="pa-input"
                  value={spaceId}
                  onChange={(event) => setSpaceId(event.target.value)}
                >
                  {runnable.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {error === null ? null : <Note tone="alert" detail={errorDetail}>{error}</Note>}
            <div>
              <Button type="submit" variant="primary" disabled={busy || intent.trim() === ""}>
                {busy ? "Starting…" : "Start"}
              </Button>
            </div>
          </form>
        </Section>
      )}

      <Section heading="Runs" note={keys === null ? undefined : "Open a run to watch what it does, step by step."}>
        {runs.length === 0 ? (
          <Empty title="No runs yet">
            <p>Anything you ask for here, or through a channel, appears in this list.</p>
          </Empty>
        ) : (
          <Table
            caption={`${String(runs.length)} run${runs.length === 1 ? "" : "s"}, newest first.`}
            head={
              <>
                <th scope="col">Task</th>
                <th scope="col">Status</th>
                <th scope="col">Where</th>
                <th scope="col" className="pa-n">
                  Updated
                </th>
              </>
            }
          >
            {runs.map((run) => (
              <tr key={run.runId}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  <Link href={`/app/runs/${run.runId}`}>{run.title === "" ? "Untitled task" : run.title}</Link>
                </th>
                <td>
                  <Status tone={statusTone(run.status)}>{run.status.replace(/_/g, " ")}</Status>
                </td>
                <td className="pa-caption">{run.executor?.kind === "cloud" ? "Cloud browser" : "This Mac"}</td>
                <td className="pa-n">
                  <When iso={run.updatedAt ?? null} relative />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </Page>
  );
}
