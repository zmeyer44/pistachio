import { memo } from "react";
import { ArrowUpRight, ChevronDown, FileText, PanelsTopLeft, Puzzle } from "lucide-react";
import type { ExtensionInfo } from "@pistachio/shell-contracts/extensions";
import { openExtensionsPage } from "../lib/extensions/actions";
import { sheetLines } from "../lib/extensions/ledge";
import { RUNS_HEADING, RUNS_LIMIT } from "../lib/extensions/triggers";
import { openExtensionSheet, putOffExtension, reviewExtension, useExtension, useExtensionsState } from "../lib/extensions/use-extensions";
import { useAppStore } from "../store";
import type { ThreadOutput } from "./chat/use-thread-layout";
import { SheetLine, extensionSubject, useApproval, type SheetSubject } from "./extensions/approval";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";

const KIND_LABEL: Record<ThreadOutput["kind"], string> = {
  note: "Note",
  artifact: "Page",
  extension: "Extension",
};

const KIND_ICON: Record<ThreadOutput["kind"], typeof FileText> = {
  note: FileText,
  artifact: PanelsTopLeft,
  extension: Puzzle,
};

const WAITING = "Waiting for you to turn it on";

/**
 * What a turn made, as a card under the reply that finished it: the note the
 * agent wrote, the page it built. The whole card is one button — the trace
 * above already says how it was made; this is the way to look at it. A note
 * opens as its own tab (the notes page); a page opens at its web address.
 *
 * An extension the agent built (docs/agent-pistachio.md §4) waits on the
 * person, and its card is where they answer: the approval itself, in the
 * sheet's compact form (`ExtensionApproval`) — what it may do, *Not now* and
 * *Turn it on* — with no sheet to open first. Once it waits on nothing the
 * card is a button again, to the extensions page.
 */
export const OutputCards = memo(function OutputCards({ outputs }: { outputs: readonly ThreadOutput[] }) {
  if (outputs.length === 0) return null;
  return (
    <div className="grid min-w-0 gap-2" data-testid="output-cards">
      {outputs.map((output) => (
        <OutputCard key={`${output.kind}:${output.id}`} output={output} />
      ))}
    </div>
  );
});

/**
 * Where an extension's card stands, pure: `asks` — the approval is drawn in
 * it; `folded` — the person answered *Not now* there, and *Review* asks
 * again; `sheet` — it waits, but this is not the card to answer in (a later
 * turn of the thread changed the extension and carries the approval, or it is
 * a Chrome extension, whose verdict the sheet explains), so *Review* opens
 * the sheet; `open` — nothing to answer.
 */
export type ExtensionCardStanding = "asks" | "folded" | "sheet" | "open";

export function extensionCardStanding(
  output: { earlier?: true },
  extension: Pick<ExtensionInfo, "id" | "kind" | "pending"> | null,
  notNow: Readonly<Record<string, string>>,
): ExtensionCardStanding {
  if (extension === null || extension.pending === null) return "open";
  if (output.earlier === true || extension.kind !== "pistachio") return "sheet";
  return notNow[extension.id] === extension.pending.manifestHash ? "folded" : "asks";
}

function OutputCard({ output }: { output: ThreadOutput }) {
  const openNotes = useAppStore((state) => state.openNotes);
  const openLink = useAppStore((state) => state.openLink);
  // An extension's card says where it stands NOW, not when it was built: turned on since, it no longer waits.
  const extension = useExtension(output.kind === "extension" ? output.id : null);
  const notNow = useExtensionsState((state) => state.notNow);
  const standing = output.kind === "extension" ? extensionCardStanding(output, extension, notNow) : "open";
  const subject = standing === "asks" ? extensionSubject(extension) : null;
  if (subject !== null && extension !== null) return <ExtensionApproval title={output.title} extension={extension} subject={subject} />;

  // (No snapshot of it — the web, a window that has not heard from main yet — and the card says what the build said.)
  const waiting = output.kind === "extension" && (extension === null ? output.waiting : extension.pending !== null);
  const Icon = KIND_ICON[output.kind];
  const open = (target: HTMLElement): void => {
    if (output.kind === "note") {
      openNotes(output.id);
      return;
    }
    if (output.kind === "extension") {
      if (standing === "folded") reviewExtension(output.id);
      else if (standing === "sheet") openExtensionSheet({ kind: "extension", id: output.id });
      else openExtensionsPage();
      return;
    }
    const { x, y, width, height } = target.getBoundingClientRect();
    void openLink(output.url, { x, y, width, height }, true);
  };
  const state =
    output.kind !== "extension"
      ? output.action === "created" ? "Created" : "Updated"
      : waiting
        ? WAITING
        : extension !== null && (extension.status === "idle" || extension.status === "running")
          ? "On"
          : output.action === "created" ? "Created" : "Updated";
  const Go = standing === "folded" ? ChevronDown : ArrowUpRight;
  return (
    <button
      type="button"
      data-testid="output-card"
      data-kind={output.kind}
      data-waiting={waiting ? "" : undefined}
      title={output.kind === "artifact" ? output.url : undefined}
      aria-expanded={standing === "folded" ? false : undefined}
      onClick={(event) => open(event.currentTarget)}
      className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-lg bg-background-100 p-2 pr-3 text-left shadow-border transition-[background-color,box-shadow] duration-150 outline-none hover:bg-background-200 hover:shadow-small focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-md bg-background-200 text-gray-900 shadow-border group-hover:bg-background-100">
        <Icon className="size-4.5" aria-hidden="true" />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-label-14 font-medium text-gray-1000">{output.title}</span>
        <span className="truncate text-label-12 text-gray-700">
          {KIND_LABEL[output.kind]} · {state}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-label-12 font-medium text-gray-700 transition-colors group-hover:text-gray-1000">
        {waiting ? "Review" : "Open"}
        <Go className="size-3.5" aria-hidden="true" />
      </span>
    </button>
  );
}

