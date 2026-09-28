/**
 * The switcher's run of one gesture (src/store.ts `openTabSwitcher` /
 * `finishTabSwitcher`): a release before the cards land still commits where
 * the steps led, unseen when it was a quick flip, and the next gesture gets
 * a run of its own rather than stepping the one still landing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabSwitcherPreview } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { useAppStore } from "../src/store";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function cards(...ids: string[]): TabSwitcherPreview[] {
  return ids.map((id) => ({ tab: { id }, dataUrl: null }) as unknown as TabSwitcherPreview);
}

/** Lets every settled promise run its continuations. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** A host whose card requests and tab selections resolve when the test says. */
function host() {
  const requests: Deferred<TabSwitcherPreview[]>[] = [];
  const selections: Deferred<void>[] = [];
  const getTabSwitcherPreviews = vi.fn(() => {
    const request = deferred<TabSwitcherPreview[]>();
    requests.push(request);
    return request.promise;
  });
  const selectTab = vi.fn((tabId: string) => {
    const selection = deferred<void>();
    selections.push(selection);
    return selection.promise.then(() => setActive(tabId));
  });
  setShellApi({ getTabSwitcherPreviews, selectTab } as unknown as ShellApiBridge);
  return { requests, selections, getTabSwitcherPreviews, selectTab };
}

function setActive(tabId: string): void {
  useAppStore.setState({ snapshot: { activeTabId: tabId } as never });
}

beforeEach(() => {
  useAppStore.setState({ onboardingOpen: false, tabSwitcher: null, overlay: "none", error: null });
  setActive("a");
});

afterEach(() => {
  vi.useRealTimers();
  setShellApi({} as unknown as ShellApiBridge);
  useAppStore.setState({ tabSwitcher: null, overlay: "none", snapshot: null, error: null });
});

describe("a gesture released before its cards land", () => {
  it("commits where its steps led", async () => {
    const { requests, selections, selectTab } = host();
    void useAppStore.getState().openTabSwitcher("control", 1, 15);
    await settle();
    const finished = useAppStore.getState().finishTabSwitcher(true);
    requests[0]!.resolve(cards("a", "b", "c"));
    await settle();
    expect(selectTab).toHaveBeenCalledWith("b");
    selections[0]!.resolve();
    await finished;
  });

  it("never reveals a quick flip, however long the selection takes", async () => {
    vi.useFakeTimers();
    const { requests, selections } = host();
    void useAppStore.getState().openTabSwitcher("control", 1, 15);
    await settle();
    const finished = useAppStore.getState().finishTabSwitcher(true);
    await vi.advanceTimersByTimeAsync(500);
    requests[0]!.resolve(cards("a", "b"));
    await settle();
    // Main is still selecting the tab: well past the reveal delay.
    await vi.advanceTimersByTimeAsync(500);
    expect(useAppStore.getState().tabSwitcher?.revealed).toBe(false);
    expect(useAppStore.getState().overlay).toBe("none");
    selections[0]!.resolve();
    await finished;
    expect(useAppStore.getState().tabSwitcher).toBeNull();
  });
});

describe("the next gesture while one is still landing", () => {
  it("gets a run of its own, and the landing one neither moves nor closes it", async () => {
    const { requests, selections, getTabSwitcherPreviews, selectTab } = host();
    // ⌃Tab, released while its cards load, then ⌃Tab again.
    void useAppStore.getState().openTabSwitcher("control", 1, 15);
    await settle();
    const first = useAppStore.getState().tabSwitcher!.serial;
    void useAppStore.getState().finishTabSwitcher(true);
    void useAppStore.getState().openTabSwitcher("control", 1, 15);
    await settle();
    const second = useAppStore.getState().tabSwitcher!;
    expect(second.serial).not.toBe(first);
    expect(second.offset).toBe(1);
    expect(second.finishing).toBe(false);

    // The first flip lands on the tab it chose, not one its successor stepped to.
    requests[0]!.resolve(cards("a", "b", "c"));
    await settle();
    expect(selectTab).toHaveBeenCalledTimes(1);
    expect(selectTab).toHaveBeenLastCalledWith("b");
    // The second's cards wait for that selection, so they come in its order.
    expect(getTabSwitcherPreviews).toHaveBeenCalledTimes(1);
    selections[0]!.resolve();
    await settle();
    expect(getTabSwitcherPreviews).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().tabSwitcher?.serial).toBe(second.serial);

    requests[1]!.resolve(cards("b", "a", "c"));
    await settle();
    // Still held: still open, on the tab before the one the first flip left.
    const open = useAppStore.getState().tabSwitcher!;
    expect(open.serial).toBe(second.serial);
    expect(open.loading).toBe(false);
    expect(open.finishing).toBe(false);
    expect(selectTab).toHaveBeenCalledTimes(1);

    void useAppStore.getState().finishTabSwitcher(true);
    await settle();
    expect(selectTab).toHaveBeenLastCalledWith("a");
    selections[1]!.resolve();
    await settle();
    expect(useAppStore.getState().tabSwitcher).toBeNull();
  });

  it("asks for its cards before coming down when cancelled meanwhile", async () => {
    const { requests, selections, getTabSwitcherPreviews } = host();
    void useAppStore.getState().openTabSwitcher("control", 1, 15);
    await settle();
    void useAppStore.getState().finishTabSwitcher(true);
    void useAppStore.getState().openTabSwitcher("meta", 0, 15);
    await settle();
    const cancelled = useAppStore.getState().finishTabSwitcher(false);
    await settle();
    // Main hears the switcher closed only after its last request for cards,
    // or it would keep capturing them.
    expect(useAppStore.getState().tabSwitcher).not.toBeNull();
    requests[0]!.resolve(cards("a", "b"));
    await settle();
    selections[0]!.resolve();
    await cancelled;
    expect(getTabSwitcherPreviews).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().tabSwitcher).toBeNull();
  });

  it("ignores steps and moves once its gesture has ended", async () => {
    const { requests, selections, selectTab } = host();
    void useAppStore.getState().openTabSwitcher("control", 1, 15);
    await settle();
    requests[0]!.resolve(cards("a", "b", "c"));
    await settle();
    const finished = useAppStore.getState().finishTabSwitcher(true);
    useAppStore.getState().stepTabSwitcher(false);
    useAppStore.getState().moveTabSwitcher("right", 5);
    useAppStore.getState().setTabSwitcherIndex(2);
    expect(useAppStore.getState().tabSwitcher?.offset).toBe(1);
    await settle();
    expect(selectTab).toHaveBeenCalledWith("b");
    selections[0]!.resolve();
    await finished;
  });
});
