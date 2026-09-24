import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Search } from "lucide-react";
import { shortcutLabel, type ShortcutPlatform } from "@pistachio/shell-contracts/shortcuts";
import { cn } from "../../lib/cn";
import { browsableRecents } from "../../lib/home";
import { prettyUrl } from "../../lib/url";
import { useAppStore } from "../../store";
import { Kbd } from "../ui/kbd";
import { useIntentOrder } from "../../lib/use-address-intent";
import { useFieldPreview } from "../../lib/use-field-preview";
import { PaletteResultRow, primaryItemFor, usePaletteInventory, useShelfRows, useTypedEntries, type Entry } from "../address-palette";
import type { HomeNavigation } from "./navigation";

export interface HomeSearchHandle {
  focus(): void;
}

const BROWSE_ROWS = 6;

/**
 * The home page's search: the address field of its tab. At rest it is the
 * pill in the middle of the page; focused and typed into, it opens into the
 * same suggestions the address modal ranks (components/address-palette.tsx)
 * — a go-to or a web search for the text, recent pages, open tabs in every
 * Space, kept pages, actions and settings — and ↵ takes this tab there.
 * Focused with nothing typed (a click, ↓), it offers the clipboard's address
 * and the recent pages. As in the modal, the field shows where the active row
 * goes once the person has steered to it (lib/use-field-preview.ts).
 *
 * Focus alone does not open it: the page hands it the keyboard as a new tab
 * shows, and a list covering the page before anything was asked would hide
 * the page itself.
 */
