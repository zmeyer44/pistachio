/**
 * There is no save (docs/notes.md §5). What there is instead is this: a pure
 * state machine the editor feeds edits, answers and remote revisions to, and
 * asks "what now?" whenever a timer fires.
 *
 * Keeping the arithmetic out of the component is what makes the awkward parts
 * testable — a remote revision arriving mid-keystroke, a host that refuses
 * four times, a flush whose answer lands after the person typed again — and
 * what keeps the editor from ever blocking on the host: every path here ends
 * in "wait", never in "stop typing".
 *
 * The one merge rule is N5, last-writer-wins by HLC on the whole note. A
 * remote revision newer than what we last wrote is adopted while the editor
 * is clean, and remembered while it is dirty: by the time our own flush lands
 * it carries a later clock and wins, which is the decision, made visible by
 * the bar's "Edited on another device".
 */

import type { NotePatch } from "@pistachio/shell-contracts/notes";

/** How long the typing has to stop before a flush goes out. */
export const NOTE_IDLE_MS = 600;
/** First backoff after a refusal; it doubles from here. */
export const NOTE_RETRY_MS = 1_000;
/** However long the host stays down, the editor tries again this often. */
export const NOTE_RETRY_CAP_MS = 30_000;

export interface NoteDraft {
  title: string;
  markdown: string;
}

/**
 * The last version we know the host holds, and what was in it. A version is
 * named by its `stamp`, not its revision: two devices that each bumped
 * revision 1 both hold a revision 2, and the sync lane keeps whichever clock
 * was later — so "newer than ours" can only be read as "not the one we
 * wrote", which the revision alone cannot say.
 */
export interface NoteSaved extends NoteDraft {
  revision: number;
  stamp: string;
}

/** `revision@updatedAt`: what tells one device's revision 2 from another's. */
export function noteStamp(note: { revision: number; updatedAt: string }): string {
  return `${String(note.revision)}@${note.updatedAt}`;
}

export interface AutosaveState {
  /** What the person has in front of them. */
  local: NoteDraft;
  saved: NoteSaved;
  /** `local` differs from `saved` — the only reason to write. */
  dirty: boolean;
  /** The draft an `update` is carrying right now, or null. */
  inflight: NoteDraft | null;
  /** A remote version (its stamp) that landed while we were dirty or in flight. */
  pendingRemote: string | null;
  /** Consecutive refusals; the backoff's exponent. */
  retry: number;
  /** The earliest moment the next flush may go: idle timer, or backoff. */
  dueAt: number | null;
  /** The last write did not land. The bar says so; typing carries on. */
  error: boolean;
}

export type AutosaveEvent =
  /** A keystroke, in the title or the body. */
  | { type: "edit"; draft: Partial<NoteDraft>; at: number }
  /** Blur, a pane going quiet, the window hiding, unmount: go now. */
  | { type: "flushNow"; at: number }
  /** The editor is sending what `nextAction` asked it to. */
  | { type: "sending"; at: number }
  /** The host answered with what it now holds — which may carry more than we sent. */
  | { type: "saved"; note: NoteSaved; at: number }
  | { type: "failed"; at: number }
  /** `onNotes` says the host holds this version of the note. */
  | { type: "remote"; stamp: string; at: number }
  /** The remote body was fetched and put into the editor. */
  | { type: "adopt"; note: NoteSaved };

export type AutosaveAction =
  /** Nothing to do until another event. */
  | { type: "idle" }
  /** Ask again in `ms`. */
  | { type: "wait"; ms: number }
  /** Send this patch — only the fields that changed. */
  | { type: "flush"; patch: NotePatch }
  /** Someone else's version is waiting; read it. */
  | { type: "fetch"; stamp: string };

export function createAutosave(note: NoteSaved): AutosaveState {
  return {
    local: { title: note.title, markdown: note.markdown },
    saved: note,
    dirty: false,
    inflight: null,
    pendingRemote: null,
    retry: 0,
    dueAt: null,
    error: false,
  };
}

/** 1s, 2s, 4s … capped, so a host that is down is asked rarely but forever. */
export function retryDelay(retry: number): number {
  if (retry <= 0) return 0;
  return Math.min(NOTE_RETRY_CAP_MS, NOTE_RETRY_MS * 2 ** (retry - 1));
}

function differs(local: NoteDraft, saved: NoteDraft): boolean {
  return local.title !== saved.title || local.markdown !== saved.markdown;
}

