"use client";

/**
 * The feature tour, played on the live shell.
 *
 * The landing page's "Core features" section used to show a screen
 * recording per feature. Now the hero's window travels down beside those
 * steps and the page tells this frame which one it is next to
 * (./tour-protocol.ts). Each scene here performs its feature on the real
 * chrome: the host is reset to a scene's tabs, and a drawn cursor walks to
 * the actual controls — the console's composer, a Glance card's buttons,
 * the pane toolbar, the sidebar's media stack — and uses them. Where the
 * app would take a gesture this page cannot make for a visitor (a tab
 * dragged onto the page, ⌘I) the scene sets the same store state that
 * gesture sets, so what is drawn is still the shell drawing it.
 *
 * A visitor's own click or key inside the frame stops the scene where it
 * is and hands the window over; the next step the page scrolls to starts
 * the tour again.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "@pistachio/shell-ui";
import { ARTICLE, VIDEOS, YOUTUBE_WATCH_URL } from "./catalog";
import { DEFAULT_SEED, type AgentScript, type DemoShellHost } from "./demo-host";
import { isTourMessage, TOUR_HAND_OVER, TOUR_READY, type TourScene } from "./tour-protocol";

/* -------------------------------- scenes ---------------------------------- */

const FAVORITES = DEFAULT_SEED.favorites;
const WIKIPEDIA = "https://en.wikipedia.org/wiki/Pistachio";
const CALENDAR = "https://calendar.google.com/calendar/u/0/r/week";
const GITHUB_REPO = "https://github.com/zmeyer44/pistachio";
const LOFI = `https://www.youtube.com/watch?v=${VIDEOS[3]!.id}`;
const SEARCH = "https://www.google.com/search?q=why+pistachio+trees+alternate";

const AGENT: AgentScript = {
  intent: "Find an hour for lunch with Maya this week and put it on my calendar",
  steps: [
    { say: "On it. I'll work in your Calendar tab and list each step as I go — type anytime to stop me.", wait: 700 },
    { notes: "Plan: read this week → find a free hour around lunch → create the event → confirm." },
    { tool: "page.inspect", label: "Read page", detail: "Google Calendar · week of Sep 21", ms: 1_300 },
    { tool: "page.inspect", label: "Find free time", detail: "Thursday 12:30 – 1:30 PM is open", ms: 1_100 },
    { tool: "page.click", label: "Click page control", detail: "Thursday, 12:30 PM", ms: 900, navigate: `${CALENDAR}?lunch=draft` },
    { tool: "page.type", label: "Type into page", detail: "“Lunch with Maya”", ms: 1_200 },
    { tool: "page.click", label: "Click page control", detail: "Save", ms: 800, navigate: `${CALENDAR}?lunch=booked`, wait: 700 },
    {
      say: "Done — Lunch with Maya is on your calendar for Thursday, 12:30–1:30 PM. It was the only free hour around lunch this week (Friday already has the team lunch).",
    },
  ],
};

interface Stage {
  host: DemoShellHost;
  cursor: CursorHandle;
  signal: AbortSignal;
}

