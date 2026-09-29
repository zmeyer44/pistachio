import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessageScroller } from "@shadcn/react/message-scroller";
import { ArrowDown, ArrowUp, FileText, House, PanelRight, Paperclip, Square, SquarePen, TextQuote, X } from "lucide-react";
import type { RunSummary } from "@pistachio/protocol";
import {
  formatAttachmentText,
  formatSelectionText,
  MAX_COMPOSER_ATTACHMENTS,
  readComposerAttachment,
  selectionChipLabel,
  toAgentAttachments,
  type ComposerAttachment,
} from "../../lib/chat-attachments";
import { cn } from "../../lib/cn";
import { agentIsActing } from "../../lib/run";
import { useAppStore, type HomeChat as HomeChatState } from "../../store";
import { LiveReply } from "../chat/LiveReply";
import { ApprovalCard, ClarificationCard, CompletionMeta, MessageRow, TERMINAL, TaskNotes, WorkTrace } from "../chat/parts";
import { useThreadLayout } from "../chat/use-thread-layout";
import { OutputCards } from "../OutputCard";
import { PistachioMark } from "../PistachioMark";
import { TakeoverCard } from "../TakeoverCard";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** The reading measure of the thread and the composer: one column, centred. */
const COLUMN = "mx-auto w-full max-w-[760px] px-5 @3xl:px-8";

/** How long the search pill takes to fly to the foot of the page and become the composer. */
const FLIGHT_MS = 560;
const FLIGHT_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * The home page as a chat (docs: the home page answers a question itself
 * rather than sending it to a provider's site). The tab's conversation is
 * the console's open thread, seen full-page: the same messages, traces,
 * cards and live reply the sidebar draws (components/chat), at the reading
 * measure of a page. The composer at the foot IS the search pill the
 * question was typed into — it flies there from `origin`, the pill's box
 * at the moment of asking, and the thread fades in above it.
 *
 * `chat` is the tab's entry in the store: its run, or a pending question
 * while main is starting the run. `onLeave` gives the tab back to the home
 * page; the conversation itself goes on in the console.
 */
export function HomeChat({
  tabKey,
  chat,
  run,
  origin,
  active,
  onLeave,
}: {
  tabKey: string;
  chat: HomeChatState;
  run: RunSummary | null;
  origin: DOMRect | null;
  active: boolean;
  onLeave: () => void;
}) {
  const setConsoleOpen = useAppStore((state) => state.setConsoleOpen);
  const layout = useThreadLayout(run);
  const composerRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const flownFrom = useRef<DOMRect | null>(origin);

  // The flight: the composer is laid out where it lives, then made to look
  // like the pill it came from and released. One compositor animation, no
  // layout thrash — and none at all when the chat mounts with no pill to
  // come from (a tab switched back to a conversation).
  useLayoutEffect(() => {
    const from = flownFrom.current;
    flownFrom.current = null;
    const composer = composerRef.current;
    const thread = threadRef.current;
    if (from === null || composer === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = composer.getBoundingClientRect();
    if (to.width === 0 || to.height === 0) return;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const sx = from.width / to.width;
    const sy = from.height / to.height;
    composer.animate(
      [{ transform: `translate(${String(dx)}px, ${String(dy)}px) scale(${String(sx)}, ${String(sy)})` }, { transform: "translate(0, 0) scale(1, 1)" }],
      { duration: FLIGHT_MS, easing: FLIGHT_EASE, fill: "both" },
    );
    thread?.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "translateY(0)" }], {
      duration: 360,
      delay: 120,
      easing: FLIGHT_EASE,
      fill: "both",
    });
  }, []);

  const live = run !== null && !TERMINAL.has(run.status);
  const title = run?.title ?? chat.prompt;
  return (
    <div data-testid="home-chat" data-run-id={run?.runId ?? undefined} className="@container absolute inset-0 flex flex-col bg-background-200 text-gray-1000">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 px-5 @3xl:px-8">
        <div className="flex min-w-0 items-center gap-2.5 text-gray-700">
          <PistachioMark size={20} tone="muted" />
          <span className="truncate text-[14px] font-medium tracking-[-0.01em] text-gray-900" data-testid="home-chat-title">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="tertiary" size="xs" svgOnly aria-label="Open in the sidebar" title="Open in the sidebar" data-testid="home-chat-sidebar" onClick={() => setConsoleOpen(true)}>
            <PanelRight aria-hidden="true" />
          </Button>
          <Button
            variant="tertiary"
            size="xs"
            svgOnly
            aria-label="New chat"
            title={live ? "The current task keeps running in the sidebar" : "New chat"}
            data-testid="home-chat-new"
            onClick={onLeave}
          >
            <SquarePen aria-hidden="true" />
          </Button>
          <Button variant="tertiary" size="xs" svgOnly aria-label="Back to the home page" title="Back to the home page" data-testid="home-chat-home" onClick={onLeave}>
            <House aria-hidden="true" />
          </Button>
        </div>
      </header>
      <div ref={threadRef} className="relative flex min-h-0 flex-1 flex-col">
        <Thread chat={chat} run={run} layout={layout} />
      </div>
      <div ref={composerRef} className={cn(COLUMN, "shrink-0 pt-2 pb-5 [transform-origin:center]")} data-testid="home-composer">
        <HomeComposer tabKey={tabKey} run={run} active={active} />
      </div>
    </div>
  );
}

