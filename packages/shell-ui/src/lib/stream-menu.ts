/**
 * The page context menu over a STREAMED pane (docs/web-browser-design.md §10,
 * §11 "Context menu").
 *
 * The menu itself is built by `@pistachio/shell-contracts/page-context-menu`,
 * the same pure builder the desktop's native menu is built from. What lives
 * here is everything the builder has to be TOLD, and everything it hands back
 * that Chromium performs for itself on the desktop and nobody performs on a
 * stream:
 *
 * - the state (`streamMenuState`): what the tab can do and what the site's
 *   policy allows, read from the snapshot and from `getBrowserControls`
 *   rather than asserted;
 * - the media flags (`streamMediaFlags`): a `<video>` in a cloud tab really
 *   can loop, but nothing on this side can make it, so the rows are disabled
 *   rather than offered and then refused;
 * - the editing verbs (`streamEditRow`): the `role` rows, which arrive with
 *   no label and no click because Electron supplied both.
 *
 * It is pure so the whole table can be read in a test: the web wires the
 * verbs to `StreamShellApi` calls and to forwarded key input.
 */

import type { BrowserControlsSnapshot, GuardedBrowserAction } from "@pistachio/shell-contracts/browser-controls";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { DEFAULT_WEB_SEARCH_PROVIDER, type WebSearchProvider } from "@pistachio/shell-contracts/search";
import type {
  ContextMenuTemplateItem,
  PageContextMenuParams,
  PageContextMenuState,
} from "@pistachio/shell-contracts/page-context-menu";
import {
  DEFAULT_SHORTCUTS,
  shortcutLabel,
  type ShortcutPlatform,
  type ShortcutSettings,
} from "@pistachio/shell-contracts/shortcuts";

/**
 * Whether a guarded action is allowed, from the host's own verdict.
 *
 * There is no "we did not ask" here: the store's neutral snapshot answers
 * `block` for every guarded action precisely so that a `getBrowserControls`
 * that failed cannot read as permission, and this passes that through.
 */
function allows(controls: BrowserControlsSnapshot | null, action: GuardedBrowserAction): boolean {
  return controls !== null && controls.actions[action].decision === "allow";
}

/**
 * A cloud tab showing a reader page.
 *
 * The desktop's reader is `pistachio://reader/<id>`, served by a protocol
 * handler it registered. A cloud tab has neither, so the host renders the
 * article and navigates the tab to it as a self-contained `data:` document
 * (`readerDataUrl`), which is what a reader tab's address IS on this surface.
 * Chromium refuses a top-level `data:` navigation from a page, so this cannot
 * be a site pretending to be one.
 */
export function isStreamReaderUrl(url: string): boolean {
  return url.startsWith("data:text/html");
}

/**
 * What the builder is told about the tab and the site.
 *
 * Every field used to be a hard-coded `true`, which put "Back" and "Forward"
 * up as live on a tab with no history, offered "Show Reader" on a tab that
 * IS the reader (the item then closes it, so the label was the opposite of
 * what happened), and claimed copy, paste, download and print were allowed
 * without ever asking the host.
 */
export function streamMenuState(input: {
  tab: BrowserTabInfo | null;
  controls: BrowserControlsSnapshot | null;
  shortcuts: ShortcutSettings | null;
  /** `search.webProvider`; absent before the settings load, which reads as the default engine. */
  searchProvider?: WebSearchProvider;
}): PageContextMenuState {
  const { tab, controls } = input;
  return {
    canGoBack: tab?.canGoBack ?? false,
    canGoForward: tab?.canGoForward ?? false,
    copyAllowed: allows(controls, "copy"),
    pasteAllowed: allows(controls, "paste"),
    downloadAllowed: allows(controls, "download"),
    printAllowed: allows(controls, "print"),
    inReaderView: tab !== null && isStreamReaderUrl(tab.url),
    // The rows that exist only on a Mac (the Emoji & Symbols panel) are not
    // offered here whatever the VIEWER runs: the panel is the OS's, and the
    // page is a thousand miles from it. The shortcut hints beside the rows
    // are a different question — see `acceleratorLabel`.
    platform: "other",
    shortcuts: input.shortcuts ?? DEFAULT_SHORTCUTS,
    searchProvider: input.searchProvider ?? DEFAULT_WEB_SEARCH_PROVIDER,
  };
}

/**
 * The media capabilities a streamed pane can actually deliver.
 *
 * The tab's init script reports what the element under the pointer supports,
 * which is honest about the ELEMENT — any `<video>` can loop — and says
 * nothing about whether this surface can ask it to. `MediaControl` has no
 * loop or controls command, and picture-in-picture in a cloud tab opens a
 * window the screencast does not capture, so all three would answer "not
 * available over a streamed pane" after being offered as available. The
 * checked state stays truthful; only the CAN flags are cleared, which leaves
 * the rows visible and disabled instead of live and inert.
 */
