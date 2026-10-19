/**
 * The live share as the shell sees it (docs/live-share.md §6.4): main's
 * `LiveShareState`, on its own channel (`onLiveShare`) — and its guests
 * alone on another (`onLiveRoster`) when only who speaks or how well they
 * are connected changed, since the state carries the chat — kept current while
 * anything watches it — the desk (DeskSurface's useLiveShareHost), the
 * rail's mark, the Live card — and the commands the shell sends. Apart from
 * the app store, as the Stack's context is (lib/desk/group-context.ts): only
 * the desktop hosts a share, and while one is live its state changes with
 * every chat message and every guest who comes or goes.
 *
 * What the shell keeps of its own: a start it asked for that main has not
 * answered yet (`requested`, so the card says "Starting…" from the click,
 * not from main's first publish), and the tool and colour the host last drew
 * with (`/draw` and the card's pen pick them up again).
 */

import { useEffect } from "react";
import { create } from "zustand";
import { HOST_COLOR } from "@pistachio/live-share";
import { idleLiveShare, type LiveCommand, type LiveDrawing, type LiveShareState } from "@pistachio/shell-contracts/live-share";
import { nativeApi } from "../../api";

interface LiveShareStore {
  state: LiveShareState;
  /** A start the shell asked for, until main's word on it: the space, and when. */
  requested: { groupId: string; at: number } | null;
  /** What the host last drew with. */
  pen: LiveDrawing;
  /** The Live card's tab: the share, or its chat. */
  cardTab: "live" | "chat";
}

export const useLiveShareStore = create<LiveShareStore>(() => ({
  state: idleLiveShare(),
  requested: null,
  pen: { tool: "pen", color: HOST_COLOR },
  cardTab: "live",
}));

type ChangeListener = (next: LiveShareState, previous: LiveShareState) => void;

const changeListeners = new Set<ChangeListener>();
let watchers = 0;
let unwatch: (() => void) | null = null;

function take(next: LiveShareState): void {
  const previous = useLiveShareStore.getState().state;
  if (next === previous) return;
  // Main's word on a start the shell asked for: its state for that space says what happens now. (Not a share of
  // another space ending first: that is main stopping the old one on the way.)
  const requested = useLiveShareStore.getState().requested;
  const answered = requested !== null && next.groupId === requested.groupId && next.status !== "idle";
  useLiveShareStore.setState(answered ? { state: next, requested: null } : { state: next });
  for (const listener of [...changeListeners]) listener(next, previous);
}

/**
 * Keep the state current until the returned function is called (counted:
 * the first watch subscribes, the last one's end lets go). Main's state is
 * asked for once as the first watch starts; a change heard meanwhile is
 * newer than that answer, which is then dropped. A roster is the state's
 * guests as they are now (main sends it in order with the state).
 */
export function watchLiveShare(): () => void {
  watchers += 1;
  if (watchers === 1) {
    const api = nativeApi();
    let heard = false;
    const offState =
      api?.onLiveShare((next) => {
        heard = true;
        take(next);
      }) ?? null;
    const offRoster = api?.onLiveRoster((participants) => take({ ...useLiveShareStore.getState().state, participants })) ?? null;
    api
      ?.getLiveShare()
      .then((first) => {
        if (!heard) take(first);
      })
      .catch(() => undefined);
    unwatch = () => {
      offState?.();
      offRoster?.();
    };
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    watchers -= 1;
    if (watchers > 0) return;
    unwatch?.();
    unwatch = null;
  };
}

/** Part of the live share, current for as long as the calling component is mounted. */
export function useLiveShare<T>(select: (state: LiveShareState) => T): T {
  useEffect(() => watchLiveShare(), []);
  return useLiveShareStore((store) => select(store.state));
}

/** The share as it stands now (for a menu read as it opens, a command run). */
export function liveShareNow(): LiveShareState {
  return useLiveShareStore.getState().state;
}

/** Every change main publishes, with the state before it (the notices, the card's own reactions). */
export function onLiveShareChange(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** A command to main's share. Main answers in the state (`error` for what failed); only a broken bridge rejects. */
export async function sendLive(command: LiveCommand): Promise<void> {
  const api = nativeApi();
  if (api === null) return;
  if (command.type === "setDrawing" && command.drawing !== null) useLiveShareStore.setState({ pen: command.drawing });
  await api.liveShare(command);
}

/** A start asked for (the shell's, until main says otherwise), or put away when the command came back. */
export function setLiveRequested(groupId: string | null): void {
  useLiveShareStore.setState({ requested: groupId === null ? null : { groupId, at: Date.now() } });
}

/** The tool and colour the host draws with next. */
export function livePen(): LiveDrawing {
  return useLiveShareStore.getState().pen;
}

/** Show the Live card's share or its chat. */
export function setLiveCardTab(tab: "live" | "chat"): void {
  useLiveShareStore.setState({ cardTab: tab });
}

/** Choose the tool or colour the host draws with; while drawing, the desk's pen changes at once. */
export function setLivePen(pen: LiveDrawing): void {
  useLiveShareStore.setState({ pen });
  if (liveShareNow().drawing !== null) void sendLive({ type: "setDrawing", drawing: pen });
}
