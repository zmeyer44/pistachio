/**
 * Regressions from the adversarial review of the `web-browser` branch.
 *
 * Everything here is host logic that needs no page behind it: the split
 * arithmetic, the Space list, the strip while a tab wakes, what the durable
 * record may carry, the settings register, and the members that act for the
 * person while the agent holds the wheel. Each test is named after the
 * guarantee it holds, not after the bug that broke it.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentTabInfo } from "@pistachio/agent-runtime";
import { DeviceRegistryVerifier, type HubTransport } from "@pistachio/sync-engine";
import {
  deriveSpaceKeys,
  generateSpaceRootSecret,
  type BrowserSessionRecord,
  type SpaceDoc,
  type WorkspaceRecordWire,
} from "@pistachio/sync-protocol";
import type { ShellTabsSnapshot } from "@pistachio/shell-contracts/ipc";
import type { BrowserSessionState } from "@pistachio/shell-contracts/tab-session";
import { ShellHost, type ShellHostSpace } from "../../src/sessions/shell-host.js";
import { SessionStateStore } from "../../src/sessions/session-state.js";
import { WorkspaceToolStore } from "../../src/sync/workspace-tools.js";

const SPACE = "work";
const SESSION = "66666666-6666-4666-8666-666666666666";
const USER = "77777777-7777-4777-8777-777777777777";

type Backend = ShellHostSpace["browser"]["backend"];

/** A backend with no browser in it: the arithmetic below is the subject. */
function stubBackend(): Backend {
  const pages = new Map<string, { url: string; kind: "human" | "agent" }>();
  let next = 0;
  return {
    kind: "cloud" as const,
    get activeTabId(): string | null {
      return [...pages.keys()][0] ?? null;
    },
    guardFor: (): null => null,
    listTabs: (): AgentTabInfo[] =>
      [...pages.entries()].map(([id, page]) => ({
        id,
        spaceId: SPACE,
        title: "",
        url: page.url,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        kind: page.kind,
      })),
    openTab: async (url?: string, options?: { kind?: "human" | "agent" }): Promise<string> => {
      next += 1;
      const id = `cloud:${String(next)}`;
      pages.set(id, { url: url ?? "about:blank", kind: options?.kind ?? "agent" });
      return id;
    },
    closeTab: async (tabId: string): Promise<void> => {
      pages.delete(tabId);
    },
    focusTab: async (): Promise<void> => undefined,
    navigate: async (tabId: string, url: string): Promise<void> => {
      const page = pages.get(tabId);
      if (page !== undefined) page.url = url;
    },
    back: async (): Promise<void> => undefined,
    forward: async (): Promise<void> => undefined,
    reload: async (): Promise<void> => undefined,
  } as unknown as Backend;
}

async function makeWorkspace(): Promise<WorkspaceToolStore> {
  const signing = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const verifier = new DeviceRegistryVerifier("reject");
  verifier.addDevice("cloud-device", signing.publicKey);
  const store = new WorkspaceToolStore({
    deviceId: "cloud-device",
    privateKey: (signing as CryptoKeyPair).privateKey,
    keys: deriveSpaceKeys("__workspace__", generateSpaceRootSecret()),
    transport: {
      publishWorkspace: (_docs: WorkspaceRecordWire[]) => undefined,
      state: "connected",
    } as unknown as HubTransport,
    verifier: async () => verifier,
  });
  store.hydrated();
  await store.ready;
  return store;
}

interface Harness {
  host: ShellHost;
  workspace: WorkspaceToolStore;
  snapshots: ShellTabsSnapshot[];
  states: BrowserSessionState[];
  control: { holder: "human" | "agent"; generation: number };
}

async function makeHost(options: { spaces?: SpaceDoc[] } = {}): Promise<Harness> {
  const workspace = await makeWorkspace();
  const spaces = options.spaces;
  // The Space records the sync engine holds are what the menu reads; a test
  // supplies them directly rather than sealing a hub frame to say so.
  const surface =
    spaces === undefined
      ? workspace
      : (Object.assign(Object.create(Object.getPrototypeOf(workspace) as object) as object, workspace, {
          spaces: () => spaces,
        }) as WorkspaceToolStore);
  const space: ShellHostSpace = {
    browser: { backend: stubBackend(), onTabsChanged: () => () => undefined },
    workspace: spaces === undefined ? workspace : surface,
  };
  const control = { holder: "human" as "human" | "agent", generation: 3 };
  const host = new ShellHost({
    sessionId: SESSION,
    userId: USER,
    spaceId: SPACE,
    space,
    control: () => control,
  });
  const snapshots: ShellTabsSnapshot[] = [];
  const states: BrowserSessionState[] = [];
  host.onSnapshot((snapshot) => snapshots.push(snapshot));
  host.onSessionState((state) => states.push(state));
  return { host, workspace, snapshots, states, control };
}

