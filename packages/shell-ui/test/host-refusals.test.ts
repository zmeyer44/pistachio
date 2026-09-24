/**
 * How the store remembers what a host would not do (src/store.ts), which is
 * W12's rule made operational: an affordance is either there and works, or is
 * visibly unavailable with the host's own reason.
 *
 * The findings pinned here: #10 (a live view the host cannot open must not
 * raise an overlay, and the button must go), #16 (`useUnavailable` for the
 * vault, integrations and account pages could never fire), #22 (the neutral
 * browser controls claimed every guarded action was allowed), #27 (a getter
 * that FAILED was rendered as a fact) and #44 (a reconnect re-read only the
 * snapshot).
 */

import { afterEach, describe, expect, it } from "vitest";
import { GUARDED_BROWSER_ACTIONS } from "@pistachio/shell-contracts/browser-controls";
import { SHELL_REPLY_CODE } from "@pistachio/shell-contracts/socket";
import type { ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { DEFAULT_ACCOUNT } from "../src/lib/account";
import { DEFAULT_CLOUD_STATUS } from "../src/lib/sync";
import { useAppStore } from "../src/store";

const SNAPSHOT: ShellSnapshot = {
  spaces: [{ id: "space-1", name: "Personal", color: "#8fbf6a", parentSpaceId: null, cloudEnabled: true }],
  activeSpaceId: "space-1",
  tabs: [],
  activeTabId: null,
  visibleTabIds: [],
  wakingTabIds: [],
  splitGroups: [],
  recentlyClosed: null,
  sidebar: { pinned: [], favorites: [], folders: [], presets: [], collapsed: [] },
  run: null,
  threads: [],
} as unknown as ShellSnapshot;

/** A refusal the transport tagged, exactly as `WsShellApi` raises one. */
function refusal(code: "unsupported" | "failed", message: string): Error {
  const error = new Error(message);
  (error as unknown as Record<symbol, unknown>)[SHELL_REPLY_CODE] = code;
  return error;
}

function bridge(pistachio: Record<string, unknown>): void {
  setShellApi(pistachio as unknown as ShellApiBridge);
}

/** The getters `initialize`/`resync` read, all answering, unless overridden. */
function host(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const answer = <T>(value: T) => () => Promise.resolve(value);
  return {
    getSnapshot: answer(SNAPSHOT),
    getSettings: () => Promise.reject(new Error("not asked")),
    ...overrides,
  };
}

afterEach(() => {
  bridge({});
  useAppStore.setState({ unavailable: {}, failed: {}, overlay: "none", cloud: DEFAULT_CLOUD_STATUS, account: DEFAULT_ACCOUNT });
});

describe("the neutral browser controls", () => {
  it("hold every guarded action BLOCKED, because 'we could not ask' is not permission", async () => {
    bridge(host({ getBrowserControls: () => Promise.reject(refusal("failed", "control is down")) }));
    await useAppStore.getState().resync();

    const controls = useAppStore.getState().browserControls;
    expect(controls).not.toBeNull();
    for (const action of GUARDED_BROWSER_ACTIONS) {
      expect(controls?.actions[action].decision, action).toBe("block");
    }
    // And the panel has something to say beyond five denials.
    expect(useAppStore.getState().failed["getBrowserControls"]).toBe("control is down");
  });
});

describe("a getter that refused", () => {
  it("is remembered as UNAVAILABLE when the host will never answer it", async () => {
    bridge(host({ getAccount: () => Promise.reject(refusal("unsupported", "The account is managed in this browser's own settings.")) }));
    await useAppStore.getState().resync();

    expect(useAppStore.getState().unavailable["getAccount"]).toBe(
      "The account is managed in this browser's own settings.",
    );
    expect(useAppStore.getState().failed["getAccount"]).toBeUndefined();
  });

  it("is remembered as FAILED when it merely broke, and never as a fact", async () => {
    // The bug: a 500 on `getCloudStatus` rendered the default — "the cloud
    // browser is off" — beside a "Turn on" button that would have worked.
    bridge(host({ getCloudStatus: () => Promise.reject(refusal("failed", "The control plane did not answer.")) }));
    await useAppStore.getState().resync();

    expect(useAppStore.getState().failed["getCloudStatus"]).toBe("The control plane did not answer.");
    expect(useAppStore.getState().unavailable["getCloudStatus"]).toBeUndefined();
  });

  it("can be recorded from anywhere, for a member the first load never probes", () => {
    // `vaultList` and `integrationProviders` are only knowable at first use.
    useAppStore.getState().noteRefusal("vaultList", refusal("unsupported", "Passwords live in this browser's own settings."));
    useAppStore.getState().noteRefusal("integrationProviders", refusal("failed", "That did not load."));

    expect(useAppStore.getState().unavailable["vaultList"]).toBe("Passwords live in this browser's own settings.");
    expect(useAppStore.getState().failed["integrationProviders"]).toBe("That did not load.");
  });

  it("moves from failed to unavailable when the host names the reason", () => {
    useAppStore.getState().noteRefusal("vaultList", refusal("failed", "That did not load."));
    useAppStore.getState().noteRefusal("vaultList", refusal("unsupported", "Not here."));

    expect(useAppStore.getState().failed["vaultList"]).toBeUndefined();
    expect(useAppStore.getState().unavailable["vaultList"]).toBe("Not here.");
  });
});

describe("openLiveView", () => {
  it("raises no overlay and remembers the refusal, so the button can go", async () => {
    bridge({
      openLiveView: () => Promise.reject(refusal("unsupported", "This pane already is the live view.")),
    });

    await expect(useAppStore.getState().openLiveView("run-1")).resolves.toBe("This pane already is the live view.");
    expect(useAppStore.getState().overlay).toBe("none");
    expect(useAppStore.getState().unavailable["openLiveView"]).toBe("This pane already is the live view.");
  });

  it("still opens where the host has one", async () => {
    bridge({ openLiveView: () => Promise.resolve({ ...DEFAULT_CLOUD_STATUS, liveState: "open" }) });

    await expect(useAppStore.getState().openLiveView("run-1")).resolves.toBeNull();
    expect(useAppStore.getState().overlay).toBe("liveView");
    expect(useAppStore.getState().unavailable["openLiveView"]).toBeUndefined();
  });
});

describe("resync", () => {
  it("re-reads everything the first load read, not only the snapshot", async () => {
    // After a reconnect the shell had kept whatever `initialize()` got for
    // devices, sync, egress, cloud, channels, the account and the refusal
    // maps — for the life of the page.
    useAppStore.setState({ unavailable: { getAccount: "stale" }, failed: { getCloudStatus: "stale" } });
    bridge(
      host({
        getCloudStatus: () => Promise.resolve({ ...DEFAULT_CLOUD_STATUS, available: true }),
        getAccount: () => Promise.resolve({ ...DEFAULT_ACCOUNT, state: "enrolled", email: "a@example.com" }),
      }),
    );

    await useAppStore.getState().resync();

    const state = useAppStore.getState();
    expect(state.cloud.available).toBe(true);
    expect(state.account.email).toBe("a@example.com");
    expect(state.unavailable["getAccount"]).toBeUndefined();
    expect(state.failed["getCloudStatus"]).toBeUndefined();
    expect(state.snapshot?.activeSpaceId).toBe("space-1");
  });

  it("leaves the console and the walkthrough alone, unlike the first load", async () => {
    // Re-applying the first-run decisions on every reconnect would reopen the
    // wizard over a live session and undo what the person did with the
    // console.
    useAppStore.setState({ consoleOpen: true, onboardingOpen: false });
    bridge(host());

    await useAppStore.getState().resync();

    expect(useAppStore.getState().consoleOpen).toBe(true);
    expect(useAppStore.getState().onboardingOpen).toBe(false);
  });
});
