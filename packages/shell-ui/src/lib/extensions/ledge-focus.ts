/**
 * ⌘⇧E (`focusLedge`, docs/extensions.md §2): the keyboard on the Ledge — ←/→
 * walk it, ↵ runs the icon, 1–9 run the nth, ⎋ gives the keyboard back to
 * whatever had it. The Ledge (components/extensions/Ledge.tsx) keeps a roving
 * tabindex; this finds the one on screen (the card's, else the rail's) and
 * puts the keyboard on its current item, remembering where it came from.
 */

/** Every Ledge item (icons, then ⋯, or the empty slot), in order. */
export function ledgeItems(ledge: Element): HTMLElement[] {
  return [...ledge.querySelectorAll<HTMLElement>("[data-ledge-item]")];
}

/** Where the keyboard was before ⌘⇧E. */
let returnTo: HTMLElement | null = null;

function onScreen(el: HTMLElement): boolean {
  if (el.closest("[inert]") !== null) return false;
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.right > 0 && box.left < window.innerWidth;
}

/** The keyboard on the Ledge on screen; false with none (the sidebar hidden, the web). */
export function focusLedge(): boolean {
  const ledge = [...document.querySelectorAll<HTMLElement>("[data-ledge]")].find(onScreen);
  if (ledge === undefined) return false;
  const items = ledgeItems(ledge);
  const target = items.find((item) => item.tabIndex === 0) ?? items[0];
  if (target === undefined) return false;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !ledge.contains(active)) returnTo = active;
  target.focus({ preventScroll: true });
  return true;
}

/** ⎋ on the Ledge: the keyboard back where it was (or nowhere, if that is gone). */
export function leaveLedge(): void {
  const to = returnTo;
  returnTo = null;
  if (to !== null && to.isConnected) {
    to.focus({ preventScroll: true });
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}