const SCENES: Record<TourScene, (stage: Stage) => Promise<void>> = {
  /** 01 — open the console, ask, and watch the agent work in the Calendar tab. */
  async agent({ host, cursor, signal }) {
    host.reset({ favorites: FAVORITES, tabs: [WIKIPEDIA, GITHUB_REPO, CALENDAR], active: 2 });
    host.scriptAgent(AGENT);
    useAppStore.getState().setConsoleOpen(false);
    await cursor.enter(signal);
    await sleep(700, signal);
    await cursor.keys("⌘ I", signal);
    useAppStore.getState().setConsoleOpen(true);
    const input = await waitFor(() => query<HTMLTextAreaElement>('[data-testid="delegation-intent"]'), signal);
    await sleep(350, signal);
    await cursor.moveTo(input, signal, { x: 0.25 });
    await cursor.click(signal);
    input.focus({ preventScroll: true });
    await typeInto(input, AGENT.intent, signal);
    await sleep(350, signal);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    await cursor.moveBy(-120, -180, signal);
    await waitFor(() => (host.runStatus() === "completed" ? true : null), signal, 30_000);
    await sleep(5_000, signal);
  },

  /** 02 — Glance a result and put it back; Glance another and keep it as a tab. */
  async glance({ host, cursor, signal }) {
    host.reset({ favorites: FAVORITES, tabs: [WIKIPEDIA, YOUTUBE_WATCH_URL, SEARCH], active: 2 });
    await cursor.enter(signal);
    await sleep(900, signal);
    for (const [href, keep] of [
      [ARTICLE.url, false],
      [WIKIPEDIA, true],
    ] as const) {
      const link = await waitFor(() => query<HTMLAnchorElement>(`[data-testid="primary-pane"] a[href="${href}"]`), signal);
      await cursor.moveTo(link, signal, { x: 0.3 });
      await cursor.keys("⇧ click", signal);
      await cursor.click(signal);
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
      await waitFor(() => query('[data-testid="glance-overlay"]'), signal);
      await sleep(2_000, signal);
      const action = await waitFor(() => query<HTMLButtonElement>(`[data-testid="${keep ? "glance-promote" : "glance-close"}"]:not(:disabled)`), signal);
      await cursor.moveTo(action, signal);
      await sleep(250, signal);
      await cursor.click(signal);
      action.click();
      await waitFor(() => (query('[data-testid="glance-overlay"]') === null ? true : null), signal);
      await sleep(keep ? 3_200 : 1_400, signal);
    }
  },

  /** 03 — drag two tabs onto the page: a side-by-side split, then a third pane below. */
  async split({ host, cursor, signal }) {
    host.reset({ favorites: FAVORITES, tabs: [WIKIPEDIA, GITHUB_REPO, YOUTUBE_WATCH_URL, CALENDAR], active: 3 });
    await cursor.enter(signal);
    await sleep(900, signal);
    for (const [url, side] of [
      [WIKIPEDIA, "right"],
      [GITHUB_REPO, "bottom"],
    ] as const) {
      const tab = host.tabs().find((candidate) => candidate.url === url);
      if (tab === undefined) return;
      const row = await waitFor(() => tabRow(tab.id), signal);
      await cursor.moveTo(row, signal, { x: 0.35 });
      await cursor.grab(signal, { title: tab.title, faviconUrl: tab.faviconUrl });
      const store = useAppStore.getState();
      store.setTabDragging(true);
      store.setSplitDragTab({ title: tab.title, url: tab.url, faviconUrl: tab.faviconUrl });
      const surface = await waitFor(() => query('[data-testid="browser-surface"]'), signal);
      const box = surface.getBoundingClientRect();
      const target = side === "right" ? { x: box.left + box.width * 0.78, y: box.top + box.height * 0.45 } : { x: box.left + box.width * 0.5, y: box.top + box.height * 0.82 };
      await cursor.moveToPoint(target.x, target.y, signal, 1_000);
      useAppStore.getState().setSplitDropZone(side);
      await sleep(900, signal);
      useAppStore.getState().setTabDragging(false);
      cursor.release();
      await host.splitWith(tab.id, side);
      await sleep(side === "right" ? 1_600 : 3_600, signal);
    }
  },

  /** 04 — reader view from the pane toolbar, then "Listen to article" into the media stack. */
  async reader({ host, cursor, signal }) {
    host.reset({ favorites: FAVORITES, tabs: [WIKIPEDIA, YOUTUBE_WATCH_URL, ARTICLE.url], active: 2 });
    await cursor.enter(signal);
    await sleep(1_100, signal);
    const surface = await waitFor(() => query('[data-testid="browser-surface"]'), signal);
    const box = surface.getBoundingClientRect();
    await cursor.moveToPoint(box.left + box.width * 0.6, box.top + 6, signal);
    useAppStore.getState().setPaneToolbarRevealed(true);
    const toggle = await waitFor(() => query<HTMLButtonElement>('[data-testid^="reader-toggle-"]'), signal);
    await sleep(300, signal);
    await cursor.moveTo(toggle, signal);
    await cursor.click(signal);
    toggle.click();
    await waitFor(() => query('[data-testid="demo-reader"]'), signal);
    useAppStore.getState().setPaneToolbarRevealed(false);
    await sleep(1_400, signal);
    const listen = await waitFor(() => query<HTMLButtonElement>('[data-testid="demo-listen"]'), signal);
    await cursor.moveTo(listen, signal, { x: 0.3 });
    await cursor.click(signal);
    listen.click();
    const card = await waitFor(() => query('[data-testid^="media-card-"]'), signal, 8_000);
    await sleep(1_400, signal);
    await cursor.moveTo(card, signal, { x: 0.4, y: 0.5 });
    await sleep(1_400, signal);
    const pause = await waitFor(() => query<HTMLButtonElement>('[data-testid^="media-card-"] .media-control[data-primary]'), signal);
    await cursor.moveTo(pause, signal);
    await cursor.click(signal);
    pause.click();
    await sleep(1_200, signal);
    await cursor.click(signal);
    query<HTMLButtonElement>('[data-testid^="media-card-"] .media-control[data-primary]')?.click();
    await sleep(900, signal);
    await cursor.moveBy(360, -160, signal);
    await sleep(3_000, signal);
  },

  /** 05 — leave a playing video: it follows into the sidebar, on top of the music already there. */
  async media({ host, cursor, signal }) {
    host.reset({ favorites: FAVORITES, tabs: [WIKIPEDIA, LOFI, YOUTUBE_WATCH_URL], active: 2 });
    const [wiki, lofi, video] = host.tabs();
    if (wiki === undefined || lofi === undefined || video === undefined) return;
    host.play(lofi.id, { title: VIDEOS[3]!.title, artist: VIDEOS[3]!.channel, hasVideo: false, duration: 7_293, position: 1_262 });
    host.play(video.id, { title: VIDEOS[0]!.title, artist: VIDEOS[0]!.channel, hasVideo: true, duration: 1_104, position: 252 });
    await cursor.enter(signal);
    await sleep(1_800, signal);
    const row = await waitFor(() => tabRow(wiki.id), signal);
    await cursor.moveTo(row, signal, { x: 0.4 });
    await cursor.click(signal);
    await host.selectTab(wiki.id);
    await waitFor(() => query(`[data-testid="media-video-${video.id}"]`), signal);
    await sleep(1_800, signal);
    const stack = await waitFor(() => query('[data-testid="media-stack"] .media-card-slot'), signal);
    await cursor.moveTo(stack, signal, { x: 0.5, y: 0.35 });
    await sleep(1_600, signal);
    const pause = query<HTMLButtonElement>(`[data-testid="media-card-${video.id}"] .media-control[data-primary]`);
    if (pause !== null) {
      await cursor.moveTo(pause, signal);
      await cursor.click(signal);
      pause.click();
      await sleep(1_300, signal);
      await cursor.click(signal);
      pause.click();
      await sleep(1_200, signal);
    }
    await cursor.moveBy(420, -200, signal);
    await sleep(3_000, signal);
  },
};

