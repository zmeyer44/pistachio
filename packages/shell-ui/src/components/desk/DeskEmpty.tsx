import { shortcutLabel, type ShortcutPlatform } from "@pistachio/shell-contracts/shortcuts";
import { newTabOnDesk } from "../../lib/desk/open";
import { useAppStore } from "../../store";
import { Kbd } from "../ui/kbd";

const PLATFORM: ShortcutPlatform = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other";

/**
 * The empty desk (docs/spaces.md §1, "An empty space"): the space holds no
 * tab, and nothing of it is out — so the well says, quietly and in the
 * middle, whose it is and what can be
 * done: a new tab (⌘T, here as a button too), or files dropped anywhere on
 * it (DeskDropZone takes them; the Stack's row keeps one without opening
 * it). The house's muted text, no picture: the Bar's nub in its corner is
 * the rest of what an empty desk shows.
 *
 * Only its button takes the pointer: a press anywhere else is the desk's
 * own surface's, as it is between windows. (A space whose windows were all
 * put away is not empty — its tabs are its rows — and shows nothing here:
 * DeskSurface, since 2026-10-09.)
 */
export function DeskEmpty({ title }: { title: string }) {
  const newTabKey = useAppStore((state) => shortcutLabel(state.settings.shortcuts.newTab, PLATFORM));
  return (
    <div data-testid="desk-empty" className="desk-empty pointer-events-none absolute inset-0 grid place-content-center justify-items-center gap-2 text-center">
      <span data-testid="desk-empty-title" className="max-w-80 truncate text-[13px] font-medium text-gray-900">
        {title}
      </span>
      <button
        type="button"
        data-testid="desk-empty-new-tab"
        // The keyboard stays where it is (the shell's: nothing is in use).
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void newTabOnDesk()}
        className="no-drag pointer-events-auto flex h-7 cursor-pointer items-center gap-2 rounded-md px-2.5 text-[12px] text-gray-900 outline-none transition-colors duration-150 hover:bg-alpha-200 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        New tab
        {newTabKey === null ? null : <Kbd small>{newTabKey}</Kbd>}
      </button>
      <span className="text-[12px] text-gray-700">Drop files here</span>
    </div>
  );
}
