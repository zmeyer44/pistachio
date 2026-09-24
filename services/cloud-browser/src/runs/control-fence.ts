/**
 * The control fence, on the agent's side of it (docs/web-browser-design.md
 * W7).
 *
 * W7 says "every agent tool call and every forwarded input carries the
 * generation it was issued under; the host drops anything older", and
 * architecture.md and security.md repeat it. Forwarded input had it — the
 * socket checks `mayAct` before dispatching a key. Tool calls did not: taking
 * control aborts the executor's TURN, but a `page.click` the model had
 * already dispatched is a promise in flight, and it lands on whatever the
 * person is now looking at. That is precisely the "a released agent lands a
 * keystroke behind the person's" case the decision exists to prevent.
 *
 * So the backend a run drives is wrapped. Each tool dispatch is stamped with
 * the generation the run holds the wheel under, and the stamp is re-checked
 * immediately before the Playwright call — after every await the tool
 * dispatch went through — so an action issued under an older fence is refused
 * rather than performed.
 *
 * The re-check has to happen INSIDE the backend, not at its door. A tool call
 * is not one Playwright call: `type` prepares the focus, awaits that round
 * trip, and only then sends keystrokes; `navigate` awaits the network policy
 * before it asks for a page. A takeover landing in one of those awaits used
 * to find the wrapper's checks already spent, and the agent's text arrived in
 * the field the person had moved to. So the wrapper installs the check in an
 * `AsyncLocalStorage` for the duration of the call — the same mechanism
 * `viewer-context.ts` uses, and for the same reason: it survives every await
 * inside the member — and the backend calls `checkActionFence()` immediately
 * before each mutation.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTabInfo, BrowserBackend, PageInspection } from "@pistachio/agent-runtime";
import type { AgentPressableKey } from "@pistachio/protocol";

/** What the fence reads: the session's control, as control last decided it. */
export interface ControlFence {
  holder: "human" | "agent";
  generation: number;
}

/** Raised when a tool call outlived the fence it was issued under. */
export class ControlLostError extends Error {
  constructor(readonly issued: number, readonly current: number) {
    super(
      "the person took control of this session; this action was issued before they did and was not performed",
    );
    this.name = "ControlLostError";
  }
}

/** Whether a failure is the fence refusing a stale action rather than a real error. */
export function isControlLost(error: unknown): error is ControlLostError {
  return error instanceof ControlLostError;
}

const fenceStorage = new AsyncLocalStorage<() => void>();

/**
 * Run `work` with `check` reachable from anywhere inside it, awaits included.
 * Only the fence calls this; everything else asks `checkActionFence()`.
 */
export function withActionFence<T>(check: () => void, work: () => Promise<T>): Promise<T> {
  return fenceStorage.run(check, work);
}

/**
 * Refuse to go on when the fence this call was issued under has moved.
 *
 * The backend calls this immediately before each page mutation, after every
 * await that preceded it. Outside a fenced call — a person's own command, a
 * run with no session, a test — there is no fence and this does nothing.
 */
export function checkActionFence(): void {
  fenceStorage.getStore()?.();
}

/**
 * Wrap a backend so every ACTION it performs is fenced. Reads (`listTabs`,
 * `inspect`, `screenshot`) are left alone: looking at a page the person is
 * driving is not acting in it, and refusing them would make the agent's next
 * turn — the one that resumes after a release — start blind.
 */
export function fencedBrowser(
  backend: BrowserBackend,
  fence: () => ControlFence,
  onDropped?: () => void,
): BrowserBackend {
  const stamp = (): number => fence().generation;
  const check = (issued: number): void => {
    const now = fence();
    if (now.holder === "agent" && now.generation === issued) return;
    onDropped?.();
    throw new ControlLostError(issued, now.generation);
  };
  /** Stamp on dispatch, re-check on arrival: the two halves of W7. */
  const act = async <T>(work: () => Promise<T>): Promise<T> => {
    const issued = stamp();
    check(issued);
    // A tool dispatch is asynchronous by the time it reaches Playwright; the
    // second check is the one that matters, because the takeover happens in
    // between.
    await Promise.resolve();
    check(issued);
    // …and the third, fourth and fifth are the backend's own, one before each
    // mutation it performs, because the takeover also happens in the middle
    // of a tool call rather than only before one.
    return withActionFence(() => check(issued), work);
  };
  return {
    kind: backend.kind,
    listTabs: (): AgentTabInfo[] => backend.listTabs(),
    inspect: (tabId: string): Promise<PageInspection> => backend.inspect(tabId),
    screenshot: (tabId: string): Promise<string> => backend.screenshot(tabId),
    openTab: async (url?: string): Promise<string> => act(() => backend.openTab(url)),
    focusTab: async (tabId: string): Promise<void> => act(() => backend.focusTab(tabId)),
    navigate: async (tabId: string, url: string): Promise<void> => act(() => backend.navigate(tabId, url)),
    back: async (tabId: string): Promise<void> => act(() => backend.back(tabId)),
    forward: async (tabId: string): Promise<void> => act(() => backend.forward(tabId)),
    reload: async (tabId: string): Promise<void> => act(() => backend.reload(tabId)),
    click: async (tabId: string, target: string): Promise<void> => act(() => backend.click(tabId, target)),
    type: async (tabId: string, target: string, value: string): Promise<string> =>
      act(() => backend.type(tabId, target, value)),
    press: async (tabId: string, key: AgentPressableKey): Promise<void> => act(() => backend.press(tabId, key)),
    scroll: async (tabId: string, deltaY: number): Promise<void> => act(() => backend.scroll(tabId, deltaY)),
  };
}