/** Only what changed: a keystroke in the title must not re-seal the body. */
export function pendingPatch(state: AutosaveState): NotePatch {
  const patch: NotePatch = {};
  if (state.local.title !== state.saved.title) patch.title = state.local.title;
  if (state.local.markdown !== state.saved.markdown) patch.markdown = state.local.markdown;
  return patch;
}

export function autosave(state: AutosaveState, event: AutosaveEvent): AutosaveState {
  switch (event.type) {
    case "edit": {
      const local = { ...state.local, ...event.draft };
      const dirty = differs(local, state.saved);
      if (!dirty) return { ...state, local, dirty: false, dueAt: null };
      // A refusal's backoff outlives a keystroke: typing must not turn a
      // host that is down into a request per 600 ms.
      const idleAt = event.at + NOTE_IDLE_MS;
      return { ...state, local, dirty: true, dueAt: Math.max(idleAt, state.retry > 0 ? (state.dueAt ?? idleAt) : idleAt) };
    }
    case "flushNow":
      // The last chance to write — a closing pane, a hidden window. It jumps
      // the backoff too: one more attempt costs nothing and saves the note.
      return state.dirty ? { ...state, dueAt: event.at } : state;
    case "sending":
      return { ...state, inflight: { ...state.local }, dueAt: null };
    case "saved": {
      // The host wrote what we sent and answers with the whole note. A field
      // we did not send may have moved under us (a title-only save while the
      // body changed elsewhere): where the person has not touched it since,
      // the host's copy is adopted, or the next flush would carry our stale
      // copy back over the newer one. A field they did touch stays theirs.
      const sent = state.inflight ?? state.local;
      const local: NoteDraft = {
        title: state.local.title === state.saved.title && sent.title === state.saved.title ? event.note.title : state.local.title,
        markdown:
          state.local.markdown === state.saved.markdown && sent.markdown === state.saved.markdown
            ? event.note.markdown
            : state.local.markdown,
      };
      const dirty = differs(local, event.note);
      return {
        ...state,
        saved: event.note,
        local,
        dirty,
        inflight: null,
        retry: 0,
        error: false,
        dueAt: dirty ? event.at + NOTE_IDLE_MS : null,
        // Our write is the version the host holds now; a notice of it is answered.
        pendingRemote: state.pendingRemote !== null && state.pendingRemote !== event.note.stamp ? state.pendingRemote : null,
      };
    }
    case "failed": {
      const retry = state.retry + 1;
      return { ...state, inflight: null, retry, error: true, dueAt: event.at + retryDelay(retry) };
    }
    case "remote": {
      // The host holds a version we neither wrote nor adopted. The last one
      // named wins: the snapshot describes what the host holds NOW.
      if (event.stamp === state.saved.stamp) return state;
      return event.stamp === state.pendingRemote ? state : { ...state, pendingRemote: event.stamp };
    }
    case "adopt":
      // What came back replaces both sides: the editor was clean, so there is
      // nothing of the person's to lose.
      return {
        ...state,
        saved: event.note,
        local: { title: event.note.title, markdown: event.note.markdown },
        dirty: false,
        pendingRemote: state.pendingRemote !== null && state.pendingRemote !== event.note.stamp ? state.pendingRemote : null,
        dueAt: null,
      };
  }
}

/**
 * What the editor should do at `now`. Called after every event and whenever
 * the timer it last asked for fires; nothing here changes state, so it is
 * safe to ask twice.
 */
export function nextAction(state: AutosaveState, now: number): AutosaveAction {
  // One write at a time: a second `update` would race its own answer, and the
  // revision the first returns would then describe the wrong body.
  if (state.inflight !== null) return { type: "idle" };
  if (state.dirty) {
    const dueAt = state.dueAt ?? now;
    return dueAt <= now ? { type: "flush", patch: pendingPatch(state) } : { type: "wait", ms: dueAt - now };
  }
  if (state.pendingRemote !== null && state.pendingRemote !== state.saved.stamp) return { type: "fetch", stamp: state.pendingRemote };
  return { type: "idle" };
}

/** What the bar shows beside the title. */
export type SaveState = "saved" | "saving" | "editing" | "retrying";

export function saveState(state: AutosaveState): SaveState {
  if (state.error) return "retrying";
  if (state.inflight !== null) return "saving";
  return state.dirty ? "editing" : "saved";
}

export const SAVE_STATE_LABEL: Record<SaveState, string> = {
  saved: "Saved",
  saving: "Saving…",
  editing: "Editing",
  retrying: "Not saved — retrying",
};