/** Let the coalesced flush run. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const spaceDoc = (id: string, name: string): SpaceDoc => ({
  kind: "space",
  id,
  name,
  color: "#4b7f52",
  parentSpaceId: null,
  purpose: "",
  createdAt: 0,
  carriedOrigins: [],
  egressPolicy: "direct",
  cloudEnabled: true,
});

describe("split groups", () => {
  it("refuses a drop onto a full group without dissolving the group the tab came from", async () => {
    const harness = await makeHost();
    for (let index = 0; index < 6; index += 1) {
      await harness.host.createTab(`https://example.com/${String(index)}`);
    }
    const ids = (await harness.host.getSnapshot()).tabs.map((tab) => tab.id);
    await harness.host.selectTab(ids[0]!);
    for (const id of [ids[1]!, ids[2]!, ids[3]!]) await harness.host.splitWith(id, "right");
    expect((await harness.host.getSnapshot()).splitGroups[0]?.tabIds).toHaveLength(4);

    await harness.host.selectTab(ids[4]!);
    await harness.host.splitWith(ids[5]!, "right");
    const before = (await harness.host.getSnapshot()).splitGroups;
    expect(before).toHaveLength(2);
    const pairBefore = before.find((group) => group.tabIds.includes(ids[4]!))?.tabIds;

    await harness.host.selectTab(ids[0]!);
    await expect(harness.host.splitWith(ids[4]!, "right")).rejects.toThrow(/up to four tabs/u);
    // The refusal is total. Detaching first and bailing out afterwards left
    // the group the tab was dragged out of silently dissolved, with no error
    // and no snapshot to show it had happened.
    const after = (await harness.host.getSnapshot()).splitGroups;
    expect(after).toHaveLength(2);
    expect(after.find((group) => group.tabIds.includes(ids[4]!))?.tabIds).toEqual(pairBefore);
  });

  it("splits a tab with a duplicate of itself when it is dropped on its own pane", async () => {
    const harness = await makeHost();
    await harness.host.createTab("https://example.com/only");
    const only = (await harness.host.getSnapshot()).tabs[0]!.id;
    await harness.host.selectTab(only);
    await harness.host.splitWith(only, "right");
    const snapshot = await harness.host.getSnapshot();
    expect(snapshot.tabs).toHaveLength(2);
    expect(snapshot.splitGroups[0]?.tabIds).toHaveLength(2);
    expect(snapshot.splitGroups[0]?.tabIds).toContain(only);
  });
});

describe("the Space switcher", () => {
  it("lists every Space the account has, so the switcher has somewhere to switch to", async () => {
    const harness = await makeHost({ spaces: [spaceDoc(SPACE, "Work"), spaceDoc("home", "Home")] });
    const snapshot = await harness.host.getSnapshot();
    // A fabricated single-element list made `SpaceMenu`'s "others" always
    // empty, so a properly implemented `switchSpace` was unreachable.
    expect(snapshot.spaces.map((space) => space.id).sort()).toEqual(["home", "work"]);
    expect(snapshot.spaces.find((space) => space.id === SPACE)?.name).toBe("Work");
    expect(snapshot.activeSpaceId).toBe(SPACE);
  });

  it("still names its own Space when no Space record has arrived yet", async () => {
    const harness = await makeHost();
    expect((await harness.host.getSnapshot()).spaces.map((space) => space.id)).toEqual([SPACE]);
  });
});

describe("waking a tab", () => {
  it("moves the selection before the page opens, and says which tab is waking", async () => {
    const harness = await makeHost();
    await harness.host.createTab("https://example.com/a");
    await harness.host.createTab("https://example.com/b");
    const [first, second] = (await harness.host.getSnapshot()).tabs.map((tab) => tab.id);
    await harness.host.selectTab(first!);
    await harness.host.suspendTab(second!);
    await flush();

    harness.snapshots.length = 0;
    const selecting = harness.host.selectTab(second!);
    await flush();
    // Publishing only after the wake left the strip on the old selection,
    // painting the previous tab's frames, for the whole page load.
    const early = harness.snapshots[0];
    expect(early?.activeTabId).toBe(second);
    expect(early?.wakingTabIds).toEqual([second]);
    await selecting;
    await flush();
    expect(harness.snapshots.at(-1)?.wakingTabIds).toEqual([]);
  });
});

describe("the sealed session record", () => {
  it("remembers when each tab was last in front", async () => {
    const harness = await makeHost();
    await harness.host.createTab("https://example.com/story");
    await flush();
    // Without it, a rebuilt session's tab switcher is insertion order.
    expect(harness.host.sessionState().tabs[0]?.lastActiveAt).toBeGreaterThan(0);
  });

  it("keeps a reader tab's whole article out of the record", async () => {
    const harness = await makeHost();
    await harness.host.createTab("https://example.com/story");
    // A reader tab's address IS the article, as a `data:` document. Persisted
    // verbatim it puts page HTML in the workspace — which security.md says
    // never leaves the worker — and a few long pieces push the doc past the
    // hub's 8 MiB frame cap, at which point the WHOLE session record silently
    // stops syncing.
    const article = `data:text/html;charset=utf-8,${encodeURIComponent(`<h1>${"a".repeat(20_000)}</h1>`)}`;
    await harness.host.createTab(article);
    await flush();
    const state = harness.host.sessionState();
    expect(state.tabs.some((tab) => tab.url.startsWith("data:"))).toBe(false);
    expect(JSON.stringify(state).length).toBeLessThan(4_000);
  });

  it("never publishes over a record it could not read", () => {
    const putBrowserSession = vi.fn();
    const workspace = {
      browserSession: () => ({ version: 99, spaceId: SPACE }),
      putBrowserSession,
      settled: async () => undefined,
    } as unknown as WorkspaceToolStore;
    const store = new SessionStateStore({ workspace, spaceId: SPACE, debounceMs: 0 });
    // A record from a build this one does not know is not an empty session.
    // Publishing over it wins LWW and takes every tab on every device with it.
    expect(store.read()).toBeNull();
    expect(store.writable).toBe(false);
    store.publish({
      version: 2,
      spaceId: SPACE,
      tabs: [],
      activeTabId: null,
      splitGroups: [],
      shelf: { favorites: [], entries: [] },
      zoom: {},
      permissions: {},
      updatedAt: 1,
    });
    expect(putBrowserSession).not.toHaveBeenCalled();
  });

  it("never writes back a record it had to prune", () => {
    const putBrowserSession = vi.fn();
    const workspace = {
      browserSession: () => ({
        version: 2,
        spaceId: SPACE,
        tabs: [],
        activeTabId: null,
        splitGroups: [],
        shelf: { favorites: [], entries: [] },
        zoom: {},
        // A permission name this build does not know is one a NEWER build
        // gave the person. Dropping it is only safe while it is never written.
        permissions: { "https://maps.example": { telepathy: "allow" } },
        updatedAt: 1,
      }),
      putBrowserSession,
      settled: async () => undefined,
    } as unknown as WorkspaceToolStore;
    const store = new SessionStateStore({ workspace, spaceId: SPACE, debounceMs: 0 });
    expect(store.read()).not.toBeNull();
    expect(store.writable).toBe(false);
  });

  it("a tab handed over from another Space survives this session's next publish", async () => {
    const harness = await makeHost();
    await harness.host.createTab("https://example.com/mine");
    await flush();
    const mine = (await harness.host.getSnapshot()).tabs[0]!.id;

    // The giving Space wrote the tab into THIS Space's record while this
    // session was live; the register has one winner, so a publish that did not
    // merge is a tab that vanished from both Spaces (the source had already
    // closed it).
    const stored: BrowserSessionRecord = {
      version: 2,
      spaceId: SPACE,
      tabs: [{ id: "web:handed", url: "https://elsewhere.example/", title: "Handed over", favicon: null, kind: "human" }],
      activeTabId: "web:handed",
      splitGroups: [],
      shelf: { favorites: [], entries: [] },
      zoom: {},
      permissions: {},
      updatedAt: 1,
    };
    const merged = harness.host.mergeStoredState(stored, harness.host.sessionState());
    expect(merged.tabs.map((tab) => tab.id)).toEqual([mine, "web:handed"]);

    // A tab the person CLOSED is not resurrected by the same merge.
    await harness.host.closeTab(mine);
    await flush();
    const again = harness.host.mergeStoredState(
      {
        ...stored,
        tabs: [...stored.tabs, { id: mine, url: "https://example.com/mine", title: "", favicon: null, kind: "human" }],
      },
      harness.host.sessionState(),
    );
    expect(again.tabs.map((tab) => tab.id)).not.toContain(mine);
  });
});

describe("settings", () => {
  it("keeps the shell's settings in the sealed account register, not in this worker's memory", async () => {
    const harness = await makeHost();
    await harness.host.updateSettings({ general: { homeUrl: "https://home.example/" } });
    expect(harness.workspace.shellSettings()?.settings.general.homeUrl).toBe("https://home.example/");

    // A second host — another worker, the same account — reads what the
    // person set. Theme, layout, shortcuts and the home page were lost on
    // every suspend while they lived only in this process.
    const other = new ShellHost({
      sessionId: SESSION,
      userId: USER,
      spaceId: SPACE,
      space: { browser: { backend: stubBackend(), onTabsChanged: () => () => undefined }, workspace: harness.workspace },
      control: () => ({ holder: "human", generation: 0 }),
    });
    expect((await other.getSettings()).general.homeUrl).toBe("https://home.example/");
  });

  it("merges a patch into its section, so choosing one search provider keeps the other", async () => {
    const harness = await makeHost();
    await harness.host.updateSettings({ search: { webProvider: "duckduckgo" } });
    const after = await harness.host.updateSettings({ search: { aiProvider: "claude" } });
    // The patch names one field; spread over the whole section it used to
    // send the other back to its default.
    expect(after.search).toEqual({ webProvider: "duckduckgo", aiProvider: "claude", smartSuggestions: true });
    expect(harness.workspace.shellSettings()?.settings.search).toEqual({
      webProvider: "duckduckgo",
      aiProvider: "claude",
      smartSuggestions: true,
    });
  });

  it("a reset does not reopen the Mac's walkthrough over a live browser session", async () => {
    const harness = await makeHost();
    await harness.host.updateSettings({ layout: { mode: "top" } });
    const reset = await harness.host.resetSettings();
    expect(reset.layout.mode).toBe("sidebar");
    // `DEFAULT_SETTINGS.onboarding.completed` is false, and the shell turns
    // that into the first-run wizard — over a live session with the person's
    // own tabs behind it. Resetting the shell is not asking to be onboarded.
    expect(reset.onboarding.completed).toBe(true);
    expect((await harness.host.getSettings()).onboarding.completed).toBe(true);
  });
});

/**
 * The walkthrough flag is REAL (§14). The host used to force
 * `onboarding.completed` true on every read and every write, which made a
 * first run on the web impossible to express at all.
 */
