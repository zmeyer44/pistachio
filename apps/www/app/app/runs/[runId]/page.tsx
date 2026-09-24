"use client";

/**
 * One cloud run, as a conversation.
 *
 * The page owns the stream and the commands; how the run reads is
 * `components/app/run-thread.tsx`, shared in spirit (and in wording, through
 * `@pistachio/run-view`) with the desktop console. A run whose Space this
 * browser has no key for still renders: control relays the sealed events,
 * nothing here can open them, and the thread says so rather than looking
 * empty.
 */

import Link from "next/link";
import { use, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { isTerminalStatus, type RunSummary } from "@pistachio/protocol";
import {
  errorDetailOf,
  getRun,
  runCommand,
  unsealDesktopThread,
  useSession,
  watchRun,
} from "@pistachio/web-account";
import { LivePane } from "../../../../components/app/live-pane";
import { RunComposer, RunHeader, RunThread, type RunActions } from "../../../../components/app/run-thread";

export default function RunPage(props: PageProps<"/app/runs/[runId]">): ReactNode {
  const { runId } = use(props.params);
  const { token, getToken, keysFor } = useSession();
  const [run, setRun] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The wire-level reason behind `error`, for a diagnostics disclosure. */
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // Kept apart from `error`: this one says the run's own record could not be
  // read, which is why nothing below it knows what to show yet.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // A run's content is sealed under its Space's key, and the Space id lives on
  // the hosted record rather than the folded summary.
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [watching, setWatching] = useState(false);
  const [watchRevision, setWatchRevision] = useState(0);
  const [sealedThread, setSealedThread] = useState<{ sealed: string } | null>(null);
  const keys = spaceId === null ? null : keysFor(spaceId);

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;
    void getRun(token, runId)
      .then((record) => {
        if (cancelled) return;
        setSpaceId(record.run.spaceId);
        setDesktop(record.run.executor.kind === "desktop");
        setSealedThread(record.thread);
        setLoadError(null);
      })
      .catch((cause: unknown) => {
        // A record that could not be READ is not a Space this browser has no
        // key for: leaving `spaceId` unset says "still nothing to look up",
        // and the banner says what actually went wrong.
        if (cancelled) return;
        setLoadError(cause instanceof Error ? cause.message : "This run could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [token, runId, loadAttempt]);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void unsealDesktopThread(keys, runId, sealedThread).then((snapshot) => {
      if (!cancelled && snapshot !== null) setRun(snapshot);
    });
    return () => {
      cancelled = true;
    };
  }, [desktop, keys, runId, sealedThread]);

  useEffect(() => {
    if (spaceId === null) return;
    const watch = watchRun({
      runId,
      // The stream asks for the token it dials with, so a run watched for
      // longer than a token's ten minutes is not torn down and rebuilt each
      // time one is re-minted.
      getToken,
      keys,
      onRun: (next) => {
        if (!desktop) setRun(next);
      },
      onThreadUpdated: () => {
        if (!desktop) return;
        void getToken()
          .then((bearer) => (bearer === null ? null : getRun(bearer, runId)))
          .then((record) => {
            if (record !== null) setSealedThread(record.thread);
          })
          .catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : "The conversation could not refresh.");
            setErrorDetail(errorDetailOf(cause));
          });
      },
      onError: (message) => {
        setError(message);
        setErrorDetail(null);
      },
    });
    return () => {
      watch.close();
    };
  }, [runId, getToken, keys, spaceId, desktop, watchRevision]);

  const ended = run !== null && isTerminalStatus(run.status);

  const actions = useMemo<RunActions>(() => {
    const send = (command: "message" | "answer" | "interrupt" | "release" | "revoke", body?: Record<string, unknown>) => {
      if (token === null) return;
      setError(null);
      setErrorDetail(null);
      void runCommand(token, runId, command, body)
        .then(() => {
          // A terminal SSE stream is closed by design. Once its follow-up
          // reopens the run, start a new stream for the same conversation.
          if (command === "message" && ended) setWatchRevision((current) => current + 1);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "That did not go through.");
          setErrorDetail(errorDetailOf(cause));
        });
    };
    return {
      answer: (questionId, value) => {
        send("answer", { questionId, value });
      },
      interrupt: () => {
        send("interrupt");
      },
      release: () => {
        send("release");
      },
      revoke: () => {
        send("revoke");
      },
      send: (text) => {
        send("message", { text });
      },
      watch: () => {
        setWatching(true);
      },
    };
  }, [token, runId, ended]);

  // Not "no keys": before the Space id lands there is nothing to look up, and
  // saying the run is sealed then would be wrong a moment later.
  const locked = spaceId !== null && keys === null;

  /**
   * Only a live cloud run has a screen to show, and only a reader holding
   * this Space's key can see it.
   *
   * The key is not merely a courtesy here: the runner challenges every viewer
   * to prove possession before it sends a pixel (§8.5), and this browser
   * answers with the same key it opens the thread with. Hiding the button is
   * just not offering a door that would shut in your face.
   */
  const watchable = !desktop && !locked && run !== null && !ended && spaceId !== null;

  return (
    <div className="pa-chat" data-watching={watchable && watching ? "" : undefined}>
      <div className="flex items-center gap-2 border-b border-alpha-400 px-6 py-2">
        <Link
          href="/app"
          className="flex items-center gap-1.5 text-label-13 text-gray-900 no-underline transition-colors hover:text-gray-1000"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          All runs
        </Link>
      </div>

      <RunHeader
        actions={watchable ? actions : { ...actions, watch: undefined }}
        onWatch={watchable ? setWatching : undefined}
        readOnly={desktop}
        run={run}
        title={run === null || run.title === "" ? "Run" : run.title}
        watching={watching}
      />

      {error === null && loadError === null ? null : (
        <p role="alert" className="border-b border-red-400 bg-red-100 px-6 py-2 text-copy-13 text-red-1000">
          {loadError ?? error}
          {loadError !== null || errorDetail === null ? null : (
            <span className="ml-2 font-mono text-[11px] opacity-70" title="Diagnostics">
              ({errorDetail})
            </span>
          )}
          {loadError === null ? null : (
            <button
              type="button"
              className="ml-2 underline underline-offset-2"
              onClick={() => {
                setLoadAttempt((attempt) => attempt + 1);
              }}
            >
              Try again
            </button>
          )}
        </p>
      )}

      {/* The pane is a SIBLING of the thread, never its parent: a screencast
          repaints several times a second and must not drag the conversation
          through a render each time. */}
      {/* Two surfaces need room for two. Below the shell's own breakpoint the
          pane takes the window and the thread waits behind it — half a phone
          each is neither a conversation nor a browser. */}
      <div
        className={
          watchable && watching
            ? "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"
            : "flex min-h-0 flex-1 flex-col"
        }
      >
        {/* `flex-1` is what keeps the composer on the floor of the window. A
            flex child sizes to its content by default, so without it this
            column was only ever as tall as the conversation inside it, and
            the composer rode up and down as the thread grew. */}
        <div
          className={
            watchable && watching
              ? "hidden min-h-0 min-w-0 flex-1 flex-col lg:flex"
              : "flex min-h-0 min-w-0 flex-1 flex-col"
          }
        >
          <RunThread actions={watchable ? actions : { ...actions, watch: undefined }} locked={locked} run={run} />
          {desktop ? null : <RunComposer actions={actions} run={run} />}
        </div>
        {watchable && watching ? (
          <LivePane
            control={run.control}
            keys={keys}
            onClose={() => {
              setWatching(false);
            }}
            onRelease={actions.release}
            onTake={actions.interrupt}
            runId={runId}
            token={token}
          />
        ) : null}
      </div>
    </div>
  );
}