/* -------------------------------- helpers --------------------------------- */

function aborted(): DOMException {
  return new DOMException("The tour moved on.", "AbortError");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(aborted());
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      window.clearTimeout(timer);
      reject(aborted());
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Poll until `find` answers — the shell renders on its own schedule. */
async function waitFor<T>(find: () => T | null, signal: AbortSignal, timeout = 5_000): Promise<T> {
  const until = performance.now() + timeout;
  for (;;) {
    const found = find();
    if (found !== null) return found;
    if (performance.now() > until) throw new Error("The tour's target never appeared.");
    await sleep(60, signal);
  }
}

function query<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

/** The sidebar row for a tab (the strip has rows of the same name, hidden in this layout). */
function tabRow(tabId: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(`[data-tab-id="${tabId}"][data-testid="human-tab"]`)].find((row) => row.offsetParent !== null) ?? null;
}

/** Type as a person does: React hears each keystroke through the native setter. */
async function typeInto(input: HTMLTextAreaElement, text: string, signal: AbortSignal): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  for (let i = 1; i <= text.length; i += 1) {
    setter?.call(input, text.slice(0, i));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(text[i - 1] === " " ? 70 : 28 + Math.random() * 34, signal);
  }
}

/* -------------------------------- cursor ---------------------------------- */