describe("the walkthrough flag", () => {
  it("reports the walkthrough done for an account with no settings record", async () => {
    const harness = await makeHost();
    expect(harness.workspace.shellSettings()).toBeNull();
    // A person whose Mac onboarded them — or whose record has not synced yet
    // — is not walked through a first run again by a browser tab.
    expect((await harness.host.getSettings()).onboarding.completed).toBe(true);
  });

  it("persists and reports a first run the web entry asked for", async () => {
    const harness = await makeHost();
    const written = await harness.host.updateSettings({ onboarding: { completed: false, completedAt: null } });
    expect(written.onboarding.completed).toBe(false);
    expect((await harness.host.getSettings()).onboarding.completed).toBe(false);
    // It is in the sealed record, so a reload mid-walkthrough reopens it and
    // a session rebuilt on another worker is still mid-walkthrough.
    expect(harness.workspace.shellSettings()?.settings.onboarding.completed).toBe(false);
    const other = new ShellHost({
      sessionId: SESSION,
      userId: USER,
      spaceId: SPACE,
      space: { browser: { backend: stubBackend(), onTabsChanged: () => () => undefined }, workspace: harness.workspace },
      control: () => ({ holder: "human", generation: 0 }),
    });
    expect((await other.getSettings()).onboarding.completed).toBe(false);
  });

  it("closes the walkthrough by writing the flag, not by pretending it was never open", async () => {
    const harness = await makeHost();
    await harness.host.updateSettings({ onboarding: { completed: false, completedAt: null } });
    await harness.host.completeOnboarding({
      name: "Claudius Meyer",
      about: "Builds browsers",
      facts: [],
      favorites: [],
      spaceName: null,
      openWelcomeTabs: false,
    });
    const settings = await harness.host.getSettings();
    expect(settings.onboarding.completed).toBe(true);
    expect(settings.onboarding.completedAt).not.toBeNull();
    expect(harness.workspace.shellSettings()?.settings.onboarding.completed).toBe(true);
  });
});

