/**
 * Waking and laying out the tabs a live share holds (docs/live-share.md
 * §6.1), as BrowserController.holdLiveTabs runs it. Each held tab that is
 * asleep is woken — three at a time, each waited on for its page's load at
 * most 8 s, so a page that never finishes loading holds up only its own
 * place — and each is laid out at its size as soon as its own wake is done.
 * The layouts go one at a time, in the order the wakes end: each draws its
 * page for a moment beneath the same view.
 */

/** Held tabs woken at once, at most. */
export const LIVE_WAKES_AT_ONCE = 3;
/** How long a held tab's wake is waited on before its layout goes ahead without it. */
export const LIVE_WAKE_WAIT_MS = 8_000;

export interface HeldTabWork {
  /** The tab is asleep: it must be woken first. */
  asleep(tabId: string): boolean;
  /** Wake it: settles once its page has loaded (or not at all). */
  wake(tabId: string): Promise<unknown>;
  /** Lay its page out at its size: settles on its own, bounded. */
  layOut(tabId: string): Promise<unknown>;
}

/** Wake what is asleep and lay out every held tab; settles when every layout has. */
export async function wakeAndLayOut(tabIds: readonly string[], work: HeldTabWork, wakeWaitMs = LIVE_WAKE_WAIT_MS): Promise<void> {
  const queue = [...tabIds];
  let layouts: Promise<unknown> = Promise.resolve();
  const lane = async (): Promise<void> => {
    for (let tabId = queue.shift(); tabId !== undefined; tabId = queue.shift()) {
      if (work.asleep(tabId)) await within(work.wake(tabId), wakeWaitMs);
      const next = tabId;
      // (A layout that fails is that tab's alone: the next goes on.)
      layouts = layouts.then(() => work.layOut(next)).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIVE_WAKES_AT_ONCE, queue.length) }, lane));
  await layouts;
}

/** Settles when `work` does, or after `ms`, whichever is first; never rejects. */
function within(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}
