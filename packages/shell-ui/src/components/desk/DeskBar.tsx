import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MessageScroller } from "@shadcn/react/message-scroller";
import {
  Archive,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  BookOpen,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Columns2,
  FileText,
  Globe,
  History,
  Languages,
  LayoutGrid,
  Lightbulb,
  Loader2,
  MessagesSquare,
  Mic,
  Newspaper,
  NotebookPen,
  Paperclip,
  PenLine,
  PictureInPicture2,
  Plus,
  Radio,
  ScrollText,
  Square,
  SquarePen,
  SquareTerminal,
  Telescope,
  TextQuote,
  TextSearch,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AgentAttachment, RunSummary, ThreadListItem } from "@pistachio/protocol";
import { groupContextMediaTypeOf, type GroupContextFile, type GroupContextView } from "@pistachio/shell-contracts/desk-agent";
import { shortcutLabel } from "@pistachio/shell-contracts/shortcuts";
import { webSearchUrl } from "@pistachio/shell-contracts/search";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { nativeApi, shellApi } from "../../api";
import { composerAccepts, formatAttachmentText, formatSelectionText, selectionChipLabel, toAgentAttachments } from "../../lib/chat-attachments";
import { useDeskFileDrag } from "../../lib/desk/file-drag";
import { addContextFiles } from "../../lib/desk/group-context";
import { activeMention, insertMention, mentionCandidates, mentionQuery, mentionsIn } from "../../lib/desk/mentions";
import {
  BAR_COMMAND_GROUPS,
  commandCandidates,
  commandDescription,
  commandPrompt,
  commandQuery,
  commandSpan,
  commandWaiting,
  insertCommand,
  parseCommand,
  type BarCommand,
  type BarCommandId,
  type CommandSettings,
} from "../../lib/desk/slash-commands";
import { arrangeDesk } from "../../lib/desk/open";
import { shareSpace, toggleLiveDrawing } from "../../lib/live/actions";
import { screenshotView } from "../../lib/screenshot";
import { isProbablyUrl } from "../../lib/url";
import { agentActivity } from "../../lib/desk/agent";
import { dictationSupported, spokenInsert, useDictation } from "../../lib/dictation";
import { DESK_GAP, NUB_DROP_R, NUB_IDLE, NUB_SWELL, nubDrops, nubExtent, type NotchShape, type Rect } from "../../lib/desk/geometry";
import { readFloatSpot } from "../../lib/desk/answer-float";
import { runFailure } from "../../lib/chat-trace";
import { AnswerMotion, type AnswerEdge } from "./answer-motion";
import { useDeskStore } from "../../lib/desk/store";
import { agentIsActing, relativeTime, sortThreads } from "../../lib/run";
import { useAppStore } from "../../store";
import { AttachmentDropVeil, useAttachmentDrop } from "../chat/attachment-drop";
import { LiveReply } from "../chat/LiveReply";
import { ApprovalCard, ClarificationCard, CompletionMeta, MessageActions, MessageRow, TERMINAL } from "../chat/parts";
import { useReplyBegun } from "../chat/SmoothHeight";
import { FailureTrace, TurnTrace } from "../chat/trace";
import { useThreadLayout } from "../chat/use-thread-layout";
import { OutputCards } from "../OutputCard";
import { SearchProviderLogo } from "../SearchProviderLogo";
import { TakeoverCard } from "../TakeoverCard";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import type { DeskEngine, DeskView } from "./desk-engine";
import { DeskNub, NubPillClose, NubPillSide, type NubTip } from "./DeskNub";
import { DictationWave } from "./DictationWave";
import { FileGlyph, fileKindLabel } from "./files/FileGlyph";
import { nubTimeScale, type NubMotion, type PillParts, type PillSource, type Swelling } from "./nub-motion";

/** A file of the group's context the Bar can mention: its bytes are on this Mac. */
type MentionFile = GroupContextFile & { here: boolean };

/**
 * The menu over the field: the files a mention being typed offers, or the
 * commands a `/` does (whole and in groups while nothing follows the slash);
 * which is lit, and how to choose one.
 */
type FieldMenuState =
  | { kind: "mentions"; candidates: readonly MentionFile[]; index: number; pick(file: MentionFile): void; point(index: number): void }
  | {
      kind: "commands";
      candidates: readonly BarCommand[];
      grouped: boolean;
      index: number;
      settings: CommandSettings;
      pick(command: BarCommand): void;
      point(index: number): void;
    };

/** At most this many files a message carries as files (pictures, PDFs) through its mentions and what was attached. */
const MAX_MESSAGE_FILES = 6;

/** The pill at one line (it grows taller with more lines): answer-motion.ts measures the docked slot from its top. */
export const BAR_H = 52;
/** What the Bar opens out of the nub stays a cover this long after it starts back: it is over the pages until it is in. */
const NOTCH_CLOSE_MS = 280;
/** The nub's menu longer: its droplets run back into it and it settles into the corner again (nub-motion's FREE_CLOSE). */
const NUB_CLOSE_MS = 400;
/** Opening waits for the pages under it to give way, but never longer than this. */
const NOTCH_WAIT_MS = 300;
/** The conversations go back into their droplet over this long (shell.css, the morph's close). */
const PICKER_CLOSE_MS = 260;
/** The chat's header's conversations fold back up over this long (shell.css, .desk-chat-picker). */
const CHAT_PICKER_CLOSE_MS = 160;
/** A tooltip over the Bar's buttons opens after this long, as the dock's do. */
const TIP_DELAY_MS = 350;
/** The band a tooltip appears in stays a cover this long after it closes: moving from one button to the next, the next's does not wait. */
const TIP_LINGER_MS = 200;
/** The pointer on the nub this long before it swells (and what it opens is made room for): one passing over it on its way elsewhere moves nothing (transitions.dev's intent delay, `--duration-micro`). */
const NUB_HOVER_MS = 80;
/** While the pointer is on the nub, the OS's pointer is read this often, for a leave the shell never hears. */
const BAR_POINTER_CHECK_MS = 150;
/** The pointer on the pill's tray this long before it opens (the same intent delay), and off it this long before it closes: a pass on the way to the field, or a slip off its end, moves nothing. */
const TRAY_OPEN_MS = 80;
const TRAY_CLOSE_MS = 160;
const PLATFORM = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other";
/** The band above the pill where its tooltips appear, and how far past its ends they may reach; beside the nub, where its droplets' do (to their left). */
const TIP_BAND_H = 44;
const TIP_BAND_REACH = 56;
const TIP_SIDE_W = 200;
/** The pill's shadow, which the pages under it give way for too. */
const PILL_SHADOW = 16;
/** The view over a live page holds the nub swelled (and a little past, as the swell overshoots), its corner the desk's (NotchApp). */
const NUB_VIEW = Math.ceil(nubExtent(NUB_SWELL)) + 3;

/** A tooltip over one of the Bar's buttons (as the dock's DockTip): open as Base UI says, seen once no live page is under it. */
type BarTip = NubTip;

/**
 * An element's laid-out box in the stage (its transforms — the Bar rising
 * in — never move it). In the card torn off the Bar it is the box as drawn:
 * the card stands where its transform puts it, not where it is laid out
 * (2026-10-10: the band of a tooltip in its row, and the mentions in it, were
 * read at the lane's corner).
 */
function stageBox(el: HTMLElement): Rect | null {
  const card = el.closest<HTMLElement>(".desk-answer");
  if (card !== null && card.dataset["mode"] === "detached") {
    const stage = card.closest(".desk-stage");
    if (stage === null) return null;
    const at = stage.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return { x: box.left - at.left, y: box.top - at.top, w: box.width, h: box.height };
  }
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

/** The desk's corner radius (the stage's, a window's), which the nub's outline rounds into. */
function cornerOf(el: Element | null): number {
  const stage = el?.closest(".desk-stage");
  if (stage === null || stage === undefined) return 0;
  return Number.parseFloat(getComputedStyle(stage).borderBottomRightRadius) || 0;
}

/**
 * What the Bar draws over the desk is a cover (DeskEngine.setCover): a live
 * page is a native view and would paint over it, so the windows under it
 * give way to their stills while it is up. `shape` makes the cover of the
 * element's box (the pill's, with its shadow).
 */
function useCover(engine: DeskEngine, key: string, ref: RefObject<HTMLElement | null>, active: boolean, shape?: (box: Rect) => Rect, rebind?: unknown): void {
  // (`rebind`: what the ref follows a different element on — the mentions, in the pill or in the card — so the
  // element is read again then; the ref itself never changes, 2026-10-10.)
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
    // In the card torn off the Bar, which moves by its transform — no resize, no layout — it is read again as the
    // card moves, and as the card docks or tears off (2026-10-10: the mentions' cover stayed where the card was torn
    // off, and a window the card had left stayed a still).
    const card = el.closest<HTMLElement>(".desk-answer");
    const moved = card === null ? null : new MutationObserver(measure);
    if (card !== null) moved?.observe(card, { attributes: true, attributeFilter: ["style", "data-mode"] });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      moved?.disconnect();
      window.removeEventListener("resize", measure);
      engine.setCover(key, null);
    };
  }, [engine, key, ref, active, shape, rebind]);
}

/** The pill's footprint as a cover: its box and its shadow. */
function pillFootprint(box: Rect): Rect {
  return { x: box.x - PILL_SHADOW, y: box.y - PILL_SHADOW, w: box.w + PILL_SHADOW * 2, h: box.h + PILL_SHADOW * 2 };
}

/** The pill's close as a cover: its circle and its shadow (a droplet's, lower). */
function closeFootprint(box: Rect): Rect {
  return { x: box.x - 12, y: box.y - 10, w: box.w + 24, h: box.h + 26 };
}

/** True while `on`, and for `ms` after it goes — stretched, with `slowed`, as the nub's motion is (nub-motion's nubTimeScale). */
function useLinger(on: boolean, ms: number, slowed = false): boolean {
  const [lingering, setLingering] = useState(on);
  useLayoutEffect(() => {
    if (on) {
      setLingering(true);
      return;
    }
    const timer = window.setTimeout(() => setLingering(false), slowed ? ms * nubTimeScale() : ms);
    return () => window.clearTimeout(timer);
  }, [on, ms, slowed]);
  return on || lingering;
}

/** True once `on` has held for `ms` (what waits on the pages giving way waits no longer than that). */
function useOverdue(on: boolean, ms: number): boolean {
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    setOverdue(false);
    if (!on) return;
    const timer = window.setTimeout(() => setOverdue(true), ms);
    return () => window.clearTimeout(timer);
  }, [on, ms]);
  return overdue;
}

