/**
 * The desk's prompt over a live page (docs/desk.md, "The foot"): a view of
 * the shell's own that main lays above the tab views (main/desk-bar-view.ts),
 * so the prompt lies on a page as the nub does and no window gives way to it.
 *
 * It is a child window the shell opens by name, which main makes a view of
 * the window instead of a window. The child keeps its opener — it is in the
 * shell's own renderer — so the Bar draws into its document as it draws into
 * its own (a React portal): one tree, one state, nothing sent across to be
 * kept in step. What the document needs to look like the shell's is put
 * there here: the stylesheets, and the root's attributes and variables (the
 * theme), kept as they change.
 *
 * Where no such view can be had — the web, a build where main refuses it —
 * `promptView()` answers null, and the prompt is the shell's own, in a band
 * the desk keeps clear for it.
 */

import { DESK_BAR_VIEW_FRAME, type DeskBarViewPlace } from "@pistachio/shell-contracts/desk";
import { nativeApi } from "../../api";

export interface PromptView {
  /** The view's window (the child the shell opened): the keys struck in the prompt are struck in it. */
  window: Window;
  /** Where the Bar draws the prompt: the view's whole box. One element for as long as the shell's document lives. */
  host: HTMLElement;
}

/** `undefined`: not asked for yet. `null`: there is none to be had. */
let opened: PromptView | null | undefined;
/** The view's document as it was last made ready: a child that navigated has another, bare. */
let ready: Document | null = null;
/** Where the view lies now, as the Bar last placed it; null while it is not over the pages. */
let placed: DeskBarViewPlace | null = null;

const COPIED = "data-prompt-view-style";

