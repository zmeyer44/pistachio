import { useEffect, useState } from "react";
import { ChevronRight, FolderOpen, X } from "lucide-react";
import type { ChromeVerdict, ExtensionSheet, ExtensionSheetLine } from "@pistachio/shell-contracts/extensions";
import { cn } from "../../lib/cn";
import { revealExtensionFolder } from "../../lib/extensions/actions";
import { sheetIsCritical, sheetLines, sourceLine } from "../../lib/extensions/ledge";
import { closeExtensionSheet, extensionsRequest, useExtensionsState, dismissExtensionSheet } from "../../lib/extensions/use-extensions";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ExtensionMark } from "./LedgeIcon";

/** What the sheet is asked about, whichever kind: an extension's pending sheet, or a store install's. */
interface SheetSubject {
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

/**
 * The approval sheet (docs/extensions.md §2, *Approve one*): every install,
 * and every reload that asks for more, is this one sheet. The mark and name;
 * where it came from ("Yours · ~/Pistachio/Extensions/gh-inbox", "Chrome Web
 * Store", "Made by Pistachio"); *Adds*, what it puts in the window; *Can*, at
 * most four lines broadest first — main's fixed phrases per capability, never
 * the extension's own words — a filled dot for a broad reach, Critical ones in
 * red, which ask a second time; *See everything it declares ›*; *Agent can
 * use it* when it declares tools; *Not now* and *Turn it on*, which names the
 * manifest the sheet showed (`manifestHash`). A Chrome extension that won't
 * work here says why in place of the button.
 *
 * A shell overlay (`extension-sheet`): the pages and any panel go under it,
 * so nothing an extension draws can cover it (§6.3). Raised by the store
 * (lib/extensions/use-extensions.ts) — a store install's by itself, any
 * other by the person (an amber icon, a row, a notice's *Review*).
 */
/** *Agent can use it* as the sheet opens: on for a first approval of an extension with tools; after that, as the person left it. */
export function agentDefault(subject: { first: boolean; tools: boolean; agentAllowed: boolean }): boolean {
  return subject.first ? subject.tools : subject.agentAllowed;
}

export function ApprovalSheet() {
  const subject = useSheetSubject();
  const [agent, setAgent] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = subject?.key ?? "";
  useEffect(() => {
    setAgent(subject === null ? true : agentDefault(subject));
    setExpanded(false);
    setConfirming(false);
    setBusy(false);
    // (A new subject, a new sheet: what was chosen on the last one is not this one's.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // ⎋ puts it down without an answer (an install's is answered: *Not now*), and never the page under it too.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      dismissExtensionSheet();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, subject]);

  // Its subject gone (approved elsewhere, removed), the overlay goes with it: never a veil with nothing on it.
  const gone = subject === null;
  useEffect(() => {
    if (gone) closeExtensionSheet();
  }, [gone]);

  if (subject === null) return null;
  const { shown, more } = sheetLines(subject.sheet);
  const critical = sheetIsCritical(subject.sheet);
  const wont = subject.verdict?.kind === "wont" ? subject.verdict : null;
  const partly = subject.verdict?.kind === "partly" ? subject.verdict : null;
  const hidden: ExtensionSheetLine[] = more > 0 ? sheetLines(subject.sheet, Number.POSITIVE_INFINITY).shown.slice(shown.length) : [];

  const turnOn = async (): Promise<void> => {
    if (busy) return;
    if (critical && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    const ok = await subject.approve(subject.tools && agent);
    setBusy(false);
    if (ok) closeExtensionSheet();
  };

  return (
    <div className="animate-backdrop-in absolute inset-0 z-30 grid place-items-center rounded-md bg-[oklch(0_0_0/0.36)] p-5" data-testid="extension-sheet-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-sheet-title"
        data-testid="extension-sheet"
        data-subject={subject.key}
        className="w-full max-w-[460px] overflow-hidden rounded-lg bg-background-100 shadow-[0_24px_80px_oklch(0_0_0/0.28),0_0_0_1px_var(--color-alpha-400)]"
      >
        <header className="flex items-start gap-3 px-5 pt-5 pb-1">
          <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-alpha-100">
            <ExtensionMark extension={subject.mark} className="extension-sheet-mark" />
          </span>
          <span className="min-w-0 flex-1">
            <h1 id="extension-sheet-title" className="truncate text-heading-16 text-gray-1000" data-testid="extension-sheet-name">
              {subject.name}
            </h1>
            <span className="mt-0.5 flex items-center gap-1.5 text-label-12 text-gray-900">
              <span className="truncate" data-testid="extension-sheet-source">
                {subject.source}
              </span>
              {subject.revealId === null ? null : (
                <button
                  type="button"
                  className="flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1 text-gray-800 hover:bg-alpha-100 hover:text-gray-1000"
                  onClick={() => revealExtensionFolder(subject.revealId ?? "")}
                >
                  <FolderOpen className="size-3" aria-hidden="true" />
                  Show
                </button>
              )}
            </span>
          </span>
          <Button variant="tertiary" size="xs" svgOnly aria-label="Close" disabled={busy} onClick={dismissExtensionSheet}>
            <X aria-hidden="true" />
          </Button>
        </header>

        <div className="max-h-[min(560px,calc(100vh-180px))] space-y-4 overflow-y-auto px-5 pt-4 pb-5">
          {subject.sheet.changedByAgent === true ? (
            // The agent wrote to it after it was approved (docs/extensions.md §6.2): it waits until the person looks again.
            <p className="rounded-md bg-amber-100 px-3 py-2 text-copy-13 text-amber-1000" data-testid="extension-sheet-changed">
              Pistachio changed it. It stays paused until you turn it on again.
            </p>
          ) : null}
          {subject.sheet.adds.length === 0 ? null : (
            <section>
              <h2 className="text-label-12 font-medium text-gray-700">Adds</h2>
              <p className="mt-1 text-copy-14 text-gray-1000" data-testid="extension-sheet-adds">
                {subject.sheet.adds.join(" · ")}
              </p>
            </section>
          )}
          <section>
            <h2 className="text-label-12 font-medium text-gray-700">Can</h2>
            {shown.length === 0 ? (
              <p className="mt-1 text-copy-14 text-gray-900">Nothing beyond what it adds.</p>
            ) : (
              <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="extension-sheet-can">
                {shown.map((line, index) => (
                  <SheetLine key={index} line={line} />
                ))}
              </ul>
            )}
            {more > 0 || subject.sheet.declares.length > 0 ? (
              <button
                type="button"
                aria-expanded={expanded}
                data-testid="extension-sheet-declares-toggle"
                className="mt-2 ml-5 flex cursor-pointer items-center gap-0.5 text-label-13 text-gray-800 hover:text-gray-1000"
                onClick={() => setExpanded((value) => !value)}
              >
                See everything it declares
                <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} aria-hidden="true" />
              </button>
            ) : null}
            {expanded ? (
              <div className="mt-2 ml-5 space-y-1.5" data-testid="extension-sheet-declares">
                {hidden.length === 0 ? null : (
                  <ul className="flex flex-col gap-1.5">
                    {hidden.map((line, index) => (
                      <SheetLine key={index} line={line} />
                    ))}
                  </ul>
                )}
                <ul className="flex flex-col gap-0.5 font-mono text-[11.5px] leading-4 text-gray-900">
                  {subject.sheet.declares.map((line, index) => (
                    <li key={index} className="break-all">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
          {partly === null ? null : (
            <section className="rounded-md bg-amber-100 px-3 py-2 text-copy-13 text-amber-1000" data-testid="extension-sheet-partly">
              <p className="font-medium">Works in part here</p>
              <ul className="mt-1 list-disc pl-4">
                {partly.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </section>
          )}
          {subject.tools ? (
            <label className="flex items-center justify-between gap-4 rounded-md bg-alpha-100 px-3 py-2.5">
              <span>
                <span className="block text-label-14 text-gray-1000">Agent can use it</span>
                <span className="block text-copy-13 text-gray-900">Pistachio may call its tools while it works for you.</span>
              </span>
              <Switch checked={agent} onChange={setAgent} label="Agent can use it" disabled={busy || wont !== null} />
            </label>
          ) : null}
          {confirming ? (
            <p role="alert" className="rounded-md bg-red-100 px-3 py-2 text-copy-13 text-red-900" data-testid="extension-sheet-critical">
              It can do things Pistachio can’t limit. Turn it on only if you trust where it came from.
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-alpha-400 bg-background-200 px-5 py-3">
          {wont !== null ? (
            <p className="mr-auto min-w-0 text-copy-13 text-gray-900" data-testid="extension-sheet-wont">
              <span className="font-medium text-gray-1000">Won’t work in Pistachio.</span> {wont.reason}
              {wont.alternative === undefined ? null : ` ${wont.alternative}`}
            </p>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            data-testid="extension-sheet-not-now"
            onClick={() => {
              subject.deny();
              closeExtensionSheet();
            }}
          >
            Not now
          </Button>
          {wont !== null ? null : (
            <Button
              variant={confirming ? "error" : "default"}
              size="sm"
              loading={busy}
              disabled={busy}
              data-testid="extension-sheet-turn-on"
              onClick={() => void turnOn()}
            >
              {confirming ? "Turn it on anyway" : "Turn it on"}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}

/** One *Can* line: its tier's dot, a filled one for a broad reach, Critical in red. */
function SheetLine({ line }: { line: ExtensionSheetLine }) {
  return (
    <li className={cn("flex items-start gap-2.5 text-copy-14", line.tier === "critical" ? "text-red-900" : "text-gray-1000")} data-tier={line.tier}>
      <span
        aria-hidden="true"
        className={cn(
          "mt-[7px] size-2 shrink-0 rounded-full",
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

/** The sheet's subject from the store, as one shape whatever its kind; null when there is none (or it is gone). */
function useSheetSubject(): SheetSubject | null {
  const sheet = useExtensionsState((state) => state.sheet);
  const extensions = useExtensionsState((state) => state.snapshot.extensions);
  const install = useExtensionsState((state) => state.snapshot.pendingInstall);
  if (sheet === null) return null;
  if (sheet.kind === "install") {
    if (install === null || install.cwsId !== sheet.cwsId) return null;
    const pending = install;
    return {
      key: `install:${pending.cwsId}`,
      mark: { id: pending.cwsId, name: pending.name, iconUrl: pending.iconUrl },
      name: pending.name,
      source: "Chrome Web Store",
      sheet: pending.sheet,
      verdict: pending.verdict,
      tools: false,
      agentAllowed: false,
      first: true,
      revealId: null,
      approve: async () => (await extensionsRequest({ type: "approveInstall", cwsId: pending.cwsId, manifestHash: pending.sheet.manifestHash })) !== null,
      deny: () => void extensionsRequest({ type: "denyInstall", cwsId: pending.cwsId }, { quiet: true }),
    };
  }
  const extension = extensions.find((candidate) => candidate.id === sheet.id) ?? null;
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
