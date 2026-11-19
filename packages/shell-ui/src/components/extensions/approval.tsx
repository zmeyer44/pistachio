import { useEffect, useState } from "react";
import type { ChromeVerdict, ExtensionInfo, ExtensionSheet, ExtensionSheetLine } from "@pistachio/shell-contracts/extensions";
import { cn } from "../../lib/cn";
import { sheetIsCritical, sourceLine } from "../../lib/extensions/ledge";
import { extensionsRequest } from "../../lib/extensions/use-extensions";

/**
 * An approval, wherever it is asked (docs/extensions.md §2, *Approve one*):
 * the sheet over the window (ApprovalSheet.tsx) and the card under the reply
 * of the conversation that built the extension (OutputCard.tsx) ask the same
 * question about the same subject and answer it the same way — the second
 * confirm of a Critical line, *Agent can use it*, the manifest named in the
 * request. What differs is only how much of the sheet each draws.
 */

/** What an approval is asked about, whichever kind: an extension's pending sheet, or a store install's. */
export interface SheetSubject {
  key: string;
  mark: { id: string; name: string; iconUrl: string | null };
  name: string;
  source: string;
  sheet: ExtensionSheet;
  verdict: ChromeVerdict | null;
  /** Declares tools: the *Agent can use it* switch is offered. */
  tools: boolean;
  agentAllowed: boolean;
  /** Its first approval (an install, a folder never turned on): the agent's access takes its default; later ones keep the person's choice. */
  first: boolean;
  /** One of the person's own folders: its id, for *Show* (`revealFolder`). */
  revealId: string | null;
  approve(agentAllowed: boolean): Promise<boolean>;
  deny(): void;
}

/** *Agent can use it* as the approval is first shown: on for a first approval of an extension with tools; after that, as the person left it. */
export function agentDefault(subject: { first: boolean; tools: boolean; agentAllowed: boolean }): boolean {
  return subject.first ? subject.tools : subject.agentAllowed;
}

/** An extension waiting on the person, as an approval's subject; null when it waits on nothing (or is not there). */
export function extensionSubject(extension: ExtensionInfo | null): SheetSubject | null {
  if (extension === null || extension.pending === null) return null;
  const pending = extension.pending;
  return {
    key: `extension:${extension.id}:${pending.manifestHash}`,
    mark: extension,
    name: extension.name,
    source: sourceLine(extension.source),
    sheet: pending,
    verdict: extension.verdict,
    tools: extension.tools.length > 0,
    agentAllowed: extension.agentAllowed,
    first: extension.status === "needs-approval",
    revealId: extension.source.type === "dev" || extension.source.type === "unpacked" ? extension.id : null,
    approve: async (agentAllowed) =>
      (await extensionsRequest({ type: "approve", id: extension.id, manifestHash: pending.manifestHash, ...(extension.tools.length > 0 ? { agentAllowed } : {}) })) !== null,
    deny: () => void extensionsRequest({ type: "deny", id: extension.id }, { quiet: true }),
  };
}

/** The person's answer to one subject, as far as it has got. */
export interface Approval {
  /** *Agent can use it*, as the person has it now. */
  agent: boolean;
  setAgent(value: boolean): void;
  /** A Critical line was asked about once: the next *Turn it on* is the answer. */
  confirming: boolean;
  /** The request is with main. */
  busy: boolean;
  /** *Turn it on*. Answers whether it is on: false for a Critical one's first press, and for a refusal (said in a notice). */
  turnOn(): Promise<boolean>;
}

/**
 * The state of one approval. A new subject — another extension, the same one
 * with another manifest — starts again: what was chosen for the last is not
 * this one's.
 */
export function useApproval(subject: SheetSubject | null): Approval {
  const [agent, setAgent] = useState(() => (subject === null ? true : agentDefault(subject)));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = subject?.key ?? "";
  useEffect(() => {
    setAgent(subject === null ? true : agentDefault(subject));
    setConfirming(false);
    setBusy(false);
    // (Keyed on the subject, not on its object: a snapshot that changed nothing of it keeps the person's choices.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const turnOn = async (): Promise<boolean> => {
    if (subject === null || busy) return false;
    if (sheetIsCritical(subject.sheet) && !confirming) {
      setConfirming(true);
      return false;
    }
    setBusy(true);
    const ok = await subject.approve(subject.tools && agent);
    setBusy(false);
    return ok;
  };
  return { agent, setAgent, confirming, busy, turnOn };
}

/** One *Can* line: its tier's dot, a filled one for a broad reach, Critical in red. `dense` is the card's size. */
export function SheetLine({ line, dense = false }: { line: ExtensionSheetLine; dense?: boolean }) {
  return (
    <li className={cn("flex items-start", dense ? "gap-2 text-copy-13" : "gap-2.5 text-copy-14", line.tier === "critical" ? "text-red-900" : "text-gray-1000")} data-tier={line.tier}>
      <span
        aria-hidden="true"
        className={cn(
          "shrink-0 rounded-full",
          dense ? "mt-[6px] size-1.5" : "mt-[7px] size-2",
          line.tier === "low" && "shadow-[inset_0_0_0_1.5px_var(--color-gray-600)]",
          line.tier === "medium" && "bg-gray-700",
          line.tier === "high" && "bg-amber-700",
          line.tier === "critical" && "bg-red-700",
        )}
      />
      <span className="min-w-0">{line.text}</span>
    </li>
  );
}
