import { AlarmClock, Cloud, History, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ThreadListItem } from "@pistachio/protocol";
import { isCloudRun } from "../lib/cloud";
import { cn } from "../lib/cn";
import { relativeTime, sortThreads, statusLabel, statusTone } from "../lib/run";
import { useAppStore } from "../store";
import { StatusDot } from "./StatusDot";
import { Button } from "./ui/button";

/**
 * The console's saved conversations. Two doors in: the header's History
 * button opens them as a popover (the same hand-rolled popover the feedback
 * button uses — a click elsewhere or Escape closes it), and the welcome
 * screen lists the latest few in place. Opening one swaps the thread the
 * console shows; main refuses while a task is acting, so the list refuses
 * the same clicks first (`busy`) rather than surface that refusal as an
 * error afterwards.
 *
 * The panel is positioned against the console header, not the History
 * button: anchored to the button it ran off the panel's left edge whenever
 * the console was narrower than the panel plus the buttons after it.
 * AgentConsole's header is `relative` for exactly this.
 */

/** The welcome screen shows this many before pointing at the full list. */
export const RECENT_THREADS = 5;

/** How long an armed delete waits for its second click before standing down. */
const DELETE_ARM_MS = 4000;

const BUSY_TITLE = "Pause or end the current task first";

function threadTitle(thread: ThreadListItem): string {
  return thread.title.trim() === "" ? "Untitled conversation" : thread.title;
}

/**
 * A conversation this desktop is not executing (RunSummary.executor is
 * `cloud`). Worth a mark of its own in the list: opening one shows a
 * transcript whose tabs are on another machine, and every command on it goes
 * out to the control plane rather than to the browser under this window.
 */
function CloudMark({ thread }: { thread: ThreadListItem }) {
  if (!isCloudRun(thread)) return null;
  return (
    <Cloud
      className="size-3 shrink-0 text-blue-900"
      aria-label="Runs in the cloud browser"
      data-testid={`thread-cloud-${thread.runId}`}
    />
  );
}

