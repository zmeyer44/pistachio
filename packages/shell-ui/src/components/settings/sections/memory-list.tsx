/**
 * The whole memory, one row per fact: what the person wrote, what the
 * agent added during runs, and what the learner picked up afterwards —
 * with history, so a versioned fact shows its edition and a forgotten one
 * can be brought back.
 */

import { useMemo, useState } from "react";
import { History, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  isActive,
  isExpired,
  MAX_MEMORY_CONTENT,
  MAX_MEMORY_LABEL,
  MEMORY_BUCKET_LABELS,
  MEMORY_BUCKETS,
  rekeyedFor,
  type MemoryBucket,
  type MemoryEntry,
  type MemoryKind,
} from "@pistachio/shell-contracts/memory";
import { cn } from "../../../lib/cn";
import { useAppStore } from "../../../store";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  Fieldset,
  FieldsetContent,
  FieldsetFooter,
  FieldsetFooterActions,
  FieldsetFooterStatus,
  FieldsetSubtitle,
  FieldsetTitle,
} from "../../ui/fieldset";
import { Input } from "../../ui/input";
import { Note } from "../../ui/note";
import { Select } from "../../ui/select";
import { Block, Group } from "../parts";

const FILTERS = [
  { value: "active", label: "In use" },
  { value: "static", label: "Lasting" },
  { value: "dynamic", label: "Current" },
  { value: "forgotten", label: "Forgotten" },
  { value: "history", label: "History" },
] as const;
type Filter = (typeof FILTERS)[number]["value"];

const KIND_ITEMS: ReadonlyArray<{ value: MemoryKind; label: string }> = [
  { value: "static", label: "Lasting" },
  { value: "dynamic", label: "Current" },
];

const BUCKET_ITEMS: ReadonlyArray<{ value: MemoryBucket; label: string }> = MEMORY_BUCKETS.map((bucket) => ({
  value: bucket,
  label: MEMORY_BUCKET_LABELS[bucket],
}));

const SOURCE_LABELS = { user: "You", agent: "Agent", learned: "Learned" } as const;

const CLEARED = "Forgotten in Settings";

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/* --------------------------------- row --------------------------------- */

function MemoryRow({ entry, now }: { entry: MemoryEntry; now: Date }) {
  const updateMemory = useAppStore((state) => state.updateMemory);
  const forgetMemory = useAppStore((state) => state.forgetMemory);
  const restoreMemory = useAppStore((state) => state.restoreMemory);
  const [draft, setDraft] = useState<{ label: string; content: string; kind: MemoryKind; bucket: MemoryBucket } | null>(null);
  const active = isActive(entry, now);
  const expired = isExpired(entry, now);

  if (draft !== null) {
    const valid = draft.content.trim() !== "";
    return (
      <div className="flex flex-col gap-2 py-3">
        <div className="flex items-center gap-2">
          <Input
            aria-label="Label"
            placeholder="Label (optional)"
            maxLength={MAX_MEMORY_LABEL}
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            className="w-40 shrink-0"
          />
          <Input
            aria-label="Fact"
            maxLength={MAX_MEMORY_CONTENT}
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
            className="min-w-0 flex-1"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Kind" value={draft.kind} items={KIND_ITEMS} onValueChange={(kind) => setDraft({ ...draft, kind })} className="w-32" />
          <Select
            aria-label="Bucket"
            value={draft.bucket}
            items={BUCKET_ITEMS}
            onValueChange={(bucket) => setDraft({ ...draft, bucket })}
            className="w-36"
          />
          <span className="ml-auto flex items-center gap-1.5">
            <Button variant="tertiary" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!valid}
              onClick={() => {
                const label = draft.label.trim() === "" ? null : draft.label.trim();
                // A place or project is keyed by its label, so the key moves
                // with a rename; leaving the old key behind would let a later
                // "Home" version whatever this became.
                void updateMemory(entry.id, {
                  label,
                  content: draft.content.trim(),
                  kind: draft.kind,
                  bucket: draft.bucket,
                  key: rekeyedFor(entry, draft.bucket, label),
                });
                setDraft(null);
              }}
            >
              Save
            </Button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex items-start justify-between gap-4 py-3", active ? "" : "opacity-70")}>
      <div className="min-w-0">
        <p className={cn("text-label-14 text-gray-1000", active ? "" : "line-through decoration-gray-500")}>
          {entry.label === null ? null : <span className="font-medium">{entry.label}: </span>}
          {entry.content}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-label-12 text-gray-900">
          <Badge variant="gray-subtle" size="sm">
            {MEMORY_BUCKET_LABELS[entry.bucket]}
          </Badge>
          <Badge variant={entry.kind === "static" ? "green-subtle" : "amber-subtle"} size="sm">
            {entry.kind === "static" ? "Lasting" : "Current"}
          </Badge>
          {entry.review === "pending" ? (
            <Badge variant="blue-subtle" size="sm">
              Needs review
            </Badge>
          ) : null}
          <span>{SOURCE_LABELS[entry.source.kind]}</span>
          <span aria-hidden="true">·</span>
          <span>{when(entry.createdAt)}</span>
          {entry.version > 1 || !entry.isLatest ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1" title={entry.isLatest ? "This fact has been updated" : "An earlier version"}>
                <History className="size-3" aria-hidden="true" />v{entry.version}
              </span>
            </>
          ) : null}
          {entry.isLatest ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span>Superseded</span>
            </>
          )}
          {entry.forgetAfter !== null && !entry.isForgotten ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{expired ? "Expired" : `Until ${when(entry.forgetAfter)}`}</span>
            </>
          ) : null}
          {entry.isForgotten ? (
            <>
              <span aria-hidden="true">·</span>
              <span>Forgotten{entry.forgetReason === null ? "" : ` — ${entry.forgetReason}`}</span>
            </>
          ) : null}
          {entry.review === "declined" ? (
            <>
              <span aria-hidden="true">·</span>
              <span>Marked not true</span>
            </>
          ) : null}
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-1">
        {active ? (
          <>
            <Button
              variant="tertiary"
              size="sm"
              svgOnly
              aria-label={`Edit ${entry.label ?? entry.content}`}
              onClick={() => setDraft({ label: entry.label ?? "", content: entry.content, kind: entry.kind, bucket: entry.bucket })}
            >
              <Pencil aria-hidden="true" />
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              svgOnly
              aria-label={`Forget ${entry.label ?? entry.content}`}
              onClick={() => void forgetMemory(entry.id, CLEARED)}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </>
        ) : entry.isLatest && (entry.isForgotten || entry.review === "declined") ? (
          <Button
            variant="tertiary"
            size="sm"
            prefix={<RotateCcw aria-hidden="true" />}
            onClick={() => {
              if (entry.review === "declined") void useAppStore.getState().reviewMemory(entry.id, "approved");
              else void restoreMemory(entry.id);
            }}
          >
            Restore
          </Button>
        ) : null}
      </span>
    </div>
  );
}

