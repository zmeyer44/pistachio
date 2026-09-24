"use client";

/**
 * The three capabilities that only exist because the pane is a picture of a
 * page inside somebody else's browser (docs/web-browser-design.md §11).
 *
 * On the desktop Chromium does all of this for itself: it opens the file
 * picker, it writes the clipboard, it draws the context menu AND performs
 * every editing verb in it. Here the page is a thousand miles away and the
 * person is here, so each one is a round trip over `StreamShellApi` — a
 * page's `filechooser` becomes a real `<input type=file>` in this tab, a
 * page's `copy` becomes `navigator.clipboard.writeText`, and a page's
 * `contextmenu` becomes a DOM menu built by the same pure builder the
 * desktop's native menu is built from, whose rows call the host.
 *
 * The uploads and the clipboard belong to the SESSION, not to a pane, so they
 * are mounted once beside the shell. The menu belongs to the pane the pointer
 * was over.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Paperclip } from "lucide-react";
import {
  acceleratorLabel,
  streamEditRow,
  streamMediaFlags,
  streamMenuState,
  useAppStore,
  viewerPlatform,
  type StreamEditChord,
  type StreamEditVerb,
} from "@pistachio/shell-ui";
import { keyInput, type LiveInput } from "@pistachio/live-view";
import {
  buildPageContextMenu,
  menuExcerpt,
  type ContextMenuTemplateItem,
} from "@pistachio/shell-contracts/page-context-menu";
import { searchUrl } from "@pistachio/shell-contracts/url";
import { MAX_UPLOAD_BYTES, type StreamContextMenuEvent, type StreamFileRequest } from "@pistachio/shell-contracts/socket";
import type { ShellInputEvent, WsShellApi } from "../lib/shell-socket";

/** Bytes → base64 without blowing the stack on a big file. */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

/**
 * A page opened a file picker, so this browser offers one too, and the bytes
 * the person chose go back to the waiting `filechooser`.
 *
 * TWO RULES, both learned the hard way.
 *
 * A PICKER NEEDS A GESTURE. `element.click()` from a socket callback has no
 * transient activation behind it, so the browser refuses to show the dialog —
 * and then neither `change` nor `cancel` ever fires, which leaves the page
 * waiting on an upload the person was never asked for. So the request raises
 * an affordance instead, and the click that opens the picker is the person's.
 *
 * ONLY THE PANE THAT ASKED ANSWERS. The host announces a file request to
 * every attached viewer. A viewer that is not showing that tab has no
 * business opening a dialog for it — and must not CANCEL it either, or one
 * person's other browser tab kills the upload someone else is choosing.
 */
