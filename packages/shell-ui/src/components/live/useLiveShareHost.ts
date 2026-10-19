import { useEffect } from "react";
import { useDeskChrome } from "../../lib/desk/chrome";
import { openLiveCard, shareSpace } from "../../lib/live/actions";
import { LiveNotifier } from "../../lib/live/notices";
import { liveShareNow, onLiveShareChange, sendLive, useLiveShareStore, watchLiveShare } from "../../lib/live/store";
import { useAppStore } from "../../store";

/**
 * The shell's side of a live share, for as long as the desk is up
 * (DeskSurface): main's state kept current (lib/live/store.ts), and what it
 * says as notices (lib/live/notices.ts) — a knock with Admit, an ask with
 * Allow, a guest come or gone, a message while the chat is out of sight, a
 * share that ended by itself — each acting on the share or opening the
 * Live card.
 */
export function useLiveShareHost(): void {
  useEffect(() => {
    const stopWatching = watchLiveShare();
    const notifier = new LiveNotifier({
      show: (message, options) => {
        const store = useAppStore.getState();
        store.showNotice(message, options);
        const shown = useAppStore.getState().notices.at(-1);
        return shown !== undefined && shown.message === message ? shown.id : null;
      },
      dismiss: (id) => useAppStore.getState().dismissNotice(id),
      isShown: (id) => useAppStore.getState().notices.some((notice) => notice.id === id),
      card: () => (useDeskChrome.getState().card?.kind === "live" ? useLiveShareStore.getState().cardTab : null),
      windowName: (windowId) => useAppStore.getState().snapshot?.tabs.find((tab) => tab.id === windowId)?.title || "a window",
      admit: (requestId) => void sendLive({ type: "admit", requestId }),
      allow: (ask) => void sendLive({ type: "answerAsk", identity: ask.identity, windowId: ask.windowId, allow: true }),
      openCard: (tab) => openLiveCard(tab),
      retry: () => {
        const groupId = liveShareNow().groupId;
        if (groupId !== null) void shareSpace(groupId);
      },
    });
    const off = onLiveShareChange((next, previous) => notifier.take(previous, next));
    return () => {
      off();
      stopWatching();
    };
  }, []);
}