/**
 * The desk's agent, as a nub in the desk's trailing foot corner (docs/desk-agent.md
 * §1): a droplet of the shell's own ground there, partly sunk into the corner
 * and joined to both edges by fillets — a hole the engine cuts through the
 * well and the windows under it (DeskEngine.setNotchShape), so it is the
 * ground whatever the theme; over a live page, main's notch view draws it
 * (NotchApp). The pointer resting on it swells it; a click lets out its
 * menu, three droplets that pinch off up the trailing edge (DeskNub,
 * nub-motion.ts): the prompt, the microphone, past chats.
 *
 * The prompt's droplet becomes the pill — the message field, attach, a new
 * conversation, the answer and send (stop while the agent works) — a
 * floating glass field at the desk's foot beside the nub; the microphone's
 * becomes the same pill already listening; past chats' grows into the
 * conversations. Above the pill, the answer card shows the latest exchange
 * as it happens; it opens when a turn starts and stays until closed, and
 * can be taken off into a window of its own (answer-motion.ts). The
 * conversations it lists are every thread, each marked with the group it
 * started in: choosing one continues it at this desk. Everything out of
 * the nub is a cover, drawn once the pages under it have given way (asked
 * as the menu is: the droplet's pill and its pages then open at once).
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
  const frameRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  /** The message field's place in the card, while it floats. */
  const footRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const nubRef = useRef<HTMLDivElement>(null);
  const faceRef = useRef<HTMLButtonElement>(null);
  const nubMotion = useRef<NubMotion | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sideRef = useRef<HTMLButtonElement>(null);
  /** The side button pressed with no card out: the card goes to the side as soon as it is up. */
  const sideWanted = useRef(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const fieldMenuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The composer's own: puts text at the caret (a mention of a file just taken into the context). */
  const insertRef = useRef<((text: string) => void) | null>(null);
  /** The composer's own: starts dictation (the microphone's droplet), and drops a recording (the pill put away). */
  const dictateRef = useRef<(() => void) | null>(null);
  const undictateRef = useRef<(() => void) | null>(null);
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
  const [fieldMenu, setFieldMenu] = useState<FieldMenuState | null>(null);
  const [answerOpen, setAnswerOpen] = useState(false);
  const [whole, setWhole] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The desk passed to another group: what was out of the nub for this one goes back in.
  useEffect(() => {
    setMenuOpen(false);
    setPickerOpen(false);
  }, [group.id]);
  // The card taken off the Bar (answer-motion.ts): whether it floats now, whether it is in the chat's own place (the
  // message field then the card's), and whether it is in hand.
  const [floating, setFloating] = useState(() => readFloatSpot()?.floating === true);
  const [chat, setChat] = useState(() => {
    const spot = readFloatSpot();
    return spot?.floating === true && spot.zone === "chat";
  });
  const [cardHeld, setCardHeld] = useState(false);
  // (Until 2026-10-09 everything below also stood down while the desk was leaving: it never is now.)
  // Floating and up, it is a window, and stays with no conversation to show (a new one, a space with none yet) — though
  // it does not come up for none; in the chat's place it is always up, the message field in it.
  const cardWasUp = useRef(false);
  const cardShown = answerOpen && (run !== null || chat || (floating && cardWasUp.current));
  useLayoutEffect(() => {
    cardWasUp.current = cardShown;
  });
  useEffect(() => {
    if (chat) setAnswerOpen(true);
  }, [chat]);
  const motionRef = useRef<AnswerMotion | null>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    const lane = laneRef.current;
    const ghost = ghostRef.current;
    const zone = zoneRef.current;
    const hint = hintRef.current;
    if (!cardShown || card === null || lane === null || ghost === null || zone === null || hint === null) return;
    // Covers are the stage's: the lane stands in it at its gutter.
    const origin = stageBox(lane) ?? { x: DESK_GAP, y: 0, w: 0, h: 0 };
    const atStage = (rect: Rect | null): Rect | null => (rect === null ? null : { x: rect.x + origin.x, y: rect.y + origin.y, w: rect.w, h: rect.h });
    const motion = new AnswerMotion(
      {
        lane,
        card,
        ghost,
        zone,
        hint,
        bar: () => barRef.current,
        floating: setFloating,
        snapped: (snapped) => setChat(snapped === "chat"),
        // In the chat's place it is a part of the desk: the windows keep a gutter clear of it.
        place: (width) => engine.setReserve(width === null ? 0 : width + DESK_GAP),
        notch: () => {
          const shape = hole.current.off ? null : hole.current.shape;
          return shape === null ? null : { shape, corner: cornerOf(nubRef.current) };
        },
        held: setCardHeld,
        cover: (rect, slot, lit) => {
          engine.setCover("answer", atStage(rect));
          engine.setCover("answer-slot", atStage(slot));
          engine.setCover("answer-zone", atStage(lit));
        },
      },
      readFloatSpot(),
    );
    motionRef.current = motion;
    // Asked for the side before it was up (NubPillSide with no card out): it goes there now, from the Bar.
    if (sideWanted.current) {
      sideWanted.current = false;
      motion.snapInto("chat");
    }
    return () => {
      motion.destroy();
      motionRef.current = null;
      setCardHeld(false);
    };
  }, [cardShown, engine]);
  // Floating, it is a window among the desk's: one the person brings up comes in front of it, its page live again,
  // and a press on the card (or its button on the pill) brings it back in front of them all.
  useLayoutEffect(() => {
    engine.stackCover("answer", cardShown && floating);
  }, [engine, cardShown, floating]);
  useEffect(
    () => () => {
      engine.stackCover("answer", false);
      engine.setReserve(0);
    },
    [engine],
  );
  const raiseAnswer = useCallback(() => engine.raiseCover("answer"), [engine]);
  /** Floating, the field is the card's: asked for (the nub's prompt or microphone, ⌘I), the card comes in front of the windows and calls out where it is. */
  const callAnswer = useCallback(() => {
    raiseAnswer();
    motionRef.current?.flash();
  }, [raiseAnswer]);
  // (A window's z is 10 above its place in the stack: DeskWindow.)
  const answerZ = floating ? view.coverZ.get("answer") : undefined;
  // Shown once no live page is under it — and, moving, kept shown while the pages it comes over give way.
  const answerClear = view.clearCovers.has("answer");
  const [answerSeen, setAnswerSeen] = useState(false);
  useEffect(() => {
    if (!cardShown) setAnswerSeen(false);
    else if (answerClear) setAnswerSeen(true);
  }, [cardShown, answerClear]);
  const answerShown = answerClear || (cardShown && answerSeen);

  // The message field — its draft, files staged, a recording — is one, wherever it is: in the pill, or, the answer
  // floating, in the card (the pill then stays in the nub). It is drawn into a box of its own, and that box is moved
  // between the two (never drawn again, so nothing in it is lost); the keyboard in it goes with it.
  const [composerBox] = useState(() => {
    const box = document.createElement("div");
    box.className = "desk-bar-composer";
    return box;
  });
  const inCard = floating && cardShown;
  const inCardNow = useRef(inCard);
  inCardNow.current = inCard;
  useLayoutEffect(() => {
    const home = inCard ? footRef.current : bodyRef.current;
    if (home === null || composerBox.parentElement === home) return;
    const active = document.activeElement;
    const typing = active instanceof HTMLElement && composerBox.contains(active) ? active : null;
    home.appendChild(composerBox);
    typing?.focus({ preventScroll: true });
  });

  // The conversations stay a moment once put away, going back into their droplet.
  const pickerUp = useLinger(pickerOpen, PICKER_CLOSE_MS, true);
  useCover(engine, "conversations", pickerRef, pickerUp);

  // The card opens when a turn starts — the person's message, or the agent
  // asking something — and when the person picks another conversation, so
  // they see they are in a different thread; it stays until it is closed.
  const userMessages = run?.messages.filter((message) => message.role === "user").length ?? 0;
  const asking = run?.pendingQuestion?.id ?? run?.pendingTakeover?.id ?? run?.pendingApproval?.id ?? null;
  const seen = useRef({ runId: run?.runId ?? null, userMessages, asking });
  const floatingNow = useRef(floating);
  floatingNow.current = floating;
  // The conversation just picked in the picker, until it is the one open: set on the click, so it is in place
  // whichever comes first, the picker's answer from main or the run it publishes.
  const chosen = useRef<string | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = { runId: run?.runId ?? null, userMessages, asking };
    if (run === null) {
      // (Floating, it is a window: it stays, with nothing in it yet.)
      if (!floatingNow.current) setAnswerOpen(false);
      return;
    }
    if (before.runId !== run.runId) {
      setWhole(false);
      if (chosen.current === run.runId) {
        chosen.current = null;
        setAnswerOpen(true);
        raiseAnswer();
      }
      return;
    }
    if (userMessages > before.userMessages || (asking !== null && asking !== before.asking)) {
      setAnswerOpen(true);
      raiseAnswer();
    }
  }, [run, userMessages, asking, raiseAnswer]);

  const activity = agentActivity(run);
  const shownCover = (key: string): boolean => view.clearCovers.has(key);

  // The pill. The composer says whether it holds anything; the rest is what holds it out: the keyboard in it, the
  // answer docked on it (or in hand on its way home), the @ list, files on their way — and a droplet just pressed
  // (`asked`), until the keyboard or the microphone has it. Put away with its close (`stowed`), it stays away whatever
  // it holds — what was typed is kept — until something asks for it again: the keyboard coming to it (⌘I, a droplet),
  // files dragged to it, an answer docking on it.
  const [composerIdle, setComposerIdle] = useState(true);
  const [focusWithin, setFocusWithin] = useState(false);
  const [asked, setAsked] = useState(false);
  const [stowed, setStowed] = useState(false);
  useEffect(() => {
    if (focusWithin || !composerIdle) setAsked(false);
  }, [focusWithin, composerIdle]);
  const dockedAnswer = cardShown && !floating;
  useEffect(() => {
    if (!(focusWithin || fileDrag || drop.dragging || dockedAnswer)) return;
    setStowed(false);
    // (The pill and the menu are one or the other: the pill asked for, the menu goes in.)
    setMenuOpen(false);
    setPickerOpen(false);
  }, [focusWithin, fileDrag, drop.dragging, dockedAnswer]);
  /** What the pill comes out of next: the droplet pressed, or the nub itself. */
  const pillSource = useRef<PillSource>("nub");
  // (A floating answer is no reason to: only one docked on it, or one in hand on its way home. Nor is anything while the
  // menu is out: the two are one or the other.)
  // (The answer floating, the message field is the card's: the pill stays in.)
  const pillWanted = !inCard && !stowed && !menuOpen && (asked || !composerIdle || focusWithin || dockedAnswer || cardHeld || fieldMenu !== null || fileDrag || drop.dragging);
  // Out, it is a cover (its whole footprint), from the pointer coming to the nub until it is back in.
  const pillOverdue = useOverdue(pillWanted, NOTCH_WAIT_MS);
  const pillOpen = pillWanted && (shownCover("pill") || pillOverdue);
  // (The @ list is the field's, shown while the pill is out — or in the card, over the field there: put away with what
  // was typed in it, the list goes too. A cover of its own in the card as well: a long list stands up past a short
  // card, over a window that would otherwise stay live and paint over it — 2026-10-10.)
  const fieldMenuUp = fieldMenu !== null && (pillOpen || inCard);
  // (Read again as the list turns from the @ list to the commands, or back, too: each is an element of its own.)
  useCover(engine, "field-menu", fieldMenuRef, fieldMenuUp, undefined, `${inCard ? "card" : "pill"}:${fieldMenu?.kind ?? ""}`);
  const compact = !pillOpen;

  // The nub: the pointer resting on it swells it.
  const [arming, setArming] = useState(false);
  const [hovered, setHovered] = useState(false);
  /** The pointer on the notch view over a page (not the shell's nub, whose tooltip Base UI opens itself). */
  const [viewHover, setViewHover] = useState(false);
  const armed = useRef(false);
  const hoverTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  /** The pointer came onto the nub (or the notch view over a page): it swells once the pointer has rested. */
  const enterNub = useCallback(() => {
    armed.current = true;
    setArming(true);
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovered(true), NUB_HOVER_MS);
  }, []);
  const leaveNub = useCallback(() => {
    armed.current = false;
    setArming(false);
    window.clearTimeout(hoverTimer.current);
    setHovered(false);
    setViewHover(false);
  }, []);
  /** The notch view's box in the window while it is up over a page (setDeskNotch, below). */
  const notchBox = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  /**
   * Whether the OS's pointer (main's word) is on the nub: its face, or the
   * notch view over a page — null where it cannot be read (Playwright), and
   * the pointer events have the last word.
   */
  const pointerOnNub = useCallback(async (): Promise<boolean | null> => {
    let point: { x: number; y: number } | null = null;
    try {
      point = (await nativeApi()?.getCursorPoint()) ?? null;
    } catch {
      point = null;
    }
    if (point === null) return null;
    const box = notchBox.current;
    if (box !== null && point.x >= box.x - 2 && point.x <= box.x + box.width + 2 && point.y >= box.y - 2 && point.y <= box.y + box.height + 2) return true;
    const under = document.elementFromPoint(point.x, point.y);
    return under !== null && faceRef.current?.contains(under) === true;
  }, []);
  // A leave the shell never hears would leave the nub swelled for good: the notch view goes from under the pointer
  // once what the nub opens has made the page under it a still, so it never hears the pointer go, and the shell hears
  // the pointer on the nub only once it moves there. While the pointer is on the nub, then, the OS's pointer is read
  // now and then: off the nub, it has gone.
  const pointerHeld = arming || hovered;
  useEffect(() => {
    if (!pointerHeld) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void pointerOnNub().then((on) => {
        if (!stopped && on === false) leaveNub();
      });
    }, BAR_POINTER_CHECK_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pointerHeld, pointerOnNub, leaveNub]);

  // The menu, drawn once the pages under it have given way (or after NOTCH_WAIT_MS).
  const menuWanted = menuOpen;
  const menuOverdue = useOverdue(menuWanted, NOTCH_WAIT_MS);
  const menuShown = menuWanted && (shownCover("bar") || menuOverdue);
  // The nub's box — the droplets' column — and the pill's footprint are covers from the menu being asked for (the pill's
  // too, so a droplet's pill opens at once) until they are back in. Not the pointer resting on the nub: the swell is the
  // nub's own (over a live page, the notch view draws it), and a pointer passing the corner freezes no page.
  const nubCovering = useLinger(menuShown || pickerOpen, NUB_CLOSE_MS, true) || menuWanted;
  useCover(engine, "bar", nubRef, nubCovering);
  const pillCovering = useLinger(pillOpen, NOTCH_CLOSE_MS, true) || pillWanted || menuWanted;
  useCover(engine, "pill", barRef, pillCovering, pillFootprint);
  // The pill's close above the nub, while the pill is out (not while the menu is: it would stand among its droplets).
  const closeUp = pillOpen && !menuWanted && !pickerOpen;
  const closeCovering = useLinger(closeUp, NOTCH_CLOSE_MS, true) || (pillWanted && !menuWanted && !pickerOpen);
  useCover(engine, "pill-close", closeRef, closeCovering, closeFootprint);
  // The chat's side button above it (2026-10-09), while no card floats — not out on the desk, nor at the side already.
  // (By the card up, not the way it floats: an empty chat put away from its place with × is still a floating one, and
  // nothing else brings it back — 2026-10-10.)
  const sideUp = closeUp && !inCard;
  const sideCovering = useLinger(sideUp, NOTCH_CLOSE_MS, true) || (pillWanted && !menuWanted && !pickerOpen && !inCard);
  useCover(engine, "pill-side", sideRef, sideCovering, closeFootprint);

  const pillParts = useCallback((): PillParts | null => {
    const bar = barRef.current;
    const frame = frameRef.current;
    const body = bodyRef.current;
    return bar === null || frame === null || body === null ? null : { bar, frame, body };
  }, []);
  // The nub as it is drawn now, swelling and settling: the engine cuts it through the well and the windows under it.
  // A screenshot of the desk is the windows without the Bar: neither it nor its hole is drawn while one is taken.
  const capturing = useDeskStore((state) => state.capturing);
  const holeOff = capturing;
  const hole = useRef<{ shape: NotchShape | null; off: boolean }>({ shape: NUB_IDLE, off: holeOff });
  hole.current.off = holeOff;
  // (None while it stands free of the corner for its menu.)
  const cutNub = useCallback(
    (shape: NotchShape | null) => {
      hole.current.shape = shape;
      if (!hole.current.off) engine.setNotchShape(shape);
      // (A card over the corner — the chat's place — has it cut through its glass too.)
      motionRef.current?.nub();
    },
    [engine],
  );
  useLayoutEffect(() => {
    engine.setNotchShape(holeOff ? null : hole.current.shape);
    motionRef.current?.nub();
  }, [engine, holeOff]);
  useEffect(() => () => engine.setNotchShape(null), [engine]);
  const deskCorner = useCallback(() => cornerOf(nubRef.current), []);
  // The idle nub's box, in the desk's trailing foot corner: the engine knows where it lies over the windows (whether a
  // live page is under it).
  useLayoutEffect(() => {
    engine.setNotch({ w: NUB_VIEW, h: NUB_VIEW });
  }, [engine]);
  useEffect(() => () => engine.setNotch(null), [engine]);

  // Swelled while the pointer rests on it and while its droplets are out; the pill out of its droplet (or the nub),
  // and back into the nub; the conversations standing where past chats' droplet was.
  const [swelling, setSwelling] = useState<Swelling>({ from: 0, to: 0, at: 0, ms: 0 });
  const swellTo = hovered || menuShown ? 1 : 0;
  useLayoutEffect(() => {
    const motion = nubMotion.current;
    if (motion !== null) setSwelling(motion.swell(swellTo));
  }, [swellTo]);
  const pillWas = useRef(false);
  useLayoutEffect(() => {
    const motion = nubMotion.current;
    if (motion === null || pillOpen === pillWas.current) return;
    pillWas.current = pillOpen;
    if (pillOpen) motion.openPill(pillSource.current);
    else motion.closePill();
    pillSource.current = "nub";
  }, [pillOpen]);
  /** The menu opened from the keys: its first droplet has them once it is out. */
  const keysToMenu = useRef(false);
  useLayoutEffect(() => {
    const motion = nubMotion.current;
    if (motion === null) return;
    if (menuShown) motion.openMenu();
    else motion.closeMenu();
    if (menuShown && keysToMenu.current) document.querySelector<HTMLElement>("[data-testid='desk-nub-prompt']")?.focus({ preventScroll: true });
    keysToMenu.current = false;
  }, [menuShown]);
  useLayoutEffect(() => {
    nubMotion.current?.take(2, pickerUp);
  }, [pickerUp]);

  // Escape unwinds what is out, one at a time: the conversations, the menu, the answer docked (a floating one is a
  // window, and stays), the pill if nothing is in it.
  const answerCloses = cardShown && !floating;
  const unwind = useRef({ pickerOpen, menuOpen, answerCloses, pillOpen, composerIdle });
  unwind.current = { pickerOpen, menuOpen, answerCloses, pillOpen, composerIdle };

  /**
   * The pill's close: the pill back into the nub whatever it holds — what was typed and staged kept for when it comes
   * out again; a recording dropped, and the answer docked on it closed (a floating one is a window, and stays).
   */
  const stowPill = useCallback(() => {
    undictateRef.current?.();
    setAsked(false);
    setStowed(true);
    if (unwind.current.answerCloses) setAnswerOpen(false);
    const field = document.activeElement;
    if (field instanceof HTMLElement && barRef.current?.contains(field) === true) field.blur();
  }, []);
  /**
   * The side button above the close (2026-10-09): the chat into its place at the desk's side — the card docked on the
   * pill torn off and sprung there, as a drag would leave it; no card out, it comes out there (the motion snaps it as
   * it is made).
   */
  const toSide = useCallback(() => {
    const motion = motionRef.current;
    if (motion !== null) {
      motion.snapInto("chat");
      return;
    }
    sideWanted.current = true;
    setChat(true);
    setAnswerOpen(true);
  }, []);
  useEffect(() => {
    // Escape in a document's window is the document's (its editor, its sheet).
    const theirs = (event: KeyboardEvent): boolean => event.key !== "Escape" || (event.target instanceof Element && event.target.closest(".desk-window") !== null);
    // What is out of the nub hears it first: a tooltip open over a droplet (Base UI's) would take it otherwise. Only
    // where the keys are the nub's — on it or its droplets, in the pill, or nowhere — though: an overlay in front of
    // the desk with the keyboard in it (the address bar, a dialog) has its own Escape first.
    const onNubKey = (event: KeyboardEvent): void => {
      if (theirs(event) || event.defaultPrevented) return;
      const target = event.target instanceof Element && event.target !== document.body ? event.target : null;
      if (target !== null && nubRef.current?.contains(target) !== true && barRef.current?.contains(target) !== true) return;
      const now = unwind.current;
      const inMenu = target !== null && nubRef.current?.contains(target) === true;
      if (now.pickerOpen) {
        setPickerOpen(false);
        if (inMenu) document.querySelector<HTMLElement>("[data-testid='desk-nub-chats']")?.focus({ preventScroll: true });
      } else if (now.menuOpen) {
        setMenuOpen(false);
        if (inMenu) faceRef.current?.focus({ preventScroll: true });
      } else return;
      event.stopPropagation();
    };
    // Back at the window, an Escape nothing in front took (the keyboard on another of the shell's controls): what is
    // out of the nub goes first here too.
    const onKey = (event: KeyboardEvent): void => {
      if (theirs(event) || event.defaultPrevented) return;
      const now = unwind.current;
      if (now.pickerOpen) setPickerOpen(false);
      else if (now.menuOpen) setMenuOpen(false);
      else if (now.answerCloses) setAnswerOpen(false);
      else if (now.pillOpen && now.composerIdle) {
        setAsked(false);
        const field = document.activeElement;
        if (field instanceof HTMLElement && barRef.current?.contains(field) === true) field.blur();
      }
    };
    window.addEventListener("keydown", onNubKey, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onNubKey, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // The menu and the conversations go on a press anywhere else — a live page's too, which the shell never hears
  // itself (main relays it) — or Escape in a page. The nub's own click toggles them itself.
  const nubOut = menuOpen || pickerOpen;
  useEffect(() => {
    if (!nubOut) return;
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input === "press" || input === "escape") {
        setPickerOpen(false);
        setMenuOpen(false);
      }
    });
    const onDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && nubRef.current?.contains(target) === true) return;
      setPickerOpen(false);
      setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      offPage?.();
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [nubOut]);

  // A droplet pressed holds the pill out until the keyboard has it; a press elsewhere lets it go.
  useEffect(() => {
    if (!asked) return;
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input === "press") setAsked(false);
    });
    const onDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && (anchorRef.current?.contains(target) === true || nubRef.current?.contains(target) === true)) return;
      setAsked(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      offPage?.();
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [asked]);

  // The answer goes as the conversations do, on a press anywhere else — a live page's too, which main relays — but
  // not on the pill, where the person writes to it, nor in what opens over it (the nub's menu, the conversations,
  // the mentions). Floating, it is a window: it stays.
  useEffect(() => {
    if (!answerCloses) return;
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input === "press") setAnswerOpen(false);
    });
    const onDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && (cardRef.current?.contains(target) === true || anchorRef.current?.contains(target) === true || nubRef.current?.contains(target) === true)) return;
      setAnswerOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      offPage?.();
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [answerCloses]);

  // A press on a window gives it the keyboard once its page is live (the engine's pendingFocus), so the pill lets go
  // of it at once: out over the windows while it held it, it would keep that page a still for good.
  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      const field = document.activeElement;
      if (!(event.target instanceof Element) || event.target.closest(".desk-window") === null || event.target.closest("button") !== null) return;
      if (field instanceof HTMLElement && barRef.current?.contains(field) === true) field.blur();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);

  // ⌘I: the keyboard in the field, the pill out of the nub — and what was out of the nub back in, as the prompt's
  // droplet puts it.
  useEffect(() => {
    if (focusSignal === 0) return;
    setStowed(false);
    setMenuOpen(false);
    setPickerOpen(false);
    // (Floating, the card comes in front of the windows with it.)
    if (inCardNow.current) callAnswer();
    focusInput();
  }, [focusSignal, focusInput, callAnswer]);

  /** The nub pressed (or the notch view over a page): its menu out, or back in — opened from the keys, the keys go to its first droplet. */
  const menuNow = useRef(menuOpen);
  menuNow.current = menuOpen;
  const toggleMenu = useCallback(
    (keyboard: boolean) => {
      const opening = !menuNow.current;
      keysToMenu.current = keyboard && opening;
      setPickerOpen(false);
      setMenuOpen(opening);
      // The pill and the menu are one or the other, never both: let out, the menu puts the pill away first (what is in
      // it kept, as its close keeps it), and the answer docked on it with it. (The field in a floating card is not
      // the pill's: it stays as it is.)
      if (opening && !inCardNow.current) stowPill();
    },
    [stowPill],
  );
  const choosePrompt = (): void => {
    if (!pillOpen) pillSource.current = "prompt";
    setStowed(false);
    setAsked(true);
    setMenuOpen(false);
    setPickerOpen(false);
    if (inCard) callAnswer();
    focusInput();
  };
  const chooseMic = (): void => {
    if (!pillOpen) pillSource.current = "mic";
    setStowed(false);
    setAsked(true);
    setMenuOpen(false);
    setPickerOpen(false);
    if (inCard) callAnswer();
    dictateRef.current?.();
  };

  // The pointer on the notch view, and a press there: the nub's, as if they were on it. The view's word that the
  // pointer came is checked against the OS's pointer: hidden under the pointer (as it is once what the nub opens has
  // made the page under it a still), it never hears the pointer go, and shown again — a window brought down under
  // the nub — it still has it there, and says so wherever the pointer is. (It says it again as the pointer moves on
  // it: once the nub has swelled, nothing new.)
  useEffect(
    () =>
      nativeApi()?.onDeskNotchInput((input) => {
        if (input === "enter") {
          if (armed.current) return;
          void pointerOnNub().then((on) => {
            if (on !== false && !armed.current) {
              enterNub();
              setViewHover(true);
            }
          });
        } else if (input === "leave") leaveNub();
        else toggleMenu(false);
      }),
    [enterNub, leaveNub, toggleMenu, pointerOnNub],
  );

  const askKey = useAppStore((state) => shortcutLabel(state.settings.shortcuts.toggleConsole, PLATFORM));
  const acting = activity !== null;
  const floatingOut = cardShown && floating;
  // Over a live page, the idle nub is main's notch view (NotchApp), drawn over the page as nothing of the shell's can
  // be: it is told where (the box the nub may fill, its corner the desk's), how swelled it is, and what it shows.
  // Once what the nub opens has made the page under it a still, there is no live page under it, and the view goes.
  const overPage = view.notchOver && !capturing;
  useLayoutEffect(() => {
    const api = nativeApi();
    const el = nubRef.current;
    if (api === null) return;
    if (!overPage || el === null) {
      notchBox.current = null;
      api.setDeskNotch(null);
      return;
    }
    const send = (): void => {
      const stage = el.closest(".desk-stage")?.getBoundingClientRect();
      if (stage === undefined) return;
      const ground = el.closest(".chrome-container")?.getBoundingClientRect() ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
      const right = Math.round(stage.right);
      const bottom = Math.round(stage.bottom);
      const bounds = { x: right - NUB_VIEW, y: bottom - NUB_VIEW, width: NUB_VIEW, height: NUB_VIEW };
      notchBox.current = bounds;
      api.setDeskNotch({
        bounds,
        label: `Ask about ${group.title}`,
        shortcut: askKey,
        color: group.color,
        idle: NUB_IDLE,
        swell: NUB_SWELL,
        corner: cornerOf(el),
        swelling,
        acting,
        floating: floatingOut,
        ground: { x: ground.x, y: ground.y, width: ground.width, height: ground.height },
      });
    };
    send();
    const observer = new ResizeObserver(send);
    const stage = el.closest(".desk-stage");
    if (stage !== null) observer.observe(stage);
    window.addEventListener("resize", send);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [overPage, group.title, group.color, askKey, swelling, acting, floatingOut]);
  useEffect(() => () => nativeApi()?.setDeskNotch(null), []);

  // A button's tooltip is open: the band it appears in — above the pill, or beside the nub — is a cover, and stays
  // one a moment after it closes (the dock's rule). The nub's is main's notch view's to lie over (`underNotch`): over a
  // live page the view stays, the nub swelled under the pointer, while the page under it is a still for the tooltip —
  // going from under the pointer and coming back once the tooltip had gone, it changed the pointer's cursor and drew
  // the nub afresh each way (2026-10-16).
  const [tip, setTip] = useState<{ label: string; where: "pill" | "nub" } | null>(null);
  const openTip = tip;
  useLayoutEffect(() => {
    // (The row's buttons are in the card while the answer floats: their band is above the row where it is, not the
    // pill's place — 2026-10-10.)
    const el = openTip === null ? null : openTip.where === "pill" ? (inCard ? footRef.current : barRef.current) : nubRef.current;
    if (openTip === null || el === null) {
      const timer = window.setTimeout(() => {
        engine.setCover("bar-tip", null);
        engine.setCover("nub-tip", null);
      }, TIP_LINGER_MS);
      return () => window.clearTimeout(timer);
    }
    const box = stageBox(el);
    if (box === null) return;
    if (openTip.where === "pill") {
      engine.setCover("nub-tip", null);
      engine.setCover("bar-tip", { x: box.x - TIP_BAND_REACH, y: box.y - TIP_BAND_H, w: box.w + TIP_BAND_REACH * 2, h: TIP_BAND_H });
    } else {
      engine.setCover("bar-tip", null);
      engine.setCover("nub-tip", { x: box.x - TIP_SIDE_W, y: box.y - TIP_BAND_H, w: TIP_SIDE_W + box.w, h: box.h + TIP_BAND_H }, { underNotch: true });
    }
  }, [engine, openTip, inCard]);
  useEffect(
    () => () => {
      engine.setCover("bar-tip", null);
      engine.setCover("nub-tip", null);
    },
    [engine],
  );
  // A button that goes while its tooltip is open (the row changing for dictation) never says it closed.
  const closeTips = useCallback(() => setTip(null), []);
  // (By where it is as well as what it says: the pill's Dictate is not the nub's.)
  const someTip = (label: string, where: "pill" | "nub"): BarTip => ({
    open: openTip?.label === label && openTip.where === where,
    shown: shownCover(where === "pill" ? "bar-tip" : "nub-tip"),
    onOpenChange: (open) => setTip((current) => (open ? { label, where } : current?.label === label && current.where === where ? null : current)),
  });
  const barTip = (label: string): BarTip => someTip(label, "pill");
  const nubTip = (label: string): BarTip => someTip(label, "nub");
  const faceLabel = `Ask about ${group.title}`;
  // (Not while the nub's menu is out: its droplets say what they are.)
  const faceTip = nubTip(faceLabel);
  if (menuOpen) faceTip.open = false;
  // Over a live page the pointer rests on the notch view, which Base UI never hears: the nub's tooltip opens for the
  // view's hover as for its own — its mark alone does not say what it is for. Its band given way (a cover), the page
  // under it is a still, the view still over it with the pointer; the pointer gone, so is the tooltip.
  useEffect(() => {
    if (!viewHover || menuOpen) return;
    const timer = window.setTimeout(() => setTip({ label: faceLabel, where: "nub" }), TIP_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      setTip((current) => (current?.label === faceLabel && current.where === "nub" ? null : current));
    };
  }, [viewHover, menuOpen, faceLabel]);

  // The conversations stand where past chats' droplet rests, growing up and left from it.
  const chats = nubDrops()[2]!;
  return (
    <div
      ref={laneRef}
      className="desk-bar-lane"
      data-testid="desk-bar-lane"
      style={{ left: DESK_GAP, right: DESK_GAP, bottom: 0, visibility: capturing ? "hidden" : undefined, "--desk-answer-z": answerZ === undefined ? undefined : String(10 + answerZ) } as React.CSSProperties}
    >
      {/* The docked answer's slot, while a floating one comes back to it (answer-motion.ts draws it). */}
      <div ref={ghostRef} className="desk-answer-ghost" data-testid="desk-answer-ghost" aria-hidden="true" />
      {/* Where a floating answer in hand would land — a tile, as a window's, or the chat's own place — and the chat's
          place hinted as it comes toward it (answer-motion.ts places them). */}
      <div ref={zoneRef} className="desk-answer-zone" data-testid="desk-answer-zone" aria-hidden="true">
        <div className="desk-answer-zone-chat">
          <span className="desk-answer-zone-label">
            <MessagesSquare aria-hidden="true" />
            Chat
          </span>
          <span className="desk-answer-zone-field" />
        </div>
      </div>
      <div ref={hintRef} className="desk-answer-hint" data-testid="desk-answer-hint" aria-hidden="true" />
      {/* One column, the pill's width: the answer rests on the pill, however tall the pill grows. */}
      <div className="desk-bar-column">
        {cardShown ? (
          <AnswerCard
            ref={cardRef}
            run={run}
            space={group.title}
            whole={whole}
            shown={answerShown}
            onWhole={() => setWhole((value) => !value)}
            undo={undo}
            onUndo={onUndo}
            onClose={() => setAnswerOpen(false)}
            // (Closed floating, or at the side, it comes back there: its spot is kept.)
            onDismiss={() => setAnswerOpen(false)}
            onPress={(event, edge) => motionRef.current?.press(event, edge)}
            onDock={() => motionRef.current?.dock()}
            onRaise={raiseAnswer}
            footRef={footRef}
            chat={chat}
            conversations={{ groupId: group.id, groups, threads, onChoose: (runId) => (chosen.current = runId) }}
            field={{
              acting,
              dropping: inCard && drop.dragging,
              dropTarget: inCard && fileDrag && !drop.dragging,
              handlers: drop.handlers,
              menu: inCard && fieldMenuUp && fieldMenu !== null ? <FieldMenu ref={fieldMenuRef} menu={fieldMenu} shown={answerShown && shownCover("field-menu")} /> : null,
            }}
          />
        ) : null}
        <div ref={anchorRef} className="desk-bar-anchor">
          {!inCard && fieldMenuUp && fieldMenu !== null ? <FieldMenu ref={fieldMenuRef} menu={fieldMenu} shown={shownCover("field-menu")} /> : null}
          {/* The pill: its box always where it rests; its glass and row what the nub's motion morphs. */}
          <div
            ref={barRef}
            {...drop.handlers}
            role="region"
            aria-label="Ask Pistachio about this space"
            data-testid="desk-bar"
            data-acting={acting ? "" : undefined}
            data-drop-target={fileDrag && !drop.dragging ? "" : undefined}
            data-compact={compact ? "" : undefined}
            className="desk-bar"
            onFocus={() => setFocusWithin(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
            }}
          >
            <div ref={frameRef} className="desk-bar-frame" aria-hidden="true" />
            {drop.dragging && !inCard ? <AttachmentDropVeil data-testid="desk-bar-drop-veil" className="inset-1 rounded-[16px]" /> : null}
            {/* The row's place: the message field's box lies here, or in the card while it floats (composerBox). */}
            <div ref={bodyRef} className="desk-bar-body" />
            {createPortal(
            <TooltipProvider delay={TIP_DELAY_MS}>
              {/* In a floating card the row is a portal: a press on it reaches the card's own handlers by the DOM, never
                  by React's tree (the row stays the pill's child there), so it says itself that the card is pressed —
                  behind a window, it comes back in front (2026-10-10). */}
              <div className="contents" onPointerDownCapture={() => { if (inCardNow.current) raiseAnswer(); }}>
              <BarComposer
                group={group}
                context={context}
                run={run}
                activity={activity}
                inputRef={inputRef}
                insertRef={insertRef}
                dictateRef={dictateRef}
                undictateRef={undictateRef}
                fileDrag={fileDrag}
                onFieldMenu={setFieldMenu}
                drop={drop}
                answerOpen={cardShown}
                floating={floatingOut}
                inCard={inCard}
                tip={barTip}
                onTipsGone={closeTips}
                onSent={() => setAnswerOpen(true)}
                // Floating, the answer is a window of its own: the button calls out where it is.
                onToggleAnswer={() => {
                  if (!cardShown || !floating) setAnswerOpen((value) => !value);
                  else {
                    raiseAnswer();
                    motionRef.current?.flash();
                  }
                }}
                onIdle={setComposerIdle}
              />
              </div>
            </TooltipProvider>,
              composerBox,
            )}
          </div>
        </div>
      </div>
      <TooltipProvider delay={TIP_DELAY_MS}>
        <DeskNub
          nubRef={nubRef}
          faceRef={faceRef}
          motionRef={nubMotion}
          pill={pillParts}
          onShape={cutNub}
          corner={deskCorner}
          label={{ text: faceLabel, shortcut: askKey }}
          acting={acting}
          floating={floatingOut}
          menuOpen={menuShown}
          chatsOpen={pickerOpen}
          hovered={hovered}
          faceTip={faceTip}
          tip={nubTip}
          onFaceEnter={enterNub}
          onFaceLeave={leaveNub}
          onFace={toggleMenu}
          onPrompt={choosePrompt}
          onMic={chooseMic}
          onChats={() => setPickerOpen((open) => !open)}
        >
          {pickerUp ? (
            <ConversationPicker
              ref={pickerRef}
              groupId={group.id}
              groups={groups}
              threads={threads}
              run={run}
              shown={shownCover("conversations")}
              open={pickerOpen && shownCover("conversations")}
              gone={!menuShown}
              place={{ right: -(chats.x + NUB_DROP_R), bottom: -(chats.y + NUB_DROP_R) }}
              onChoose={(runId) => (chosen.current = runId)}
              // (A conversation chosen, or a new one, is what the menu was opened for: it goes in too.)
              onClose={() => {
                setPickerOpen(false);
                setMenuOpen(false);
              }}
            />
          ) : null}
          <NubPillClose ref={closeRef} shown={closeUp && shownCover("pill-close")} tip={nubTip("Close")} onClose={stowPill} />
          <NubPillSide ref={sideRef} shown={sideUp && shownCover("pill-side")} tip={nubTip("Chat at the side")} onSide={toSide} />
        </DeskNub>
      </TooltipProvider>
    </div>
  );
});

