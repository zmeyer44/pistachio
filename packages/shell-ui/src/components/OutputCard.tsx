import { memo } from "react";
import { ArrowUpRight, FileText, PanelsTopLeft } from "lucide-react";
import type { AgentToolOutput } from "@pistachio/protocol";
import { useAppStore } from "../store";

const KIND_LABEL: Record<AgentToolOutput["kind"], string> = {
  note: "Note",
  artifact: "Page",
};

const KIND_ICON: Record<AgentToolOutput["kind"], typeof FileText> = {
  note: FileText,
  artifact: PanelsTopLeft,
};

/**
 * What a turn made, as a card under the reply that finished it: the note the
 * agent wrote, the page it built. The whole card is one button — the trace
 * above already says how it was made; this is the way to look at it. A note
 * opens as its own tab (the notes page); a page opens at its web address.
 */
export const OutputCards = memo(function OutputCards({ outputs }: { outputs: readonly AgentToolOutput[] }) {
  if (outputs.length === 0) return null;
  return (
    <div className="grid min-w-0 gap-2" data-testid="output-cards">
      {outputs.map((output) => (
        <OutputCard key={`${output.kind}:${output.id}`} output={output} />
      ))}
    </div>
  );
});

function OutputCard({ output }: { output: AgentToolOutput }) {
  const openNotes = useAppStore((state) => state.openNotes);
  const openLink = useAppStore((state) => state.openLink);
  const Icon = KIND_ICON[output.kind];
  const open = (target: HTMLElement): void => {
    if (output.kind === "note") {
      openNotes(output.id);
      return;
    }
    const { x, y, width, height } = target.getBoundingClientRect();
    void openLink(output.url, { x, y, width, height }, true);
  };
  return (
    <button
      type="button"
      data-testid="output-card"
      data-kind={output.kind}
      title={output.kind === "artifact" ? output.url : undefined}
      onClick={(event) => open(event.currentTarget)}
      className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-lg bg-background-100 p-2 pr-3 text-left shadow-border transition-[background-color,box-shadow] duration-150 outline-none hover:bg-background-200 hover:shadow-small focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-md bg-background-200 text-gray-900 shadow-border group-hover:bg-background-100">
        <Icon className="size-4.5" aria-hidden="true" />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-label-14 font-medium text-gray-1000">{output.title}</span>
        <span className="truncate text-label-12 text-gray-700">
          {KIND_LABEL[output.kind]} · {output.action === "created" ? "Created" : "Updated"}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-label-12 font-medium text-gray-700 transition-colors group-hover:text-gray-1000">
        Open
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
      </span>
    </button>
  );
}
