import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { MessageScroller } from "@shadcn/react/message-scroller";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronUp, FileText, History, Loader2, Mic, Paperclip, Square, SquarePen, TextQuote, Undo2, X } from "lucide-react";
import type { AgentAttachment, RunSummary, ThreadListItem } from "@pistachio/protocol";
import { groupContextMediaTypeOf, type GroupContextFile, type GroupContextView } from "@pistachio/shell-contracts/desk-agent";
import { shortcutLabel } from "@pistachio/shell-contracts/shortcuts";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { nativeApi } from "../../api";
import { composerAccepts, formatAttachmentText, formatSelectionText, selectionChipLabel, toAgentAttachments } from "../../lib/chat-attachments";
import { useDeskFileDrag } from "../../lib/desk/file-drag";
import { addContextFiles } from "../../lib/desk/group-context";
import { activeMention, insertMention, mentionCandidates, mentionQuery, mentionsIn } from "../../lib/desk/mentions";
import { agentActivity } from "../../lib/desk/agent";
import { dictationSupported, spokenInsert, useDictation } from "../../lib/dictation";
import { DESK_GAP, type Rect } from "../../lib/desk/geometry";
import { agentIsActing, relativeTime, sortThreads } from "../../lib/run";
import { useAppStore } from "../../store";
import { AttachmentDropVeil, useAttachmentDrop } from "../chat/attachment-drop";
import { LiveReply } from "../chat/LiveReply";
import { ApprovalCard, ClarificationCard, CompletionMeta, MessageRow, TERMINAL, WorkTrace } from "../chat/parts";
import { useThreadLayout } from "../chat/use-thread-layout";
import { OutputCards } from "../OutputCard";
import { TakeoverCard } from "../TakeoverCard";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import type { DeskEngine, DeskView } from "./desk-engine";
import { DeskNotchFace } from "./DeskNotchFace";
import { DictationWave } from "./DictationWave";
import { FileGlyph, fileKindLabel } from "./files/FileGlyph";

/** A file of the group's context the Bar can mention: its bytes are on this Mac. */
type MentionFile = GroupContextFile & { here: boolean };

/** The files a mention being typed offers (the menu above the Bar), which is lit, and how to choose one. */
interface MentionMenuState {
  candidates: readonly MentionFile[];
  index: number;
  pick(file: MentionFile): void;
  point(index: number): void;
}

/** At most this many files a message carries as files (pictures, PDFs) through its mentions and what was attached. */
const MAX_MESSAGE_FILES = 6;

/** The Bar's height at one line: as tall as the notch grows (it grows taller with more lines). */
export const BAR_H = 52;
/** The idle notch's height above the desk's foot (`.desk-bar[data-compact]`), and the radius of its flares beside it (the engine's hole). */
export const NOTCH_H = 32;
export const NOTCH_FLARE = 10;
/** The grown Bar stays a cover this long after it starts back to its idle notch: it is over the pages until it is down. */
const NOTCH_CLOSE_MS = 280;
/** Growing waits for the pages under the grown Bar to give way, but never longer than this. */
const NOTCH_WAIT_MS = 300;
/** A tooltip over the Bar's buttons opens after this long, as the dock's do. */
const TIP_DELAY_MS = 350;
/** The band above the Bar stays a cover this long after a tooltip closes: moving from one button to the next, the next's does not wait. */
const TIP_LINGER_MS = 200;
/** The pointer on the pill this long before it grows: one passing over it on its way elsewhere does not (transitions.dev's intent delay, `--duration-micro`). */
const PILL_HOVER_MS = 80;
const PLATFORM = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other";
/** The band above the Bar where its tooltips appear, and how far past its ends they may reach. */
const TIP_BAND_H = 44;
const TIP_BAND_REACH = 56;

/** A tooltip over one of the Bar's buttons (as the dock's DockTip): open as Base UI says, seen once no live page is under it. */
interface BarTip {
  open: boolean;
  shown: boolean;
  onOpenChange: (open: boolean) => void;
}

/** An element's laid-out box in the stage (its transforms — the Bar rising in — never move it). */
function stageBox(el: HTMLElement): Rect | null {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node !== null && !node.classList.contains("desk-stage")) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return node === null ? null : { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

/**
 * What the Bar draws over the desk is a cover (DeskEngine.setCover): a live
 * page is a native view and would paint over it, so the windows under it
 * give way to their stills while it is up. `shape` makes the cover of the
 * element's box (the grown notch's, from its box at any size).
 */
function useCover(engine: DeskEngine, key: string, ref: RefObject<HTMLElement | null>, active: boolean, shape?: (box: Rect) => Rect): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || el === null) {
      engine.setCover(key, null);
      return;
    }
    const measure = (): void => {
      const box = stageBox(el);
      engine.setCover(key, box === null || shape === undefined ? box : shape(box));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // (The stage too: the desk resized moves what is centred on it.)
    const stage = el.closest(".desk-stage");
    if (stage !== null) observer.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      engine.setCover(key, null);
    };
  }, [engine, key, ref, active, shape]);
}

/** The grown notch's footprint, from the anchor's box at any size: the Bar's whole width at one line at least, and its flares. */
function grownNotch(box: Rect): Rect {
  const h = Math.max(box.h, BAR_H);
  return { x: box.x - NOTCH_FLARE, y: box.y + box.h - h, w: box.w + NOTCH_FLARE * 2, h };
}

/** True while `on`, and for `ms` after it goes. */
function useLinger(on: boolean, ms: number): boolean {
  const [lingering, setLingering] = useState(on);
  useLayoutEffect(() => {
    if (on) {
      setLingering(true);
      return;
    }
    const timer = window.setTimeout(() => setLingering(false), ms);
    return () => window.clearTimeout(timer);
  }, [on, ms]);
  return on || lingering;
}

