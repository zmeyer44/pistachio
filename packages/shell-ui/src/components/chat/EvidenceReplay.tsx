import { X } from "lucide-react";
import type { EvidenceEntry } from "@pistachio/evidence";
import { useAppStore } from "../../store";
import { Button } from "../ui/button";
import { formatTime } from "./parts";

/**
 * The activity record of a conversation, replayed: the signed timeline of
 * its messages, browser actions, decisions and control changes (⌘E; the
 * store's `evidence`). Drawn where the conversation is — in the desk's
 * answer card on the desktop (DeskBar), in the console where there is no
 * desk (AgentConsole) — in its place until closed.
 */
export function EvidenceReplay({
  entries,
  onClose,
}: {
  entries: EvidenceEntry[];
  onClose(): void;
}) {
  const showPayloads = useAppStore(
    (state) => state.settings.evidence.showPayloads,
  );
  return (
    <div
      data-testid="evidence-replay"
      className="scroll-thin min-h-0 overflow-y-auto px-4 py-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="text-label-12 font-medium text-gray-700">
            Activity record
          </span>
          <h2 className="mt-1 text-heading-20 text-gray-1000">
            Conversation replay
          </h2>
        </div>
        <Button
          variant="tertiary"
          size="sm"
          svgOnly
          aria-label="Close replay"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <p className="mt-2 mb-4 text-copy-13 text-gray-900">
        A signed timeline of the messages, browser actions, decisions, and
        control changes in this task.
      </p>
      <ol className="grid">
        {entries.map((entry, index) => (
          <li
            key={entry.id}
            className="relative grid grid-cols-[24px_1fr] gap-2.5 py-2.5"
          >
            {index < entries.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute top-8 -bottom-2 left-3 w-px bg-alpha-400"
              />
            ) : null}
            <span className="relative z-1 grid size-6 place-items-center rounded-full bg-background-100 font-mono text-[10px] font-medium tabular-nums text-gray-900 shadow-border">
              {String(entry.sequence).padStart(2, "0")}
            </span>
            <div className="min-w-0">
              <strong className="block text-label-12 font-medium text-gray-1000">
                {entry.type}
              </strong>
              <small className="font-mono text-[10px] text-gray-700">
                {formatTime(entry.at)} · {entry.hash.slice(0, 10)}…
              </small>
              {showPayloads ? (
                <pre className="scroll-thin mt-1.5 max-h-24 overflow-auto rounded-sm bg-background-200 p-2 font-mono text-[10px] leading-4 whitespace-pre-wrap text-gray-900 shadow-border">
                  {JSON.stringify(entry.payload, null, 2)}
                </pre>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

