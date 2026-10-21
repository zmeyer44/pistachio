import { memo, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Archive,
  Bell,
  Bookmark,
  Bot,
  Brain,
  Calendar,
  Camera,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleX,
  ClipboardList,
  Globe,
  Keyboard,
  KeyRound,
  LayoutGrid,
  LayoutTemplate,
  LoaderCircle,
  Mail,
  MousePointerClick,
  MoveVertical,
  NotebookPen,
  Paperclip,
  PanelsTopLeft,
  Plug,
  RotateCw,
  ScanText,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { AgentSource, AgentToolCall } from "@pistachio/protocol";
import { sourceHost } from "../../lib/chat-sources";
import { thinkingSpan, traceSteps, traceSummary, type RunFailure, type TraceStep, type TraceStepState } from "../../lib/chat-trace";
import type { TraceTurn } from "../../lib/run";
import { useAppStore } from "../../store";
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton } from "../ui/code-block";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle, type TraceStatus } from "../ui/trace";
import { Markdown } from "./Markdown";
import { useElapsedSeconds } from "./ReasoningBlock";
import { SmoothHeight } from "./SmoothHeight";

/**
 * The agent's side of a turn as Trace lines (AI Elements' Reasoning, Chain
 * of Thought and Stack Trace patterns; ui.shadcn.com/docs/ai-elements):
 * what the model thought, the steps it took, and why a run stopped. The
 * desk's answer card draws its thread with them (DeskBar's AnswerThread);
 * the sidebar console and the home chat keep their own (parts.tsx).
 *
 * Every collapsible line here follows `open ?? running`: it opens while its
 * work goes on and shuts when it is done, unless the person opened or shut
 * it themselves — their choice wins from then on.
 */

const LINE_STATUS: Record<TraceStepState, TraceStatus | undefined> = {
  running: "running",
  done: undefined,
  paused: undefined,
  failed: "error",
};

/** What a step did, at a glance: the surface it worked, or the action. */
function toolIcon(name: AgentToolCall["name"] | null): LucideIcon {
  if (name === null) return Bot;
  switch (name) {
    case "tabs.list":
      return PanelsTopLeft;
    case "tab.open":
    case "tab.show":
      return AppWindow;
    case "page.navigate":
      return Globe;
    case "page.inspect":
      return ScanText;
    case "page.back":
      return ArrowLeft;
    case "page.forward":
      return ArrowRight;
    case "page.reload":
      return RotateCw;
    case "page.click":
    case "page.submit":
      return MousePointerClick;
    case "page.type":
    case "page.press":
      return Keyboard;
    case "page.scroll":
      return MoveVertical;
    case "page.screenshot":
      return Camera;
    case "credentials.request":
      return KeyRound;
    case "notes.update":
      return ClipboardList;
    default:
      break;
  }
  if (name.startsWith("memory.")) return Brain;
  if (name.startsWith("reminder.")) return Bell;
  if (name.startsWith("artifact.")) return LayoutTemplate;
  if (name.startsWith("watchtower.")) return Archive;
  if (name.startsWith("bookmark.")) return Bookmark;
  if (name.startsWith("note.")) return NotebookPen;
  if (name.startsWith("gmail.")) return Mail;
  if (name.startsWith("google_calendar.")) return Calendar;
  if (name.startsWith("desk.")) return LayoutGrid;
  if (name.startsWith("context.")) return Paperclip;
  return Plug;
}

function Spinner() {
  return <LoaderCircle className="animate-spin motion-reduce:animate-none" />;
}

/**
 * What the model thought before it answered: "Thinking", a clock running
 * beside it, then "Thought" and how long. While it thinks the line is open
 * on the latest of it, the text pinned to its foot in a few lines' window
 * and faded at the top; once done it shuts, and opens on a click to the
 * whole of it, drawn. `live` (LiveReply: the turn still works, its reply
 * not begun) keeps it open on the latest lines through the steps between
 * thoughts, so it shuts once rather than with every step.
 */
export const ReasoningTrace = memo(function ReasoningTrace({
  reasoning,
  thinking,
  live = thinking,
  startedAt = null,
  thinkingMs = null,
}: {
  reasoning: string;
  thinking: boolean;
  live?: boolean;
  startedAt?: string | null;
  thinkingMs?: number | null;
}) {
  const [open, setOpen] = useState<boolean>();
  const elapsed = useElapsedSeconds(thinking ? startedAt : null);
  const took = thinking ? (elapsed === null || elapsed < 1 ? null : `${String(elapsed)}s`) : thinkingSpan(thinkingMs ?? 0);
  const line = (
    <TraceLine status={thinking ? "running" : undefined}>
      <TraceIcon>{thinking ? <Spinner /> : <Sparkles />}</TraceIcon>
      <TraceTitle data-testid="reasoning-label">{thinking ? "Thinking" : "Thought"}</TraceTitle>
      {took === null ? null : <TraceDescription>{took}</TraceDescription>}
    </TraceLine>
  );
  return (
    <Trace data-testid="reasoning-block" data-thinking={thinking ? "" : undefined}>
      {reasoning.trim() === "" ? (
        line
      ) : (
        <TraceCollapsible open={open ?? (thinking || live)} onOpenChange={setOpen}>
          <TraceCollapsibleTrigger data-testid="reasoning-toggle">{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent data-testid="reasoning-text">
            {thinking || live ? <ReasoningTail text={reasoning} /> : <Markdown text={reasoning} density="panel" />}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      )}
    </Trace>
  );
});

/** The live reasoning in a window of a few lines, kept scrolled to its newest; faded at the top once there is more above. */
function ReasoningTail({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (box === null) return;
    box.scrollTop = box.scrollHeight;
    box.toggleAttribute("data-clipped", box.scrollTop > 0);
  }, [text]);
  return (
    <div ref={ref} className="trace-reasoning-tail" aria-hidden="true">
      {text}
    </div>
  );
}

