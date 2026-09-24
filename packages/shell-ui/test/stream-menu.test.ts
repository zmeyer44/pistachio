/**
 * The streamed pane's context menu, which is pure: what the builder is told
 * (src/lib/stream-menu.ts), not how the web wires it. The findings these pin
 * are #8 (blank, enabled, inert `role` rows), #22 (allowances hard-coded to
 * `true` instead of read from `getBrowserControls`), #38 (history and reader
 * state hard-coded; media rows offered and then refused) and #45 (Electron
 * accelerator spelling rendered into the DOM).
 */

import { describe, expect, it } from "vitest";
import {
  BROWSER_PERMISSIONS,
  GUARDED_BROWSER_ACTIONS,
  type ActionDecision,
  type BrowserControlsSnapshot,
  type BrowserPermission,
  type BrowserPolicyVerdict,
  type GuardedBrowserAction,
  type PermissionDecision,
} from "@pistachio/shell-contracts/browser-controls";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { buildPageContextMenu, type PageContextMenuParams } from "@pistachio/shell-contracts/page-context-menu";
import { DEFAULT_SHORTCUTS } from "@pistachio/shell-contracts/shortcuts";
import {
  acceleratorLabel,
  isStreamReaderUrl,
  streamEditRow,
  streamMediaFlags,
  streamMenuState,
} from "../src/lib/stream-menu";

function tab(patch: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
  return {
    id: "tab-1",
    spaceId: "space-1",
    title: "Example",
    url: "https://example.com/",
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    kind: "human",
    runId: null,
    lifecycle: "live",
    lastActiveAt: 0,
    unlisted: false,
    anchorId: null,
    ...patch,
  };
}

function controls(actions: Partial<Record<GuardedBrowserAction, ActionDecision>>): BrowserControlsSnapshot {
  return {
    tabId: "tab-1",
    tabKind: "human",
    origin: "https://example.com",
    secure: true,
    zoomPercent: 100,
    muted: false,
    permissions: Object.fromEntries(
      BROWSER_PERMISSIONS.map((permission) => [permission, { decision: "ask", source: "default", reason: "" }]),
    ) as Record<BrowserPermission, BrowserPolicyVerdict<PermissionDecision>>,
    externalAppSchemes: [],
    actions: Object.fromEntries(
      GUARDED_BROWSER_ACTIONS.map((action) => [
        action,
        { decision: actions[action] ?? "allow", source: "managed", reason: "" },
      ]),
    ) as Record<GuardedBrowserAction, BrowserPolicyVerdict<ActionDecision>>,
    passkeys: {
      webAuthnAvailable: false,
      platformAuthenticatorAvailable: false,
      conditionalMediationAvailable: false,
      touchIdConfigured: false,
    },
    pendingPermissions: [],
    pendingPasskeyRequests: [],
    downloads: [],
    recentEvents: [],
  };
}

function target(patch: Partial<PageContextMenuParams> = {}): PageContextMenuParams {
  return {
    linkURL: "",
    pageURL: "https://example.com/",
    srcURL: "",
    selectionText: "",
    misspelledWord: "",
    dictionarySuggestions: [],
    hasImageContents: false,
    isEditable: false,
    mediaType: "none",
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: false,
    },
    mediaFlags: {
      isLooping: false,
      canLoop: false,
      isControlsVisible: false,
      canToggleControls: false,
      isShowingPictureInPicture: false,
      canShowPictureInPicture: false,
      canSave: false,
    },
    ...patch,
  };
}

