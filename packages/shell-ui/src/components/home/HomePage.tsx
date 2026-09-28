import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { profileView } from "@pistachio/shell-contracts/memory";
import { cn } from "../../lib/cn";
import { greeting } from "../../lib/home";
import { agentIsActing } from "../../lib/run";
import { TABLESS_HOME_KEY, useAppStore } from "../../store";
import { PistachioMark } from "../PistachioMark";
import { HomeApps } from "./HomeApps";
import { HomeChat } from "./HomeChat";
import { ContinueBrowsing, TodaySchedule, TodayTodos } from "./HomeCards";
import { HomeSearch, type HomeSearchHandle } from "./HomeSearch";
import { HomeWeather } from "./HomeWeather";
import { HomeBrief } from "./HomeBrief";
import { HomeNotes } from "./HomeNotes";
import { useHomeNavigation } from "./navigation";
import { useNow } from "./use-now";

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))
  );
}

/** How long the page takes to step aside for the chat, and to come back. */
const LEAVE_MS = 260;

/**
 * The home page (@pistachio/shell-contracts/home): what a new tab and a
 * window with no tabs show, drawn in the pane by the shell on both surfaces.
 *
 * `tabId` is the tab showing it, or null for a window with no tabs, where
 * what it opens becomes a new tab. `active` is whether its pane has focus:
 * the active page takes the keyboard for its search as it shows, and a
 * letter typed with nothing else focused lands there too.
 *
 * A question asked of Pistachio turns the page into a chat (HomeChat):
 * the search pill flies to the foot of the pane and becomes the composer,
 * the page's cards step aside, and the conversation — the console's open
 * thread — fills the pane. The tab stays a home tab; which conversation it
 * shows is the store's (`homeChats`), so it survives a switch away and
 * back, and ends when the person leaves it or the console moves on. A
 * browse turn that navigates the tab away unmounts this page; the store
 * opens the sidebar then (`homeChatLeftHome`), since nothing here can.
 */