/** The pill's own row: the field and its buttons; files staged for the message above them. In the pill, or in the card while it floats. */
function BarComposer({
  group,
  context,
  run,
  activity,
  inputRef,
  insertRef,
  dictateRef,
  undictateRef,
  fileDrag,
  onFieldMenu,
  drop,
  answerOpen,
  floating,
  inCard,
  tip,
  onTipsGone,
  onSent,
  onToggleAnswer,
  onIdle,
}: {
  group: TabGroupInfo;
  context: GroupContextView | null;
  run: RunSummary | null;
  activity: string | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  insertRef: RefObject<((text: string) => void) | null>;
  /** Starts dictation (the nub's microphone droplet). */
  dictateRef: RefObject<(() => void) | null>;
  undictateRef: RefObject<(() => void) | null>;
  /** Files are being dragged over the desk: the Bar says it takes them. */
  fileDrag: boolean;
  onFieldMenu: (menu: FieldMenuState | null) => void;
  drop: ReturnType<typeof useAttachmentDrop>;
  answerOpen: boolean;
  /** The answer floats, a window of its own: the button says so, and calls it out. */
  floating: boolean;
  /** It is the floating card's: the answer is right above it, and needs no button of its own. */
  inCard: boolean;
  tip: (label: string) => BarTip;
  /** The row's buttons changed under the pointer: whatever tooltip was open has gone with its button. */
  onTipsGone: () => void;
  onSent: () => void;
  onToggleAnswer: () => void;
  /** Whether it holds nothing and nothing is going on in it: the pill may then go back into the nub. */
  onIdle: (idle: boolean) => void;
}) {
  const sendMessage = useAppStore((state) => state.sendAgentMessage);
  const interrupt = useAppStore((state) => state.interruptAgent);
  const [value, setValue] = useState("");
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  /** A mention menu the person dismissed (Escape) stays away until the next `@`. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  /** A command menu the person dismissed (Escape) stays away until the field's `/` goes. */
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const webProvider = useAppStore((state) => state.settings.search.webProvider);
  const commandSettings = useMemo<CommandSettings>(() => ({ webProvider }), [webProvider]);
  // A list put away stays away only while what it was for is there: the field emptied, or its `/` gone, however
  // that came about (sent, a command run, edited), the next `/` or `@` opens its list.
  useEffect(() => {
    if (!value.startsWith("/")) setCommandsDismissed(false);
    if (value === "") setDismissedAt(null);
  }, [value]);
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
  useEffect(() => {
    dictateRef.current = startDictation;
    // (Put away listening, the recording goes: nothing is transcribed into a field no one sees.)
    undictateRef.current = () => {
      if (voice.phase !== "idle") voice.cancel();
    };
    return () => {
      dictateRef.current = null;
      undictateRef.current = null;
    };
  });
  const discardDictation = (): void => {
    voice.cancel();
    refocus();
  };
  useEffect(() => {
    onTipsGone();
    // Listening, the keyboard is on Done: Enter or Space finishes, Escape discards. (From the nub's too — its
    // microphone droplet clicked with the keyboard on the nub, which would otherwise hear Enter and Escape itself.)
    if (listening) {
      const active = document.activeElement;
      if (active === null || active === document.body || active.closest(".desk-bar, .desk-nub") !== null) doneRef.current?.focus({ preventScroll: true });
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
  // The commands a `/` at the head of the field offers, while the caret is in its word (lib/desk/slash-commands.ts).
  const commandTyping = listening || commandsDismissed ? null : commandQuery(value, caret);
  const commandTyped = commandTyping?.query ?? null;
  const commands = useMemo(() => (commandTyped === null ? [] : commandCandidates(commandTyped)), [commandTyped]);
  const commandsOpen = commands.length > 0;
  const commandLit = Math.min(commandIndex, Math.max(0, commands.length - 1));
  /** The command the field holds, marked in the mirror, its hint after it while nothing follows it. */
  const command = listening ? null : commandSpan(value);
  const mentionsOpen = !listening && !commandsOpen && typing !== null && candidates.length > 0;
  const lit = Math.min(mentionIndex, Math.max(0, candidates.length - 1));

  /** The field as tall as what is in it (up to its max-height). */
  const fit = useCallback(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${String(el.scrollHeight)}px`;
    if (mirrorRef.current !== null) mirrorRef.current.scrollTop = el.scrollTop;
  }, [inputRef]);
  // (Hidden while dictating, it has no height to measure; shown again, it is measured afresh.)
  useLayoutEffect(fit, [value, listening, fit]);
  // Laid out narrower or wider — moved into a floating card, the card resized — its lines wrap afresh: measured again.
  useEffect(() => {
    const el = inputRef.current;
    if (el === null || typeof ResizeObserver !== "function") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [inputRef, fit]);

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

  /** The field holds `text`, the caret at `at`, and the keyboard is in it. */
  const fill = (text: string, at: number): void => {
    const el = inputRef.current;
    setValue(text);
    setCaret(at);
    requestAnimationFrame(() => {
      el?.focus({ preventScroll: true });
      el?.setSelectionRange(at, at);
    });
  };

  /**
   * A command chosen from the menu: Enter (or a click) runs one that needs
   * nothing more, with whatever follows its word; Tab — or a command that
   * waits for what it takes — puts it in the field, to go on typing after.
   */
  const chooseCommand = (chosen: BarCommand, how: "run" | "complete"): void => {
    if (commandTyping === null) return;
    setCommandIndex(0);
    if (how === "run" && chosen.arg?.required !== true) {
      runCommand(chosen, value.slice(commandTyping.end).trim());
      return;
    }
    const next = insertCommand(value, commandTyping.end, chosen);
    fill(next.text, next.caret);
  };

  /**
   * A command sent: a request to Pistachio goes as the message it stands for
   * (lib/desk/slash-commands.ts, `commandPrompt`); the rest the Bar does
   * itself, and the field empties (files staged stay for the next message).
   * One that waits for what it takes stays in the field, its hint saying what.
   */
  const runCommand = (chosen: BarCommand, args: string): void => {
    if (chosen.arg?.required === true && args === "") {
      const next = insertCommand(value, /^\/\S*/.exec(value)?.[0].length ?? value.length, chosen);
      fill(next.text, next.caret);
      return;
    }
    const prompt = commandPrompt(chosen.id, args);
    if (prompt !== null) {
      send(prompt);
      return;
    }
    const store = useAppStore.getState();
    if (chosen.id === "new" && acting) {
      store.showNotice("Stop the agent first, then start a new conversation", { tone: "warning" });
      return;
    }
    setValue("");
    setCaret(0);
    switch (chosen.id) {
      case "search":
        void store.createTab(webSearchUrl(args, webProvider));
        break;
      case "open":
        void store.createTab(isProbablyUrl(args) ? args : webSearchUrl(args, webProvider));
        break;
      case "find":
        // On the window in use, by meaning when smart find is on (else the words as typed); `fill`, so the Find bar
        // shows these words even while it is open on others (its field is otherwise the person's).
        void shellApi()
          .find({ type: "search", query: args, forward: true, mode: "smart", fill: true })
          .catch(() => store.showNotice("There's no page to find in", { tone: "warning" }));
        break;
      case "new":
        startNewConversation();
        break;
      case "arrange":
        if (!arrangeDesk("smart")) store.showNotice("The desk can't be arranged just now", { tone: "warning" });
        break;
      case "tidy":
        void store.tidyTabs();
        break;
      case "remember":
        nativeApi()
          ?.groupContext({ type: "addText", groupId: group.id, title: group.title, kind: "fact", text: args })
          .then(() => store.showNotice(`Saved to ${group.title}'s context`, { tone: "success" }))
          .catch(() => store.showNotice("That fact could not be saved", { tone: "warning" }));
        break;
      case "screenshot":
        if (!screenshotView()) store.showNotice("There's nothing on the desk to capture yet", { tone: "warning" });
        break;
      case "share":
        // This space, live (shared already: its Live card).
        void shareSpace(group.id);
        break;
      case "draw":
        toggleLiveDrawing();
        break;
      case "note":
        void newNoteTitled(args);
        break;
      case "brief":
        store.openBrief();
        break;
      case "terminal":
        void store.newTerminal();
        break;
      default:
        break;
    }
  };

  // The menu is drawn beside the Bar, where the glass behind it is the desk's (DeskBar). What it is handed to choose
  // with reads the composer as it is when chosen (`chooseRef`), so the menu reported changes only when it does.
  const chooseRef = useRef({ mention: (_file: MentionFile): void => undefined, command: (_chosen: BarCommand): void => undefined });
  chooseRef.current = { mention: (file) => pick(file), command: (chosen) => chooseCommand(chosen, "run") };
  const pickMention = useCallback((file: MentionFile) => chooseRef.current.mention(file), []);
  const pickCommand = useCallback((chosen: BarCommand) => chooseRef.current.command(chosen), []);
  const grouped = commandTyped === "";
  useEffect(() => {
    onFieldMenu(
      commandsOpen
        ? { kind: "commands", candidates: commands, grouped, index: commandLit, settings: commandSettings, pick: pickCommand, point: setCommandIndex }
        : mentionsOpen
          ? { kind: "mentions", candidates, index: lit, pick: pickMention, point: setMentionIndex }
          : null,
    );
  }, [candidates, commandLit, commandSettings, commands, commandsOpen, grouped, lit, mentionsOpen, onFieldMenu, pickCommand, pickMention]);
  useEffect(() => () => onFieldMenu(null), [onFieldMenu]);

  // The field waiting on what its command must have, there is nothing to send yet.
  const empty = (value.trim() === "" && staged.length === 0) || commandWaiting(value);
  const idle = value === "" && staged.length === 0 && drop.rejection === null && !listening && !acting;
  useEffect(() => onIdle(idle), [idle, onIdle]);
  /** Send `text` as the person's message, with the files staged and those it @mentions. */
  const send = (text: string): void => {
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
    const go = async (): Promise<void> => {
      // Each file @mentioned rides with the message, as the agent would read it: its text, or the file itself.
      const mentionBlocks: string[] = [];
      const api = nativeApi();
      for (const file of mentioned) {
        const reading = api === null ? null : await api.groupFileForMessage(group.id, file.id).catch(() => null);
        if (reading?.kind === "text") mentionBlocks.push(formatAttachmentText(file.name, reading.text));
        else if (reading?.kind === "file" && attachments.length < MAX_MESSAGE_FILES) attachments.push({ id: crypto.randomUUID(), name: file.name, mediaType: reading.mediaType, url: reading.dataUrl } satisfies AgentAttachment);
        else mentionBlocks.push(`“${file.name}” is in this space's context as ${file.id}${reading?.kind === "reference" ? ` (${reading.reason})` : ""}: read it with context_read.`);
      }
      // The desk is the subject, not the page in view: the desk block tells the agent what is on it.
      await sendMessage([text, ...mentionBlocks, ...textBlocks].filter((block) => block !== "").join("\n\n"), attachments, { page: false });
    };
    sending.current = sending.current.then(go, go).catch(() => undefined);
  };
  const submit = (): void => {
    if (value.trim() === "" && staged.length === 0) return;
    // A message that starts with a command's name is that command (any other `/word` is a message).
    const parsed = parseCommand(value);
    if (parsed === null) send(value.trim());
    else runCommand(parsed.command, parsed.args);
  };

  const onFieldKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (commandsOpen && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setCommandIndex((commandLit + step + commands.length) % commands.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        const chosen = commands[commandLit];
        if (chosen !== undefined) chooseCommand(chosen, event.key === "Tab" ? "complete" : "run");
        return;
      }
      if (event.key === "Escape") {
        // The menu goes, and stays away while the field starts with this `/`; the answer card stays.
        event.preventDefault();
        event.stopPropagation();
        setCommandsDismissed(true);
        return;
      }
    }
    if (mentionsOpen && !event.nativeEvent.isComposing) {
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
  /** The tray's New conversation: as the conversations' own, an empty one for the group, which the next message starts. */
  const startNewConversation = (): void => {
    nativeApi()
      ?.deskConversation({ type: "new", groupId: group.id })
      .catch((failure: unknown) => {
        useAppStore.getState().showNotice(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "A new conversation could not be started", { tone: "warning" });
      });
  };

  const placeholder = fileDrag
    ? "Drop here to attach to your message"
    : acting
      ? `${activity ?? "Working"}… type to steer`
      : run === null || TERMINAL.has(run.status) || run.messages.length === 0
        ? files.length > 0
          ? `Ask about ${group.title}… (/ for commands, @ for files)`
          : `Ask about ${group.title}… (/ for commands)`
        : "Ask a follow-up…";
  return (
    <div className="flex flex-col">
      {drop.rejection === null ? null : (
        <div role="status" className="mx-2.5 mt-2 flex items-start gap-1.5 rounded-md bg-amber-100 px-2 py-1 text-[11px] leading-4 text-amber-900">
          <span className="min-w-0 flex-1">{drop.rejection}</span>
          <button type="button" aria-label="Dismiss" onClick={drop.dismissRejection} className="shrink-0 cursor-pointer rounded-xs p-0.5 hover:bg-amber-400">
            <X className="size-3" aria-hidden="true" />
          </button>
        </div>
      )}
      {staged.length === 0 ? null : (
        <div className="desk-bar-staged mx-2.5 mt-2 flex flex-wrap items-end gap-1.5" data-testid="desk-bar-staged">
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
        {listening ? null : (
          <BarTray>
            <BarButton label="Attach files" testId="desk-bar-attach" tip={tip("Attach files")} onClick={() => fileRef.current?.click()}>
              <Paperclip aria-hidden="true" />
            </BarButton>
            <BarButton
              label="New conversation"
              testId="desk-bar-new-conversation"
              unavailable={acting || run === null}
              tip={tip(acting ? "Stop the agent first" : "New conversation")}
              onClick={startNewConversation}
            >
              <SquarePen aria-hidden="true" />
            </BarButton>
          </BarTray>
        )}
        <div className="desk-bar-field" hidden={listening}>
          {/* The mentions, lit behind the field's own text (which stays the field's, caret and all). */}
          <div ref={mirrorRef} aria-hidden="true" className="desk-bar-mirror text-copy-14 px-1 py-[7px] text-[15px] leading-[22px]">
            {spans.length === 0 && command === null ? null : mirrorSegments(value, spans, command)}
          </div>
          <Textarea
            ref={inputRef}
            data-testid="desk-bar-input"
            aria-label={acting ? "Steer Pistachio" : "Ask Pistachio"}
            aria-autocomplete="list"
            aria-expanded={commandsOpen || mentionsOpen}
            aria-controls={commandsOpen ? "desk-commands" : mentionsOpen ? "desk-mentions" : undefined}
            aria-activedescendant={commandsOpen ? `desk-command-${String(commandLit)}` : mentionsOpen ? `desk-mention-${String(lit)}` : undefined}
            placeholder={placeholder}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setCaret(event.target.selectionStart);
              setMentionIndex(0);
              setCommandIndex(0);
              if (dismissedAt !== null && mentionQuery(event.target.value, event.target.selectionStart)?.start !== dismissedAt) setDismissedAt(null);
            }}
            onSelect={noteCaret}
            onClick={noteCaret}
            onScroll={(event) => {
              if (mirrorRef.current !== null) mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
            }}
            onKeyDown={onFieldKeyDown}
            className="relative max-h-32 min-h-9 flex-1 overflow-y-auto px-1 py-[7px] text-[15px] leading-[22px]"
            variant="bare"
            rows={1}
          />
        </div>
        {run === null || listening || inCard ? null : (
          <BarButton
            label={floating ? "Show where the answer is" : answerOpen ? "Hide the answer" : "Show the answer"}
            testId="desk-bar-answer"
            pressed={answerOpen && !floating}
            floating={floating}
            tip={tip(floating ? "The answer is floating" : answerOpen ? "Hide the answer" : "Show the answer")}
            onClick={onToggleAnswer}
          >
            {floating ? <PictureInPicture2 aria-hidden="true" /> : answerOpen ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
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

/** A new note, opened: titled with what followed `/note` (its first line; the rest its text), or blank as ⌘N's in Notes. */
async function newNoteTitled(text: string): Promise<void> {
  const store = useAppStore.getState();
  if (text === "") return store.newNote();
  // (The notes store is the editor chunk's, asked for when a note is wanted, as store.newNote does.)
  const { useNotes } = await import("../notes/use-notes");
  const [title = "", ...rest] = text.split("\n");
  const body = rest.join("\n").trim();
  const note = await useNotes.getState().create(body === "" ? { title: title.trim() } : { title: title.trim(), markdown: body });
  if (note !== null) store.openNotes(note.id);
}

/**
 * The field's text with its command and mentions marked, for the mirror
 * behind it, and a command's hint after it while nothing follows it (a last
 * line break kept, as the field lays it out).
 */
function mirrorSegments(value: string, spans: ReadonlyArray<{ start: number; end: number }>, command: { end: number; hint: string | null } | null): React.ReactNode[] {
  const marks = [...(command === null ? [] : [{ start: 0, end: command.end, className: "desk-bar-command" }]), ...spans.map((span) => ({ ...span, className: "desk-bar-mention" }))];
  const out: React.ReactNode[] = [];
  let at = 0;
  marks.forEach((mark, index) => {
    if (mark.start > at) out.push(value.slice(at, mark.start));
    out.push(
      <mark key={index} className={mark.className}>
        {value.slice(mark.start, mark.end)}
      </mark>,
    );
    at = mark.end;
  });
  out.push(value.slice(at));
  if (command?.hint != null) {
    out.push(
      <span key="hint" className="desk-bar-hint" data-testid="desk-bar-command-hint">
        {command.hint}
      </span>,
    );
  }
  out.push("\u200b");
  return out;
}

/** The menu over the field: the files an `@` offers, or the commands a `/` does. */
function FieldMenu({ ref, menu, shown }: { ref: React.Ref<HTMLDivElement>; menu: FieldMenuState; shown: boolean }) {
  return menu.kind === "commands" ? <CommandMenu ref={ref} menu={menu} shown={shown} /> : <MentionMenu ref={ref} menu={menu} shown={shown} />;
}

const COMMAND_ICONS: Record<Exclude<BarCommandId, "search">, LucideIcon> = {
  open: Globe,
  find: TextSearch,
  summarize: ScrollText,
  compare: Columns2,
  explain: BookOpen,
  translate: Languages,
  research: Telescope,
  new: SquarePen,
  arrange: LayoutGrid,
  tidy: Archive,
  remember: Lightbulb,
  screenshot: Camera,
  share: Radio,
  draw: PenLine,
  note: NotebookPen,
  brief: Newspaper,
  terminal: SquareTerminal,
};

/**
 * The commands a `/` offers, over the desk above the Bar's leading end, as
 * the @ list is: a bare slash lists them all under their groups, typing
 * narrows them to a list, best first. Each row is its mark, `/name` and what
 * it does; the lit one is run by Enter (or put in the field by Tab), any by
 * a click, and the list scrolls to keep the lit one in sight.
 */
function CommandMenu({ ref, menu, shown }: { ref: React.Ref<HTMLDivElement>; menu: Extract<FieldMenuState, { kind: "commands" }>; shown: boolean }) {
  const listRef = useRef<HTMLDivElement>(null);
  /** Rows below the fold: the list's foot fades, so the groups past it are known to be there. */
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = listRef.current;
    if (el !== null) setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);
  useLayoutEffect(measure, [measure, menu.candidates]);
  useEffect(() => {
    listRef.current?.querySelector(`#desk-command-${String(menu.index)}`)?.scrollIntoView({ block: "nearest" });
  }, [menu.index]);
  const row = (entry: BarCommand, index: number): React.ReactNode => {
    const Icon = entry.id === "search" ? null : COMMAND_ICONS[entry.id];
    return (
      <button
        key={entry.id}
        id={`desk-command-${String(index)}`}
        type="button"
        role="option"
        aria-selected={index === menu.index}
        data-testid="desk-command"
        data-command={entry.name}
        className="desk-mention desk-command"
        onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={() => menu.point(index)}
        onClick={() => menu.pick(entry)}
      >
        {Icon === null ? <SearchProviderLogo provider={menu.settings.webProvider} className="size-4" /> : <Icon className="size-4 shrink-0 text-gray-900" aria-hidden="true" />}
        <span className="shrink-0 text-[13px] font-medium text-gray-1000">/{entry.name}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-gray-700">{commandDescription(entry, menu.settings)}</span>
      </button>
    );
  };
  return (
    <div ref={ref} id="desk-commands" role="listbox" aria-label="Commands" data-testid="desk-commands" data-shown={shown ? "" : undefined} className="desk-mentions desk-commands">
      <div ref={listRef} className="desk-commands-list flex flex-col gap-px p-1.5" data-more={more ? "" : undefined} onScroll={measure}>
        {menu.grouped
          ? BAR_COMMAND_GROUPS.map((name) => {
              const rows = menu.candidates.flatMap((entry, index) => (entry.group === name ? [row(entry, index)] : []));
              return rows.length === 0 ? null : (
                <div key={name} role="group" aria-label={name} className="flex flex-col gap-px">
                  <div aria-hidden="true" className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-gray-700">
                    {name}
                  </div>
                  {rows}
                </div>
              );
            })
          : menu.candidates.map(row)}
      </div>
    </div>
  );
}

/**
 * The files a mention offers, over the desk above the Bar's leading end:
 * each with its kind, the lit one chosen by Enter or Tab, any by a click.
 */
function MentionMenu({ ref, menu, shown }: { ref: React.Ref<HTMLDivElement>; menu: Extract<FieldMenuState, { kind: "mentions" }>; shown: boolean }) {
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

/**
 * The tray at the field's leading end: a plus that, under the pointer or the
 * keyboard, lets out the pill's other tools — attach files, a new
 * conversation — sliding the field aside (shell.css, "The Bar's tray"). (The
 * conversations are the nub's past-chats droplet.) A click on the plus opens
 * or shuts it, for a pointer that cannot hover or one that wants it shut;
 * shut while the pointer is on it, it waits for the pointer to leave and
 * come back.
 */
function BarTray({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const later = (next: boolean, ms: number): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), ms);
  };
  const shown = open;
  const itemsId = useId();
  return (
    <div
      className="desk-bar-tray"
      data-testid="desk-bar-tray"
      data-open={shown ? "" : undefined}
      onPointerEnter={() => later(true, TRAY_OPEN_MS)}
      onPointerLeave={() => later(false, TRAY_CLOSE_MS)}
      onFocus={() => {
        window.clearTimeout(timer.current);
        setOpen(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="desk-bar-button desk-bar-tray-plus"
        data-testid="desk-bar-more"
        aria-label="More"
        aria-expanded={shown}
        aria-controls={itemsId}
        // A press leaves the keyboard where it was.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          window.clearTimeout(timer.current);
          setOpen((value) => !value);
        }}
      >
        <Plus aria-hidden="true" />
      </button>
      {/* Shut, its tools are out of reach as well as out of sight. */}
      <div id={itemsId} className="desk-bar-tray-items" inert={!shown}>
        {children}
      </div>
    </div>
  );
}

/** One of the pill's buttons, its label in a tooltip above it. */
function BarButton({
  buttonRef,
  label,
  testId,
  pressed,
  floating = false,
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
  /** Marked with a dot: what it stands for floats elsewhere on the desk. */
  floating?: boolean;
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
        data-floating={floating ? "" : undefined}
        className={kind === "send" ? "desk-bar-send" : "desk-bar-button"}
        // A press leaves the keyboard where it was.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (!unavailable) onClick();
        }}
      >
        {children}
        {floating ? <span className="desk-bar-floating-dot" aria-hidden="true" /> : null}
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
/** The resize ring's edges and corners, as a floating window's. */
const ANSWER_EDGES: readonly AnswerEdge[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

/** The message field's place in the card, floating: what it says about files, and the @ list over it. */
interface CardField {
  acting: boolean;
  /** Files dragged over it, and over the desk (it takes them). */
  dropping: boolean;
  dropTarget: boolean;
  handlers: ReturnType<typeof useAttachmentDrop>["handlers"];
  menu: React.ReactNode;
}

function AnswerCard({
  ref,
  run,
  space,
  whole,
  shown,
  onWhole,
  undo,
  onUndo,
  onClose,
  onDismiss,
  onPress,
  onDock,
  onRaise,
  footRef,
  chat,
  conversations,
  field,
}: {
  ref: React.Ref<HTMLDivElement>;
  /** Null: no conversation yet (a new one, a space with none) — floating, it stays, a window with nothing in it yet. */
  run: RunSummary | null;
  space: string;
  whole: boolean;
  shown: boolean;
  onWhole: () => void;
  undo: boolean;
  onUndo: () => void;
  onClose: () => void;
  /** Its × (2026-10-09): the card closes, docked, floating or in the chat's place — where it was is kept for the next. */
  onDismiss: () => void;
  /** A press on its header (to lift it off the Bar, or move it) or on an edge of it floating (to resize it): answer-motion.ts's. */
  onPress: (event: PointerEvent, edge?: AnswerEdge) => void;
  /** Its dock button, floating: back onto the Bar. */
  onDock: () => void;
  /** A press anywhere on it: floating behind a window, it comes back in front (DeskEngine.raiseCover). */
  onRaise: () => void;
  /** Where the message field lies, floating (DeskBar moves it there): React keeps it empty. */
  footRef: RefObject<HTMLDivElement | null>;
  /** In the chat's place: its header is a chat's (the conversation's name opening the conversations, its actions), and it shows the whole conversation. */
  chat: boolean;
  /** Every conversation, for the chat's header to choose from (as the nub's past chats). */
  conversations: { groupId: string; groups: readonly TabGroupInfo[]; threads: readonly ThreadListItem[]; onChoose: (runId: string | null) => void };
  field: CardField;
}) {
  // Shown docked, it opens out of the pill's trailing end (the plus → menu morph's open: its clip grows from a circle
  // there, up and left, a little past and back). Played once, as it comes — a clip left on it would make it a
  // backdrop root, its glass blurring nothing — and not again as a floating card docks (answer-motion.ts morphs that).
  const visRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const vis = visRef.current;
    if (!shown || vis === null || typeof vis.animate !== "function" || vis.parentElement?.dataset["mode"] === "detached") return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const reveal = vis.animate(
      [
        // (Past the card all round at the end: its shadow, and a held card's deeper one, are never cut.)
        { clipPath: "inset(calc(100% - 52px) 0 0 calc(100% - 52px) round 26px)", transform: "translateY(10px)" },
        { clipPath: "inset(-160px round 18px)", transform: "none" },
      ],
      { duration: 350 * nubTimeScale(), easing: "cubic-bezier(0.34, 1.25, 0.64, 1)" },
    );
    return () => reveal.cancel();
  }, [shown]);
  let lastAsked = (run?.messages.length ?? 0) - 1;
  while (run !== null && lastAsked > 0 && run.messages[lastAsked]?.role !== "user") lastAsked -= 1;
  // (A chat shows the whole conversation: the chat's place is its height.)
  const from = whole || chat ? 0 : Math.max(0, lastAsked);
  const earlier = from > 0;
  const title = run === null ? "New conversation" : run.title.trim() === "" ? "Untitled conversation" : run.title;
  // The chat's header's conversations, dropped down from its name; put away with the chat's place.
  const [picking, setPicking] = useState(false);
  const pickerUp = useLinger(picking, CHAT_PICKER_CLOSE_MS);
  const titleRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!chat) setPicking(false);
  }, [chat]);
  useEffect(() => {
    if (!picking) return;
    // A press anywhere else puts them away — a live page's too, which main relays — and Escape, the keys back on the name.
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input === "press" || input === "escape") setPicking(false);
    });
    const onDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && (pickerRef.current?.contains(target) === true || titleRef.current?.contains(target) === true)) return;
      setPicking(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPicking(false);
      titleRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      offPage?.();
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [picking]);
  const acting = run !== null && agentIsActing(run);
  const newConversation = (): void => {
    nativeApi()
      ?.deskConversation({ type: "new", groupId: conversations.groupId })
      .catch((failure: unknown) => {
        useAppStore.getState().showNotice(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "A new conversation could not be started", { tone: "warning" });
      });
  };
  // Its layers (shell.css, "The answer, detached"): where it is drawn and its mode are answer-motion.ts's to write,
  // never React's — nothing here sets a style, or data-mode, on them.
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Pistachio's answer"
      data-testid="desk-answer"
      data-shown={shown ? "" : undefined}
      className="desk-answer"
      onPointerDownCapture={onRaise}
    >
      <div ref={visRef} className="desk-answer-vis">
        <div className="desk-answer-frame" aria-hidden="true">
          <div className="desk-answer-lift" />
          <div className="desk-answer-sheen" />
          <div className="desk-answer-flash" />
        </div>
        <div className="desk-answer-content">
          <header className="desk-answer-head flex h-8 shrink-0 items-center gap-1.5 pr-1 pl-3.5" data-testid="desk-answer-head" onPointerDown={(event) => onPress(event.nativeEvent)}>
            <span className="desk-answer-grab" aria-hidden="true" />
            <span className="desk-answer-title min-w-0 flex-1 truncate text-[12px] font-medium text-gray-900" data-testid="desk-answer-title">
              {run?.title ?? "New conversation"}
            </span>
            {/* In the chat's place (shell.css): the conversation's name, which drops down the conversations to choose another. */}
            <button
              ref={titleRef}
              type="button"
              data-testid="desk-chat-title"
              className="desk-answer-chat-title desk-answer-chat-only"
              aria-haspopup="dialog"
              aria-expanded={picking}
              title="Choose a conversation"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setPicking((open) => !open)}
            >
              <span className="min-w-0 truncate">{title}</span>
              <ChevronDown aria-hidden="true" />
            </button>
            <div className="desk-answer-actions flex shrink-0 items-center gap-1">
              {undo && run !== null ? (
                <button type="button" data-testid="desk-undo-layout" className="desk-answer-action desk-answer-not-chat" onMouseDown={(event) => event.preventDefault()} onClick={onUndo}>
                  <Undo2 aria-hidden="true" />
                  Undo layout
                </button>
              ) : null}
              {run !== null && (earlier || whole) ? (
                <button type="button" data-testid="desk-answer-whole" className="desk-answer-action desk-answer-not-chat" aria-pressed={whole} onMouseDown={(event) => event.preventDefault()} onClick={onWhole}>
                  {whole ? "Latest" : "Whole conversation"}
                </button>
              ) : null}
              {/* The chat's actions: its layout undone, a new conversation (and, as floating, back onto the pill). */}
              {undo && run !== null ? (
                <button type="button" aria-label="Undo layout" title="Undo layout" data-testid="desk-chat-undo" className="desk-bar-button desk-answer-chat-only" onMouseDown={(event) => event.preventDefault()} onClick={onUndo}>
                  <Undo2 aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                aria-label="New conversation"
                title={acting ? "Stop the agent first" : "New conversation"}
                data-testid="desk-chat-new"
                className="desk-bar-button desk-answer-chat-only"
                aria-disabled={acting || run === null ? "true" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!acting && run !== null) newConversation();
                }}
              >
                <SquarePen aria-hidden="true" />
              </button>
              <button type="button" aria-label="Hide the answer" title="Hide (Esc)" data-testid="desk-answer-close" className="desk-bar-button desk-answer-docked-only" onMouseDown={(event) => event.preventDefault()} onClick={onClose}>
                <ChevronDown aria-hidden="true" />
              </button>
              <button type="button" aria-label="Put it back on the pill" title="Put it back on the pill" data-testid="desk-answer-dock" className="desk-bar-button desk-answer-floating-only" onMouseDown={(event) => event.preventDefault()} onClick={onDock}>
                <ArrowDownToLine aria-hidden="true" />
              </button>
              {/* Its ×, last in every state: the card closes (floating or at the side, where it was is kept for the next). */}
              <button type="button" aria-label="Close the chat" title="Close" data-testid="desk-answer-dismiss" className="desk-bar-button" onMouseDown={(event) => event.preventDefault()} onClick={onDismiss}>
                <X aria-hidden="true" />
              </button>
            </div>
          </header>
          {pickerUp ? (
            <div ref={pickerRef} role="dialog" aria-label="Conversations" data-testid="desk-chat-picker" data-open={picking ? "" : undefined} className="desk-chat-picker" inert={!picking}>
              <ConversationList
                groupId={conversations.groupId}
                groups={conversations.groups}
                threads={conversations.threads}
                run={run}
                onChoose={conversations.onChoose}
                onClose={() => setPicking(false)}
              />
            </div>
          ) : null}
          {/* (A wrapper that stays whatever is in it: answer-motion.ts fades it as the card morphs.) */}
          <div className="desk-answer-body relative flex min-h-0 min-w-0 flex-1 flex-col">
            {run === null ? (
              <p className="desk-answer-empty" data-testid="desk-answer-empty">
                Ask about {space} — the conversation shows here.
              </p>
            ) : (
              <AnswerThread run={run} from={from} />
            )}
          </div>
          {/* The message field, floating: the pill's own, moved here (DeskBar), on the pill's glass. */}
          <div className="desk-answer-foot" data-testid="desk-answer-foot">
            <div
              {...field.handlers}
              className="desk-bar desk-answer-field"
              data-testid="desk-answer-field"
              data-acting={field.acting ? "" : undefined}
              data-drop-target={field.dropTarget ? "" : undefined}
            >
              <div className="desk-bar-frame" aria-hidden="true" />
              {field.dropping ? <AttachmentDropVeil className="inset-1 rounded-[16px]" /> : null}
              {field.menu}
              <div ref={footRef} className="desk-bar-body" />
            </div>
          </div>
        </div>
        {/* The morph's still copy of how it was lies here (answer-motion.ts): React keeps it empty. */}
        <div className="desk-answer-snap" aria-hidden="true" />
      </div>
      <div className="desk-answer-edges" aria-hidden="true">
        {ANSWER_EDGES.map((edge) => (
          <div key={edge} className="desk-answer-edge" data-edge={edge} onPointerDown={(event) => onPress(event.nativeEvent, edge)} />
        ))}
      </div>
    </div>
  );
}

