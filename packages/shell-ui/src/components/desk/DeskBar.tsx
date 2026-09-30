import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { MessageScroller } from "@shadcn/react/message-scroller";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, FileText, History, Paperclip, Square, SquarePen, TextQuote, Undo2, X } from "lucide-react";
import type { RunSummary, ThreadListItem } from "@pistachio/protocol";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { nativeApi } from "../../api";
import { formatAttachmentText, formatSelectionText, selectionChipLabel, toAgentAttachments } from "../../lib/chat-attachments";
import { cn } from "../../lib/cn";
import { agentActivity } from "../../lib/desk/agent";
import { DESK_GAP, type Rect } from "../../lib/desk/geometry";
import { agentIsActing, relativeTime, sortThreads } from "../../lib/run";
import { useAppStore } from "../../store";
import { AttachmentDropVeil, useAttachmentDrop } from "../chat/attachment-drop";
import { LiveReply } from "../chat/LiveReply";
import { ApprovalCard, ClarificationCard, CompletionMeta, MessageRow, TERMINAL, WorkTrace } from "../chat/parts";
import { useThreadLayout } from "../chat/use-thread-layout";
import { OutputCards } from "../OutputCard";
import { PistachioMark } from "../PistachioMark";
import { TakeoverCard } from "../TakeoverCard";
import { Textarea } from "../ui/textarea";
import { DOCK_W, type DeskEngine, type DeskView } from "./desk-engine";

/** The Bar's height at one line, and the band the desk keeps for it at its foot (the Bar and the gap above it). */
export const BAR_H = 52;
export const BAR_BAND = BAR_H + DESK_GAP;
/** The answer card never takes more of the desk's height than this. */
const ANSWER_MAX_SHARE = 0.62;

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
 * give way to their stills while it is up.
 */
function useCover(engine: DeskEngine, key: string, ref: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || el === null) {
      engine.setCover(key, null);
      return;
    }
    const measure = (): void => engine.setCover(key, stageBox(el));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      engine.setCover(key, null);
    };
  }, [engine, key, ref, active]);
}

/**
 * The desk's agent, in a glass bar at the desk's foot (docs/desk-agent.md
 * §1): the group's chip, the message field, attach, the conversations and
 * send — stop while the agent works. Above it, the answer card shows the
 * latest exchange as it happens; it opens when a turn starts and stays until
 * closed. The conversations it lists are every thread, each marked with the
 * group it started in: choosing one continues it at this desk.
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
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focusInput = useCallback(() => inputRef.current?.focus({ preventScroll: true }), []);
  const drop = useAttachmentDrop(focusInput);
  const [answerOpen, setAnswerOpen] = useState(false);
  const [whole, setWhole] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const leaving = view.phase === "leaving";
  const cardShown = answerOpen && run !== null && !leaving;

  useCover(engine, "bar", barRef, !leaving);
  useCover(engine, "answer", cardRef, cardShown);
  useCover(engine, "conversations", pickerRef, pickerOpen && !leaving);

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
      if (event.key !== "Escape") return;
      if (pickerOpen) setPickerOpen(false);
      else setAnswerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cardShown, pickerOpen]);

  useEffect(() => {
    if (focusSignal > 0) focusInput();
  }, [focusSignal, focusInput]);

  const activity = agentActivity(run);
  const shownCover = (key: string): boolean => view.clearCovers.has(key);

  return (
    // Centred on the desk beside the dock: the room windows have.
    <div className="desk-bar-lane" data-testid="desk-bar-lane" style={{ left: DOCK_W + DESK_GAP, right: 0 }}>
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
      {/* Over the answer: it is what the conversations button opened last. */}
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
      <div
        ref={barRef}
        {...drop.handlers}
        role="region"
        aria-label="Ask Pistachio about this desk"
        data-testid="desk-bar"
        data-acting={activity !== null ? "" : undefined}
        className="desk-bar"
      >
        {drop.dragging ? <AttachmentDropVeil data-testid="desk-bar-drop-veil" className="inset-1 rounded-[20px]" /> : null}
        <BarComposer
          group={group}
          run={run}
          activity={activity}
          inputRef={inputRef}
          drop={drop}
          answerOpen={cardShown}
          pickerOpen={pickerOpen}
          onSent={() => setAnswerOpen(true)}
          onToggleAnswer={() => setAnswerOpen((value) => !value)}
          onTogglePicker={() => setPickerOpen((value) => !value)}
        />
      </div>
    </div>
  );
});