export function HomePage({
  tabId,
  active,
}: {
  tabId: string | null;
  active: boolean;
}) {
  const now = useNow();
  const navigation = useHomeNavigation(tabId);
  const memory = useAppStore((s) => s.memory.entries);
  const name = useMemo(() => profileView(memory, new Date()).name, [memory]);
  const searchRef = useRef<HomeSearchHandle>(null);

  const tabKey = tabId ?? TABLESS_HOME_KEY;
  const chat = useAppStore((s) => s.homeChats[tabKey] ?? null);
  const run = useAppStore((s) => s.snapshot?.run ?? null);
  const askHome = useAppStore((s) => s.askHome);
  const closeHomeChat = useAppStore((s) => s.closeHomeChat);
  const setConsoleOpen = useAppStore((s) => s.setConsoleOpen);
  // The chat this tab shows: its pending question, or its run while that
  // is still the console's open thread. A run the console moved on from is
  // not this tab's any more, and the page comes back.
  const chatRun = chat === null || chat.runId === null ? null : run !== null && run.runId === chat.runId ? run : null;
  const showChat = chat !== null && (chat.runId === null || chatRun !== null);
  useEffect(() => {
    if (chat !== null && chat.runId !== null && chatRun === null) closeHomeChat(tabKey);
  }, [chat, chatRun, closeHomeChat, tabKey]);

  // The transition: the page keeps drawing while it steps aside, so the
  // chat can fly its composer out of the pill; and it fades back in when
  // the chat is left. The chat itself mounts and unmounts in place.
  const [leaving, setLeaving] = useState(false);
  const [returning, setReturning] = useState(false);
  const origin = useRef<DOMRect | null>(null);
  const wasChat = useRef(showChat);
  useEffect(() => {
    if (wasChat.current === showChat) return;
    wasChat.current = showChat;
    if (showChat) {
      setLeaving(true);
      const timer = window.setTimeout(() => setLeaving(false), LEAVE_MS);
      return () => window.clearTimeout(timer);
    }
    origin.current = null;
    setReturning(true);
    const timer = window.setTimeout(() => setReturning(false), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [showChat]);

  const [busy, setBusy] = useState(false);
  const ask = useCallback(
    (prompt: string) => {
      origin.current = searchRef.current?.rect() ?? null;
      setBusy(false);
      void askHome(tabKey, prompt).then((started) => {
        if (started) return;
        // The agent is acting on another conversation: the question is not
        // a steer of it, and the sidebar is where that conversation is.
        setBusy(true);
        setConsoleOpen(true);
      });
    },
    [askHome, setConsoleOpen, tabKey],
  );
  useEffect(() => {
    if (busy && !agentIsActing(run)) setBusy(false);
  }, [busy, run]);

  useEffect(() => {
    if (active && !showChat) searchRef.current?.focus();
  }, [active, tabId, showChat]);

  // The address modal (⌘L, the sidebar's address row) opens over the home
  // page as it does over any other; dismissed, it hands the keyboard back
  // to the search it took it from.
  const urlBarOpen = useAppStore((s) => s.overlay === "url");
  const urlBarWasOpen = useRef(false);
  useEffect(() => {
    const closed = urlBarWasOpen.current && !urlBarOpen;
    urlBarWasOpen.current = urlBarOpen;
    // Closed INTO another overlay (a settings action), the keyboard is that
    // overlay's.
    if (
      closed &&
      active &&
      !showChat &&
      useAppStore.getState().overlay === "none" &&
      !isEditable(document.activeElement)
    )
      searchRef.current?.focus();
  }, [urlBarOpen, active, showChat]);

  useEffect(() => {
    if (!active || showChat) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.length !== 1
      )
        return;
      if (isEditable(event.target) || isEditable(document.activeElement))
        return;
      const state = useAppStore.getState();
      if (state.overlay !== "none" || state.onboardingOpen) return;
      // Focus moves before the key's default action, so the letter itself
      // lands in the field.
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, showChat]);

  const date = now.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = now.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div
      data-testid="home-page"
      data-tab-id={tabId ?? undefined}
      data-mode={showChat ? "chat" : "home"}
      className="@container absolute inset-0 overflow-hidden bg-background-200 text-gray-1000"
    >
      {showChat && chat !== null ? (
        <HomeChat
          tabKey={tabKey}
          chat={chat}
          run={chatRun}
          origin={origin.current}
          active={active}
          onLeave={() => closeHomeChat(tabKey)}
        />
      ) : null}
      {!showChat || leaving ? (
        <div
          data-testid="home-content"
          className={cn("absolute inset-0 overflow-y-auto", leaving && showChat && "home-leave", returning && "home-return")}
          inert={showChat || undefined}
        >
          <div className="mx-auto flex min-h-full w-full max-w-[1180px] flex-col px-5 pt-5 pb-6 @3xl:px-10 @3xl:pt-8">
            <header className="flex items-center justify-between gap-4">
              {/* Muted and small, as the onboarding pages carry it: the corner
                  says whose page this is, the page itself is about the person. */}
              <div
                className="flex items-center gap-2 text-gray-700"
                aria-label="Pistachio"
              >
                <PistachioMark size={20} tone="muted" />
                <span className="text-[17px] leading-none font-medium tracking-[-0.02em]">
                  Pistachio
                </span>
              </div>
              <div className="flex items-center gap-1 text-[14px] text-gray-800 tabular-nums @xl:gap-3">
                <time
                  data-testid="home-date"
                  dateTime={now.toISOString().slice(0, 10)}
                  className="hidden px-1 @xl:inline"
                >
                  {date}
                </time>
                <time
                  data-testid="home-time"
                  dateTime={now.toISOString()}
                  className="px-1"
                >
                  {time}
                </time>
                <HomeWeather />
              </div>
            </header>

            <main className="flex flex-1 flex-col items-center pt-[clamp(28px,9vh,112px)]">
              <h1
                data-testid="home-greeting"
                className="text-center text-[34px] leading-[1.05] font-semibold tracking-[-0.04em] text-gray-1000 @3xl:text-[56px]"
              >
                {greeting(now.getHours(), name)}
              </h1>
              <HomeBrief now={now} />
              <HomeNotes />
              <HomeSearch
                ref={searchRef}
                navigation={navigation}
                onAsk={ask}
                className={cn("mt-7 w-full max-w-[700px] @3xl:mt-9", leaving && showChat && "invisible")}
              />
              {busy ? (
                <p role="status" data-testid="home-ask-busy" className="mt-3 text-center text-[13px] text-gray-700">
                  Pistachio is busy with a task in the sidebar — finish or stop it there to ask something new.
                </p>
              ) : null}
              <div className="mt-8 w-full @3xl:mt-10">
                <HomeApps navigation={navigation} />
              </div>
              <div className="mt-10 grid w-full grid-cols-1 gap-4 @3xl:mt-14 @3xl:grid-cols-3 @3xl:gap-5">
                <ContinueBrowsing navigation={navigation} now={now} />
                <TodayTodos now={now} />
                <TodaySchedule navigation={navigation} now={now} />
              </div>
            </main>

            {/* <footer className="pt-10 text-center text-[13px] text-gray-700 @3xl:pt-14">“The browser that runs your errands.”</footer> */}
          </div>
        </div>
      ) : null}
    </div>
  );
}