describe("naming the first Space", () => {
  it("renames the Space through its own synced record, and the snapshot says so at once", async () => {
    const harness = await makeHost();
    await harness.host.completeOnboarding({
      name: "Claudius Meyer",
      about: "",
      facts: [],
      favorites: [],
      spaceName: "Claudius",
      openWelcomeTabs: false,
    });
    // The name is account-global: every device's Space menu reads this doc,
    // which is why it is published rather than kept in the session.
    expect(harness.workspace.spaces().map((space) => [space.id, space.name])).toEqual([[SPACE, "Claudius"]]);
    const snapshot = await harness.host.getSnapshot();
    expect(snapshot.spaces.find((space) => space.id === SPACE)?.name).toBe("Claudius");
  });

  it("keeps everything else about a Space that already has a record", async () => {
    const harness = await makeHost();
    harness.workspace.putSpace({ ...spaceDoc(SPACE, "Personal"), color: "#123456", purpose: "the day job" });
    await harness.host.completeOnboarding({
      name: "Ada",
      about: "",
      facts: [],
      favorites: [],
      spaceName: "Ada",
      openWelcomeTabs: false,
    });
    const renamed = harness.workspace.spaces().find((space) => space.id === SPACE);
    expect(renamed?.name).toBe("Ada");
    expect(renamed?.color).toBe("#123456");
    expect(renamed?.purpose).toBe("the day job");
  });
});