/**
 * The conversation in the card: the latest exchange (or every turn), scrolled to the end as it streams. The agent's
 * side of each turn — what it thought, its steps, why it stopped — is drawn as Trace lines (chat/trace.tsx).
 */
function AnswerThread({ run, from }: { run: RunSummary; from: number }) {
  const layout = useThreadLayout(run);
  const { tracesAt, outputsAt, pendingOutputs, sourcesAt, pendingSources } = layout;
  const failure = runFailure(run);
  // The turn at work: the run's latest, its reply not begun (its words held a moment: useReplyBegun) — its steps' line
  // stays running between two steps.
  const replyBegun = useReplyBegun(run);
  const working = run.status === "running" && !replyBegun;
  return (
    <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollPreviousItemPeek={48}>
      <MessageScroller.Root className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <MessageScroller.Viewport className="desk-answer-viewport scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" aria-label="Conversation">
          <MessageScroller.Content className="flex shrink-0 flex-col px-3.5 pt-1 pb-3.5" aria-busy={run.status === "running"}>
            <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {run.result === null ? "" : "Answer complete"}
            </span>
            {run.messages.map((message, index) => {
              if (index < from) return null;
              const canRetry =
                message.role === "assistant" &&
                index === run.messages.length - 1 &&
                !agentIsActing(run) &&
                run.status !== "waiting_for_judgment" &&
                run.status !== "waiting_for_approval" &&
                run.status !== "human_control" &&
                run.executor?.kind !== "cloud";
              return (
                <MessageScroller.Item key={message.id} messageId={message.id} scrollAnchor={message.role === "user"} className="mb-4 min-w-0">
                  {failure?.messageId === message.id ? (
                    // (What the turn made before it stopped is shown under the line, as under a reply.)
                    <FailureTrace failure={failure}>
                      {outputsAt.has(index) ? <OutputCards outputs={outputsAt.get(index)!} /> : null}
                      <MessageActions text={message.content} canRetry={canRetry} />
                    </FailureTrace>
                  ) : (
                    <MessageRow message={message} outputs={outputsAt.get(index)} sources={sourcesAt.get(index)} links="glance" canRetry={canRetry} trace />
                  )}
                  {(tracesAt.get(index) ?? []).map((turn) => (
                    <Fragment key={turn.turn}>
                      <TurnTrace
                        turn={turn}
                        live={working && turn.turn === run.turns}
                        latest={turn.toolCalls.at(-1) === run.toolCalls.at(-1)}
                        awaitingApproval={run.status === "waiting_for_approval"}
                      />
                      {pendingOutputs.has(turn.turn) ? (
                        <div className="mt-3">
                          <OutputCards outputs={pendingOutputs.get(turn.turn)!} />
                        </div>
                      ) : null}
                    </Fragment>
                  ))}
                </MessageScroller.Item>
              );
            })}
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
                <LiveReply run={run} sources={pendingSources} links="glance" tabChip={false} trace />
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
  );
}