/**
 * The messages, in the same scroller the console uses: pinned to the end
 * while the reply streams, with a "Latest" pill the moment the person
 * scrolls up to read.
 */
function Thread({ chat, run, layout }: { chat: HomeChatState; run: RunSummary | null; layout: ReturnType<typeof useThreadLayout> }) {
  const { tracesAt, outputsAt, pendingOutputs, sourcesAt, pendingSources } = layout;
  return (
    <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollPreviousItemPeek={64}>
      <MessageScroller.Root className="home-thread relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <MessageScroller.Viewport className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" aria-label="Conversation">
          <MessageScroller.Content className={cn(COLUMN, "flex min-h-full shrink-0 flex-col pt-4 pb-6")} aria-busy={run?.status === "running"}>
            <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {run?.result === null || run?.result === undefined ? "" : "Answer complete"}
            </span>
            {run === null ? (
              // The question, on screen before main has the run: the page
              // never waits on the round trip to show what was just asked.
              <>
                <MessageScroller.Item messageId="pending-question" scrollAnchor className="mb-6 min-w-0">
                  <MessageRow
                    message={{ id: "pending", at: new Date().toISOString(), role: "user", content: chat.prompt, turn: 1 }}
                    density="page"
                    links="tab"
                  />
                </MessageScroller.Item>
                <MessageScroller.Item messageId="pending-reply" className="mb-6 min-w-0">
                  <div className="flex items-center gap-2 text-[15px] text-gray-700">
                    <span className="agent-thinking-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="agent-shimmer">Thinking…</span>
                  </div>
                </MessageScroller.Item>
              </>
            ) : (
              <>
                {run.notes.trim() === "" ? null : <TaskNotes run={run} />}
                {run.messages.map((message, index) => (
                  <MessageScroller.Item key={message.id} messageId={message.id} scrollAnchor={message.role === "user"} className="mb-6 min-w-0">
                    <MessageRow
                      message={message}
                      outputs={outputsAt.get(index)}
                      sources={sourcesAt.get(index)}
                      density="page"
                      links="tab"
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
                ))}
                {run.pendingQuestion === null ? null : (
                  <MessageScroller.Item messageId={run.pendingQuestion.id} className="mb-6 min-w-0">
                    <ClarificationCard run={run} />
                  </MessageScroller.Item>
                )}
                {run.pendingTakeover === null ? null : (
                  <MessageScroller.Item messageId={run.pendingTakeover.id} className="mb-6 min-w-0">
                    <TakeoverCard run={run} />
                  </MessageScroller.Item>
                )}
                {run.pendingApproval === null ? null : (
                  <MessageScroller.Item messageId={run.pendingApproval.id} className="mb-6 min-w-0">
                    <ApprovalCard run={run} />
                  </MessageScroller.Item>
                )}
                {run.result === null ? null : (
                  <MessageScroller.Item messageId={`result-${run.runId}`} className="mb-2 min-w-0">
                    <CompletionMeta run={run} />
                  </MessageScroller.Item>
                )}
                {run.status === "running" ? (
                  <MessageScroller.Item messageId={`working-${run.runId}`} className="mb-6 min-w-0">
                    <LiveReply run={run} sources={pendingSources} density="page" links="tab" />
                  </MessageScroller.Item>
                ) : null}
              </>
            )}
          </MessageScroller.Content>
        </MessageScroller.Viewport>
        <MessageScroller.Button
          direction="end"
          className="absolute bottom-3 left-1/2 z-10 flex h-7 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full bg-gray-1000 px-3 text-label-12 font-medium whitespace-nowrap text-background-100 shadow-menu transition-[opacity,translate] inert:pointer-events-none inert:translate-y-2 inert:opacity-0"
        >
          <ArrowDown className="size-3.5" aria-hidden="true" /> Latest
        </MessageScroller.Button>
      </MessageScroller.Root>
    </MessageScroller.Provider>
  );
}

/**
 * The chat's composer: the search pill, grown a line taller and given the
 * chat's controls — attach, send, and stop while the agent works. A
 * follow-up continues the thread; while the agent acts it steers it.
 */