export function streamMediaFlags(target: PageContextMenuParams): PageContextMenuParams {
  return {
    ...target,
    mediaFlags: {
      ...target.mediaFlags,
      canLoop: false,
      canToggleControls: false,
      canShowPictureInPicture: false,
    },
  };
}

/**
 * One forwarded key press: what the person would have pressed in the page.
 *
 * `ctrlKey` rather than `metaKey` because the chord is bound by the CLOUD
 * page's Chromium, which runs on the worker (Linux in the fleet), not by the
 * viewer's own browser. A Mac viewer presses ⌘Z in their browser; what has
 * to reach the page for the page to undo is Ctrl+Z.
 */
export interface StreamEditChord {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/**
 * How the shell performs one editing role over a stream.
 *
 * `paste` is the only one that cannot be a key press: the clipboard the page
 * would read is the CLOUD machine's, which is empty and not the person's, so
 * the text travels as an argument (`pasteText` → `Input.insertText`, which is
 * what a real paste does). `copy` and `cut` take the selection out of the hit
 * report the menu was opened from — it is already here, and asking the page
 * for it again would be a round trip for a string we hold. Everything else is
 * a key press the page's own editor handles.
 */
export type StreamEditVerb =
  | { kind: "paste" }
  | { kind: "copy"; text: string }
  | { kind: "cut"; text: string; chord: StreamEditChord }
  | { kind: "chord"; chord: StreamEditChord };

export interface StreamEditRow {
  label: string;
  verb: StreamEditVerb;
}

const CHORDS = {
  undo: { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: false },
  redo: { key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true },
  selectAll: { key: "a", code: "KeyA", ctrlKey: true, shiftKey: false },
  /**
   * Backspace, not Ctrl+X: with a selection it removes exactly the selection,
   * and it is the one editing key that means the same thing on every
   * platform's Chromium, so a cut does not depend on which OS the worker runs.
   */
  deleteSelection: { key: "Backspace", code: "Backspace", ctrlKey: false, shiftKey: false },
} as const satisfies Record<string, StreamEditChord>;

/**
 * The label and the verb for one `role` row, or null for a role this surface
 * cannot perform at all.
 *
 * Electron gives a `role` row its label and its behaviour from the platform's
 * own edit menu, so the builder emits `{role, enabled}` and nothing else. A
 * DOM menu gets neither, which is why every one of these rows used to render
 * as a blank, enabled, do-nothing button where undo, cut, copy and paste
 * live. The labels are Chrome's, in Chrome's wording.
 */
export function streamEditRow(
  role: NonNullable<ContextMenuTemplateItem["role"]>,
  target: PageContextMenuParams,
): StreamEditRow | null {
  const selection = target.selectionText;
  switch (role) {
    case "undo":
      return { label: "Undo", verb: { kind: "chord", chord: CHORDS.undo } };
    case "redo":
      return { label: "Redo", verb: { kind: "chord", chord: CHORDS.redo } };
    case "cut":
      return { label: "Cut", verb: { kind: "cut", text: selection, chord: CHORDS.deleteSelection } };
    case "copy":
      return { label: "Copy", verb: { kind: "copy", text: selection } };
    case "paste":
      return { label: "Paste", verb: { kind: "paste" } };
    case "pasteAndMatchStyle":
      // `Input.insertText` inserts text and only text, so a paste over this
      // surface never carries style: the two rows do the same thing, and the
      // builder already gives this one its own label.
      return { label: "Paste as Plain Text", verb: { kind: "paste" } };
    case "delete":
      return { label: "Delete", verb: { kind: "chord", chord: CHORDS.deleteSelection } };
    case "selectAll":
      return { label: "Select All", verb: { kind: "chord", chord: CHORDS.selectAll } };
    default:
      return null;
  }
}

/**
 * An Electron accelerator (`"CommandOrControl+Shift+R"`) as the label the
 * VIEWER'S browser would show for it (`"⇧⌘R"`, `"Ctrl+Shift+R"`).
 *
 * The template carries accelerators because the desktop hands the same
 * template to `Menu.buildFromTemplate`, which speaks that spelling. A DOM
 * menu has to render it, and Electron's spelling is not something to show a
 * person. The platform here is the one whose keyboard the person is at — the
 * shell binds ⌘ on a Mac and Ctrl elsewhere — which is a different question
 * from the modifier a forwarded chord carries into the cloud page.
 */
export function acceleratorLabel(
  accelerator: string | undefined,
  platform: ShortcutPlatform,
): string | null {
  if (accelerator === undefined) return null;
  // `shortcutAccelerator` writes the portable `Mod` as Electron's
  // `CommandOrControl` and leaves `Alt`/`Shift` alone, so the way back is
  // that one word.
  return shortcutLabel(accelerator.replace(/CommandOrControl/giu, "Mod"), platform);
}

/** The platform whose keyboard the person reading this menu is using. */
export function viewerPlatform(): ShortcutPlatform {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform) ? "darwin" : "other";
}
