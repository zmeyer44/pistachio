import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, Sparkles, X } from "lucide-react";
import { CLOSED_FIND, FIND_BAR, FIND_BAR_ROOM, SMART_FIND_QUERY_LIMIT, type FindMode, type FindState } from "@pistachio/shell-contracts/browser-controls";
import { shellApi } from "./api";
import { cn } from "./lib/cn";

/** How long the typing must pause before a description is asked (docs/smart-find.md §3). */
const SMART_FIND_PAUSE_MS = 500;

/** A description worth asking about: exact find already serves a single word. */
const describes = (text: string): boolean => text.trim().split(/\s+/).length >= 2;

/** Smart mode's second line: what is happening, then the active match's key sentence. */
export function smartFindDetail(state: FindState): { text: string; tone: "quiet" | "match" | "warn" } {
  const { smart } = state;
  if (smart.stale) return { text: "The page changed · ↵ to search again", tone: "warn" };
  switch (smart.status) {
    case "idle":
      return { text: "Describe what you're looking for · sends this page's text to the model", tone: "quiet" };
    case "reading":
      return { text: "Reading the page…", tone: "quiet" };
    case "ranking":
      return state.matches > 0 ? { text: smart.excerpt, tone: "match" } : { text: "Looking for what you mean…", tone: "quiet" };
    case "unavailable":
      return { text: "Sign in to find by meaning.", tone: "warn" };
    case "unreadable":
      return { text: "There is no text on this page to search.", tone: "warn" };
    case "failed":
      return { text: "The model could not be reached · ↵ to try again", tone: "warn" };
    case "done":
      if (state.matches === 0) return { text: "Nothing on this page matches.", tone: "quiet" };
      return { text: `${smart.weak ? "Closest: " : ""}${smart.excerpt}`, tone: "match" };
  }
}

/**
 * Compact app-owned view positioned above the live Chromium page. The card
 * sits inside FIND_BAR_ROOM of transparent margin, where its shadow paints.
 */