/**
 * What a turn did, as one line that opens to its steps (Chain of Thought):
 * the step in hand, shimmering, while the turn works, then what the turn
 * was and how many steps it took — how many failed, if any did. Each step
 * is a line of its own with its tool's mark; one that finished with
 * something to say opens to it, and the page it read links out; one that
 * failed is red, says so, and opens to its error.
 *
 * `live` is the turn still at work (the run's latest, its reply not yet
 * begun); `awaitingApproval` opens the latest turn on the step held for
 * the person. Memoized on the turn and those facts, not the run, which
 * changes on every publish.
 */
export const TurnTrace = memo(function TurnTrace({ turn, live, latest, awaitingApproval }: { turn: TraceTurn; live: boolean; latest: boolean; awaitingApproval: boolean }) {
  const [open, setOpen] = useState<boolean>();
  const steps = traceSteps(turn);
  const summary = traceSummary(turn, steps, live);
  const running = summary.state === "running";
  // (Its height eased as steps come and it shuts: SmoothHeight.)
  return (
    <SmoothHeight className="mt-3">
    <Trace data-testid="work-trace" data-turn={turn.turn} data-state={summary.state}>
      <TraceCollapsible open={open ?? (running || (latest && awaitingApproval))} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={LINE_STATUS[summary.state]}>
            <TraceIcon>
              {summary.state === "running" ? <Spinner /> : summary.state === "failed" ? <CircleAlert /> : summary.state === "paused" ? <CirclePause className="text-amber-900" /> : <CircleCheck />}
            </TraceIcon>
            <TraceTitle data-testid="trace-label">{summary.title}</TraceTitle>
            <TraceDescription data-testid="trace-count">{summary.description}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted>
          <Trace>
            {steps.map((step) => (
              <StepLine key={step.id} step={step} />
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
    </SmoothHeight>
  );
});

/** Memoized on the step's fields: a publish that did not touch the step leaves the line be. */
const StepLine = memo(
  function StepLine({ step }: { step: TraceStep }) {
    const Icon = toolIcon(step.tool);
    const line = (
      <TraceLine status={LINE_STATUS[step.state]} data-testid="trace-step" data-state={step.state} className="chat-step-in">
        <TraceIcon>{step.state === "running" ? <Spinner /> : <Icon />}</TraceIcon>
        <TraceTitle>{step.title}</TraceTitle>
        {step.state === "paused" ? <TraceDescription>Waiting for you</TraceDescription> : null}
      </TraceLine>
    );
    // Running, or done with nothing to show, it is the line alone: there is nothing to open yet.
    if (step.state === "running" || (step.detail === "" && step.source === null)) return line;
    return (
      <TraceCollapsible>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {step.state === "failed" ? (
            <TraceError error={step.detail === "" ? "It gave no reason." : step.detail} />
          ) : (
            <div className="grid min-w-0 gap-1">
              {step.detail === "" ? null : <p className="text-gray-900 select-text">{step.detail}</p>}
              {step.source === null ? null : <SourceLine source={step.source} />}
            </div>
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  },
  (before, after) =>
    before.step.id === after.step.id &&
    before.step.title === after.step.title &&
    before.step.detail === after.step.detail &&
    before.step.state === after.step.state &&
    before.step.source?.url === after.step.source?.url,
);

/** The page a step read, as a line that opens it — as the reply's own links do: a Glance, or a tab with ⌘. */
function SourceLine({ source }: { source: AgentSource }) {
  const openLink = useAppStore((state) => state.openLink);
  const open = (event: MouseEvent<HTMLAnchorElement>, inNewTab: boolean): void => {
    event.preventDefault();
    const { x, y, width, height } = event.currentTarget.getBoundingClientRect();
    void openLink(source.url, { x, y, width, height }, inNewTab);
  };
  return (
    <a
      href={source.url}
      title={source.url}
      draggable={false}
      data-testid="trace-source"
      onClick={(event) => open(event, event.metaKey || event.ctrlKey)}
      onAuxClick={(event) => {
        if (event.button === 1) open(event, true);
      }}
    >
      <TraceLine>
        <TraceIcon>
          <Globe />
        </TraceIcon>
        <TraceTitle>{source.title === "" ? sourceHost(source.url) : source.title}</TraceTitle>
        <TraceIcon>
          <ArrowUpRight />
        </TraceIcon>
      </TraceLine>
    </a>
  );
}

/** An error as it was thrown: whole, in a monospace box that scrolls past a few lines, with a copy button. */
function TraceError({ error }: { error: string }) {
  return (
    <CodeBlock size="sm" variant="destructive" data-testid="trace-error">
      <CodeBlockActions>
        <CodeBlockCopyButton value={error} />
      </CodeBlockActions>
      <CodeBlockContent wrap className="max-h-40 pe-9">
        {error}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/**
 * Why the run stopped (Stack Trace): the reply's own sentence as a red
 * line, open on the error it stopped on — the line's title truncates, so
 * the error is in full below it. The reply's actions follow it, as they
 * follow any reply (`children`), so the turn can still be retried.
 */
export function FailureTrace({ failure, children }: { failure: RunFailure; children?: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5" data-testid="run-failure">
      <Trace>
        <TraceCollapsible defaultOpen>
          <TraceCollapsibleTrigger>
            <TraceLine status="error">
              <TraceIcon>
                <CircleX />
              </TraceIcon>
              <TraceTitle>{failure.title}</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <TraceError error={failure.error} />
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
      {children}
    </div>
  );
}