/** The shell's stylesheets, as the view's own: every rule the prompt is drawn by is the shell's. */
function copyStyles(to: Document): void {
  for (const stale of to.head.querySelectorAll(`[${COPIED}]`)) stale.remove();
  for (const sheet of document.head.querySelectorAll<HTMLElement>('style, link[rel="stylesheet"]')) {
    const copy = to.importNode(sheet, true) as HTMLElement;
    // (A sheet named by a relative address is the shell's document's to resolve, not about:blank's.)
    if (sheet instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = sheet.href;
    copy.setAttribute(COPIED, "");
    to.head.appendChild(copy);
  }
}

/** The root's attributes — the scheme, the theme's variables, the texture — as the shell's has them. */
function copyRoot(to: Document): void {
  const from = document.documentElement;
  const root = to.documentElement;
  for (const name of root.getAttributeNames()) if (!from.hasAttribute(name)) root.removeAttribute(name);
  for (const name of from.getAttributeNames()) {
    const value = from.getAttribute(name) ?? "";
    if (root.getAttribute(name) !== value) root.setAttribute(name, value);
  }
}

/**
 * The view's document made the prompt's: the shell's sheets and root, nothing of the shell's ground, and the host in
 * it. Asked again whenever the view is used: a document that is not the one made ready (the child navigated — it was
 * opened under its name by an earlier shell document, say) is made ready in its turn, the same host moved into it.
 */
function prepare(view: PromptView): void {
  let doc: Document;
  try {
    doc = view.window.document;
  } catch {
    return;
  }
  if (ready === doc && view.host.ownerDocument === doc && view.host.isConnected) return;
  ready = doc;
  doc.title = "Prompt";
  copyStyles(doc);
  copyRoot(doc);
  // A utility view: nothing of the shell's ground is painted in it (shell.css, body[data-chrome-view]).
  doc.body.dataset["chromeView"] = "prompt";
  for (const child of [...doc.body.children]) if (child !== view.host) child.remove();
  doc.body.appendChild(view.host);
}

function open(): PromptView | null {
  if (typeof window === "undefined" || nativeApi()?.setDeskBarView === undefined) return null;
  let child: Window | null = null;
  try {
    // (No address: a child an earlier document of the shell's opened under this name is taken as it stands, not sent
    // to a blank page again — which would empty it a moment after it was drawn into.)
    child = window.open("", DESK_BAR_VIEW_FRAME);
  } catch {
    child = null;
  }
  // (Refused: main makes no view of it here, and the prompt stays the shell's own.)
  if (child === null) return null;
  const host = document.createElement("div");
  host.className = "desk-prompt-view";
  // The window's own height, for what is sized by it in the shell (`vh`): in the view a `vh` is the view's, a strip
  // as tall as the pill, and a list limited to half of that is three rows of a dozen (shell.css .desk-prompt-view).
  const sized = (): void => host.style.setProperty("--desk-prompt-window-height", `${String(window.innerHeight)}px`);
  sized();
  window.addEventListener("resize", sized);
  const view: PromptView = { window: child, host };
  prepare(view);
  // Kept as the shell's change: a sheet added or rewritten (the dev server's), the theme's variables on the root.
  new MutationObserver(() => {
    prepare(view);
    copyStyles(view.host.ownerDocument);
  }).observe(document.head, { childList: true, subtree: true, characterData: true });
  new MutationObserver(() => {
    prepare(view);
    copyRoot(view.host.ownerDocument);
  }).observe(document.documentElement, { attributes: true });
  // (And once more when the child has settled, should it have been on its way to another document as it was opened.)
  for (const ms of [0, 60, 300, 1000]) window.setTimeout(() => prepare(view), ms);
  return view;
}

/** The prompt's view, opened the first time it is asked for; null where there is none. */
export function promptView(): PromptView | null {
  if (opened === undefined) opened = open();
  // (Closed under us — main dropped it: there is none any more, and none is opened again in this document.)
  if (opened !== null && opened.window.closed) opened = null;
  if (opened !== null) prepare(opened);
  return opened;
}

/**
 * Where the view lies (the window's content box), or null to take it from over the pages. Said to main only when it
 * says something new: the Bar places the view again whenever anything it is measured from is laid out again, and a
 * view moved to where it already lies is still a view moved — in the middle of the pill coming out of the nub.
 */
export function placePromptView(place: DeskBarViewPlace | null): void {
  if (place !== null && opened !== null && opened !== undefined) prepare(opened);
  const before = placed;
  // (Whole pixels, as main lays it: what the view's own window is then measured against — whenPromptViewDrawn.)
  const bounds = place === null ? null : { x: Math.round(place.bounds.x), y: Math.round(place.bounds.y), width: Math.round(place.bounds.width), height: Math.round(place.bounds.height) };
  placed = bounds === null ? null : { bounds };
  const same =
    (before === null && bounds === null) ||
    (before !== null && bounds !== null && before.bounds.x === bounds.x && before.bounds.y === bounds.y && before.bounds.width === bounds.width && before.bounds.height === bounds.height);
  if (same && place?.focus !== true) return;
  nativeApi()?.setDeskBarView?.(bounds === null ? null : { bounds, ...(place?.focus === true ? { focus: true } : {}) });
}

/** A view that has not drawn within this long (ms) is not waited for: hidden with its window, it draws no frame at all. */
const DRAWN_WAIT_MS = 240;

/**
 * Call back once the view is drawing where it was last placed: a frame of its own window's, at that size. Placed, it
 * is main's to lay and show — a moment later, in another process — and its document is laid out for its new box a
 * frame after that; what the Bar draws in it before then is never seen, or is seen where it was not meant (the first
 * time it comes up its window has no size at all). The pill's way out of the nub starts from this, so its first
 * frame is its first. Answers a way to call it off.
 */
export function whenPromptViewDrawn(done: () => void): () => void {
  const view = opened ?? null;
  if (view === null) {
    // (None to wait for. Still not answered in the caller's own turn: it asks from an effect.)
    const soon = window.setTimeout(done, 0);
    return () => window.clearTimeout(soon);
  }
  let frame = 0;
  let over = false;
  const finish = (): void => {
    if (over) return;
    over = true;
    window.clearTimeout(timer);
    done();
  };
  const check = (): void => {
    frame = 0;
    if (over) return;
    const at = placed;
    let fits = false;
    try {
      fits = at !== null && Math.abs(view.window.innerWidth - at.bounds.width) <= 1 && Math.abs(view.window.innerHeight - at.bounds.height) <= 1;
    } catch {
      fits = true;
    }
    if (fits) finish();
    else frame = view.window.requestAnimationFrame(check);
  };
  const timer = window.setTimeout(finish, DRAWN_WAIT_MS);
  try {
    frame = view.window.requestAnimationFrame(check);
  } catch {
    finish();
  }
  return () => {
    over = true;
    window.clearTimeout(timer);
    try {
      if (frame !== 0) view.window.cancelAnimationFrame(frame);
    } catch {
      // (A window gone under us has no frame left to call off.)
    }
  };
}

/**
 * The keyboard in `el`, wherever it lies. In the shell's own document that is the element's to take. In the prompt's
 * view it is only half of it: the view has the keys once main hands them over, so main is asked too — a field the
 * Bar puts the caret back in (a mention picked from the shell's list, a recording done) is typed in again at once.
 */
export function focusField(el: HTMLElement | null): void {
  if (el === null) return;
  el.focus({ preventScroll: true });
  if (el.ownerDocument !== document && placed !== null) nativeApi()?.setDeskBarView?.({ ...placed, focus: true });
}

/**
 * The element with the keyboard in whichever document `within` is in — the shell's, or the prompt view's — when it is
 * inside `within`; null otherwise. (An element moved into the view's document is no longer the shell's
 * `document.activeElement` to find.)
 */
export function focusedWithin(within: Element | null): HTMLElement | null {
  if (within === null) return null;
  const active = within.ownerDocument.activeElement;
  return active !== null && active !== within.ownerDocument.body && within.contains(active) ? (active as HTMLElement) : null;
}

/** An event's target as an element, whichever document made it (`instanceof Element` is the shell's realm's alone). */
export function elementOf(target: EventTarget | null): Element | null {
  return target !== null && (target as Node).nodeType === 1 ? (target as Element) : null;
}

/** Hear `type` on the shell's window and on the prompt view's: a key struck in the prompt is struck in its own document. */
export function listenInBoth<K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void, capture = false): () => void {
  // (On the view's host, not its window: the host is one element for good, where a child that navigates has another
  // window; and whatever is struck in the view is struck inside the host.)
  const host = opened?.host ?? null;
  window.addEventListener(type, listener, capture);
  host?.addEventListener(type, listener as EventListener, capture);
  return () => {
    window.removeEventListener(type, listener, capture);
    host?.removeEventListener(type, listener as EventListener, capture);
  };
}