export function FindApp() {
  const [state, setState] = useState(CLOSED_FIND);
  // The input is the person's: the host's echo of the query arrives a hop
  // late, and must not retype what they have typed since.
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pause = useRef<number | undefined>(undefined);
  const wasOpen = useRef(false);

  useEffect(() => {
    let active = true;
    const adopt = (next: FindState) => {
      if (next.open !== wasOpen.current) {
        wasOpen.current = next.open;
        setText(next.query);
        window.clearTimeout(pause.current);
      }
      setState(next);
    };
    void shellApi().getFindState().then((next) => {
      if (active) adopt(next);
    });
    const off = shellApi().onFindStateChanged((next) => {
      adopt(next);
      if (next.open) requestAnimationFrame(() => inputRef.current?.focus());
    });
    return () => {
      active = false;
      off();
      window.clearTimeout(pause.current);
    };
  }, []);

  useLayoutEffect(() => {
    if (!state.open) return;
    inputRef.current?.focus();
    const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [state.open]);

  const smart = state.mode === "smart";

  const ask = (query: string, forward: boolean, mode: FindMode) => {
    // Any asking cancels the pending pause, so a pause that would have ended
    // after ↵ cannot ask the same thing again — which would step.
    window.clearTimeout(pause.current);
    void shellApi().find({ type: "search", query, forward, mode });
  };

  const type = (query: string) => {
    setText(query);
    window.clearTimeout(pause.current);
    if (!smart) {
      void shellApi().find({ type: "search", query, forward: true, mode: "exact" });
      return;
    }
    // Nothing is sent to the model while the person is still typing; the old
    // matches come down at once, and the asking waits for a pause or ↵.
    void shellApi().find({ type: "search", query, forward: true, mode: "smart", draft: true });
    if (query.trim().length >= 2) pause.current = window.setTimeout(() => ask(query, true, "smart"), SMART_FIND_PAUSE_MS);
  };

  const step = (forward: boolean) => {
    // ↵ on an exact find that found nothing, with a description typed, is the
    // moment a person would give up: find it by meaning instead.
    if (!smart && state.smartAvailable && state.matches === 0 && describes(text)) ask(text, true, "smart");
    else ask(text, forward, state.mode);
  };

  const setMode = (mode: FindMode) => {
    window.clearTimeout(pause.current);
    void shellApi().find({ type: "mode", mode });
    if (mode === "smart" && text.trim().length >= 2) ask(text, true, "smart");
  };

  const offerSmart = !smart && state.smartAvailable && text !== "" && state.matches === 0 && describes(text);
  const detail = smart ? smartFindDetail(state) : null;
  const ModeIcon = smart ? Sparkles : Search;

  return (
    <div
      className="h-full w-full"
      style={{ padding: `${FIND_BAR_ROOM.top}px ${FIND_BAR_ROOM.side}px ${FIND_BAR_ROOM.bottom}px` }}
      data-find-mode={state.mode}
      data-smart-status={smart ? state.smart.status : undefined}
    >
      <div data-find-card className="relative overflow-hidden rounded-lg bg-background-100 shadow-menu">
        <div className="flex items-center pr-1" style={{ height: FIND_BAR.height }}>
          {state.smartAvailable ? (
            <button
              type="button"
              aria-label={smart ? "Find exact words" : "Find by meaning"}
              aria-pressed={smart}
              title={smart ? "Finding by meaning — click for exact words (Tab)" : "Find by meaning (Tab)"}
              data-testid="find-mode-toggle"
              onClick={() => setMode(smart ? "exact" : "smart")}
              className={cn(
                "ml-1.5 grid size-7 shrink-0 cursor-pointer place-items-center rounded-sm outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-700 [&_svg]:size-4",
                smart ? "text-green-800" : "text-gray-700 hover:text-gray-1000",
              )}
            >
              <ModeIcon aria-hidden="true" />
            </button>
          ) : (
            <Search className="ml-3 size-4 shrink-0 text-gray-700" aria-hidden="true" />
          )}
          <input
            ref={inputRef}
            value={text}
            maxLength={smart ? SMART_FIND_QUERY_LIMIT : undefined}
            aria-label={smart ? "Find by meaning" : "Find in page"}
            placeholder={smart ? "Describe what you're looking for" : "Find in page"}
            onChange={(event) => type(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") step(!event.shiftKey);
              if (event.key === "Escape") void shellApi().find({ type: "close" });
              if (event.key === "Tab" && state.smartAvailable && !event.shiftKey) {
                event.preventDefault();
                setMode(smart ? "exact" : "smart");
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent px-2 text-label-13 text-gray-1000 outline-none placeholder:text-gray-600"
          />
          {offerSmart ? (
            <button
              type="button"
              data-testid="find-offer-smart"
              onClick={() => ask(text, true, "smart")}
              className="mr-1 shrink-0 cursor-pointer rounded-sm px-1.5 py-1 text-[10px] whitespace-nowrap text-green-800 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-700"
            >
              No exact matches · ↵ by meaning
            </button>
          ) : (
            <span className={cn("shrink-0 text-center font-mono text-[10px] text-gray-700", smart ? "w-12" : "w-16")} data-testid="find-count">
              {text === "" ? "" : state.matches === 0 ? (smart ? "" : "0 / 0") : `${state.activeMatchOrdinal} / ${state.matches}`}
            </span>
          )}
          {/* Nothing to step through while the offer stands, and the input needs the room. */}
          {!offerSmart && (
            <>
              <FindButton label="Previous match" onClick={() => ask(text, false, state.mode)}>
                <ChevronUp />
              </FindButton>
              <FindButton label="Next match" onClick={() => ask(text, true, state.mode)}>
                <ChevronDown />
              </FindButton>
            </>
          )}
          <FindButton label="Close find" onClick={() => void shellApi().find({ type: "close" })}>
            <X />
          </FindButton>
        </div>
        {detail !== null && (
          // Inset to line up under the input's text: toggle (6 + 28) + the input's own 8.
          <div className="flex items-center border-t border-alpha-400 pr-3 pl-[42px]" style={{ height: FIND_BAR.detailHeight }} aria-live="polite">
            <span
              data-testid="find-detail"
              title={state.smart.truncated ? "This page is very long: only its first part was searched." : detail.text}
              className={cn(
                "min-w-0 flex-1 truncate text-[11px]",
                detail.tone === "match" ? "text-gray-1000" : detail.tone === "warn" ? "text-amber-900" : "text-gray-700",
              )}
            >
              {detail.text}
            </span>
            {state.smart.truncated && state.smart.status === "done" && <span className="ml-2 shrink-0 text-[10px] text-gray-700">partial</span>}
          </div>
        )}
        {smart && (state.smart.status === "reading" || state.smart.status === "ranking") && (
          <div
            aria-hidden="true"
            className="absolute bottom-0 left-0 h-0.5 bg-green-700 transition-[width] duration-200"
            style={{ width: `${Math.max(8, state.smart.total === 0 ? 8 : (100 * state.smart.searched) / state.smart.total)}%` }}
          />
        )}
      </div>
    </div>
  );
}

function FindButton({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-sm text-gray-700 outline-none hover:bg-gray-100 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-blue-700 [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}