/**
 * The approval, asked where the conversation that built the extension left
 * it (docs/extensions.md §8: the sheet's compact form). The same lines the
 * sheet shows, in main's words and never the agent's — what it adds, when it
 * runs by itself, what it can do (at most four, broadest first; a Critical
 * one asks a second time) — then *Not now* and *Turn it on*, which names the
 * manifest those lines describe. *See everything it declares* opens the
 * sheet, which has the rest: every declared line, where the folder is.
 *
 * It is the shell's own, drawn in the conversation: nothing of the extension
 * runs yet, so nothing of it can stand over the buttons.
 */
function ExtensionApproval({ title, extension, subject }: { title: string; extension: ExtensionInfo; subject: SheetSubject }) {
  const { agent, setAgent, confirming, busy, turnOn } = useApproval(subject);
  const sheet = subject.sheet;
  const { shown, more } = sheetLines(sheet);
  const runs = sheet.runs ?? [];
  // Still being written (a later turn is changing it): main would refuse, so the button waits with it.
  const writing = extension.drafting === true;
  return (
    <section
      data-testid="output-card"
      data-kind="extension"
      data-waiting=""
      data-asking=""
      aria-label={`${title}: ${WAITING.toLowerCase()}`}
      className="min-w-0 overflow-hidden rounded-lg bg-background-100 text-left shadow-border"
    >
      <div className="flex min-w-0 items-center gap-3 p-2 pr-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-background-200 text-gray-900 shadow-border">
          <Puzzle className="size-4.5" aria-hidden="true" />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-label-14 font-medium text-gray-1000">{title}</span>
          <span className="truncate text-label-12 text-gray-700">
            {KIND_LABEL.extension} · {WAITING}
          </span>
        </span>
      </div>

      <div className="grid min-w-0 gap-2.5 border-t border-alpha-400 px-3 py-2.5 select-text" data-testid="output-card-sheet">
        {sheet.changedByAgent === true ? (
          <p className="rounded-md bg-amber-100 px-2.5 py-1.5 text-copy-13 text-amber-1000" data-testid="output-card-changed">
            Pistachio changed it. It stays paused until you turn it on again.
          </p>
        ) : null}
        {sheet.adds.length === 0 ? null : (
          <div className="min-w-0">
            <p className="text-label-12 font-medium text-gray-700">Adds</p>
            <p className="mt-0.5 text-copy-13 wrap-anywhere text-gray-1000">{sheet.adds.join(" · ")}</p>
          </div>
        )}
        {runs.length === 0 ? null : (
          <div className="min-w-0">
            <p className="text-label-12 font-medium text-gray-700">{RUNS_HEADING}</p>
            <ul className="mt-0.5 grid gap-0.5">
              {runs.map((line, index) => (
                <li key={index} className="text-copy-13 wrap-anywhere text-gray-1000">
                  {line}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-label-12 wrap-anywhere text-gray-900">{sheet.runsLimit ?? RUNS_LIMIT}</p>
          </div>
        )}
        <div className="min-w-0">
          <p className="text-label-12 font-medium text-gray-700">Can</p>
          {shown.length === 0 ? (
            <p className="mt-0.5 text-copy-13 text-gray-900">Nothing beyond what it adds.</p>
          ) : (
            <ul className="mt-1 grid gap-1 wrap-anywhere" data-testid="output-card-can">
              {shown.map((line, index) => (
                <SheetLine key={index} line={line} dense />
              ))}
            </ul>
          )}
          {more > 0 || sheet.declares.length > 0 ? (
            <button
              type="button"
              data-testid="output-card-declares"
              className="mt-1.5 flex cursor-pointer items-center gap-0.5 rounded-sm text-label-12 text-gray-800 outline-none select-none hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => openExtensionSheet({ kind: "extension", id: extension.id })}
            >
              {more > 0 ? `${String(more)} more: see everything it declares` : "See everything it declares"}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {subject.tools ? (
          <label className="flex items-center justify-between gap-3 rounded-md bg-alpha-100 px-2.5 py-2 select-none">
            <span className="min-w-0">
              <span className="block text-label-13 text-gray-1000">Agent can use it</span>
              <span className="block text-label-12 text-gray-900">Pistachio may call its tools while it works for you.</span>
            </span>
            <Switch checked={agent} onChange={setAgent} label="Agent can use it" disabled={busy} />
          </label>
        ) : null}
        {confirming ? (
          <p role="alert" className="rounded-md bg-red-100 px-2.5 py-1.5 text-copy-13 text-red-900" data-testid="output-card-critical">
            It can do things Pistachio can’t limit. Turn it on only if you trust where it came from.
          </p>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center justify-end gap-2 border-t border-alpha-400 bg-background-200 px-3 py-2">
        {writing ? <span className="mr-auto min-w-0 truncate text-label-12 text-gray-700">Pistachio is still writing it…</span> : null}
        <Button variant="secondary" size="sm" disabled={busy} data-testid="output-card-not-now" onClick={() => putOffExtension(extension.id)}>
          Not now
        </Button>
        <Button variant={confirming ? "error" : "default"} size="sm" loading={busy} disabled={busy || writing} data-testid="output-card-turn-on" onClick={() => void turnOn()}>
          {confirming ? "Turn it on anyway" : "Turn it on"}
        </Button>
      </div>
    </section>
  );
}
