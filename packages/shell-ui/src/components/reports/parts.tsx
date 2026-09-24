/**
 * What the report's blocks and its preview panel both need: the tick, and the
 * two things an item can do. Kept apart from the registry so the panel can use
 * them without importing the catalog's components.
 */
import { useMemo } from "react";
import { useActions, useStateBinding } from "@json-render/react";
import { Check } from "lucide-react";
import { tickPath } from "@pistachio/shell-contracts/reports";
import { cn } from "../../lib/cn";
import { isWebUrl } from "../../lib/reports";

export const FOCUS = "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** What an item does when pressed goes through the catalog's actions, like everything else in a spec. */
export function useRun(): { open: (url: string | null) => void; ask: (prompt: string | null) => void } {
  const { execute } = useActions();
  return useMemo(
    () => ({
      open: (url) => {
        if (isWebUrl(url)) void execute({ action: "open_url", params: { url } });
      },
      ask: (prompt) => {
        if (prompt !== null && prompt.trim() !== "") void execute({ action: "ask_agent", params: { prompt } });
      },
    }),
    [execute],
  );
}

export function Tick({ itemKey, label }: { itemKey: string; label: string }) {
  const [checked, setChecked] = useStateBinding<boolean>(tickPath(itemKey));
  const on = checked === true;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      data-testid="report-tick"
      onClick={(event) => {
        event.stopPropagation();
        setChecked(!on);
      }}
      className={cn(
        "grid size-[19px] shrink-0 cursor-pointer place-items-center rounded-full border-[1.5px] transition-colors duration-100",
        FOCUS,
        on ? "border-gray-700 bg-gray-700 text-background-100" : "border-gray-500 hover:border-gray-800",
      )}
    >
      {on ? <Check className="size-3" strokeWidth={3} aria-hidden="true" /> : null}
    </button>
  );
}

export function useTicked(itemKey: string): boolean {
  const [checked] = useStateBinding<boolean>(tickPath(itemKey));
  return checked === true;
}