export function useStreamUploads(api: WsShellApi): ReactNode {
  const input = useRef<HTMLInputElement | null>(null);
  const [request, setRequest] = useState<StreamFileRequest | null>(null);
  /** The request the `<input>` is currently open for. */
  const pending = useRef<string | null>(null);

  useEffect(() => {
    return api.onFileRequest((next) => {
      // Whether this viewer is the one showing the tab that asked. The
      // snapshot's visible tabs are the panes on screen here.
      const visible = useAppStore.getState().snapshot?.visibleTabIds ?? [];
      if (!visible.includes(next.tabId)) return;
      // A second request replaces the first: only one picker can be up, and
      // the page that asked first is told rather than left hanging.
      const previous = pending.current;
      if (previous !== null) void api.cancelFileRequest(previous).catch(() => undefined);
      pending.current = null;
      setRequest(next);
    });
  }, [api]);

  /** The person dismissed the offer, or the picker they opened. */
  const cancel = useCallback(
    (requestId: string | null) => {
      pending.current = null;
      setRequest(null);
      if (requestId !== null) void api.cancelFileRequest(requestId).catch(() => undefined);
    },
    [api],
  );

  const choose = useCallback(() => {
    const element = input.current;
    if (request === null || element === null) return;
    pending.current = request.requestId;
    element.value = "";
    element.multiple = request.multiple;
    element.accept = request.accept.join(",");
    // Inside the click handler, so the picker opens with the person's own
    // activation. The offer stays up until the picker settles.
    element.click();
  }, [request]);

  const onChange = useCallback(async () => {
    const requestId = pending.current;
    const element = input.current;
    if (requestId === null || element === null) return;
    const files = [...(element.files ?? [])];
    if (files.length === 0) {
      cancel(requestId);
      return;
    }
    pending.current = null;
    setRequest(null);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_UPLOAD_BYTES) {
      await api.cancelFileRequest(requestId).catch(() => undefined);
      useAppStore.getState().showNotice("That is more than the 32 MB one upload can carry to the cloud browser.", { tone: "warning" });
      return;
    }
    try {
      await api.provideFiles(
        requestId,
        await Promise.all(
          files.map(async (file) => ({ name: file.name, type: file.type, base64: await base64Of(file) })),
        ),
      );
    } catch (error: unknown) {
      useAppStore.getState().showNotice(error instanceof Error ? error.message : "That upload did not go through.", { tone: "warning" });
    }
  }, [api, cancel]);

  // A dismissed picker has to tell the page, or the page waits forever.
  // React has no `onCancel` for an input, so the native event is bound.
  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    const cancelled = (): void => cancel(pending.current);
    element.addEventListener("cancel", cancelled);
    return () => element.removeEventListener("cancel", cancelled);
  }, [cancel]);

  // Escape dismisses the offer the way it dismisses every other prompt, and
  // the page is told rather than left waiting. CAPTURE, because the focused
  // pane forwards every key to the cloud page and stops the event there; a
  // listener that waits for the bubble would never hear this one.
  useEffect(() => {
    if (request === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") cancel(request.requestId);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancel, request]);

  return (
    <>
      {/* The picker is a real input, kept out of the layout rather than out
          of the DOM: nothing else can put a native file dialog on screen. */}
      <input ref={input} type="file" hidden data-testid="stream-file-input" onChange={() => void onChange()} />
      {request === null ? null : (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="The page is asking for a file"
          data-testid="stream-file-prompt"
          // The route's own rule is `.pa-browse > * { height: 100% }`, for the
          // shell's root; this is a sibling of it, and a pill is not a column.
          style={{ height: "auto" }}
          className="fixed bottom-4 left-1/2 z-100 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-alpha-400 bg-background-100 px-4 py-3 shadow-modal"
        >
          <Paperclip className="size-4 shrink-0 text-gray-700" aria-hidden="true" />
          <p className="text-copy-13 text-gray-1000">
            The page wants {request.multiple ? "files" : "a file"} from this computer.
          </p>
          <button
            type="button"
            data-testid="stream-file-choose"
            onClick={choose}
            className="shrink-0 cursor-pointer rounded-md bg-gray-1000 px-2.5 py-1.5 text-label-13 text-background-100"
          >
            {request.multiple ? "Choose files" : "Choose file"}
          </button>
          <button
            type="button"
            data-testid="stream-file-cancel"
            onClick={() => cancel(request.requestId)}
            className="shrink-0 cursor-pointer rounded-md px-2.5 py-1.5 text-label-13 text-gray-900 hover:bg-alpha-200"
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

/**
 * A page copied something, so this browser's clipboard gets it too. Writing
 * needs a user gesture in some browsers and can simply be refused in others;
 * a refusal is shown rather than swallowed, because the person pressed ⌘C and
 * is entitled to know it did not take.
 */
export function useStreamClipboard(api: WsShellApi): void {
  useEffect(() => {
    return api.onClipboardCopy((copy) => {
      if (typeof navigator === "undefined" || navigator.clipboard === undefined) return;
      void navigator.clipboard.writeText(copy.text).then(
        () => {
          if (copy.notice !== undefined) useAppStore.getState().showNotice(copy.notice, { tone: "success" });
        },
        () => {
          useAppStore.getState().showNotice("This browser would not let the page write to your clipboard.", { tone: "warning" });
        },
      );
    });
  }, [api]);
}

/**
 * What a screen reader is told when the tab on screen changes.
 *
 * The pane is pixels — there is no DOM in it for a reader to walk, and the
 * semantic bridge that would mirror the page's accessibility tree is a
 * milestone of its own (§11). What a browser CAN honestly say about a picture
 * is which page it is a picture of, and say it once when that changes, which
 * is what this is. It lives beside the shell rather than inside a pane so that
 * a split of four panes announces one thing, not four.
 */
export function StreamAnnouncer(): ReactNode {
  const snapshot = useAppStore((state) => state.snapshot);
  const active = snapshot?.tabs.find((tab) => tab.id === snapshot.activeTabId) ?? null;
  const said = active === null ? "" : `${active.title.trim() === "" ? "Untitled page" : active.title}, ${active.url}`;
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="stream-announcement"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        margin: -1,
        padding: 0,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        whiteSpace: "nowrap",
        border: 0,
      }}
    >
      {said}
    </p>
  );
}

/* ------------------------------ context menu ------------------------------ */

interface MenuAt {
  event: StreamContextMenuEvent;
  /** Where in the viewport to draw it, from the pane's own box. */
  x: number;
  y: number;
}

/** `keyInput` answers a whole live-view frame; the socket wants the event. */
function eventOf(input: LiveInput | null): ShellInputEvent | null {
  return input !== null && input.t === "input" ? input.event : null;
}

/**
 * Press one chord in the cloud page. Down and up, because a page that watches
 * for `keyup` (and Chromium's own editor, for a held key) needs both.
 */
function press(api: WsShellApi, tabId: string, chord: StreamEditChord): void {
  const event = { ...chord, altKey: false, metaKey: false };
  api.input(tabId, eventOf(keyInput(event, "keyDown")));
  api.input(tabId, eventOf(keyInput(event, "keyUp")));
}

/**
 * Perform one editing verb (`@pistachio/shell-ui`'s `streamEditRow`).
 *
 * This is the DOM menu's answer to `document.execCommand`, which is what
 * Electron's `role` performs on the desktop: paste is the person's clipboard
 * carried as an argument, copy is the selection the hit report already
 * brought, and the rest is a key press the cloud page's own editor handles.
 */
async function runEdit(api: WsShellApi, tabId: string, verb: StreamEditVerb): Promise<void> {
  const notice = (text: string): void => {
    useAppStore.getState().showNotice(text, { tone: "warning" });
  };
  switch (verb.kind) {
    case "paste": {
      // The cloud machine's clipboard is not the person's, and the page
      // cannot be allowed to read this one: the person asked, so this browser
      // is asked, and whatever it hands over is inserted.
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        notice("This browser would not let the page read your clipboard.");
        return;
      }
      if (text === "") return;
      await api.pasteText(tabId, text).catch(() => notice("That paste did not reach the page."));
      return;
    }
    case "copy": {
      if (verb.text === "") return;
      await navigator.clipboard
        .writeText(verb.text)
        .catch(() => notice("This browser would not let anything be copied."));
      return;
    }
    case "cut": {
      if (verb.text !== "") {
        await navigator.clipboard
          .writeText(verb.text)
          .catch(() => notice("This browser would not let anything be copied."));
      }
      press(api, tabId, verb.chord);
      return;
    }
    case "chord":
      press(api, tabId, verb.chord);
      return;
  }
}

/**
 * The right-click menu over a streamed pane.
 *
 * Every row comes from `buildPageContextMenu`, the same pure builder that
 * shapes the desktop's native menu — so the two menus have the same sections,
 * in the same order, with the same wording, and a change to either is a
 * change to both. What differs is where the rows GO: each action maps to a
 * `ShellApi`/`StreamShellApi` call instead of to something Chromium does for
 * itself.
 */
export function PaneContextMenu({
  api,
  tabId,
  surface,
  anchor,
  interaction,
}: {
  api: WsShellApi;
  tabId: string;
  surface: React.RefObject<HTMLElement | null>;
  /** DOM mirrors supply the local pointer position because their layout can differ. */
  anchor?: React.RefObject<{ x: number; y: number } | null>;
  interaction?: number;
}): ReactNode {
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const shortcuts = useAppStore((state) => state.settings.shortcuts);
  const searchProvider = useAppStore((state) => state.settings.search.webProvider);
  // What the menu is TOLD, from what the host said rather than from a row of
  // hard-coded `true`s: this tab's own history and reader state, and the
  // site's policy for the actions the enterprise controls guard.
  const tab = useAppStore((state) => state.snapshot?.tabs.find((entry) => entry.id === tabId) ?? null);
  const controls = useAppStore((state) => state.browserControls);
  useEffect(() => { setMenu(null); }, [interaction]);

  useEffect(() => {
    return api.onContextMenu((event) => {
      if (event.tabId !== tabId) return;
      const image = surface.current?.querySelector("img");
      const box = image?.getBoundingClientRect();
      // The report is in the PAGE's coordinates; the pane's picture is the
      // same page scaled into its box, so one ratio maps one to the other.
      const scale = box === undefined || box.width === 0 ? 1 : box.width / Math.max(1, image?.naturalWidth ?? 1);
      setMenu({
        event,
        x: anchor?.current?.x ?? (box?.left ?? 0) + event.x * scale,
        y: anchor?.current?.y ?? (box?.top ?? 0) + event.y * scale,
      });
    });
  }, [api, tabId, surface, anchor]);

  useEffect(() => {
    if (menu === null) return;
    const close = (): void => setMenu(null);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  if (menu === null) return null;
  const notice = (text: string): void => {
    useAppStore.getState().showNotice(text, { tone: "warning" });
  };
  const copy = (text: string): void => {
    void navigator.clipboard?.writeText(text).catch(() => notice("This browser would not let anything be copied."));
  };
  const state = streamMenuState({ tab, controls, shortcuts, searchProvider });
  // What the pointer was over, minus the playback capabilities nothing on
  // this surface can perform: the rows stay, disabled, instead of being
  // offered and then answering "not available over a streamed pane".
  const target = streamMediaFlags(menu.event.target);
  const template = buildPageContextMenu(target, state, {
    back: () => void api.goBack(tabId),
    forward: () => void api.goForward(tabId),
    reload: () => void api.reload(tabId),
    openInNewTab: (url) => void api.createTab(url),
    // §10: there is no hover preview on a stream surface; the target opens as
    // a tab beside this one, which is what the person wanted to see.
    openInGlance: (url) => void api.createTab(url),
    copyText: copy,
    copyImage: () => notice("The cloud browser can copy an image's address, not the image itself."),
    save: (url) => void api.createTab(url),
    // The page as a file, which in a cloud tab means the page as a PDF: there
    // is no folder on the worker to put an .html and its assets in.
    savePage: () => void api.printToPdf(tabId).catch(() => notice("This page could not be saved.")),
    search: (query) => void api.createTab(searchUrl(query, searchProvider)),
    lookUp: () => notice("Look Up is your Mac's dictionary; it is not in the cloud browser."),
    readAloud: () => notice("Read aloud is not available in the cloud browser."),
    readerView: () => void api.toggleReaderView(tabId),
    print: () => void api.printToPdf(tabId).catch(() => notice("This page could not be printed.")),
    inspect: () => notice("Developer tools are not available over a streamed pane."),
    replaceMisspelling: () => undefined,
    addToDictionary: () => undefined,
    showEmojiPanel: () => undefined,
    media: () => notice("That playback control is not available over a streamed pane."),
    // The composer takes an image's BYTES, which only the cloud page holds:
    // a data: URL would have to travel back through the socket, and a plain
    // address is not what the model is being shown. The address goes to the
    // console as words instead, which is honest about what was sent.
    addImageToChat: () => {
      const src = target.srcURL;
      if (src === "") {
        useAppStore.getState().rejectChatInsert("There is no image here to add.");
        return;
      }
      useAppStore.getState().receiveChatInsert({
        kind: "selection",
        text: src,
        title: "Image",
        url: target.pageURL,
      });
    },
    addSelectionToChat: (text) => {
      useAppStore.getState().receiveChatInsert({
        kind: "selection",
        text,
        title: menuExcerpt(text),
        url: target.pageURL,
      });
    },
  });

  return createPortal(
    <div
      role="menu"
      aria-label="Page actions"
      data-testid="pane-context-menu"
      className="fixed z-100 min-w-52 rounded-md border border-alpha-400 bg-background-100 py-1 shadow-[0_8px_24px_oklch(0_0_0/0.16)]"
      style={{ left: Math.round(menu.x), top: Math.round(menu.y) }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {template.map((item, index) => (
        <MenuRow
          key={index}
          item={item}
          onRun={(verb) => {
            setMenu(null);
            if (verb !== null) void runEdit(api, tabId, verb);
          }}
          target={target}
        />
      ))}
    </div>, document.body,
  );
}

function MenuRow({
  item,
  onRun,
  target,
}: {
  item: ContextMenuTemplateItem;
  onRun: (verb: StreamEditVerb | null) => void;
  target: Parameters<typeof streamEditRow>[1];
}): ReactNode {
  if (item.type === "separator") return <div className="my-1 h-px bg-alpha-400" role="separator" />;
  // A `role` row arrives with no label and no click, because on the desktop
  // Electron supplies both from the platform's edit menu. This is the DOM
  // menu's half of that (§11): the label Chrome uses, and the verb this
  // surface performs it with.
  const edit = item.role === undefined ? null : streamEditRow(item.role, target);
  const label = item.label ?? edit?.label ?? "";
  const enabled = item.enabled !== false && (item.click !== undefined || edit !== null);
  const accelerator = acceleratorLabel(item.accelerator, viewerPlatform());
  return (
    <button
      type="button"
      role={item.type === "checkbox" ? "menuitemcheckbox" : "menuitem"}
      aria-checked={item.type === "checkbox" ? item.checked === true : undefined}
      disabled={!enabled}
      data-role={item.role}
      className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-copy-13 text-gray-1000 hover:bg-alpha-200 disabled:opacity-40 disabled:hover:bg-transparent"
      onClick={() => {
        item.click?.();
        onRun(edit?.verb ?? null);
      }}
    >
      <span className="truncate">{label}</span>
      {accelerator === null ? null : <span className="shrink-0 text-copy-13 text-gray-900">{accelerator}</span>}
    </button>
  );
}