/** Where a conversation started: this group, another of the Space's, one no longer here, or elsewhere in the browser. */
function startedIn(thread: ThreadListItem, groupId: string, groups: readonly TabGroupInfo[]): { label: string; color: TabGroupInfo["color"] | null } {
  if (thread.groupId === undefined) return { label: thread.origin?.kind === "reminder" ? "Reminder" : "Sidebar", color: null };
  if (thread.groupId === groupId) return { label: "This space", color: groups.find((group) => group.id === groupId)?.color ?? null };
  const group = groups.find((candidate) => candidate.id === thread.groupId);
  return group === undefined ? { label: "Another space", color: null } : { label: group.title, color: group.color };
}

/**
 * Every conversation, newest first, each marked with the group it started
 * in. Choosing one continues it at this desk — the group's conversation
 * from then on — and the Bar opens its card on it (`onChoose`, null again
 * when it could not be opened); New conversation starts an empty one for
 * the group. While the agent is acting the console is its, and nothing here
 * can be chosen.
 *
 * It is the nub's past-chats droplet grown into a list (shell.css, "The
 * conversations"): laid out at its open size where the droplet rests
 * (`place`, from the nub's corner), its glass grown from the droplet's box
 * and its rows clipped to it while `open` comes and goes; `gone`, it fades
 * as it shrinks, the droplet it would go back into going too.
 */
