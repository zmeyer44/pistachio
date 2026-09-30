import { useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { FileImage, FileSpreadsheet, FileText, CalendarDays, FileJson, Lightbulb, Link2, Plus, Quote, Sparkles, X, Import } from "lucide-react";
import type { GroupContextItem, GroupContextResult, GroupContextView } from "@pistachio/shell-contracts/desk-agent";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { nativeApi } from "../../api";
import { addContextFiles, droppedText, fileSize } from "../../lib/desk/group-context";
import { cn } from "../../lib/cn";
import { displayHost } from "../../lib/url";
import { DOCK_W } from "./desk-engine";

/** The Stack's card beside the dock: its width, and the gap between them (the dock's popovers'). */
const CARD_W = 312;
const CARD_GAP = 12;
/** How long the Stack bounces on taking something in. */
const RECEIVED_MS = 520;

type Item = GroupContextView["items"][number];

function carriesSomething(event: ReactDragEvent): boolean {
  const types = [...event.dataTransfer.types];
  return types.includes("Files") || types.includes("text/uri-list") || types.includes("text/plain");
}

/** Take what was dropped on the Stack into the group's context: files, or a link or text dragged out of a page. */
async function takeDrop(group: TabGroupInfo, data: DataTransfer): Promise<GroupContextResult> {
  const files = [...data.files];
  if (files.length > 0) return addContextFiles(group.id, group.title, files);
  const text = droppedText(data);
  if (text === null) return { rejected: [] };
  await nativeApi()?.groupContext({
    type: "addText",
    groupId: group.id,
    title: group.title,
    kind: text.kind,
    text: text.text,
    ...(text.url === undefined ? {} : { url: text.url }),
  });
  return { rejected: [] };
}

function rejectionLine(result: GroupContextResult): string | null {
  if (result.rejected.length === 0) return null;
  return result.rejected.map((entry) => `${entry.name}: ${entry.reason}`).join(" · ");
}

/**
 * The group's context in the dock (docs/desk-agent.md §1, "The Stack"): a
 * stack of cards between the tabs and the other groups, with a count. Files
 * dropped on it (and text or links dragged out of a page) go into the
 * context; a click opens its card beside the dock. It bounces when
 * something comes in — the agent saving a fact, a file dropped.
 */
export function StackTile({
  group,
  context,
  open,
  onToggle,
  onRejected,
}: {
  group: TabGroupInfo;
  context: GroupContextView | null;
  open: boolean;
  onToggle: (el: HTMLElement) => void;
  onRejected: (line: string | null) => void;
}) {
  const count = context?.items.length ?? 0;
  const tileRef = useRef<HTMLSpanElement>(null);
  const [dropping, setDropping] = useState(false);
  const depth = useRef(0);
  const before = useRef(count);
  useEffect(() => {
    const grew = count > before.current;
    before.current = count;
    const el = tileRef.current;
    if (!grew || el === null) return;
    delete el.dataset["received"];
    void el.offsetWidth;
    el.dataset["received"] = "";
    const timer = window.setTimeout(() => delete el.dataset["received"], RECEIVED_MS);
    return () => window.clearTimeout(timer);
  }, [count]);
  const label = count === 0 ? "Context: drop files here" : `Context: ${String(count)} ${count === 1 ? "thing" : "things"}`;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-expanded={open}
      title={label}
      data-testid="desk-stack"
      data-count={count}
      data-open={open ? "" : undefined}
      data-dropping={dropping ? "" : undefined}
      className="desk-dock-item desk-stack-item"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => onToggle(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onToggle(event.currentTarget);
      }}
      onDragEnter={(event) => {
        if (!carriesSomething(event)) return;
        event.preventDefault();
        depth.current += 1;
        setDropping(true);
      }}
      onDragOver={(event) => {
        if (!carriesSomething(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDropping(false);
      }}
      onDrop={(event) => {
        if (!carriesSomething(event)) return;
        event.preventDefault();
        depth.current = 0;
        setDropping(false);
        void takeDrop(group, event.dataTransfer).then((result) => onRejected(rejectionLine(result)), () => onRejected("That could not be added"));
      }}
    >
      <span ref={tileRef} className="desk-stack-tile" aria-hidden="true">
        <span className="desk-stack-card" data-layer="3" />
        <span className="desk-stack-card" data-layer="2" />
        <span className="desk-stack-card" data-layer="1">
          {count === 0 ? <Plus /> : null}
        </span>
        {count === 0 ? null : <span className="desk-stack-count">{count}</span>}
      </span>
    </div>
  );
}

/**
 * The Stack's card, beside the dock: the files as tiles (a click opens one
 * in its own app), the facts and snippets as lines, a field to add a fact,
 * Add files…, and × on each. What the agent saved says so. Contexts of
 * groups that are not here (another Mac's, synced) can be brought in.
 */
export function StackCard({
  ref,
  group,
  context,
  others,
  center,
  dockHeight,
  shown,
  rejection,
  onRejected,
}: {
  ref: React.Ref<HTMLDivElement>;
  group: TabGroupInfo;
  context: GroupContextView | null;
  /** Contexts of groups not in this Space's list: another Mac's, or another Space's. */
  others: readonly GroupContextView[];
  /** The Stack's middle, from the dock's top: the card is centred on it where it fits. */
  center: number;
  dockHeight: number;
  shown: boolean;
  rejection: string | null;
  onRejected: (line: string | null) => void;
}) {
  const items = context?.items ?? [];
  const files = items.filter((item): item is Item & { kind: "file" } => item.kind === "file");
  const lines = items.filter((item) => item.kind !== "file");
  const [fact, setFact] = useState("");
  const [height, setHeight] = useState(0);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (el === null) return;
    const measure = (): void => setHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const top = Math.max(8, Math.min(Math.max(8, dockHeight - height - 8), center - height / 2));
  const api = nativeApi();
  const addFact = (): void => {
    const text = fact.trim();
    if (text === "" || api === null) return;
    setFact("");
    api.groupContext({ type: "addText", groupId: group.id, title: group.title, kind: "fact", text }).catch(() => onRejected("That could not be saved"));
  };
  const remove = (item: GroupContextItem): void => {
    api?.groupContext({ type: "remove", groupId: group.id, itemId: item.id }).catch(() => undefined);
  };
  const open = (item: GroupContextItem): void => {
    api?.groupContext({ type: "open", groupId: group.id, itemId: item.id }).catch((error: unknown) => onRejected(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "That file could not be opened"));
  };
  return (
    <div
      ref={(el) => {
        cardRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref !== null && ref !== undefined) (ref as React.RefObject<HTMLDivElement | null>).current = el;
      }}
      role="dialog"
      aria-label={`${group.title}: context`}
      data-testid="desk-stack-card"
      data-shown={shown ? "" : undefined}
      data-dropping={dropping ? "" : undefined}
      className="desk-dock-menu desk-stack-card-panel tab-group-tone"
      data-group-color={group.color}
      style={{ left: DOCK_W + CARD_GAP, top, width: CARD_W }}
      onDragOver={(event) => {
        if (!carriesSomething(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        if (!carriesSomething(event)) return;
        event.preventDefault();
        setDropping(false);
        void takeDrop(group, event.dataTransfer).then((result) => onRejected(rejectionLine(result)), () => onRejected("That could not be added"));
      }}
    >
      <div className="flex items-baseline gap-2 px-3 pt-3 pb-1">
        <span className="text-[13px] font-semibold text-gray-1000">Context</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-gray-700">{group.title}</span>
        {items.length === 0 ? null : <span className="text-[11px] text-gray-700 tabular-nums">{items.length}</span>}
      </div>
      {items.length === 0 ? (
        <p className="px-3 pb-2 text-[12px] leading-[17px] text-gray-800">
          Drop files here — a booking, a boarding pass, a PDF — or add a fact. Pistachio reads them when you ask about this desk, and saves what it finds here too.
        </p>
      ) : null}
      {rejection === null ? null : (
        <div role="status" data-testid="desk-stack-rejection" className="mx-3 mb-2 flex items-start gap-1.5 rounded-md bg-amber-100 px-2 py-1 text-[11px] leading-4 text-amber-900">
          <span className="min-w-0 flex-1">{rejection}</span>
          <button type="button" aria-label="Dismiss" onClick={() => onRejected(null)} className="shrink-0 cursor-pointer rounded-xs p-0.5 hover:bg-amber-400">
            <X className="size-3" aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="scroll-thin flex max-h-[min(420px,60vh)] flex-col gap-2 overflow-y-auto px-2 pb-2">
        {files.length === 0 ? null : (
          <div className="grid grid-cols-3 gap-1.5" role="list" aria-label="Files">
            {files.map((item) => (
              <div key={item.id} role="listitem" className="desk-stack-file group/file" data-testid="desk-stack-file" data-here={item.here ? "" : undefined}>
                <button
                  type="button"
                  className="flex min-w-0 flex-col items-center gap-1 px-1 pt-2 pb-1.5"
                  title={item.here ? `Open ${item.name}` : `${item.name} is on another Mac (too large to sync)`}
                  disabled={!item.here}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => open(item)}
                >
                  <FileGlyph mediaType={item.mediaType} />
                  <span className="w-full truncate text-center text-[11px] leading-[14px] text-gray-1000">{item.name}</span>
                  <span className="text-[10px] leading-3 text-gray-700">
                    {item.addedBy === "agent" ? "Pistachio · " : ""}
                    {item.here ? fileSize(item.byteLength) : "Other Mac"}
                  </span>
                </button>
                <RemoveButton label={`Remove ${item.name}`} onClick={() => remove(item)} />
              </div>
            ))}
          </div>
        )}
        {lines.length === 0 ? null : (
          <ul className="flex flex-col gap-px" aria-label="Facts and snippets">
            {lines.map((item) => (
              <li key={item.id} className="desk-stack-line group/file" data-testid="desk-stack-line" data-kind={item.kind}>
                <span className="mt-[3px] shrink-0 text-gray-700 [&_svg]:size-3.5">
                  {item.addedBy === "agent" ? <Sparkles aria-label="Saved by Pistachio" /> : item.kind === "fact" ? <Lightbulb aria-hidden="true" /> : item.kind === "link" ? <Link2 aria-hidden="true" /> : <Quote aria-hidden="true" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-3 text-[12px] leading-[17px] text-gray-1000 select-text">{item.text}</span>
                  {item.url === undefined ? null : <span className="block truncate text-[10.5px] leading-[14px] text-gray-700">{displayHost(item.url)}</span>}
                </span>
                <RemoveButton label="Remove" onClick={() => remove(item)} />
              </li>
            ))}
          </ul>
        )}
        {others.length === 0 ? null : (
          <div className="flex flex-col gap-1 border-t border-alpha-300 pt-2" data-testid="desk-stack-others">
            <span className="px-1 text-[10.5px] font-semibold tracking-wide text-gray-700 uppercase">From another Mac or Space</span>
            {others.map((other) => (
              <div key={other.groupId} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-alpha-100">
                <span className="min-w-0 flex-1 truncate text-[12px] text-gray-1000">
                  {other.title || "A group"} <span className="text-gray-700">· {other.items.length}</span>
                </span>
                <button
                  type="button"
                  data-testid="desk-stack-adopt"
                  className="desk-answer-action"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void api?.groupContext({ type: "adopt", groupId: group.id, title: group.title, fromGroupId: other.groupId })}
                >
                  <Import aria-hidden="true" />
                  Bring in
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 border-t border-alpha-300 px-2 py-2">
        <input
          type="text"
          value={fact}
          data-testid="desk-stack-fact"
          aria-label="Add a fact"
          placeholder="Add a fact…"
          maxLength={4_000}
          onChange={(event) => setFact(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              addFact();
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-md bg-alpha-100 px-2 text-[12px] text-gray-1000 outline-none placeholder:text-gray-700 focus-visible:ring-2 focus-visible:ring-ring"
        />
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          data-testid="desk-stack-file-input"
          onChange={(event) => {
            const list = event.currentTarget.files;
            const chosen = list === null ? [] : [...list];
            event.currentTarget.value = "";
            if (chosen.length > 0) void addContextFiles(group.id, group.title, chosen).then((result) => onRejected(rejectionLine(result)), () => onRejected("Those files could not be added"));
          }}
        />
        <button type="button" data-testid="desk-stack-add-files" className="desk-answer-action" onMouseDown={(event) => event.preventDefault()} onClick={() => fileRef.current?.click()}>
          <Plus aria-hidden="true" />
          Add files…
        </button>
      </div>
    </div>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn("desk-stack-remove")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <X aria-hidden="true" />
    </button>
  );
}

function FileGlyph({ mediaType }: { mediaType: string }) {
  const Glyph = mediaType.startsWith("image/")
    ? FileImage
    : mediaType === "text/csv"
      ? FileSpreadsheet
      : mediaType === "text/calendar"
        ? CalendarDays
        : mediaType === "application/json"
          ? FileJson
          : FileText;
  return (
    <span className="desk-stack-glyph" data-kind={mediaType === "application/pdf" ? "pdf" : mediaType.startsWith("image/") ? "image" : "text"}>
      <Glyph aria-hidden="true" />
    </span>
  );
}
