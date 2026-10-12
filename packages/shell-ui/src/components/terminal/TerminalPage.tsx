/**
 * `pistachio://terminal/<id>` — a shell on this Mac, in a tab's pane
 * (docs/terminal.md §2). The terminal itself is the shell window's
 * (lib/terminal/sessions.ts) and outlives this component: the page only
 * lends it a place to be shown, fits it to that place, gives it the
 * keyboard when its window is in use, and draws its find bar.
 *
 * Loaded lazily (DeskWindow), so xterm.js and its addons are fetched the
 * first time a terminal is opened, not with the shell.
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { nativeApi } from "../../api";
import { terminalSession, type TerminalSession } from "../../lib/terminal/sessions";

export function TerminalPage({
  tabId,
  terminalId,
  active,
  frozen,
}: {
  tabId: string;
  terminalId: string;
  /** Its window is the one in use: the keyboard is the terminal's. */
  active: boolean;
  /** Minimized, flying or closing: its box is not its size, and the shell keeps the one it has. */
  frozen: boolean;
}) {
  if (nativeApi() === null) {
    // On the web there is no Mac to run a shell on.
    return (
      <div className="grid size-full place-items-center bg-background-100 text-[12px] text-gray-900" data-testid="terminal-page">
        Terminals open in the Pistachio desktop app.
      </div>
    );
  }
  return <TerminalSurface tabId={tabId} terminalId={terminalId} active={active} frozen={frozen} />;
}

function TerminalSurface({ tabId, terminalId, active, frozen }: { tabId: string; terminalId: string; active: boolean; frozen: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [session] = useState(() => terminalSession(terminalId, tabId));
  session.tabId = tabId;
  const state = useSyncExternalStore(session.subscribe, session.getState);
  // (Before the element is put in its new box: a minimized window's is laid out at twice its size.)
  useLayoutEffect(() => session.setFrozen(frozen), [frozen, session]);

  // The terminal's element is put here while this page is up, and fitted to it as it changes size.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    void session.attach(host);
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => session.fit());
    });
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      session.detach(host);
    };
  }, [session]);

  // In use: the keyboard is the terminal's (unless its find bar has it) — at once, while its window is still flying in:
  // what is typed straight after ⌘J is the shell's.
  useEffect(() => {
    if (active && !state.search.open) session.focus();
  }, [active, state.search.open, session]);

  return (
    <div className="terminal-page" data-testid="terminal-page" data-terminal-id={terminalId} data-status={state.status}>
      <div ref={hostRef} className="terminal-host" />
      {state.search.open ? <TerminalFind session={session} index={state.search.index} count={state.search.count} /> : null}
      {state.note === null ? null : (
        // Why its shell stopped: beside its text, not in it (the text is the host's, replayed as it is there).
        <div className="terminal-note" data-testid="terminal-note" role="status">
          <span>{state.note}</span>
          <span className="terminal-note-hint">Press Enter for a new shell</span>
        </div>
      )}
    </div>
  );
}

/** ⌘F over a terminal: its scrollback searched as it is typed; Enter and ⇧Enter step, Escape closes. */
function TerminalFind({ session, index, count }: { session: TerminalSession; index: number; count: number }) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      session.closeSearch();
    } else if (event.key === "Enter") {
      event.preventDefault();
      session.find(text, event.shiftKey ? "previous" : "next");
    } else if (event.key.toLowerCase() === "f" && event.metaKey) {
      // ⌘F again: the field, its text chosen.
      event.preventDefault();
      inputRef.current?.select();
    }
  };
  const found = text === "" ? "" : count === 0 ? "No results" : `${String(index + 1)} of ${String(count)}`;
  return (
    <div className="terminal-find" data-testid="terminal-find">
      <input
        ref={inputRef}
        value={text}
        placeholder="Find"
        spellCheck={false}
        aria-label="Find in terminal"
        data-testid="terminal-find-input"
        onChange={(event) => {
          setText(event.target.value);
          session.find(event.target.value, "next", true);
        }}
        onKeyDown={onKeyDown}
      />
      <span className="terminal-find-count" data-testid="terminal-find-count">
        {found}
      </span>
      <button type="button" aria-label="Previous match" onClick={() => session.find(text, "previous")}>
        <ChevronUp aria-hidden="true" />
      </button>
      <button type="button" aria-label="Next match" onClick={() => session.find(text, "next")}>
        <ChevronDown aria-hidden="true" />
      </button>
      <button type="button" aria-label="Close find" onClick={() => session.closeSearch()}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
