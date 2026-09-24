/**
 * The right-click menu of a web page, shaped after Chrome's (lifted out of
 * `apps/desktop/src/main` in S6 so both hosts build the same menu:
 * docs/web-browser-design.md §11, "Context menu").
 *
 * The builder is PURE — it names no window, no `Menu`, and no Electron
 * import. What the pointer is over travels as `PageContextMenuParams`, a
 * structural subset of Electron's `PageContextMenuParams` (so the desktop passes
 * Chromium's own object straight in) and of the hit report the cloud tab's
 * init script sends over the shell socket. What comes back is a template of
 * `ContextMenuTemplateItem`, a structural subset of Electron's
 * `ContextMenuTemplateItem` (so the desktop hands it to
 * `Menu.buildFromTemplate`) that the web shell renders as DOM.
 */

import {
  shortcutAccelerator,
  type ShortcutPlatform,
  type ShortcutSettings,
} from "./shortcuts.js";
import { webSearchLabel, type WebSearchProvider } from "./search.js";
import { isAllowedNavigation, viewSourceUrl } from "./url.js";

/** The editing capabilities of the field under the pointer. */
export interface ContextMenuEditFlags {
  canUndo: boolean;
  canRedo: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canDelete: boolean;
  canSelectAll: boolean;
}

/** The playback capabilities of the media element under the pointer. */
export interface ContextMenuMediaFlags {
  isLooping: boolean;
  canLoop: boolean;
  isControlsVisible: boolean;
  canToggleControls: boolean;
  isShowingPictureInPicture: boolean;
  canShowPictureInPicture: boolean;
  canSave: boolean;
}

/**
 * What the pointer was over. Every field is one Electron's own
 * `PageContextMenuParams` carries with the same name and meaning, so the desktop
 * passes Chromium's object in unchanged; the cloud tab's init script reports
 * the same shape (`StreamContextTarget` in `./socket.ts` widens to it).
 */
export interface PageContextMenuParams {
  linkURL: string;
  pageURL: string;
  srcURL: string;
  selectionText: string;
  misspelledWord: string;
  dictionarySuggestions: string[];
  hasImageContents: boolean;
  isEditable: boolean;
  mediaType: "none" | "image" | "audio" | "video" | "canvas" | "file" | "plugin";
  editFlags: ContextMenuEditFlags;
  mediaFlags: ContextMenuMediaFlags;
}

/**
 * One row of the menu. A structural subset of Electron's
 * `ContextMenuTemplateItem`: `role` is the editing verb Chromium performs
 * for itself on the desktop, which a DOM menu over a streamed pane maps to a
 * host call instead.
 */
export interface ContextMenuTemplateItem {
  label?: string;
  enabled?: boolean;
  checked?: boolean;
  accelerator?: string;
  type?: "normal" | "separator" | "checkbox";
  role?: "undo" | "redo" | "cut" | "copy" | "paste" | "pasteAndMatchStyle" | "delete" | "selectAll";
  click?: () => void;
}

/**
 * The right-click menu of a web page, shaped after Chrome's: what the pointer
 * is over (a link, an image, a video, selected words, a text field, or plain
 * page) decides which sections appear, in Chrome's order and with Chrome's
 * wording. The builder is pure — the browser controller supplies what it
 * knows (policy verdicts, history) and the actions to run — so the shape of
 * every menu can be checked without Electron.
 */

/** A playback change applied to the media element under the pointer. */
export type ContextMediaCommand = "loop" | "controls" | "pictureInPicture";

export interface PageContextMenuState {
  canGoBack: boolean;
  canGoForward: boolean;
  /** Text, images, and addresses may leave the page (Settings → policy). */
  copyAllowed: boolean;
  pasteAllowed: boolean;
  /** Files may be written to disk: every "Save … As…" item. */
  downloadAllowed: boolean;
  printAllowed: boolean;
  /** The tab is already showing a reader page, so the item leaves it. */
  inReaderView: boolean;
  platform: ShortcutPlatform;
  shortcuts: ShortcutSettings;
  /** The engine "Search … for" names and runs on (`search.webProvider`). */
  searchProvider: WebSearchProvider;
}