/* --------------------------------- add --------------------------------- */

function AddMemoryFieldset() {
  const addMemory = useAppStore((state) => state.addMemory);
  const [content, setContent] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<MemoryKind>("static");
  const [bucket, setBucket] = useState<MemoryBucket>("preference");
  const canAdd = content.trim() !== "";

  return (
    <Fieldset>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!canAdd) return;
          void addMemory({
            content: content.trim(),
            label: label.trim() === "" ? null : label.trim(),
            kind,
            bucket,
          });
          setContent("");
          setLabel("");
        }}
      >
        <FieldsetContent>
          <FieldsetTitle>Add a memory</FieldsetTitle>
          <FieldsetSubtitle>
            One fact per memory, written about you: “Prefers aisle seats”, “Manager is Priya”, “Ships everything to the
            office”.
          </FieldsetSubtitle>
          <div className="mt-4 flex flex-col gap-3">
            <Input
              label="Fact"
              placeholder="Prefers aisle seats on flights"
              maxLength={MAX_MEMORY_CONTENT}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
            <div className="flex flex-wrap items-end gap-3">
              <Input
                label="Label"
                description="Optional. A short handle for a named thing."
                placeholder="Priya"
                maxLength={MAX_MEMORY_LABEL}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                containerClassName="w-44"
              />
              <div className="flex flex-col gap-1.5">
                <span className="text-label-13 text-gray-1000">Kind</span>
                <Select aria-label="Kind" value={kind} items={KIND_ITEMS} onValueChange={setKind} className="w-32" />
                <span className="text-label-12 text-gray-900">Lasting facts do not fade; current ones do.</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-label-13 text-gray-1000">About</span>
                <Select aria-label="Bucket" value={bucket} items={BUCKET_ITEMS} onValueChange={setBucket} className="w-36" />
                <span className="text-label-12 text-gray-900">Where it files.</span>
              </div>
            </div>
          </div>
        </FieldsetContent>
        <FieldsetFooter>
          <FieldsetFooterStatus>Saved as your own words: full confidence, no review.</FieldsetFooterStatus>
          <FieldsetFooterActions>
            <Button type="submit" size="sm" disabled={!canAdd} prefix={<Plus aria-hidden="true" />}>
              Remember
            </Button>
          </FieldsetFooterActions>
        </FieldsetFooter>
      </form>
    </Fieldset>
  );
}

/* --------------------------------- list -------------------------------- */

export function MemoryList({ entries, now }: { entries: MemoryEntry[]; now: Date }) {
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries
      .filter((entry) => {
        if (filter === "history") return !entry.isLatest;
        if (filter === "forgotten") return entry.isLatest && (entry.isForgotten || entry.review === "declined");
        if (!isActive(entry, now)) return false;
        return filter === "active" || entry.kind === filter;
      })
      .filter((entry) => needle === "" || `${entry.label ?? ""} ${entry.content}`.toLowerCase().includes(needle))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [entries, filter, query, now]);

  const total = entries.filter((entry) => isActive(entry, now)).length;

  return (
    <>
      <Group
        title="Everything remembered"
        note="Every fact in use, wherever it came from. Edit one and it keeps its history; forget one and it can be restored."
        footer={`${String(total)} in use · ${String(entries.length)} ${entries.length === 1 ? "record" : "records"} including history.`}
      >
        <Block>
          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="Filter memories" className="flex items-center gap-1">
              {FILTERS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  aria-selected={filter === item.value}
                  onClick={() => setFilter(item.value)}
                  className={cn(
                    "h-7 cursor-pointer rounded-full px-3 text-label-12 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    filter === item.value ? "bg-gray-1000 text-background-100" : "text-gray-900 hover:bg-alpha-100 hover:text-gray-1000",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <Input
              aria-label="Search memories"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="ml-auto w-52"
            />
          </div>
        </Block>
        <Block>
          {rows.length === 0 ? (
            <Note type="secondary" size="sm">
              {query.trim() === ""
                ? filter === "forgotten"
                  ? "Nothing has been forgotten."
                  : filter === "history"
                    ? "No fact has been updated yet. Earlier versions of edited facts appear here."
                    : "Nothing here yet. Add a fact below, or let the agent learn one."
                : "No memory matches that."}
            </Note>
          ) : (
            <div className="divide-y divide-alpha-400">
              {rows.map((entry) => (
                <MemoryRow key={entry.id} entry={entry} now={now} />
              ))}
            </div>
          )}
        </Block>
      </Group>
      <AddMemoryFieldset />
    </>
  );
}