interface CursorHandle {
  enter(signal: AbortSignal): Promise<void>;
  moveTo(element: Element, signal: AbortSignal, at?: { x?: number; y?: number }): Promise<void>;
  moveToPoint(x: number, y: number, signal: AbortSignal, ms?: number): Promise<void>;
  moveBy(dx: number, dy: number, signal: AbortSignal): Promise<void>;
  click(signal: AbortSignal): Promise<void>;
  keys(label: string, signal: AbortSignal): Promise<void>;
  grab(signal: AbortSignal, chip: { title: string; faviconUrl: string | null }): Promise<void>;
  release(): void;
  hide(): void;
}

/**
 * The pointer the tour moves. It also stands in for the pointer's hover:
 * the element it comes to rest on is told the pointer arrived (and the one
 * it left, that it went), which is what the shell listens for — the sidebar
 * stack fans out under it as it would under a real one.
 */
const TourCursor = forwardRef<CursorHandle>(function TourCursor(_props, ref): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [chip, setChip] = useState<{ title: string; faviconUrl: string | null } | null>(null);
  const position = useRef({ x: 0, y: 0 });
  const hovered = useRef<Element | null>(null);

  useImperativeHandle(ref, () => {
    const place = (x: number, y: number) => {
      position.current = { x, y };
      if (root.current !== null) root.current.style.transform = `translate(${x}px, ${y}px)`;
    };
    const hover = () => {
      const { x, y } = position.current;
      const target = document.elementFromPoint(x, y);
      const previous = hovered.current;
      if (target === previous) return;
      const init = { bubbles: true, clientX: x, clientY: y, pointerType: "mouse", isPrimary: true } as const;
      previous?.dispatchEvent(new PointerEvent("pointerout", { ...init, relatedTarget: target }));
      target?.dispatchEvent(new PointerEvent("pointerover", { ...init, relatedTarget: previous }));
      target?.dispatchEvent(new PointerEvent("pointermove", init));
      hovered.current = target;
    };
    const glide = async (x: number, y: number, signal: AbortSignal, ms?: number) => {
      const element = root.current;
      const from = position.current;
      const distance = Math.hypot(x - from.x, y - from.y);
      const duration = ms ?? Math.min(1_100, Math.max(380, distance * 1.1));
      place(x, y);
      if (element === null || reducedMotion()) return;
      const animation = element.animate([{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: `translate(${x}px, ${y}px)` }], {
        duration,
        easing: "cubic-bezier(0.45, 0, 0.2, 1)",
      });
      const stop = () => animation.cancel();
      signal.addEventListener("abort", stop, { once: true });
      await animation.finished.catch(() => undefined);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) throw aborted();
    };
    return {
      async enter(signal) {
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (!visible) place(w * 0.62, h * 0.72);
        setVisible(true);
        await sleep(40, signal);
      },
      async moveTo(element, signal, at = {}) {
        const box = element.getBoundingClientRect();
        await glide(box.left + box.width * (at.x ?? 0.5), box.top + box.height * (at.y ?? 0.5), signal);
        hover();
      },
      async moveToPoint(x, y, signal, ms) {
        await glide(x, y, signal, ms);
        hover();
      },
      async moveBy(dx, dy, signal) {
        const { x, y } = position.current;
        await glide(Math.min(window.innerWidth - 20, Math.max(20, x + dx)), Math.min(window.innerHeight - 20, Math.max(20, y + dy)), signal);
        hover();
      },
      async click(signal) {
        ring.current?.animate([{ opacity: 0.55, transform: "translate(-50%, -50%) scale(0.4)" }, { opacity: 0, transform: "translate(-50%, -50%) scale(1.6)" }], {
          duration: 420,
          easing: "ease-out",
        });
        root.current?.firstElementChild?.animate([{ transform: "scale(1)" }, { transform: "scale(0.82)" }, { transform: "scale(1)" }], { duration: 220 });
        await sleep(160, signal);
      },
      async keys(label, signal) {
        setHint(label);
        await sleep(750, signal);
        setHint(null);
      },
      async grab(signal, next) {
        setChip(next);
        await sleep(200, signal);
      },
      release() {
        setChip(null);
      },
      hide() {
        setVisible(false);
        setHint(null);
        setChip(null);
        const previous = hovered.current;
        hovered.current = null;
        previous?.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
      },
    };
  }, [visible]);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[2147483000] overflow-hidden" style={{ opacity: visible ? 1 : 0, transition: "opacity 200ms" }}>
      <div ref={root} className="absolute top-0 left-0 will-change-transform">
        <svg width="24" height="24" viewBox="0 0 24 24" className="block origin-top-left drop-shadow-[0_2px_3px_rgba(0,0,0,0.35)]">
          <path d="M3 2.2v17.3l4.6-4.3 2.9 6.6 3-1.3-2.9-6.5h6.2L3 2.2Z" fill="#111" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
        <span ref={ring} className="absolute top-[3px] left-[3px] size-9 rounded-full bg-[#52a862] opacity-0" style={{ transform: "translate(-50%, -50%)" }} />
        {chip !== null ? (
          <span className="absolute top-5 left-4 flex max-w-[220px] items-center gap-2 rounded-lg bg-white/95 px-2.5 py-1.5 text-[12px] font-medium text-[#1f1f1f] shadow-[0_8px_24px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.06)]">
            {chip.faviconUrl !== null ? <img src={chip.faviconUrl} alt="" className="size-4 rounded-sm" /> : null}
            <span className="truncate">{chip.title}</span>
          </span>
        ) : null}
        {hint !== null ? (
          <span className="absolute top-6 left-5 rounded-md bg-[#1f1f1f]/90 px-2 py-1 font-mono text-[12px] whitespace-nowrap text-white shadow-lg">{hint}</span>
        ) : null}
      </div>
    </div>
  );
});

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ------------------------------- director --------------------------------- */

