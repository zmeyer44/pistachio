import { RotateCcw, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  DEFAULT_SHORTCUTS,
  reservedShortcutReason,
  shortcutConflict,
  shortcutFromEvent,
  shortcutLabel,
  SHORTCUT_DEFINITIONS,
  type ShortcutActionId,
  type ShortcutPlatform,
} from "@pistachio/shell-contracts/shortcuts";
import { cn } from "../../../lib/cn";
import { useAppStore } from "../../../store";
import { Button } from "../../ui/button";
import { Kbd } from "../../ui/kbd";
import { Note } from "../../ui/note";
import { Group, Page } from "../parts";

const PLATFORM: ShortcutPlatform = /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other";
const GROUPS = ["Tabs", "Page", "Window", "Agent"] as const;

const GROUP_NOTES: Record<(typeof GROUPS)[number], string> = {
  Tabs: "Opening, closing, and moving between tabs.",
  Page: "Acting on the page in the front tab.",
  Window: "The chrome around the page.",
  Agent: "Handing work to the agent and taking it back.",
};

function ShortcutKeys({ binding }: { binding: string | null }) {
  const label = shortcutLabel(binding, PLATFORM);
  if (label === null) return <span className="text-[11px] text-gray-700">Unassigned</span>;
  return <Kbd>{label}</Kbd>;
}

export function ShortcutsPage() {
  const shortcuts = useAppStore((state) => state.settings.shortcuts);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [error, setError] = useState<{ id: ShortcutActionId; message: string } | null>(null);
  const grouped = useMemo(
    () => GROUPS.map((group) => ({ group, definitions: SHORTCUT_DEFINITIONS.filter((definition) => definition.group === group) })),
    [],
  );

  const commit = (id: ShortcutActionId, binding: string | null) => {
    setError(null);
    setRecording(null);
    void updateSettings({ shortcuts: { [id]: binding } });
  };

  /**
   * Back to the default — through the same conflict check a recording gets.
   * Another action may hold the default by now (⌘T given to Edit address
   * after New tab moved to ⌘K); writing it anyway would have the sanitizer
   * unassign that action without a word.
   */
  const reset = (id: ShortcutActionId) => {
    const binding = DEFAULT_SHORTCUTS[id];
    const conflict = binding === null ? null : shortcutConflict(shortcuts, binding, id);
    if (conflict !== null) {
      setRecording(null);
      setError({
        id,
        message: `The default, ${shortcutLabel(binding, PLATFORM) ?? ""}, is used by “${conflict.label}”. Clear that binding first.`,
      });
      return;
    }
    commit(id, binding);
  };

  const record = (id: ShortcutActionId, event: React.KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
    if (event.key === "Escape") {
      setRecording(null);
      setError(null);
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey && !event.altKey) {
      commit(id, null);
      return;
    }
    const binding = shortcutFromEvent(event.nativeEvent, PLATFORM);
    if (binding === null) {
      setError({ id, message: "Include Command/Ctrl or Option/Alt, or use a function key." });
      return;
    }
    const reserved = reservedShortcutReason(binding);
    if (reserved !== null) {
      setError({ id, message: reserved });
      return;
    }
    const conflict = shortcutConflict(shortcuts, binding, id);
    if (conflict !== null) {
      setError({ id, message: `Already used by “${conflict.label}”. Clear that binding first.` });
      return;
    }
    commit(id, binding);
  };

  return (
    <Page
      title="Keyboard shortcuts"
      description="Click a binding, then press a new key combination. Changes apply in browser pages and app chrome immediately."
    >
      <Note
        type="secondary"
        size="sm"
        className="py-1.5 pr-1.5"
        action={
          <Button
            variant="tertiary"
            size="xs"
            prefix={<RotateCcw aria-hidden="true" />}
            onClick={() => {
              setRecording(null);
              setError(null);
              void updateSettings({ shortcuts: DEFAULT_SHORTCUTS });
            }}
          >
            Reset all
          </Button>
        }
      >
        Escape cancels · Delete clears · conflicts are never overwritten.
      </Note>

      {grouped.map(({ group, definitions }) => (
        <Group key={group} title={group} note={GROUP_NOTES[group]}>
          {definitions.map((definition) => {
            const active = recording === definition.id;
            const changed = shortcuts[definition.id] !== DEFAULT_SHORTCUTS[definition.id];
            const rowError = error?.id === definition.id ? error.message : null;
            return (
              <div key={definition.id} className="px-5 py-3 @max-md:px-4">
                <div className="flex items-start justify-between gap-5">
                  <div className="min-w-0">
                    <p className="text-label-14 text-gray-1000">{definition.label}</p>
                    {definition.note === undefined ? null : <p className="mt-1 text-copy-13 leading-4.5 text-gray-900">{definition.note}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {changed ? (
                      <button
                        type="button"
                        aria-label={`Reset ${definition.label}`}
                        title="Reset binding"
                        onClick={() => reset(definition.id)}
                        className="grid size-7 cursor-pointer place-items-center rounded-sm text-gray-700 outline-none hover:bg-alpha-200 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <RotateCcw className="size-3" aria-hidden="true" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`${active ? "Recording" : "Edit"} shortcut for ${definition.label}`}
                      data-testid={`shortcut-${definition.id}`}
                      onClick={() => {
                        setError(null);
                        setRecording(active ? null : definition.id);
                      }}
                      onKeyDown={(event) => {
                        if (recording === definition.id) record(definition.id, event);
                      }}
                      className={cn(
                        "flex min-h-8 min-w-28 cursor-pointer items-center justify-center rounded-sm px-2 outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        active
                          ? "bg-gray-1000 text-background-100"
                          : "bg-background-100 text-gray-1000 shadow-border hover:shadow-[0_0_0_1px_var(--color-gray-500)]",
                      )}
                    >
                      {active ? (
                        <span className="flex items-center gap-2 text-[11px] font-medium">
                          <span className="size-1.5 animate-pulse rounded-full bg-green-700" />
                          Press shortcut
                        </span>
                      ) : (
                        <ShortcutKeys binding={shortcuts[definition.id]} />
                      )}
                    </button>
                    {shortcuts[definition.id] === null && !active ? null : (
                      <button
                        type="button"
                        aria-label={`Clear ${definition.label}`}
                        title="Clear binding"
                        onClick={() => commit(definition.id, null)}
                        className="grid size-7 cursor-pointer place-items-center rounded-sm text-gray-700 outline-none hover:bg-alpha-200 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
                {rowError === null ? null : (
                  <Note role="alert" type="error" size="sm" className="mt-2.5">
                    {rowError}
                  </Note>
                )}
              </div>
            );
          })}
        </Group>
      ))}
    </Page>
  );
}