export interface PageContextMenuActions {
  back(): void;
  forward(): void;
  reload(): void;
  openInNewTab(url: string): void;
  openInGlance(url: string): void;
  copyText(text: string): void;
  /** Copy the image under the pointer as image data, not its address. */
  copyImage(): void;
  /** Download `url` through the tab's session, prompting for a location. */
  save(url: string): void;
  savePage(): void;
  search(query: string): void;
  /** macOS dictionary panel for the selection. */
  lookUp(): void;
  readAloud(text: string): void;
  /** Show the page's article stripped to its prose, or leave reader view. */
  readerView(): void;
  print(): void;
  inspect(): void;
  replaceMisspelling(word: string): void;
  addToDictionary(word: string): void;
  showEmojiPanel(): void;
  media(command: ContextMediaCommand): void;
  /** Stage the image under the pointer in the agent console's composer. */
  addImageToChat(): void;
  /** Stage the selected words in the agent console's composer. */
  addSelectionToChat(text: string): void;
}

type Section = ContextMenuTemplateItem[];

/** Chrome shows this much of the selection inside a menu label. */
const LABEL_EXCERPT_LENGTH = 32;

export function menuExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= LABEL_EXCERPT_LENGTH) return collapsed;
  return `${collapsed.slice(0, LABEL_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

function emailAddress(linkURL: string): string | null {
  if (!/^mailto:/iu.test(linkURL)) return null;
  const address = linkURL.slice("mailto:".length).split("?", 1)[0] ?? "";
  try {
    return address === "" ? null : decodeURIComponent(address);
  } catch {
    return address;
  }
}

function navigationSection(
  state: PageContextMenuState,
  actions: PageContextMenuActions,
): Section {
  return [
    {
      label: "Back",
      enabled: state.canGoBack,
      accelerator: shortcutAccelerator(state.shortcuts.back),
      click: () => actions.back(),
    },
    {
      label: "Forward",
      enabled: state.canGoForward,
      accelerator: shortcutAccelerator(state.shortcuts.forward),
      click: () => actions.forward(),
    },
    {
      label: "Reload",
      accelerator: shortcutAccelerator(state.shortcuts.reload),
      click: () => actions.reload(),
    },
  ];
}

function printItem(
  state: PageContextMenuState,
  actions: PageContextMenuActions,
): ContextMenuTemplateItem {
  return {
    label: "Print…",
    enabled: state.printAllowed,
    accelerator: shortcutAccelerator(state.shortcuts.print),
    click: () => actions.print(),
  };
}

function pageSection(
  state: PageContextMenuState,
  actions: PageContextMenuActions,
): Section {
  return [
    {
      // Safari's wording: the item says where it takes you, not what it is.
      label: state.inReaderView ? "Hide Reader" : "Show Reader",
      accelerator: shortcutAccelerator(state.shortcuts.readerView),
      click: () => actions.readerView(),
    },
    {
      label: "Save Page As…",
      enabled: state.downloadAllowed,
      click: () => actions.savePage(),
    },
    printItem(state, actions),
  ];
}

function sourceSection(
  params: PageContextMenuParams,
  actions: PageContextMenuActions,
): Section {
  const source = viewSourceUrl(params.pageURL);
  if (source === null) return [];
  return [
    { label: "View Page Source", click: () => actions.openInNewTab(source) },
  ];
}

function linkSection(
  params: PageContextMenuParams,
  state: PageContextMenuState,
  actions: PageContextMenuActions,
): Section {
  const email = emailAddress(params.linkURL);
  if (email !== null) {
    return [
      {
        label: "Copy Email Address",
        enabled: state.copyAllowed,
        click: () => actions.copyText(email),
      },
    ];
  }
  if (params.linkURL === "" || !isAllowedNavigation(params.linkURL)) return [];
  return [
    {
      label: "Open Link in New Tab",
      click: () => actions.openInNewTab(params.linkURL),
    },
    {
      label: "Open Link in Glance",
      click: () => actions.openInGlance(params.linkURL),
    },
    { type: "separator" },
    {
      label: "Save Link As…",
      enabled: state.downloadAllowed,
      click: () => actions.save(params.linkURL),
    },
    {
      label: "Copy Link Address",
      enabled: state.copyAllowed,
      click: () => actions.copyText(params.linkURL),
    },
  ];
}

function imageSection(
  params: PageContextMenuParams,
  state: PageContextMenuState,
  actions: PageContextMenuActions,
): Section {
  if (params.mediaType !== "image" && params.mediaType !== "canvas") return [];
  const address = params.mediaType === "image" ? params.srcURL : "";
  const items: Section = [];
  if (isAllowedNavigation(address)) {
    items.push({
      label: "Open Image in New Tab",
      click: () => actions.openInNewTab(address),
    });
  }
  if (address !== "") {
    items.push({
      label: "Save Image As…",
      enabled: state.downloadAllowed,
      click: () => actions.save(address),
    });
  }
  items.push({
    label: "Copy Image",
    enabled: state.copyAllowed && params.hasImageContents,
    click: () => actions.copyImage(),
  });
  if (address !== "") {
    items.push({
      label: "Copy Image Address",
      enabled: state.copyAllowed,
      click: () => actions.copyText(address),
    });
  }
  if (/^https?:/iu.test(address)) {
    items.push({
      label: "Search Image with Google",
      enabled: state.copyAllowed,
      click: () =>
        actions.openInNewTab(
          `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(address)}`,
        ),
    });
  }
  if (params.mediaType === "image" && address !== "") {
    items.push({
      label: "Add Image to Chat",
      // The pixels go to the model, so the same policy as a copy applies.
      enabled: state.copyAllowed && params.hasImageContents,
      click: () => actions.addImageToChat(),
    });
  }
  return items;
}

function mediaSection(
  params: PageContextMenuParams,
  state: PageContextMenuState,
  actions: PageContextMenuActions,
): Section {
  if (params.mediaType !== "video" && params.mediaType !== "audio") return [];
  const noun = params.mediaType === "video" ? "Video" : "Audio";
  const flags = params.mediaFlags;
  const items: Section = [
    {
      label: "Loop",
      type: "checkbox",
      checked: flags.isLooping,
      enabled: flags.canLoop,
      click: () => actions.media("loop"),
    },
    {
      label: "Show Controls",
      type: "checkbox",
      checked: flags.isControlsVisible,
      enabled: flags.canToggleControls,
      click: () => actions.media("controls"),
    },
  ];
  if (params.mediaType === "video") {
    items.push({
      label: "Picture in Picture",
      type: "checkbox",
      checked: flags.isShowingPictureInPicture,
      enabled: flags.canShowPictureInPicture || flags.isShowingPictureInPicture,
      click: () => actions.media("pictureInPicture"),
    });
  }
  if (params.srcURL === "") return items;
  items.push(
    { type: "separator" },
    {
      label: `Save ${noun} As…`,
      enabled: state.downloadAllowed && flags.canSave,
      click: () => actions.save(params.srcURL),
    },
    {
      label: `Copy ${noun} Address`,
      enabled: state.copyAllowed,
      click: () => actions.copyText(params.srcURL),
    },
  );
  if (isAllowedNavigation(params.srcURL)) {
    items.push({
      label: `Open ${noun} in New Tab`,
      click: () => actions.openInNewTab(params.srcURL),
    });
  }
  return items;
}

function lookUpSection(
  selection: string,
  state: PageContextMenuState,
  actions: PageContextMenuActions,
): Section {
  if (state.platform !== "darwin" || selection === "") return [];
  return [
    {
      label: `Look Up “${menuExcerpt(selection)}”`,
      enabled: state.copyAllowed,
      click: () => actions.lookUp(),
    },
  ];
}

function searchSection(
  selection: string,
  state: PageContextMenuState,
  actions: PageContextMenuActions,
): Section {
  return [
    {
      label: `Search ${webSearchLabel(state.searchProvider)} for “${menuExcerpt(selection)}”`,
      // The words leave the page exactly as a copy would, so the same policy applies.
      enabled: state.copyAllowed,
      click: () => actions.search(selection),
    },
    {
      label: "Read Aloud",
      enabled: state.copyAllowed,
      click: () => actions.readAloud(selection),
    },
    {
      label: "Add Selection to Chat",
      enabled: state.copyAllowed,
      click: () => actions.addSelectionToChat(selection),
    },
  ];
}

function selectionSection(
  selection: string,
  state: PageContextMenuState,
  actions: PageContextMenuActions,
): Section {
  return [
    { role: "copy", enabled: state.copyAllowed },
    ...searchSection(selection, state, actions),
  ];
}

function spellingSection(
  params: PageContextMenuParams,
  actions: PageContextMenuActions,
): Section {
  const word = params.misspelledWord;
  if (word === "") return [];
  const suggestions: Section =
    params.dictionarySuggestions.length === 0
      ? [{ label: "No Guesses Found", enabled: false }]
      : params.dictionarySuggestions.slice(0, 5).map((suggestion) => ({
          label: suggestion,
          click: () => actions.replaceMisspelling(suggestion),
        }));
  return [
    ...suggestions,
    { type: "separator" },
    {
      label: "Add to Dictionary",
      click: () => actions.addToDictionary(word),
    },
  ];
}

function editingSection(
  params: PageContextMenuParams,
  state: PageContextMenuState,
  actions: PageContextMenuActions,
): Section {
  const flags = params.editFlags;
  const items: Section = [];
  if (state.platform === "darwin") {
    items.push(
      { label: "Emoji & Symbols", click: () => actions.showEmojiPanel() },
      { type: "separator" },
    );
  }
  items.push(
    { role: "undo", enabled: flags.canUndo },
    { role: "redo", enabled: flags.canRedo },
    { type: "separator" },
    { role: "cut", enabled: flags.canCut && state.copyAllowed },
    { role: "copy", enabled: flags.canCopy && state.copyAllowed },
    { role: "paste", enabled: flags.canPaste && state.pasteAllowed },
    {
      role: "pasteAndMatchStyle",
      label: "Paste as Plain Text",
      enabled: flags.canPaste && state.pasteAllowed,
    },
    { role: "delete", enabled: flags.canDelete },
    { type: "separator" },
    { role: "selectAll", enabled: flags.canSelectAll },
  );
  return items;
}

/** Join the non-empty sections with a separator between each pair. */
function joinSections(sections: Section[]): ContextMenuTemplateItem[] {
  const template: ContextMenuTemplateItem[] = [];
  for (const section of sections) {
    if (section.length === 0) continue;
    if (template.length > 0) template.push({ type: "separator" });
    template.push(...section);
  }
  return template;
}

export function buildPageContextMenu(
  params: PageContextMenuParams,
  state: PageContextMenuState,
  actions: PageContextMenuActions,
): ContextMenuTemplateItem[] {
  const selection = params.selectionText.trim();
  const link = linkSection(params, state, actions);
  const image = imageSection(params, state, actions);
  const media = mediaSection(params, state, actions);
  const inspect: Section = [
    { label: "Inspect", click: () => actions.inspect() },
  ];

  if (params.isEditable) {
    return joinSections([
      spellingSection(params, actions),
      link,
      image,
      lookUpSection(selection, state, actions),
      editingSection(params, state, actions),
      selection === "" ? [] : searchSection(selection, state, actions),
      inspect,
    ]);
  }

  const overSomething =
    link.length > 0 || image.length > 0 || media.length > 0;
  if (!overSomething && selection === "") {
    return joinSections([
      navigationSection(state, actions),
      pageSection(state, actions),
      [...sourceSection(params, actions), ...inspect],
    ]);
  }

  return joinSections([
    link,
    image,
    media,
    lookUpSection(selection, state, actions),
    selection === "" ? [] : selectionSection(selection, state, actions),
    selection === "" ? [] : [printItem(state, actions)],
    inspect,
  ]);
}

/** A file name for "Save Page As…": the title, else the host, else "page". */
export function pageFileName(title: string, url: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "")
    .slice(0, 100)
    .trim();
  if (cleaned !== "") return cleaned;
  try {
    const host = new URL(url).hostname;
    if (host !== "") return host;
  } catch {
    // Not an address at all; fall through to the generic name.
  }
  return "page";
}

/**
 * Page-world script that applies `command` to the media element the menu was
 * opened over. Chromium hands the menu only the element's address, so the
 * element is found again by that address inside its own frame; a frame with
 * a single player is matched regardless, which covers players streaming
 * through MediaSource whose `currentSrc` is a blob no longer resolvable.
 */
export function contextMediaScript(
  srcURL: string,
  command: ContextMediaCommand,
): string {
  return `(() => {
  const src = ${JSON.stringify(srcURL)};
  const all = [...document.querySelectorAll("video,audio")];
  const media =
    all.find((candidate) => candidate.currentSrc === src || candidate.src === src) ??
    (all.length === 1 ? all[0] : null);
  if (!media) return false;
  switch (${JSON.stringify(command)}) {
    case "loop":
      media.loop = !media.loop;
      return true;
    case "controls":
      media.controls = !media.controls;
      return true;
    case "pictureInPicture":
      if (document.pictureInPictureElement === media) return document.exitPictureInPicture();
      if (!(media instanceof HTMLVideoElement) || media.disablePictureInPicture) return false;
      return media.requestPictureInPicture();
    default:
      return false;
  }
})()`;
}