describe("streamMenuState", () => {
  it("takes the history and the reader state from the tab, not from a constant", () => {
    const state = streamMenuState({ tab: tab({ canGoBack: true }), controls: null, shortcuts: null });
    expect(state.canGoBack).toBe(true);
    expect(state.canGoForward).toBe(false);
    expect(state.inReaderView).toBe(false);
  });

  it("knows a cloud reader tab, whose address IS the article", () => {
    // The item then says "Hide Reader", and toggling it closes the reader tab
    // — which is what the host does. Before this it said "Show Reader".
    const reader = tab({ url: "data:text/html;charset=utf-8,%3Chtml%3E" });
    expect(isStreamReaderUrl(reader.url)).toBe(true);
    expect(streamMenuState({ tab: reader, controls: null, shortcuts: null }).inReaderView).toBe(true);
    expect(isStreamReaderUrl("https://example.com/data:text/html")).toBe(false);
  });

  it("reads every guarded allowance from the host's verdicts", () => {
    const state = streamMenuState({ tab: tab(), controls: controls({ copy: "block", print: "block" }), shortcuts: null });
    expect(state.copyAllowed).toBe(false);
    expect(state.printAllowed).toBe(false);
    expect(state.pasteAllowed).toBe(true);
    expect(state.downloadAllowed).toBe(true);
  });

  it("allows nothing at all when the host never answered", () => {
    // FAIL CLOSED (#22): with no snapshot there is no verdict, and no verdict
    // is not permission. The store's neutral snapshot says the same thing.
    const state = streamMenuState({ tab: tab(), controls: null, shortcuts: null });
    expect([state.copyAllowed, state.pasteAllowed, state.downloadAllowed, state.printAllowed]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("never offers the Mac's emoji panel, whatever the viewer runs", () => {
    expect(streamMenuState({ tab: tab(), controls: null, shortcuts: null }).platform).toBe("other");
  });
});

describe("streamMediaFlags", () => {
  it("clears the capabilities nothing on this surface can perform, and keeps the state", () => {
    const media = target({
      mediaType: "video",
      srcURL: "https://example.com/clip.mp4",
      mediaFlags: {
        isLooping: true,
        canLoop: true,
        isControlsVisible: true,
        canToggleControls: true,
        isShowingPictureInPicture: false,
        canShowPictureInPicture: true,
        canSave: true,
      },
    });
    const flags = streamMediaFlags(media).mediaFlags;
    expect([flags.canLoop, flags.canToggleControls, flags.canShowPictureInPicture]).toEqual([false, false, false]);
    expect([flags.isLooping, flags.isControlsVisible, flags.canSave]).toEqual([true, true, true]);
  });

  it("leaves the three checkboxes disabled rather than live and inert", () => {
    const state = streamMenuState({ tab: tab(), controls: controls({}), shortcuts: null });
    const template = buildPageContextMenu(
      streamMediaFlags(target({ mediaType: "video", mediaFlags: { ...target().mediaFlags, canLoop: true, canToggleControls: true, canShowPictureInPicture: true } })),
      state,
      actions(),
    );
    const rows = template.filter((item) => item.type === "checkbox");
    expect(rows.map((item) => item.label)).toEqual(["Loop", "Show Controls", "Picture in Picture"]);
    expect(rows.every((item) => item.enabled === false)).toBe(true);
  });
});

describe("streamEditRow", () => {
  it("gives every editing role a label and a verb", () => {
    const roles = ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll"] as const;
    expect(roles.map((role) => streamEditRow(role, target({ selectionText: "hi" }))?.label)).toEqual([
      "Undo",
      "Redo",
      "Cut",
      "Copy",
      "Paste",
      "Paste as Plain Text",
      "Delete",
      "Select All",
    ]);
  });

  it("pastes the person's clipboard rather than pressing a key in the page", () => {
    // The cloud machine's clipboard is not the person's, so paste travels as
    // an argument (`pasteText`), and "paste and match style" is the same call
    // because `Input.insertText` carries no style.
    expect(streamEditRow("paste", target())?.verb).toEqual({ kind: "paste" });
    expect(streamEditRow("pasteAndMatchStyle", target())?.verb).toEqual({ kind: "paste" });
  });

  it("copies the selection the hit report already carried", () => {
    expect(streamEditRow("copy", target({ selectionText: "invoice 42" }))?.verb).toEqual({
      kind: "copy",
      text: "invoice 42",
    });
  });

  it("cuts by copying here and deleting there, with a key every platform binds", () => {
    const verb = streamEditRow("cut", target({ selectionText: "invoice 42" }))?.verb;
    expect(verb).toEqual({
      kind: "cut",
      text: "invoice 42",
      chord: { key: "Backspace", code: "Backspace", ctrlKey: false, shiftKey: false },
    });
  });

  it("sends undo, redo and select-all as chords the CLOUD page's Chromium binds", () => {
    // Ctrl, not ⌘: the chord is interpreted by the worker's Chromium, not by
    // the Mac the person is sitting at.
    expect(streamEditRow("undo", target())?.verb).toEqual({
      kind: "chord",
      chord: { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: false },
    });
    expect(streamEditRow("redo", target())?.verb).toEqual({
      kind: "chord",
      chord: { key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true },
    });
    expect(streamEditRow("selectAll", target())?.verb).toEqual({
      kind: "chord",
      chord: { key: "a", code: "KeyA", ctrlKey: true, shiftKey: false },
    });
  });

  it("covers every role the builder can emit", () => {
    // The builder's `role` union is the list; a role added to it with no row
    // here would render blank again, so this is the guard against that.
    const template = buildPageContextMenu(
      target({ isEditable: true, selectionText: "x", editFlags: { ...target().editFlags, canPaste: true } }),
      streamMenuState({ tab: tab(), controls: controls({}), shortcuts: null }),
      actions(),
    );
    const roles = template.flatMap((item) => (item.role === undefined ? [] : [item.role]));
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.every((role) => streamEditRow(role, target()) !== null)).toBe(true);
  });
});

describe("acceleratorLabel", () => {
  it("shows the viewer's own spelling, never Electron's", () => {
    const reload = buildPageContextMenu(
      target(),
      streamMenuState({ tab: tab(), controls: controls({}), shortcuts: DEFAULT_SHORTCUTS }),
      actions(),
    ).find((item) => item.label === "Reload");
    expect(reload?.accelerator).toBe("CommandOrControl+R");
    expect(acceleratorLabel(reload?.accelerator, "darwin")).toBe("⌘R");
    expect(acceleratorLabel(reload?.accelerator, "other")).toBe("Ctrl+R");
  });

  it("answers null for a row with no shortcut, so nothing is drawn", () => {
    expect(acceleratorLabel(undefined, "other")).toBeNull();
    expect(acceleratorLabel("Nonsense", "other")).toBeNull();
  });
});

/** Every action the builder takes, doing nothing: this file tests the shape. */
function actions(): Parameters<typeof buildPageContextMenu>[2] {
  const noop = (): void => undefined;
  return {
    back: noop,
    forward: noop,
    reload: noop,
    openInNewTab: noop,
    openInGlance: noop,
    copyText: noop,
    copyImage: noop,
    save: noop,
    savePage: noop,
    search: noop,
    lookUp: noop,
    readAloud: noop,
    readerView: noop,
    print: noop,
    inspect: noop,
    replaceMisspelling: noop,
    addToDictionary: noop,
    showEmojiPanel: noop,
    media: noop,
    addImageToChat: noop,
    addSelectionToChat: noop,
  };
}