export function HomeSearch({ ref, navigation, className }: { ref?: Ref<HomeSearchHandle>; navigation: HomeNavigation; className?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(-1);
  const recents = useAppStore((s) => s.recents);
  const editAddress = useAppStore((s) => s.settings.shortcuts.editAddress);
  const { tab } = navigation;

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus({ preventScroll: true }) }), []);

  const q = query.trim();
  const { palette, paletteTabs } = usePaletteInventory(expanded);
  const shelfRows = useShelfRows(tab?.anchorId);
  const searchSettings = useAppStore((s) => s.settings.search);
  const primaryItem = useMemo(() => primaryItemFor(q, searchSettings), [q, searchSettings]);
  const face = useTypedEntries({ q, primaryItem, tab, currentUrl: tab?.url ?? "", palette, paletteTabs, shelfRows });
  // Held still as soon as the person steers, and ↵ keeps meaning what the
  // list said a moment ago (lib/use-address-intent).
  const order = useIntentOrder(face, q, primaryItem);
  const typed = order.entries;

  const browse = useMemo<Entry[]>(() => {
    const rows: Entry[] = [];
    if (palette.clipboardUrl !== null) {
      rows.push({ kind: "paste", id: "paste-and-go", url: palette.clipboardUrl, title: "Paste and Go", subtitle: prettyUrl(palette.clipboardUrl) });
    }
    for (const site of browsableRecents(recents).slice(0, BROWSE_ROWS)) {
      rows.push({ kind: "history", id: `visit:${site.host}`, url: site.url, site });
    }
    return rows;
  }, [palette.clipboardUrl, recents]);

  const entries = q.length > 0 ? typed : browse;
  const open = expanded && entries.length > 0;
  const preview = useFieldPreview({ inputRef, typed: query, entries, selected });

  useEffect(() => {
    setSelected(q.length > 0 ? 0 : -1);
  }, [q]);

  useEffect(() => {
    setSelected((index) => Math.min(index, entries.length - 1));
  }, [entries.length]);

  const collapse = () => {
    setExpanded(false);
    setSelected(-1);
    preview.settle();
  };

  const act = (entry: Entry | undefined) => {
    if (entry === undefined) return;
    setQuery("");
    collapse();
    inputRef.current?.blur();
    if (entry.kind === "action") {
      entry.run();
      return;
    }
    if (entry.kind === "tab") {
      navigation.leaveFor(() => navigation.selectTab(entry.tabId));
      return;
    }
    if (entry.kind === "shelf") {
      navigation.leaveFor(() => navigation.openAnchor(entry.anchorId));
      return;
    }
    navigation.open(entry.url);
  };

  /** Hover selects; only a hover that CHANGES the row counts as steering. */
  const selectResult = (index: number) => {
    if (q.length > 0) order.moved(index, selected);
    preview.steer("pointer", index);
    setSelected(index);
  };

  /** ↑/↓ landed on `index` (-1: back in the field, which shows the typed text again). */
  const stepTo = (index: number) => {
    preview.steer("keys", index);
    setSelected(index);
  };

  /**
   * ↑/↓ run in a RING, as they do in the address modal (components/UrlBar.tsx):
   * off the bottom lands back on the top, off the top on the bottom. With
   * nothing typed the field itself (-1) is the ring's stop above the first
   * row; typed into, there is no such stop and the ends meet on the rows.
   */
  const firstStop = q.length > 0 ? 0 : -1;

  /** The pointer left the list: a row it was only looking at is no longer the active one. */
  const endHover = () => {
    if (preview.leave()) setSelected(q.length > 0 ? 0 : -1);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = q.length > 0 ? order.entryFor(selected) : entries[selected];
      if (entry !== undefined) act(entry);
      else if (q.length > 0) {
        setQuery("");
        collapse();
        navigation.open(q);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (query !== "") {
        preview.settle();
        setQuery("");
      } else if (expanded) collapse();
      else inputRef.current?.blur();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (q.length > 0) order.freeze();
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!expanded) {
        setExpanded(true);
        return;
      }
      if (entries.length === 0) return;
      stepTo(selected + 1 < entries.length ? selected + 1 : firstStop);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      // Closed, there is no row to show the field stepping onto.
      if (!expanded || entries.length === 0) return;
      stepTo(selected > firstStop ? selected - 1 : entries.length - 1);
      return;
    }
    preview.release(event);
  };

  useEffect(() => {
    if (selected < 0) return;
    inputRef.current?.parentElement?.parentElement?.querySelector(`[data-index="${String(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const platform: ShortcutPlatform = /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other";
  const hint = shortcutLabel(editAddress, platform);

  return (
    <div className={cn("relative h-14", className)}>
      <div
        data-testid="home-search"
        data-expanded={open ? "" : undefined}
        className={cn(
          "absolute inset-x-0 top-0 flex flex-col overflow-hidden bg-background-100 transition-[border-radius,box-shadow] duration-150",
          open
            ? "z-30 rounded-[28px] shadow-modal"
            : "rounded-[28px] shadow-[0_0_0_1px_var(--color-alpha-400),0_2px_8px_-2px_var(--color-alpha-200)] hover:shadow-[0_0_0_1px_var(--color-alpha-500),0_2px_8px_-2px_var(--color-alpha-200)] focus-within:shadow-[0_0_0_1px_var(--color-alpha-600),0_4px_14px_-4px_var(--color-alpha-300)]",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-3.5 pr-3.5 pl-5">
          <Search className="size-[18px] shrink-0 text-gray-800" strokeWidth={2} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls="home-search-results"
            aria-label="Search the web or type a URL"
            data-testid="home-search-input"
            spellCheck={false}
            autoComplete="off"
            placeholder="Search the web or type a URL"
            value={preview.value}
            onChange={(event) => {
              preview.settle();
              setQuery(event.target.value);
              setExpanded(true);
            }}
            onPointerDown={() => setExpanded(true)}
            onKeyDown={onKeyDown}
            onBlur={collapse}
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-gray-1000 outline-none placeholder:text-gray-700"
          />
          {hint !== null && !open ? <Kbd>{hint}</Kbd> : null}
        </div>
        {open ? (
          <div
            id="home-search-results"
            role="listbox"
            data-testid="home-search-results"
            data-intent-ranked={order.intentState}
            // Rows keep the input's focus: a press here must not blur it
            // (which closes the list) before the click lands.
            onMouseDown={(event) => event.preventDefault()}
            onMouseLeave={endHover}
            className="max-h-[min(380px,50vh)] overflow-y-auto border-t border-alpha-200 px-2.5 pt-2 pb-2.5"
          >
            {q.length === 0 ? <p className="px-2.5 pt-1 pb-1.5 text-[11.5px] font-medium text-gray-700">Recent</p> : null}
            {entries.map((entry, index) => (
              <PaletteResultRow
                key={entry.id}
                entry={entry}
                index={index}
                selected={index === selected}
                onSelect={selectResult}
                onActivate={act}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