const HomeComposer = memo(function HomeComposer({ tabKey, run, active }: { tabKey: string; run: RunSummary | null; active: boolean }) {
  const sendMessage = useAppStore((state) => state.sendAgentMessage);
  const interrupt = useAppStore((state) => state.interruptAgent);
  const [value, setValue] = useState("");
  const [staged, setStaged] = useState<ComposerAttachment[]>([]);
  const [rejection, setRejection] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const acting = agentIsActing(run);
  const starting = run === null;

  // The keyboard lands here as the chat shows, and comes back after a reply.
  useEffect(() => {
    if (active) inputRef.current?.focus({ preventScroll: true });
  }, [active, tabKey]);
  useEffect(() => {
    if (active && run !== null && TERMINAL.has(run.status)) inputRef.current?.focus({ preventScroll: true });
  }, [active, run?.status, run]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${String(el.scrollHeight)}px`;
  }, [value]);

  const addFiles = async (list: FileList): Promise<void> => {
    let room = MAX_COMPOSER_ATTACHMENTS - staged.length;
    if (room <= 0) {
      setRejection(`At most ${String(MAX_COMPOSER_ATTACHMENTS)} files per message`);
      return;
    }
    setRejection(null);
    for (const file of Array.from(list)) {
      if (room <= 0) break;
      try {
        const result = await readComposerAttachment(file);
        if (result.ok) {
          room -= 1;
          setStaged((prev) => [...prev, result.attachment]);
        } else setRejection(result.reason);
      } catch {
        setRejection(`Could not read ${file.name}`);
      }
    }
    inputRef.current?.focus({ preventScroll: true });
  };

  const empty = value.trim() === "" && staged.length === 0;
  const submit = (): void => {
    if (empty || starting) return;
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
    setRejection(null);
    void sendMessage(blocks.join("\n\n"), attachments, { page: false });
  };

  return (
    <div
      data-testid="home-chat-composer"
      className="home-composer flex flex-col rounded-[28px] bg-background-100 shadow-[0_0_0_1px_var(--color-alpha-400),0_2px_8px_-2px_var(--color-alpha-200)] transition-shadow duration-150 focus-within:shadow-[0_0_0_1px_var(--color-alpha-600),0_4px_14px_-4px_var(--color-alpha-300)]"
    >
      {rejection === null ? null : (
        <div role="status" className="mx-4 mt-3 flex items-start gap-1.5 rounded-md bg-amber-100 px-2 py-1.5 text-[11px] leading-4 text-amber-900">
          <span className="min-w-0 flex-1">{rejection}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setRejection(null)} className="shrink-0 cursor-pointer rounded-xs p-0.5 hover:bg-amber-400">
            <X className="size-3" aria-hidden="true" />
          </button>
        </div>
      )}
      {staged.length === 0 ? null : (
        <div className="mx-4 mt-3 flex flex-wrap items-end gap-2" data-testid="home-staged-attachments">
          {staged.map((file) => (
            <span key={file.id} className="group/chip relative">
              {file.kind === "image" ? (
                <img src={file.url} alt={file.name} title={file.name} draggable={false} className="block h-12 w-auto max-w-24 rounded-sm object-cover shadow-border" />
              ) : (
                <span title={file.name} className="flex h-8 max-w-48 items-center gap-1.5 rounded-sm bg-background-200 px-2 text-label-12 text-gray-900 shadow-border">
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
      {/* The buttons ride the field's last line: bottom-aligned, and lifted
          by half of what the one-line field (44px) has over them (32px), so
          they sit centred on it however many lines the field grows to. */}
      <div className="flex items-end gap-2 pr-2.5 pl-2.5 pt-2 pb-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          data-testid="home-attach-input"
          onChange={(event) => {
            const files = event.currentTarget.files;
            if (files !== null && files.length > 0) void addFiles(files);
            event.currentTarget.value = "";
          }}
        />
        <Button variant="tertiary" size="sm" shape="circle" svgOnly aria-label="Attach files" data-testid="home-attach-button" className="mb-1.5 shrink-0" onClick={() => fileRef.current?.click()}>
          <Paperclip aria-hidden="true" />
        </Button>
        <Textarea
          ref={inputRef}
          data-testid="home-chat-input"
          aria-label={acting ? "Steer Pistachio" : "Ask a follow-up"}
          placeholder={acting ? "Steer Pistachio…" : "Ask a follow-up…"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="scroll-thin max-h-44 min-h-10 flex-1 overflow-y-auto px-1.5 py-2.5 text-[16px] leading-6"
          variant="bare"
          rows={1}
        />
        {acting ? (
          <Button size="sm" shape="circle" svgOnly aria-label="Stop" title="Stop" data-testid="home-chat-stop" className="mb-1.5 shrink-0" onClick={() => void interrupt()}>
            <Square className="fill-current" aria-hidden="true" />
          </Button>
        ) : (
          <Button size="sm" shape="circle" svgOnly aria-label="Send" title="Send" data-testid="home-chat-send" className="mb-1.5 shrink-0" disabled={empty || starting} onClick={submit}>
            <ArrowUp aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
});