describe("acting for the person", () => {
  it("refuses to paste, upload or print while the agent holds the wheel", async () => {
    const harness = await makeHost();
    await harness.host.createTab("https://example.com/a");
    const tabId = (await harness.host.getSnapshot()).tabs[0]!.id;
    harness.control.holder = "agent";
    harness.control.generation = 4;
    // `Input.insertText`, a file the picker is waiting for and a print ARE
    // forwarded input; they simply arrive as RPC calls rather than as
    // `{t:'input'}`, which is the one path the fence covered (W7).
    await expect(harness.host.pasteText(tabId, "x")).rejects.toThrow(/agent has control/u);
    await expect(harness.host.printToPdf(tabId)).rejects.toThrow(/agent has control/u);
    await expect(harness.host.provideFiles("nope", [])).rejects.toThrow(/agent has control/u);
  });

  it("records the policy decision it applied, so Site Controls can show it", async () => {
    const harness = await makeHost();
    await harness.host.createTab("https://example.com/a");
    const tabId = (await harness.host.getSnapshot()).tabs[0]!.id;
    // The desktop applies the `print` verdict and records it; the cloud host
    // did neither, so a managed deployment that blocks printing was answered
    // by the cloud browser anyway.
    await harness.host.printToPdf(tabId).catch(() => undefined);
    const controls = await harness.host.getBrowserControls();
    expect(controls.recentEvents.map((event) => event.capability)).toContain("print");
    expect(controls.recentEvents[0]?.decision).toBe("allow");
  });
});

describe("site controls", () => {
  it("says a site is asked each time when that is what the person chose", async () => {
    const harness = await makeHost();
    await harness.host.createTab("https://example.com/a");
    await harness.host.browserControl({ type: "setPermission", permission: "geolocation", decision: "ask" });
    const controls = await harness.host.getBrowserControls();
    // A three-value decision read through a two-way ternary told the person
    // they had blocked a site they had only ever been asked about.
    expect(controls.permissions.geolocation.decision).toBe("ask");
    expect(controls.permissions.geolocation.reason).not.toMatch(/blocked/u);
  });
});