/**
 * Plays whichever scene the page last asked for, over and over, until the
 * page asks for another — or the visitor takes the window.
 */
export function TourDirector({ host }: { host: DemoShellHost }): ReactNode {
  const cursor = useRef<CursorHandle>(null);

  useEffect(() => {
    let run: AbortController | null = null;
    let scene: TourScene | null = null;
    /** Whether the host is in a scene's state rather than the hero's. */
    let staged = false;

    const stop = () => {
      run?.abort();
      run = null;
      cursor.current?.hide();
      useAppStore.getState().setTabDragging(false);
    };

    const play = (next: TourScene | null) => {
      stop();
      scene = next;
      if (next === null) {
        if (staged) {
          host.reset(DEFAULT_SEED);
          useAppStore.getState().setConsoleOpen(false);
          staged = false;
        }
        return;
      }
      const controller = new AbortController();
      run = controller;
      staged = true;
      void (async () => {
        while (!controller.signal.aborted && cursor.current !== null) {
          // Every scene opens on a bare window: the console belongs to the
          // agent scene alone, which opens it itself when it asks. Left open
          // from a scene the page scrolled away from mid-run, it would crowd
          // the next feature into half the window.
          useAppStore.getState().setConsoleOpen(false);
          try {
            await SCENES[next]({ host, cursor: cursor.current, signal: controller.signal });
          } catch (error) {
            if (controller.signal.aborted) return;
            // A target that never showed: start the scene over rather than stall.
            console.warn(error);
          }
        }
      })();
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if ((event.data as { type?: unknown } | null)?.type === TOUR_HAND_OVER) {
        stop();
        return;
      }
      if (!isTourMessage(event.data)) return;
      if (event.data.scene === scene && (run !== null || scene === null)) return;
      play(event.data.scene);
    };
    // The visitor's own hand: the scene stops where it is and the window is
    // theirs. Not the wheel — that is how the page around the frame scrolls.
    const onVisitor = (event: Event) => {
      if (!event.isTrusted || run === null) return;
      stop();
    };

    window.addEventListener("message", onMessage);
    document.addEventListener("pointerdown", onVisitor, true);
    document.addEventListener("keydown", onVisitor, true);
    window.parent.postMessage({ type: TOUR_READY }, window.location.origin);
    return () => {
      stop();
      window.removeEventListener("message", onMessage);
      document.removeEventListener("pointerdown", onVisitor, true);
      document.removeEventListener("keydown", onVisitor, true);
    };
  }, [host]);

  return <TourCursor ref={cursor} />;
}