function ConversationPicker({
  ref,
  groupId,
  groups,
  threads,
  run,
  shown,
  open,
  gone,
  place,
  onChoose,
  onClose,
}: {
  ref: React.Ref<HTMLDivElement>;
  groupId: string;
  groups: readonly TabGroupInfo[];
  threads: readonly ThreadListItem[];
  run: RunSummary | null;
  shown: boolean;
  open: boolean;
  gone: boolean;
  place: { right: number; bottom: number };
  onChoose: (runId: string | null) => void;
  onClose: () => void;
}) {
  // Opened from the keys, on the droplet it grew out of: the keys go into the list.
  const firstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open && (document.activeElement?.closest("[data-testid='desk-nub-chats']") ?? null) !== null) firstRef.current?.focus({ preventScroll: true });
  }, [open]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Conversations"
      data-testid="desk-conversations"
      data-shown={shown && open ? "" : undefined}
      data-open={open ? "" : undefined}
      data-gone={gone && !open ? "" : undefined}
      className="desk-conversations"
      style={{ right: place.right, bottom: place.bottom }}
    >
      <div className="desk-conversations-frame" aria-hidden="true" />
      <span className="desk-conversations-mark" aria-hidden="true">
        <History />
      </span>
      <div className="desk-conversations-body" inert={!open}>
        <ConversationList groupId={groupId} groups={groups} threads={threads} run={run} onChoose={onChoose} onClose={onClose} firstRef={firstRef} />
      </div>
    </div>
  );
}