/**
 * The desk's agent, in a notch at the desk's foot (docs/desk-agent.md
 * §1): the message field, attach, the conversations, the answer and send —
 * stop while the agent works. Above it, the answer card shows the latest
 * exchange as it happens; it opens when a turn starts and stays until
 * closed. The card sits on the Bar, however tall the Bar grows, and is as
 * wide. The conversations it lists are every thread, each marked with the
 * group it started in: choosing one continues it at this desk.
 *
 * The notch is the shell's own ground rising out of the surface's edge
 * into the desk. Idle — nothing typed or staged, nothing open above it, the
 * agent not at work, no file on its way, the keyboard and the pointer
 * elsewhere — it is small and says what it is for, and the windows under it
 * are cut short of it (DeskEngine.setNotch); the pointer coming to it, a
 * click, ⌘I or a drag of files grows it into the Bar (a morph,
 * transitions.dev's plus → menu: the row keeps its full width and is
 * revealed as the notch widens around it) — a cover, once the pages under
 * it have given way (the pointer on it asks them to at once).
 *
 * `undo` is offered on the card after a turn that moved the windows.
 */
export const DeskBar = memo(function DeskBar({
  group,
  groups,
  engine,
  view,
  run,
  threads,
  undo,
  onUndo,
  focusSignal,
  context,
}: {
  group: TabGroupInfo;
  /** The Space's groups, to name the group a conversation started in. */
  groups: readonly TabGroupInfo[];
  engine: DeskEngine;
  view: DeskView;
  run: RunSummary | null;
  threads: readonly ThreadListItem[];
  undo: boolean;
  onUndo: () => void;
  /** Changes when the keyboard should come to the field (⌘I on a desk). */
  focusSignal: number;
  /** The group's context: its files can be @mentioned. */
  context: GroupContextView | null;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const mentionsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The composer's own: puts text at the caret (a mention of a file just taken into the context). */
  const insertRef = useRef<((text: string) => void) | null>(null);
  const focusInput = useCallback(() => inputRef.current?.focus({ preventScroll: true }), []);
  // A Word or Excel file dropped on the Bar goes into the group's context, and the message mentions it.
  const groupRef = useRef(group);
  groupRef.current = group;
  const divert = useCallback((files: File[]): File[] => {
    const elsewhere = files.filter((file) => !composerAccepts(file) && groupContextMediaTypeOf(file.name, file.type) !== null);
    if (elsewhere.length === 0) return files;
    const target = groupRef.current;
    void addContextFiles(target.id, target.title, elsewhere).then((result) => {
      const names = (result.added ?? []).map((added) => `@${added.name} `).join("");
      if (names !== "") insertRef.current?.(names);
      if (result.rejected.length > 0) useAppStore.getState().showNotice(result.rejected.map((entry) => `${entry.name}: ${entry.reason}`).join(" · "), { tone: "warning" });
    });
    return files.filter((file) => !elsewhere.includes(file));
  }, []);
  const drop = useAttachmentDrop(focusInput, { divert });
  const fileDrag = useDeskFileDrag((state) => state.active);
  const [mentionMenu, setMentionMenu] = useState<MentionMenuState | null>(null);
  const [answerOpen, setAnswerOpen] = useState(false);
  const [whole, setWhole] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const leaving = view.phase === "leaving";
  const cardShown = answerOpen && run !== null && !leaving;

  useCover(engine, "answer", cardRef, cardShown);
  useCover(engine, "conversations", pickerRef, pickerOpen && !leaving);
  useCover(engine, "mentions", mentionsRef, mentionMenu !== null && !leaving);

  // The card opens when a turn starts — the person's message, or the agent
  // asking something — and stays until it is closed.
  const userMessages = run?.messages.filter((message) => message.role === "user").length ?? 0;
  const asking = run?.pendingQuestion?.id ?? run?.pendingTakeover?.id ?? run?.pendingApproval?.id ?? null;
  const seen = useRef({ runId: run?.runId ?? null, userMessages, asking });
  useEffect(() => {
    const before = seen.current;
    seen.current = { runId: run?.runId ?? null, userMessages, asking };
    if (run === null) {
      setAnswerOpen(false);
      return;
    }
    if (before.runId !== run.runId) {
      setWhole(false);
      return;
    }
    if (userMessages > before.userMessages || (asking !== null && asking !== before.asking)) setAnswerOpen(true);
  }, [run, userMessages, asking]);

  // Escape closes what is open over the desk, the picker first.
  useEffect(() => {
    if (!cardShown && !pickerOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape in a document's window is the document's (its editor, its sheet).
      if (event.target instanceof Element && event.target.closest(".desk-window") !== null) return;
      if (pickerOpen) setPickerOpen(false);
      else setAnswerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cardShown, pickerOpen]);

  // The conversations go on a press anywhere else — a live page's too, which
  // the shell never hears itself (main relays it) — or Escape in a page.
  // Their button toggles them itself.
  useEffect(() => {
    if (!pickerOpen) return;
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input === "press" || input === "escape") setPickerOpen(false);
    });
    const onDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && (pickerRef.current?.contains(target) === true || target.closest("[data-testid='desk-bar-conversations']") !== null)) return;
      setPickerOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      offPage?.();
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (focusSignal > 0) focusInput();
  }, [focusSignal, focusInput]);

  const activity = agentActivity(run);
  const shownCover = (key: string): boolean => view.clearCovers.has(key);

  // Idle, the Bar is a small notch. The composer says whether it holds anything; the rest is what is open around it.
  const [composerIdle, setComposerIdle] = useState(true);
  const [focusWithin, setFocusWithin] = useState(false);
  const [hovered, setHovered] = useState(false);
  /** The pointer is on the idle notch: the pages under the grown Bar are asked to give way at once, before it grows. */
  const [arming, setArming] = useState(false);
  const hoverTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  /** The pointer came onto the Bar (or the notch view over a page): the pages under it are asked to give way, and it grows once the pointer has rested. */
  const enterBar = useCallback(() => {
    setArming(true);
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovered(true), PILL_HOVER_MS);
  }, []);
  const leaveBar = useCallback(() => {
    setArming(false);
    window.clearTimeout(hoverTimer.current);
    setHovered(false);
  }, []);
  const wanted = !composerIdle || focusWithin || hovered || cardShown || pickerOpen || mentionMenu !== null || fileDrag || drop.dragging;
  // Grown, the Bar is a cover (its whole footprint, whatever its width as it grows or shrinks: what is under it is the
  // same throughout), from the pointer coming to it until it is back down.
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    setOverdue(false);
    if (!wanted) return;
    const timer = window.setTimeout(() => setOverdue(true), NOTCH_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [wanted]);
  const compact = !wanted || !(shownCover("bar") || overdue);
  const covering = useLinger(!compact, NOTCH_CLOSE_MS) || wanted || arming;
  useCover(engine, "bar", anchorRef, covering && !leaving, grownNotch);
  const askKey = useAppStore((state) => shortcutLabel(state.settings.shortcuts.toggleConsole, PLATFORM));
  // The idle notch is as wide as what it says (a long group name is cut short).
  const [pillWidth, setPillWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = pillRef.current;
    if (el === null) return;
    const measure = (): void => setPillWidth(el.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The idle notch at the desk's foot: the engine knows where it lies over the windows (whether a live page is under it).
  useLayoutEffect(() => {
    engine.setNotch(leaving || pillWidth === null ? null : { w: pillWidth + NOTCH_FLARE * 2, h: NOTCH_H });
  }, [engine, leaving, pillWidth]);
  useEffect(() => () => engine.setNotch(null), [engine]);
  // Over a live page, idle, the notch is main's notch view (NotchApp), drawn over the page as nothing of the
  // shell's can be: it is told where (the notch and its flares, in the window) and what it says.
  const overPage = compact && view.notchOver && !leaving;
  useLayoutEffect(() => {
    const api = nativeApi();
    const el = barRef.current;
    if (api === null) return;
    if (!overPage || el === null) {
      api.setDeskNotch(null);
      return;
    }
    const send = (): void => {
      const box = el.getBoundingClientRect();
      api.setDeskNotch({
        bounds: { x: box.left - NOTCH_FLARE, y: box.top, width: box.width + NOTCH_FLARE * 2, height: box.height },
        label: `Ask about ${group.title}`,
        shortcut: askKey,
        color: group.color,
        radius: Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0,
        flare: NOTCH_FLARE,
      });
    };
    send();
    const observer = new ResizeObserver(send);
    observer.observe(el);
    const stage = el.closest(".desk-stage");
    if (stage !== null) observer.observe(stage);
    window.addEventListener("resize", send);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [overPage, group.title, group.color, askKey]);
  useEffect(() => () => nativeApi()?.setDeskNotch(null), []);
  // The pointer on the notch view, and a press there: the Bar's, as if they were on it.
  useEffect(
    () =>
      nativeApi()?.onDeskNotchInput((input) => {
        if (input === "enter") enterBar();
        else if (input === "leave") leaveBar();
        else focusInput();
      }),
    [enterBar, leaveBar, focusInput],
  );
  // The notch as it is drawn now, as it grows and shrinks: the engine cuts it through the well and the windows under it.
  useLayoutEffect(() => {
    const el = barRef.current;
    if (el === null || leaving) {
      engine.setNotchShape(null);
      return;
    }
    const measure = (): void => {
      const box = stageBox(el);
      if (box !== null) engine.setNotchShape({ ...box, radius: Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, flare: NOTCH_FLARE });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const stage = el.closest(".desk-stage");
    if (stage !== null) observer.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      engine.setNotchShape(null);
    };
  }, [engine, leaving]);

  // A button's tooltip is open: the band above the Bar, where it appears, is
  // a cover, and stays one a moment after it closes (the dock's rule).
  const [tip, setTip] = useState<string | null>(null);
  const openTip = leaving ? null : tip;
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (openTip === null || bar === null) {
      const timer = window.setTimeout(() => engine.setCover("bar-tip", null), TIP_LINGER_MS);
      return () => window.clearTimeout(timer);
    }
    const box = stageBox(bar);
    if (box !== null) engine.setCover("bar-tip", { x: box.x - TIP_BAND_REACH, y: box.y - TIP_BAND_H, w: box.w + TIP_BAND_REACH * 2, h: TIP_BAND_H });
  }, [engine, openTip]);
  useEffect(() => () => engine.setCover("bar-tip", null), [engine]);
  // A button that goes while its tooltip is open (the row changing for dictation) never says it closed.
  const closeTips = useCallback(() => setTip(null), []);
  const barTip = (label: string): BarTip => ({
    open: openTip === label,
    shown: shownCover("bar-tip"),
    onOpenChange: (open) => setTip((current) => (open ? label : current === label ? null : current)),
  });

  return (
    // Centred on the desk, on its foot.
    <div className="desk-bar-lane" data-testid="desk-bar-lane" style={{ left: DESK_GAP, right: DESK_GAP, bottom: 0 }}>
      {/* One column, the Bar's width: the answer rests on the Bar, however tall the Bar grows. */}
      <div className="desk-bar-column">
        {cardShown ? (
          <AnswerCard
            ref={cardRef}
            run={run}
            whole={whole}
            shown={shownCover("answer")}
            onWhole={() => setWhole((value) => !value)}
            undo={undo}
            onUndo={onUndo}
            onClose={() => setAnswerOpen(false)}
          />
        ) : null}
        <div ref={anchorRef} className="desk-bar-anchor">
          {/* Over the answer, on the Bar's top edge: it is what the conversations button opened last. */}
          {pickerOpen && !leaving ? (
            <ConversationPicker
              ref={pickerRef}
              groupId={group.id}
              groups={groups}
              threads={threads}
              run={run}
              shown={shownCover("conversations")}
              onClose={() => setPickerOpen(false)}
            />
          ) : null}
          {mentionMenu !== null && !leaving ? <MentionMenu ref={mentionsRef} menu={mentionMenu} shown={shownCover("mentions")} /> : null}
          {/* The notch: the Bar, its flares beside its foot. */}
          <div
            className="desk-notch"
            data-compact={compact ? "" : undefined}
            style={pillWidth === null ? undefined : ({ "--desk-pill-w": `${String(pillWidth)}px` } as React.CSSProperties)}
          >
            <div
              ref={barRef}
              {...drop.handlers}
              role="region"
              aria-label="Ask Pistachio about this desk"
              data-testid="desk-bar"
              data-acting={activity !== null ? "" : undefined}
              data-drop-target={fileDrag && !drop.dragging ? "" : undefined}
              data-compact={compact ? "" : undefined}
              className="desk-bar"
              onFocus={() => setFocusWithin(true)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
              }}
              onPointerEnter={enterBar}
              // A close is never delayed: the pointer gone, the Bar goes back to its idle notch at once.
              onPointerLeave={leaveBar}
            >
              {/* What the Bar is while idle: a click grows it and puts the keyboard in its field. */}
              <span className="desk-bar-pill" aria-hidden="true" data-testid="desk-bar-pill" onMouseDown={(event) => event.preventDefault()} onClick={focusInput}>
                <DeskNotchFace ref={pillRef} label={`Ask about ${group.title}`} shortcut={askKey} />
              </span>
              {drop.dragging ? <AttachmentDropVeil data-testid="desk-bar-drop-veil" className="inset-1 rounded-t-[19px] rounded-b-md" /> : null}
              <TooltipProvider delay={TIP_DELAY_MS}>
                <BarComposer
                  group={group}
                  context={context}
                  run={run}
                  activity={activity}
                  inputRef={inputRef}
                  insertRef={insertRef}
                  fileDrag={fileDrag}
                  onMentionMenu={setMentionMenu}
                  drop={drop}
                  answerOpen={cardShown}
                  pickerOpen={pickerOpen}
                  tip={barTip}
                  onTipsGone={closeTips}
                  onSent={() => setAnswerOpen(true)}
                  onToggleAnswer={() => setAnswerOpen((value) => !value)}
                  onTogglePicker={() => setPickerOpen((value) => !value)}
                  onIdle={setComposerIdle}
                />
              </TooltipProvider>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

/** The Bar's own row: the field and its buttons; files staged for the message above them. */
function BarComposer({
  group,
  context,
  run,
  activity,
  inputRef,
  insertRef,
  fileDrag,
  onMentionMenu,
  drop,
  answerOpen,
  pickerOpen,
  tip,
  onTipsGone,
  onSent,
  onToggleAnswer,
  onTogglePicker,
  onIdle,
}: {
  group: TabGroupInfo;
  context: GroupContextView | null;
  run: RunSummary | null;
  activity: string | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  insertRef: RefObject<((text: string) => void) | null>;
  /** Files are being dragged over the desk: the Bar says it takes them. */
  fileDrag: boolean;
  onMentionMenu: (menu: MentionMenuState | null) => void;
  drop: ReturnType<typeof useAttachmentDrop>;
  answerOpen: boolean;
  pickerOpen: boolean;
  tip: (label: string) => BarTip;
  /** The row's buttons changed under the pointer: whatever tooltip was open has gone with its button. */
  onTipsGone: () => void;
  onSent: () => void;
  onToggleAnswer: () => void;
  onTogglePicker: () => void;
  /** Whether it holds nothing and nothing is going on in it: the Bar may then be its pill. */
  onIdle: (idle: boolean) => void;
}) {
  const sendMessage = useAppStore((state) => state.sendAgentMessage);
  const interrupt = useAppStore((state) => state.interruptAgent);
  const [value, setValue] = useState("");
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  /** A mention menu the person dismissed (Escape) stays away until the next `@`. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  /** Messages go out in the order they were sent, however long a mention takes to read. */
  const sending = useRef<Promise<void>>(Promise.resolve());
  const acting = agentIsActing(run);
  const { staged, setStaged } = drop;
  const doneRef = useRef<HTMLButtonElement>(null);

  // Dictation: while the microphone listens the field gives way to what it
  // hears, and what was said goes in where the caret was — to be read back
  // and sent, as the console's composer does.
  const [canDictate] = useState(dictationSupported);
  /** The keyboard back in the field, unless it has gone somewhere else meanwhile (a document's window). */
  const refocus = useCallback(
    (caretAt?: number) => {
      requestAnimationFrame(() => {
        const el = inputRef.current;
        const active = document.activeElement;
        if (el === null || (active !== null && active !== document.body && el.closest(".desk-bar")?.contains(active) !== true)) return;
        el.focus({ preventScroll: true });
        if (caretAt !== undefined) el.setSelectionRange(caretAt, caretAt);
      });
    },
    [inputRef],
  );
  const voice = useDictation({
    onText: (spoken) => {
      // The field keeps its selection while it is hidden.
      const el = inputRef.current;
      const next = spokenInsert(value, el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length, spoken);
      setValue(next.text);
      setCaret(next.caret);
      refocus(next.caret);
    },
    onError: (message) => {
      drop.reject(message);
      refocus();
    },
  });
  const listening = voice.phase !== "idle";
  const startDictation = (): void => {
    drop.dismissRejection();
    voice.start();
  };
  const discardDictation = (): void => {
    voice.cancel();
    refocus();
  };
  useEffect(() => {
    onTipsGone();
    // Listening, the keyboard is on Done: Enter or Space finishes, Escape discards.
    if (listening) {
      const active = document.activeElement;
      if (active === null || active === document.body || active.closest(".desk-bar") !== null) doneRef.current?.focus({ preventScroll: true });
    }
  }, [listening, onTipsGone]);
  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || (event.key !== "Escape" && event.key !== "Enter")) return;
      // A key in a document's window, or in a field elsewhere, is theirs; Enter on one of the Bar's buttons presses it.
      const target = event.target instanceof Element && event.target !== document.body ? event.target : null;
      if (target !== null && target.closest(".desk-bar") === null) return;
      if (event.key === "Enter" && (target instanceof HTMLButtonElement || event.shiftKey || event.metaKey || event.altKey || event.ctrlKey)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") discardDictation();
      else voice.finish();
    };
    // Capturing, so the Bar's own Escape (closing the answer) waits for it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // The group's files that can be mentioned: those whose bytes are on this Mac.
  const files = useMemo(() => (context?.items ?? []).filter((item): item is MentionFile => item.kind === "file" && item.here), [context]);
  const names = useMemo(() => files.map((file) => file.name), [files]);
  const spans = useMemo(() => mentionsIn(value, names), [value, names]);
  // (A mention accepted, or dismissed, is not being typed: Enter sends, Tab leaves.)
  const typing = activeMention(value, caret, names, dismissedAt);
  const typed = typing?.query ?? null;
  const candidates = useMemo(() => (typed === null ? [] : mentionCandidates(files, typed)), [files, typed]);
  const menuOpen = !listening && typing !== null && candidates.length > 0;
  const lit = Math.min(mentionIndex, Math.max(0, candidates.length - 1));

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${String(el.scrollHeight)}px`;
    if (mirrorRef.current !== null) mirrorRef.current.scrollTop = el.scrollTop;
    // (Hidden while dictating, it has no height to measure; shown again, it is measured afresh.)
  }, [value, inputRef, listening]);

  /** Put text at the caret, as if typed. */
  const insertText = useCallback(
    (text: string) => {
      const el = inputRef.current;
      const at = el?.selectionStart ?? value.length;
      const next = `${value.slice(0, at)}${text}${value.slice(el?.selectionEnd ?? at)}`;
      setValue(next);
      const moved = at + text.length;
      setCaret(moved);
      requestAnimationFrame(() => {
        el?.focus({ preventScroll: true });
        el?.setSelectionRange(moved, moved);
      });
    },
    [inputRef, value],
  );
  useEffect(() => {
    insertRef.current = insertText;
    return () => {
      insertRef.current = null;
    };
  }, [insertRef, insertText]);

  const pick = useCallback(
    (file: MentionFile) => {
      if (typing === null) return;
      const el = inputRef.current;
      const next = insertMention(value, typing.start, caret, file.name);
      setValue(next.text);
      setCaret(next.caret);
      setMentionIndex(0);
      requestAnimationFrame(() => {
        el?.focus({ preventScroll: true });
        el?.setSelectionRange(next.caret, next.caret);
      });
    },
    [caret, inputRef, typing, value],
  );

  // The menu is drawn beside the Bar, where the glass behind it is the desk's (DeskBar).
  useEffect(() => {
    onMentionMenu(menuOpen ? { candidates, index: lit, pick, point: setMentionIndex } : null);
  }, [candidates, lit, menuOpen, onMentionMenu, pick]);
  useEffect(() => () => onMentionMenu(null), [onMentionMenu]);

  const empty = value.trim() === "" && staged.length === 0;
  const idle = value === "" && staged.length === 0 && drop.rejection === null && !listening && !acting;
  useEffect(() => onIdle(idle), [idle, onIdle]);
  const submit = (): void => {
    if (empty) return;
    const text = value.trim();
    const mentioned = [...new Set(mentionsIn(text, names).map((span) => span.name))].flatMap((name) => files.filter((file) => file.name === name).slice(0, 1));
    const textBlocks = staged.flatMap((file) => {
      if (file.kind === "text") return [formatAttachmentText(file.name, file.text ?? "")];
      if (file.kind === "selection") return [formatSelectionText(file.name, file.url, file.text ?? "")];
      return [];
    });
    const attachments = toAgentAttachments(staged);
    setValue("");
    setCaret(0);
    setStaged([]);
    drop.dismissRejection();
    onSent();
    const send = async (): Promise<void> => {
      // Each file @mentioned rides with the message, as the agent would read it: its text, or the file itself.
      const mentionBlocks: string[] = [];
      const api = nativeApi();
      for (const file of mentioned) {
        const reading = api === null ? null : await api.groupFileForMessage(group.id, file.id).catch(() => null);
        if (reading?.kind === "text") mentionBlocks.push(formatAttachmentText(file.name, reading.text));
        else if (reading?.kind === "file" && attachments.length < MAX_MESSAGE_FILES) attachments.push({ id: crypto.randomUUID(), name: file.name, mediaType: reading.mediaType, url: reading.dataUrl } satisfies AgentAttachment);
        else mentionBlocks.push(`“${file.name}” is in this desk's context as ${file.id}${reading?.kind === "reference" ? ` (${reading.reason})` : ""}: read it with context_read.`);
      }
      // The desk is the subject, not the page in view: the desk block tells the agent what is on it.
      await sendMessage([text, ...mentionBlocks, ...textBlocks].filter((block) => block !== "").join("\n\n"), attachments, { page: false });
    };
    sending.current = sending.current.then(send, send).catch(() => undefined);
  };

  const onFieldKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((lit + step + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const chosen = candidates[lit];
        if (chosen !== undefined) pick(chosen);
        return;
      }
      if (event.key === "Escape") {
        // The menu goes; the answer card stays (the Bar's own Escape is not reached).
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(typing?.start ?? null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  const noteCaret = (event: React.SyntheticEvent<HTMLTextAreaElement>): void => setCaret(event.currentTarget.selectionStart);

  const placeholder = fileDrag
    ? "Drop here to attach to your message"
    : acting
      ? `${activity ?? "Working"}… type to steer`
      : run === null || TERMINAL.has(run.status) || run.messages.length === 0
        ? files.length > 0
          ? `Ask about ${group.title}… (@ to mention a file)`
          : `Ask about ${group.title}…`
        : "Ask a follow-up…";
  return (
    <div className="desk-bar-body flex flex-col">
      {drop.rejection === null ? null : (
        <div role="status" className="mx-3 mt-2 flex items-start gap-1.5 rounded-md bg-amber-100 px-2 py-1 text-[11px] leading-4 text-amber-900">
          <span className="min-w-0 flex-1">{drop.rejection}</span>
          <button type="button" aria-label="Dismiss" onClick={drop.dismissRejection} className="shrink-0 cursor-pointer rounded-xs p-0.5 hover:bg-amber-400">
            <X className="size-3" aria-hidden="true" />
          </button>
        </div>
      )}
      {staged.length === 0 ? null : (
        <div className="mx-3 mt-2 flex flex-wrap items-end gap-1.5" data-testid="desk-bar-staged">
          {staged.map((file) => (
            <span key={file.id} className="group/chip relative">
              {file.kind === "image" ? (
                <img src={file.url} alt={file.name} title={file.name} draggable={false} className="block h-9 w-auto max-w-20 rounded-sm object-cover shadow-border" />
              ) : (
                <span title={file.name} className="flex h-7 max-w-44 items-center gap-1.5 rounded-sm bg-background-200 px-2 text-label-12 text-gray-900 shadow-border">
                  {file.kind === "selection" ? <TextQuote className="size-3 shrink-0 text-gray-700" aria-hidden="true" /> : <FileText className="size-3 shrink-0 text-gray-700" aria-hidden="true" />}
                  <span className="truncate">{file.kind === "selection" ? selectionChipLabel(file.text ?? "") : file.name}</span>
                </span>
              )}
              <button
                type="button"
                title="Remove"
                aria-label={`Remove ${file.name}`}
                onClick={() => setStaged((prev) => prev.filter((entry) => entry.id !== file.id))}
                className="absolute -top-1.5 -right-1.5 grid size-4 cursor-pointer place-items-center rounded-full bg-gray-1000 text-background-100 opacity-0 transition-opacity group-hover/chip:opacity-100 focus-visible:opacity-100"
              >
                <X className="size-2.5" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="desk-bar-row" data-listening={listening ? "" : undefined}>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          data-testid="desk-bar-attach-input"
          onChange={(event) => {
            const files = event.currentTarget.files;
            if (files !== null && files.length > 0) void drop.addFiles(files);
            event.currentTarget.value = "";
          }}
        />
        {/* Discard at the leading end, clear of where the microphone was: a second press there only listens on. */}
        {listening ? (
          <>
            <BarButton label="Discard recording" testId="desk-bar-dictation-discard" tip={tip("Discard recording")} onClick={discardDictation}>
              <X aria-hidden="true" />
            </BarButton>
            <DictationWave dictation={voice.dictation} phase={voice.phase} />
          </>
        ) : null}
        <div className="desk-bar-field" hidden={listening}>
          {/* The mentions, lit behind the field's own text (which stays the field's, caret and all). */}
          <div ref={mirrorRef} aria-hidden="true" className="desk-bar-mirror text-copy-14 px-1 py-[7px] text-[14px] leading-[22px]">
            {spans.length === 0 ? null : mirrorSegments(value, spans)}
          </div>
          <Textarea
            ref={inputRef}
            data-testid="desk-bar-input"
            aria-label={acting ? "Steer Pistachio" : "Ask Pistachio"}
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? "desk-mentions" : undefined}
            aria-activedescendant={menuOpen ? `desk-mention-${String(lit)}` : undefined}
            placeholder={placeholder}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setCaret(event.target.selectionStart);
              setMentionIndex(0);
              if (dismissedAt !== null && mentionQuery(event.target.value, event.target.selectionStart)?.start !== dismissedAt) setDismissedAt(null);
            }}
            onSelect={noteCaret}
            onClick={noteCaret}
            onScroll={(event) => {
              if (mirrorRef.current !== null) mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
            }}
            onKeyDown={onFieldKeyDown}
            className="scroll-thin relative max-h-32 min-h-9 flex-1 overflow-y-auto px-1 py-[7px] text-[14px] leading-[22px]"
            variant="bare"
            rows={1}
          />
        </div>
        {listening ? null : (
          <BarButton label="Attach files" testId="desk-bar-attach" tip={tip("Attach files")} onClick={() => fileRef.current?.click()}>
            <Paperclip aria-hidden="true" />
          </BarButton>
        )}
        {listening ? null : (
          <BarButton label="Conversations" testId="desk-bar-conversations" pressed={pickerOpen} tip={tip("Conversations")} onClick={onTogglePicker}>
            <History aria-hidden="true" />
          </BarButton>
        )}
        {run === null || listening ? null : (
          <BarButton
            label={answerOpen ? "Hide the answer" : "Show the answer"}
            testId="desk-bar-answer"
            pressed={answerOpen}
            tip={tip(answerOpen ? "Hide the answer" : "Show the answer")}
            onClick={onToggleAnswer}
          >
            {answerOpen ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
          </BarButton>
        )}
        {canDictate && !listening ? (
          <BarButton label="Dictate" testId="desk-bar-dictate" tip={tip("Dictate")} onClick={startDictation}>
            <Mic aria-hidden="true" />
          </BarButton>
        ) : null}
        {listening ? (
          <BarButton
            buttonRef={doneRef}
            label="Done"
            testId="desk-bar-dictation-done"
            kind="send"
            unavailable={voice.phase !== "recording"}
            tip={tip("Done")}
            onClick={voice.finish}
          >
            {voice.phase === "transcribing" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
          </BarButton>
        ) : acting ? (
          <BarButton label="Stop" testId="desk-bar-stop" kind="send" tip={tip("Stop")} onClick={() => void interrupt()}>
            <Square className="fill-current" aria-hidden="true" />
          </BarButton>
        ) : (
          // Not `disabled` while empty: a disabled button hears no pointer, and its tooltip would never show.
          <BarButton label="Send" testId="desk-bar-send" kind="send" unavailable={empty} tip={tip("Send")} onClick={submit}>
            <ArrowUp aria-hidden="true" />
          </BarButton>
        )}
      </div>
    </div>
  );
}

/** The field's text with its mentions marked, for the mirror behind it (a last line break kept, as the field lays it out). */
function mirrorSegments(value: string, spans: ReadonlyArray<{ start: number; end: number }>): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let at = 0;
  spans.forEach((span, index) => {
    if (span.start > at) out.push(value.slice(at, span.start));
    out.push(
      <mark key={index} className="desk-bar-mention">
        {value.slice(span.start, span.end)}
      </mark>,
    );
    at = span.end;
  });
  out.push(`${value.slice(at)}\u200b`);
  return out;
}

/**
 * The files a mention offers, over the desk above the Bar's leading end:
 * each with its kind, the lit one chosen by Enter or Tab, any by a click.
 */
function MentionMenu({ ref, menu, shown }: { ref: React.Ref<HTMLDivElement>; menu: MentionMenuState; shown: boolean }) {
  return (
    <div ref={ref} id="desk-mentions" role="listbox" aria-label="Mention a file" data-testid="desk-mentions" data-shown={shown ? "" : undefined} className="desk-mentions">
      <div className="flex flex-col gap-px p-1.5">
        {menu.candidates.map((file, index) => (
          <button
            key={file.id}
            id={`desk-mention-${String(index)}`}
            type="button"
            role="option"
            aria-selected={index === menu.index}
            data-testid="desk-mention"
            className="desk-mention"
            onMouseDown={(event) => event.preventDefault()}
            onPointerEnter={() => menu.point(index)}
            onClick={() => menu.pick(file)}
          >
            <FileGlyph mediaType={file.mediaType} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-gray-1000">{file.name}</span>
            <span className="shrink-0 text-[11px] text-gray-700">{fileKindLabel(file.mediaType, file.name)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** One of the Bar's buttons, its label in a tooltip above it. */
function BarButton({
  buttonRef,
  label,
  testId,
  pressed,
  kind = "tool",
  unavailable = false,
  tip,
  onClick,
  children,
}: {
  buttonRef?: React.Ref<HTMLButtonElement>;
  label: string;
  testId: string;
  pressed?: boolean;
  /** Send and Stop are the Bar's filled round button; the rest its quiet ones. */
  kind?: "tool" | "send";
  /** Nothing to do yet (Send with nothing typed): it says so, but still shows its tooltip. */
  unavailable?: boolean;
  tip: BarTip;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip open={tip.open} onOpenChange={tip.onOpenChange}>
      <TooltipTrigger
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        aria-disabled={unavailable ? true : undefined}
        data-testid={testId}
        className={kind === "send" ? "desk-bar-send" : "desk-bar-button"}
        // A press leaves the keyboard where it was.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (!unavailable) onClick();
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={10}
        data-testid="desk-bar-tip"
        data-shown={tip.shown ? "" : undefined}
        // Until the pages under it have given way, it is there but unseen.
        className={tip.shown ? "whitespace-nowrap" : "whitespace-nowrap opacity-0"}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The latest exchange, over the desk above the Bar: what was asked, the
 * agent's steps as it takes them, its reply as it streams, and anything it
 * asks. "Whole conversation" shows every turn, scrolled to the end.
 */
function AnswerCard({
  ref,
  run,
  whole,
  shown,
  onWhole,
  undo,
  onUndo,
  onClose,
}: {
  ref: React.Ref<HTMLDivElement>;
  run: RunSummary;
  whole: boolean;
  shown: boolean;
  onWhole: () => void;
  undo: boolean;
  onUndo: () => void;
  onClose: () => void;
}) {
  const layout = useThreadLayout(run);
  const { tracesAt, outputsAt, pendingOutputs, sourcesAt, pendingSources } = layout;
  let lastAsked = run.messages.length - 1;
  while (lastAsked > 0 && run.messages[lastAsked]?.role !== "user") lastAsked -= 1;
  const from = whole ? 0 : Math.max(0, lastAsked);
  const earlier = from > 0;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Pistachio's answer"
      data-testid="desk-answer"
      data-shown={shown ? "" : undefined}
      className="desk-answer"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-4">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-gray-900" data-testid="desk-answer-title">
          {run.title}
        </span>
        {undo ? (
          <button type="button" data-testid="desk-undo-layout" className="desk-answer-action" onMouseDown={(event) => event.preventDefault()} onClick={onUndo}>
            <Undo2 aria-hidden="true" />
            Undo layout
          </button>
        ) : null}
        {earlier || whole ? (
          <button type="button" data-testid="desk-answer-whole" className="desk-answer-action" aria-pressed={whole} onMouseDown={(event) => event.preventDefault()} onClick={onWhole}>
            {whole ? "Latest" : "Whole conversation"}
          </button>
        ) : null}
        <button type="button" aria-label="Hide the answer" title="Hide (Esc)" data-testid="desk-answer-close" className="desk-bar-button" onMouseDown={(event) => event.preventDefault()} onClick={onClose}>
          <ChevronDown aria-hidden="true" />
        </button>
      </header>
      <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollPreviousItemPeek={48}>
        <MessageScroller.Root className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <MessageScroller.Viewport className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" aria-label="Conversation">
            <MessageScroller.Content className="flex shrink-0 flex-col px-4 pt-1 pb-4" aria-busy={run.status === "running"}>
              <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                {run.result === null ? "" : "Answer complete"}
              </span>
              {run.messages.map((message, index) =>
                index < from ? null : (
                  <MessageScroller.Item key={message.id} messageId={message.id} scrollAnchor={message.role === "user"} className="mb-4 min-w-0">
                    <MessageRow
                      message={message}
                      outputs={outputsAt.get(index)}
                      sources={sourcesAt.get(index)}
                      links="glance"
                      canRetry={
                        message.role === "assistant" &&
                        index === run.messages.length - 1 &&
                        !agentIsActing(run) &&
                        run.status !== "waiting_for_judgment" &&
                        run.status !== "waiting_for_approval" &&
                        run.status !== "human_control" &&
                        run.executor?.kind !== "cloud"
                      }
                    />
                    {(tracesAt.get(index) ?? []).map((turn) => (
                      <Fragment key={turn.turn}>
                        <WorkTrace turn={turn} latest={turn.toolCalls.at(-1) === run.toolCalls.at(-1)} awaitingApproval={run.status === "waiting_for_approval"} />
                        {pendingOutputs.has(turn.turn) ? (
                          <div className="mt-3">
                            <OutputCards outputs={pendingOutputs.get(turn.turn)!} />
                          </div>
                        ) : null}
                      </Fragment>
                    ))}
                  </MessageScroller.Item>
                ),
              )}
              {run.pendingQuestion === null ? null : (
                <MessageScroller.Item messageId={run.pendingQuestion.id} className="mb-4 min-w-0">
                  <ClarificationCard run={run} />
                </MessageScroller.Item>
              )}
              {run.pendingTakeover === null ? null : (
                <MessageScroller.Item messageId={run.pendingTakeover.id} className="mb-4 min-w-0">
                  <TakeoverCard run={run} />
                </MessageScroller.Item>
              )}
              {run.pendingApproval === null ? null : (
                <MessageScroller.Item messageId={run.pendingApproval.id} className="mb-4 min-w-0">
                  <ApprovalCard run={run} />
                </MessageScroller.Item>
              )}
              {run.result === null ? null : (
                <MessageScroller.Item messageId={`result-${run.runId}`} className="mb-1 min-w-0">
                  <CompletionMeta run={run} />
                </MessageScroller.Item>
              )}
              {run.status === "running" ? (
                <MessageScroller.Item messageId={`working-${run.runId}`} className="mb-4 min-w-0">
                  <LiveReply run={run} sources={pendingSources} links="glance" tabChip={false} />
                </MessageScroller.Item>
              ) : null}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          <MessageScroller.Button
            direction="end"
            className="absolute bottom-2 left-1/2 z-10 flex h-6 -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full bg-gray-1000 px-2.5 text-[11px] font-medium whitespace-nowrap text-background-100 shadow-menu transition-[opacity,translate] inert:pointer-events-none inert:translate-y-2 inert:opacity-0"
          >
            <ArrowDown className="size-3" aria-hidden="true" /> Latest
          </MessageScroller.Button>
        </MessageScroller.Root>
      </MessageScroller.Provider>
    </div>
  );
}

/** Where a conversation started: this group, another of the Space's, one no longer here, or elsewhere in the browser. */
function startedIn(thread: ThreadListItem, groupId: string, groups: readonly TabGroupInfo[]): { label: string; color: TabGroupInfo["color"] | null } {
  if (thread.groupId === undefined) return { label: thread.origin?.kind === "reminder" ? "Reminder" : "Sidebar", color: null };
  if (thread.groupId === groupId) return { label: "This desk", color: groups.find((group) => group.id === groupId)?.color ?? null };
  const group = groups.find((candidate) => candidate.id === thread.groupId);
  return group === undefined ? { label: "Another group", color: null } : { label: group.title, color: group.color };
}

/**
 * Every conversation, newest first, each marked with the group it started
 * in. Choosing one continues it at this desk — the group's conversation
 * from then on; New conversation starts an empty one for the group. While
 * the agent is acting the console is its, and nothing here can be chosen.
 */
function ConversationPicker({
  ref,
  groupId,
  groups,
  threads,
  run,
  shown,
  onClose,
}: {
  ref: React.Ref<HTMLDivElement>;
  groupId: string;
  groups: readonly TabGroupInfo[];
  threads: readonly ThreadListItem[];
  run: RunSummary | null;
  shown: boolean;
  onClose: () => void;
}) {
  const acting = agentIsActing(run);
  const [error, setError] = useState<string | null>(null);
  const act = (command: Parameters<NonNullable<ReturnType<typeof nativeApi>>["deskConversation"]>[0]): void => {
    const api = nativeApi();
    if (api === null) return;
    api.deskConversation(command).then(
      () => onClose(),
      (failure: unknown) => setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "That conversation could not be opened"),
    );
  };
  const sorted = sortThreads([...threads]);
  return (
    <div ref={ref} role="dialog" aria-label="Conversations" data-testid="desk-conversations" data-shown={shown ? "" : undefined} className="desk-conversations">
      <div className="p-1.5 pb-0">
        <button
          type="button"
          data-testid="desk-conversation-new"
          disabled={acting}
          title={acting ? "Stop the agent first" : "Start a new conversation for this desk"}
          className="desk-conversation"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => act({ type: "new", groupId })}
        >
          <SquarePen className="size-3.5 shrink-0 text-gray-800" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-gray-1000">New conversation</span>
        </button>
      </div>
      <div className="desk-conversations-rule" />
      {error === null ? null : (
        <div role="status" className="mx-2 mb-1.5 rounded-md bg-amber-100 px-2 py-1 text-[11px] leading-4 text-amber-900">
          {error}
        </div>
      )}
      <div className="scroll-thin flex max-h-72 flex-col gap-px overflow-y-auto px-1.5 pb-1.5" role="list" aria-label="Earlier conversations">
        {sorted.length === 0 ? <div className="px-2.5 py-2.5 text-[12.5px] text-gray-700">No conversations yet</div> : null}
        {sorted.map((thread) => {
          const open = run?.runId === thread.runId;
          const where = startedIn(thread, groupId, groups);
          return (
            <button
              key={thread.runId}
              type="button"
              role="listitem"
              data-testid="desk-conversation"
              data-run-id={thread.runId}
              data-open={open ? "" : undefined}
              aria-current={open ? "true" : undefined}
              disabled={acting && !open}
              title={acting && !open ? "Stop the agent first" : open ? "Open at this desk" : "Continue here"}
              className="desk-conversation"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => (open ? onClose() : act({ type: "choose", groupId, runId: thread.runId }))}
            >
              <span className={`min-w-0 flex-1 truncate text-[13px] text-gray-1000${open ? " font-medium" : ""}`}>{thread.title.trim() === "" ? "Untitled conversation" : thread.title}</span>
              <span className="desk-conversation-group tab-group-tone" data-group-color={where.color ?? undefined} data-toned={where.color === null ? undefined : ""}>
                {where.label}
              </span>
              <span className="w-14 shrink-0 text-right text-[11px] text-gray-700 tabular-nums">{relativeTime(thread.updatedAt)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