/** The Bar's own row: the mark, the group, the field and its buttons; files staged for the message above them. */
function BarComposer({
  group,
  run,
  activity,
  inputRef,
  drop,
  answerOpen,
  pickerOpen,
  onSent,
  onToggleAnswer,
  onTogglePicker,
}: {
  group: TabGroupInfo;
  run: RunSummary | null;
  activity: string | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  drop: ReturnType<typeof useAttachmentDrop>;
  answerOpen: boolean;
  pickerOpen: boolean;
  onSent: () => void;
  onToggleAnswer: () => void;
  onTogglePicker: () => void;
}) {
  const sendMessage = useAppStore((state) => state.sendAgentMessage);
  const interrupt = useAppStore((state) => state.interruptAgent);
  const [value, setValue] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const acting = agentIsActing(run);
  const { staged, setStaged } = drop;

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${String(el.scrollHeight)}px`;
  }, [value, inputRef]);

  const empty = value.trim() === "" && staged.length === 0;
  const submit = (): void => {
    if (empty) return;
    const blocks = [
      value.trim(),
      ...staged.flatMap((file) => {
        if (file.kind === "text") return [formatAttachmentText(file.name, file.text ?? "")];
        if (file.kind === "selection") return [formatSelectionText(file.name, file.url, file.text ?? "")];
        return [];
      }),
    ].filter((block) => block !== "");
    const attachments = toAgentAttachments(staged);
    setValue("");
    setStaged([]);
    drop.dismissRejection();
    onSent();
    // The desk is the subject, not the page in view: the desk block tells the agent what is on it.
    void sendMessage(blocks.join("\n\n"), attachments, { page: false });
  };

  const placeholder = acting ? `${activity ?? "Working"}… type to steer` : run === null || TERMINAL.has(run.status) || run.messages.length === 0 ? `Ask about ${group.title}…` : "Ask a follow-up…";
  return (
    <div className="flex min-w-0 flex-1 flex-col">
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
      <div className="desk-bar-row">
        <span className={cn("desk-bar-mark", acting && "agent-ring agent-ring-mark")} data-testid="desk-bar-mark">
          <PistachioMark size={20} />
        </span>
        <span className="desk-bar-group" data-testid="desk-bar-group" title={group.title}>
          <span className="desk-bar-group-dot" aria-hidden="true" />
          <span className="truncate">{group.title}</span>
        </span>
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
        <Textarea
          ref={inputRef}
          data-testid="desk-bar-input"
          aria-label={acting ? "Steer Pistachio" : "Ask Pistachio"}
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="scroll-thin max-h-32 min-h-9 flex-1 overflow-y-auto px-1 py-[7px] text-[14px] leading-[22px]"
          variant="bare"
          rows={1}
        />
        <BarButton label="Attach files" testId="desk-bar-attach" onClick={() => fileRef.current?.click()}>
          <Paperclip aria-hidden="true" />
        </BarButton>
        <BarButton label="Conversations" testId="desk-bar-conversations" pressed={pickerOpen} onClick={onTogglePicker}>
          <History aria-hidden="true" />
        </BarButton>
        {run === null ? null : (
          <BarButton label={answerOpen ? "Hide the answer" : "Show the answer"} testId="desk-bar-answer" pressed={answerOpen} onClick={onToggleAnswer}>
            {answerOpen ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
          </BarButton>
        )}
        {acting ? (
          <button type="button" aria-label="Stop" title="Stop" data-testid="desk-bar-stop" className="desk-bar-send" onClick={() => void interrupt()}>
            <Square className="fill-current" aria-hidden="true" />
          </button>
        ) : (
          <button type="button" aria-label="Send" title="Send" data-testid="desk-bar-send" className="desk-bar-send" disabled={empty} onClick={submit}>
            <ArrowUp aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

function BarButton({ label, testId, pressed, onClick, children }: { label: string; testId: string; pressed?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-testid={testId}
      className="desk-bar-button"
      // A press leaves the keyboard where it was.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
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
      style={{ bottom: BAR_BAND, maxHeight: `calc(${String(ANSWER_MAX_SHARE * 100)}% - ${String(BAR_BAND)}px)` }}
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
        <button type="button" aria-label="Close" title="Close (Esc)" data-testid="desk-answer-close" className="desk-bar-button" onMouseDown={(event) => event.preventDefault()} onClick={onClose}>
          <X aria-hidden="true" />
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
    <div ref={ref} role="dialog" aria-label="Conversations" data-testid="desk-conversations" data-shown={shown ? "" : undefined} className="desk-conversations" style={{ bottom: BAR_BAND }}>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span className="flex-1 text-[11px] font-semibold tracking-wide text-gray-700 uppercase">Conversations</span>
        <button
          type="button"
          data-testid="desk-conversation-new"
          disabled={acting}
          title={acting ? "Stop the agent first" : "Start a new conversation for this desk"}
          className="desk-answer-action"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => act({ type: "new", groupId })}
        >
          <SquarePen aria-hidden="true" />
          New
        </button>
      </div>
      {error === null ? null : (
        <div role="status" className="mx-3 mb-1.5 rounded-md bg-amber-100 px-2 py-1 text-[11px] leading-4 text-amber-900">
          {error}
        </div>
      )}
      <div className="scroll-thin flex max-h-72 flex-col gap-px overflow-y-auto px-1.5 pb-1.5" role="list">
        {sorted.length === 0 ? <div className="px-2 py-3 text-[12px] text-gray-700">No conversations yet.</div> : null}
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
              disabled={acting && !open}
              title={acting && !open ? "Stop the agent first" : open ? "Open at this desk" : "Continue here"}
              className="desk-conversation"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => (open ? onClose() : act({ type: "choose", groupId, runId: thread.runId }))}
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-gray-1000">{thread.title.trim() === "" ? "Untitled conversation" : thread.title}</span>
              <span className="desk-conversation-group tab-group-tone" data-group-color={where.color ?? undefined} data-toned={where.color === null ? undefined : ""}>
                {where.label}
              </span>
              <span className="w-14 shrink-0 text-right text-[11px] text-gray-700">{relativeTime(thread.updatedAt)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