/**
 * The conversations' rows, as the nub's past chats and the chat's header
 * list them: New conversation first, then every conversation, newest
 * first, each marked with the group it started in. Choosing one continues
 * it at this desk (`onChoose`, null again when it could not be opened);
 * while the agent is acting the console is its, and nothing here can be
 * chosen.
 */
function ConversationList({
  groupId,
  groups,
  threads,
  run,
  onChoose,
  onClose,
  firstRef,
}: {
  groupId: string;
  groups: readonly TabGroupInfo[];
  threads: readonly ThreadListItem[];
  run: RunSummary | null;
  onChoose: (runId: string | null) => void;
  onClose: () => void;
  firstRef?: React.Ref<HTMLButtonElement>;
}) {
  const acting = agentIsActing(run);
  const [error, setError] = useState<string | null>(null);
  const act = (command: Parameters<NonNullable<ReturnType<typeof nativeApi>>["deskConversation"]>[0]): void => {
    const api = nativeApi();
    if (api === null) return;
    if (command.type === "choose") onChoose(command.runId);
    api.deskConversation(command).then(
      () => onClose(),
      (failure: unknown) => {
        if (command.type === "choose") onChoose(null);
        setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "That conversation could not be opened");
      },
    );
  };
  const sorted = sortThreads([...threads]);
  return (
    <>
      <div className="p-1 pb-0">
        <button
          ref={firstRef}
          type="button"
          data-testid="desk-conversation-new"
          disabled={acting}
          title={acting ? "Stop the agent first" : "Start a new conversation for this space"}
          className="desk-conversation"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => act({ type: "new", groupId })}
        >
          <SquarePen className="size-3.5 shrink-0 text-gray-800" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-gray-1000">New conversation</span>
        </button>
      </div>
      <div className="desk-conversations-rule" />
      {error === null ? null : (
        <div role="status" className="mx-2 mb-1.5 rounded-md bg-amber-100 px-2 py-1 text-[11px] leading-4 text-amber-900">
          {error}
        </div>
      )}
      <div className="scroll-thin flex min-h-0 flex-col gap-px overflow-y-auto px-1 pb-1" role="list" aria-label="Earlier conversations">
        {sorted.length === 0 ? <div className="px-2.5 py-2 text-[12px] text-gray-700">No conversations yet</div> : null}
        {sorted.map((thread) => {
          const current = run?.runId === thread.runId;
          const where = startedIn(thread, groupId, groups);
          return (
            <button
              key={thread.runId}
              type="button"
              role="listitem"
              data-testid="desk-conversation"
              data-run-id={thread.runId}
              data-open={current ? "" : undefined}
              aria-current={current ? "true" : undefined}
              disabled={acting && !current}
              title={acting && !current ? "Stop the agent first" : current ? "Open in this space" : "Continue here"}
              className="desk-conversation"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => (current ? onClose() : act({ type: "choose", groupId, runId: thread.runId }))}
            >
              <span className={`min-w-0 flex-1 truncate text-[12.5px] text-gray-1000${current ? " font-medium" : ""}`}>{thread.title.trim() === "" ? "Untitled conversation" : thread.title}</span>
              <span className="desk-conversation-group tab-group-tone" data-group-color={where.color ?? undefined} data-toned={where.color === null ? undefined : ""}>
                {where.label}
              </span>
              <span className="w-12 shrink-0 text-right text-[10.5px] text-gray-700 tabular-nums">{relativeTime(thread.updatedAt)}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