export function ThreadListPopover({
  threads,
  currentRunId,
  busy,
}: {
  threads: ThreadListItem[];
  currentRunId: string | null;
  /** The agent is acting: main would refuse to open or delete the open thread. */
  busy: boolean;
}) {
  const openThread = useAppStore((state) => state.openThread);
  const deleteThread = useAppStore((state) => state.deleteThread);
  const [open, setOpen] = useState(false);
  /** The thread whose delete button is waiting for its confirming click. */
  const [armed, setArmed] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Where focus lands on open: the current thread, else the first, else the empty note. */
  const initialFocusRef = useRef<HTMLElement | null>(null);
  const setInitialFocus = useCallback((node: HTMLElement | null) => {
    initialFocusRef.current = node;
  }, []);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setArmed(null);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node) ||
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
        setArmed(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      // An armed delete stands down first; a second Escape closes the list.
      if (armed !== null) setArmed(null);
      else close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, armed, close]);

  // A dialog takes focus when it opens, so the keyboard is already inside it.
  useEffect(() => {
    if (open) initialFocusRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (armed === null) return;
    const timer = window.setTimeout(() => setArmed(null), DELETE_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const sorted = sortThreads(threads);
  const initialFocusId =
    sorted.find((thread) => thread.runId === currentRunId)?.runId ??
    sorted[0]?.runId ??
    null;

  const remove = (runId: string) => {
    setArmed(null);
    // The button about to vanish holds focus; keep focus in the dialog.
    panelRef.current?.focus();
    void deleteThread(runId);
  };

  return (
    <div ref={rootRef}>
      <Button
        ref={triggerRef}
        variant="tertiary"
        size="xs"
        svgOnly
        aria-label="Conversations"
        title="Conversations"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid="thread-list-button"
        className={cn(open && "bg-alpha-100")}
        onClick={() => setOpen((current) => !current)}
      >
        <History aria-hidden="true" />
      </Button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Conversations"
          tabIndex={-1}
          data-testid="thread-list"
          className="animate-overlay-in absolute top-full right-3.5 z-30 mt-1.5 w-72 max-w-[calc(100%-1.75rem)] rounded-lg border border-alpha-400 bg-background-100 p-1.5 shadow-modal outline-none"
        >
          <div className="flex items-center justify-between px-2 pt-1 pb-1.5">
            <span className="text-label-12 font-medium text-gray-700">
              Conversations
            </span>
            <span className="text-[11px] text-gray-700 tabular-nums">
              {sorted.length}
            </span>
          </div>
          {sorted.length === 0 ? (
            <p
              ref={setInitialFocus}
              tabIndex={-1}
              data-testid="thread-list-empty"
              className="px-2 pt-1 pb-2.5 text-copy-13 text-gray-700 outline-none"
            >
              No conversations yet
            </p>
          ) : (
            <ul className="scroll-thin grid max-h-80 gap-px overflow-y-auto">
              {sorted.map((thread) => {
                const current = thread.runId === currentRunId;
                const armedHere = armed === thread.runId;
                // While the agent acts, only the open thread can be clicked
                // (it just closes the list) and only other threads deleted.
                const openLocked = busy && !current;
                const deleteLocked = busy && current;
                return (
                  <li
                    key={thread.runId}
                    className="group/thread relative grid min-w-0"
                    onPointerLeave={() => {
                      if (armedHere) setArmed(null);
                    }}
                  >
                    <button
                      ref={
                        thread.runId === initialFocusId
                          ? setInitialFocus
                          : undefined
                      }
                      type="button"
                      data-testid={`thread-item-${thread.runId}`}
                      aria-current={current ? "true" : undefined}
                      aria-disabled={openLocked || undefined}
                      title={openLocked ? BUSY_TITLE : threadTitle(thread)}
                      className={cn(
                        "grid w-full cursor-pointer grid-cols-[8px_1fr] items-center gap-2 rounded-md py-1.5 pl-2 text-left outline-none transition-colors hover:bg-alpha-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent",
                        armedHere ? "pr-16" : "pr-7",
                        current && "bg-alpha-100",
                      )}
                      onClick={() => {
                        if (openLocked) return;
                        if (!current) void openThread(thread.runId);
                        close();
                      }}
                    >
                      <StatusDot tone={statusTone(thread.status)} />
                      <span className="grid min-w-0">
                        <span
                          className={cn(
                            "truncate text-label-13 text-gray-1000",
                            current && "font-medium",
                          )}
                        >
                          {threadTitle(thread)}
                        </span>
                        <span className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-gray-700">
                          {thread.origin === undefined ? null : (
                            <AlarmClock
                              className="size-3 shrink-0"
                              aria-label="Scheduled"
                            />
                          )}
                          <CloudMark thread={thread} />
                          <span className="truncate">
                            {relativeTime(thread.updatedAt)} ·{" "}
                            {statusLabel(thread.status)}
                          </span>
                        </span>
                      </span>
                    </button>
                    {/* Two clicks to delete: the first turns the X into a
                        "Delete?" that the second confirms. Same element and
                        test id both times, so keyboard focus stays put. */}
                    <button
                      type="button"
                      aria-label={
                        armedHere
                          ? `Confirm deleting “${threadTitle(thread)}”`
                          : `Delete “${threadTitle(thread)}”`
                      }
                      aria-disabled={deleteLocked || undefined}
                      title={
                        deleteLocked
                          ? BUSY_TITLE
                          : armedHere
                            ? "Click again to delete"
                            : "Delete conversation"
                      }
                      data-testid={`thread-delete-${thread.runId}`}
                      data-armed={armedHere ? "true" : undefined}
                      className={cn(
                        "absolute top-1/2 right-1.5 grid h-5 -translate-y-1/2 cursor-pointer place-items-center rounded-sm transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:group-hover/thread:opacity-40",
                        armedHere
                          ? "bg-red-100 px-1.5 text-[11px] font-medium text-red-900 opacity-100 hover:bg-red-100"
                          : "w-5 text-gray-700 opacity-0 group-hover/thread:opacity-100 hover:bg-alpha-200 hover:text-gray-1000",
                      )}
                      onClick={() => {
                        if (deleteLocked) return;
                        if (armedHere) remove(thread.runId);
                        else setArmed(thread.runId);
                      }}
                    >
                      {armedHere ? (
                        "Delete?"
                      ) : (
                        <X className="size-3" aria-hidden="true" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The welcome screen's shortcut back into what was going on. */
export function RecentThreads({ threads }: { threads: ThreadListItem[] }) {
  const openThread = useAppStore((state) => state.openThread);
  const recent = sortThreads(threads).slice(0, RECENT_THREADS);
  if (recent.length === 0) return null;
  return (
    <section data-testid="recent-threads" className="mt-5">
      <h3 className="mb-2 flex items-center gap-1.5 text-label-12 font-medium text-gray-700">
        <History className="size-3.5" aria-hidden="true" />
        Recent conversations
      </h3>
      <ul className="grid gap-1">
        {recent.map((thread) => (
          <li key={thread.runId} className="min-w-0">
            <button
              type="button"
              data-testid={`recent-thread-${thread.runId}`}
              title={threadTitle(thread)}
              className="grid w-full cursor-pointer grid-cols-[8px_1fr_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => void openThread(thread.runId)}
            >
              <StatusDot tone={statusTone(thread.status)} />
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-label-13 text-gray-1000">
                  {threadTitle(thread)}
                </span>
                <CloudMark thread={thread} />
              </span>
              <span className="shrink-0 text-[11px] text-gray-700">
                <span className="sr-only">{statusLabel(thread.status)} · </span>
                {relativeTime(thread.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
