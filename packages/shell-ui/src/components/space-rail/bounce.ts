/**
 * A rail item taking something — a row or a favorite let go on it, a space
 * merged into it — gives a little bounce (`data-received`, shell.css's
 * desk-receive), as it does when a desk window goes into it (desk-engine.ts's
 * #bounce, whose length this is). Restarted if one is running.
 */

/** desk-engine.ts's RECEIVE_MS: the bounce and a beat after it. */
const RECEIVE_MS = 560;

export function bounceRailItem(el: HTMLElement | null | undefined): void {
  if (el === null || el === undefined || !el.isConnected) return;
  delete el.dataset["received"];
  // (A style read between the two writes restarts a bounce already running.)
  void el.offsetWidth;
  el.dataset["received"] = "";
  window.setTimeout(() => {
    if (el.dataset["received"] !== undefined) delete el.dataset["received"];
  }, RECEIVE_MS);
}

/** The rail's tile of `groupId`, wherever the column draws it. */
export function railTileOf(groupId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid='rail-space'][data-group-id='${CSS.escape(groupId)}']`);
}
