import { memo } from "react";
import type { RunSummary } from "@pistachio/protocol";
import { cn } from "../../lib/cn";
import type { CitedSource } from "../../lib/chat-sources";
import { workingText } from "../../lib/run";
import { holdUnfinished } from "../../lib/markdown";
import { Markdown } from "./Markdown";
import type { ChatDensity } from "./parts";
import { ReasoningBlock } from "./ReasoningBlock";
import { ThinkingStatus } from "./ThinkingStatus";
import { useSmoothText } from "./use-smooth-text";

/**
 * The reply that is being written: everything the thread shows for a turn
 * between the person's message and the assistant's finished one. What the
 * model is thinking, as it thinks it (ReasoningBlock); then the words as
 * they land, paced smoothly (use-smooth-text) with each new word resolving
 * into place; and until there are words, one line saying what the agent
 * is doing instead — thinking, searching, working a page.
 *
 * Read from the run alone: `draft` is the stream (RunSummary.draft), the
 * tool calls say what is running. Shared by the console and the home
 * page's chat, at their own densities.
 */
export const LiveReply = memo(function LiveReply({
  run,
  sources = NO_SOURCES,
  density = "panel",
  links = "glance",
  trailing = null,
  className,
}: {
  run: RunSummary;
  /** The pages this turn has read so far: a citation in the streaming text resolves against them. */
  sources?: readonly CitedSource[];
  density?: ChatDensity;
  links?: "glance" | "tab";
  /** Drawn at the end of the status line — the console's context meter. */
  trailing?: React.ReactNode;
  className?: string;
}) {
  const draft = run.draft ?? null;
  const reasoning = draft?.reasoning ?? "";
  const target = draft?.text ?? "";
  const { text: revealed } = useSmoothText(target, true);
  const text = holdUnfinished(revealed);
  const thinking = draft?.thinking === true;
  const reasoningShown = reasoning.trim() !== "";
  const status = thinking ? "Thinking…" : workingText(run);
  return (
    <div data-testid="live-reply" className={cn("grid min-w-0 text-gray-1000", density === "page" ? "gap-2.5" : "gap-1.5", className)}>
      {reasoningShown ? (
        <ReasoningBlock reasoning={reasoning} thinking={thinking} startedAt={draft?.thinkingSince ?? null} thinkingMs={draft?.thinkingMs ?? null} density={density} />
      ) : null}
      {/* While the reasoning ticker is live it already says "Thinking"; the status line waits for the work. */}
      {text === "" && reasoningShown && thinking ? (
        trailing === null ? null : <div className="flex items-center text-copy-13">{trailing}</div>
      ) : text === "" ? (
        <div className={cn("flex items-center gap-2", density === "page" ? "text-[15px]" : "text-copy-13")}>
          <span className="agent-thinking-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <ThinkingStatus text={status} />
          {trailing}
        </div>
      ) : (
        <Markdown text={text} streaming sources={sources} links={links} density={density} />
      )}
    </div>
  );
});

const NO_SOURCES: readonly CitedSource[] = [];
