/**
 * The console on the worker (docs/web-browser-design.md §8): the 17 run
 * members of `ShellApi`, driven against the fake control plane.
 *
 * A `cloud` device may not call `POST /runs` or the sponsor routes, so the
 * host acts through the lease-authenticated session routes. What is under
 * test here is that seam and the fold behind it: a run started from the shell
 * appears in the snapshot, the person's commands move control's state and the
 * session's fence with it, the run's own events reach the console without a
 * stream, and a saved conversation reopens.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTabInfo } from "@pistachio/agent-runtime";
import type { RunSummary } from "@pistachio/protocol";
import type { ShellRunSnapshot } from "@pistachio/shell-contracts/ipc";
import { runEventSealAad, runThreadSealAad, seal, toBase64, utf8, type SpaceKeys } from "@pistachio/sync-protocol";
import { ControlClient } from "../../src/control-client.js";
import { BrowserSession } from "../../src/sessions/browser-session.js";
import { isUnsupportedShellMethod, type SessionSpace } from "../../src/sessions/shell-host.js";
import { withViewer } from "../../src/sessions/viewer-context.js";
import type { CloudBrowser } from "../../src/sync/session.js";
import { startFakeControl, type FakeControl } from "../helpers/fake-control.js";
import { settle } from "../helpers/fixture-server.js";
import { testSpaceKeys, USER_A } from "../helpers/keys.js";

const SPACE = "work";

/** A browser with no browser in it: what a run does to tabs is not the subject here. */
function stubBackend(): CloudBrowser {
  const pages = new Map<string, { url: string; kind: "human" | "agent" }>();
  let next = 0;
  return {
    kind: "cloud" as const,
    get activeTabId() {
      return [...pages.keys()][0] ?? null;
    },
    guardFor: () => null,
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
    openTab: async (url?: string, options?: { kind?: "human" | "agent" }) => {
      next += 1;
      const id = `cloud:${String(next)}`;
      pages.set(id, { url: url ?? "about:blank", kind: options?.kind ?? "agent" });
      return id;
    },
    closeTab: async (tabId: string) => {
      pages.delete(tabId);
    },
    focusTab: async () => undefined,
    navigate: async () => undefined,
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
  } as unknown as CloudBrowser;
}

let fake: FakeControl;
let control: ControlClient;
let session: BrowserSession;
let keys: SpaceKeys;
let deviceId: string;
let published: ShellRunSnapshot[];

/** Claim the session for this worker, as a shell ticket landing here would. */
async function build(options: { viewerDeviceId?: string | null } = {}): Promise<void> {
  const row = fake.addBrowserSession({ userId: USER_A, spaceId: SPACE });
  const claimed = await control.claimSession(row.id, "worker-a", "http://10.0.0.7:8791");
  if ("refused" in claimed) throw new Error(`the fake refused the claim: ${claimed.refused}`);
  const backend = stubBackend();
  const listeners = new Set<() => void>();
  const space: SessionSpace = {
    ready: Promise.resolve(),
    workspace: null,
    browser: {
      backend,
      onTabsChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  session = new BrowserSession({
    id: row.id,
    userId: USER_A,
    spaceId: SPACE,
    space,
    keys,
    leaseToken: claimed.leaseToken,
    controlClient: control,
    viewerDeviceId: options.viewerDeviceId === undefined ? deviceId : options.viewerDeviceId,
  });
  published = [];
  session.host.onRun((snapshot) => published.push(snapshot));
}

beforeEach(async () => {
  fake = await startFakeControl();
  control = new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken });
  keys = await testSpaceKeys(SPACE);
  deviceId = fake.addWebDevice(USER_A).id;
  await build();
});

afterEach(async () => {
  await session.close("shutdown");
  await fake.close();
});

/** The run the console has open, once one is there. */
async function openRun(): Promise<RunSummary> {
  const snapshot = await session.host.getSnapshot();
  if (snapshot.run === null) throw new Error("no run is open");
  return snapshot.run;
}

describe("starting a run from the shell (§8)", () => {
  it("creates the run on the session and folds it into the run snapshot at once", async () => {
    await session.host.startDelegation("Read the fixture page");
    const run = await openRun();
    expect(run.purpose).toBe("Read the fixture page");
    expect(run.status).toBe("ready");
    // Control created it against THIS session, with no start page: the run
    // acts in the tabs the person already has open.
    const created = fake.run(run.runId);
    expect(created.record.sessionId).toBe(session.id);
    expect(created.record.userId).toBe(USER_A);
    expect(created.record.startUrl).toBeNull();
    // The conversation reached the shell on the run channel, not the tab one.
    await settle(() => published.some((snapshot) => snapshot.run?.runId === run.runId));
    await settle(() => published.some((snapshot) => snapshot.threads.some((item) => item.runId === run.runId)));
    expect((await session.host.getSnapshot()).threads.map((item) => item.runId)).toContain(run.runId);
  });

  it("names a start page only when the shell gives one, and startCloudRun is the same motion", async () => {
    const { runId } = await session.host.startCloudRun({
      intent: "Book the table",
      startUrl: "https://fixture.example/book",
    });
    expect(fake.run(runId).record.startUrl).toBe("https://fixture.example/book");
    expect(fake.run(runId).record.sessionId).toBe(session.id);
    // Anything that is not a web address is the runner's own default, not a
    // page the shell can talk it into opening.
    const { runId: second } = await session.host.startCloudRun({
      intent: "Look something up",
      startUrl: "file:///etc/passwd",
    });
    expect(fake.run(second).record.startUrl).toBeNull();
  });

  it("refuses an empty intent, and refuses everything without a viewer that proved the key", async () => {
    await expect(session.host.startDelegation("   ")).rejects.toThrow(/say what the agent should do/u);
    await build({ viewerDeviceId: null });
    await expect(session.host.startDelegation("Do it")).rejects.toThrow(/proved this Space's key/u);
  });
});

describe("the person's commands", () => {
  it("moves control's state and the session's fence, and mirrors the generation", async () => {
    await session.host.startDelegation("Type into the fixture");
    const run = await openRun();
    // The run is claimed: control hands the wheel to the agent with the lease.
    const claimed = await control.claimRun("worker-a");
    expect(claimed?.session).toMatchObject({ id: session.id, generation: 1 });
    session.setControl({ holder: "agent", generation: claimed?.session?.generation ?? 0 });
    expect(session.control).toEqual({ holder: "agent", generation: 1 });

    // Taking control is control's `interrupt` on a hosted run, and the
    // `{t:'control', generation}` it answers with moves the session's fence
    // here — so the pane accepts input without waiting for a heartbeat (W7).
    await session.host.takeControl();
    expect(session.control).toEqual({ holder: "human", generation: 2 });
    expect((await openRun()).status).toBe("human_control");
    expect(session.mayAct(2)).toBe(true);
    expect(session.mayAct(1)).toBe(false);

    await session.host.releaseControl();
    expect(session.control).toEqual({ holder: "agent", generation: 3 });
    expect((await openRun()).status).toBe("running");

    await session.host.sendAgentMessage("try the other button");
    expect(fake.run(run.runId).events.some((event) => event.event.t === "cmd.message")).toBe(true);

    await session.host.answerAgentQuestion("q1", "yes");
    expect(fake.run(run.runId).events.some((event) => event.event.t === "cmd.answer")).toBe(true);

    await session.host.revokeRun();
    expect((await openRun()).status).toBe("revoked");
    // A terminal run leaves the session to the person.
    expect(session.control).toEqual({ holder: "human", generation: 4 });
  });

  it("interrupts before releasing when the run is not already the person's", async () => {
    await session.host.startDelegation("Fill the form");
    await control.claimRun("worker-a");
    // What the executor's writer mirrors when it starts driving.
    const started = await openRun();
    session.host.receiveRunEvent(
      started.runId,
      { t: "status", status: "running", completedAt: null },
      new Date().toISOString(),
    );
    const run = await openRun();
    expect(run.status).toBe("running");
    await session.host.releaseControl();
    const kinds = fake.run(run.runId).events.map((event) => event.event.t);
    // Control releases only from `human_control`, so the exit is take-then-release.
    expect(kinds.filter((kind) => kind === "cmd.interrupt")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "cmd.release")).toHaveLength(1);
  });

  it("approves and rejects a pending approval", async () => {
    await session.host.startDelegation("Submit it");
    const run = await openRun();
    await session.host.approve("pause-1");
    expect(fake.run(run.runId).events.some((event) => event.event.t === "resume")).toBe(true);
    await session.host.reject("pause-1");
    expect((await openRun()).status).toBe("rejected");
  });

  it("refuses every command when no conversation is open", async () => {
    for (const call of [
      () => session.host.sendAgentMessage("hi"),
      () => session.host.answerAgentQuestion("q", "a"),
      () => session.host.approve("a"),
      () => session.host.reject("a"),
      () => session.host.interruptAgent(),
      () => session.host.takeControl(),
      () => session.host.releaseControl(),
      () => session.host.revokeRun(),
    ]) {
      await expect(call()).rejects.toThrow(/no conversation is open/u);
    }
  });
});

describe("the run's own events", () => {
  it("reach the console without a stream, and carry the evidence getEvidence answers with", async () => {
    await session.host.startDelegation("Read it");
    const run = await openRun();
    const at = new Date().toISOString();
    // What the executor's writer mirrors, in the clear, in this process.
    session.host.receiveRunEvent(run.runId, { t: "status", status: "running", completedAt: null }, at);
    session.host.receiveRunEvent(run.runId, { t: "title", title: "Reading the fixture" }, at);
    session.host.receiveRunEvent(
      run.runId,
      { t: "tool.started", toolId: "t1", name: "page.inspect", label: "Inspect", tabId: "cloud:1" },
      at,
    );
    session.host.receiveRunEvent(
      run.runId,
      { t: "evidence", entry: { type: "browser.action", at, payload: {} } } as never,
      at,
    );
    const folded = await openRun();
    expect(folded.status).toBe("running");
    expect(folded.title).toBe("Reading the fixture");
    expect(folded.toolCalls.map((tool) => tool.name)).toEqual(["page.inspect"]);
    expect(await session.host.getEvidence()).toHaveLength(1);

    // An event for another conversation is not folded into this one.
    session.host.receiveRunEvent("00000000-0000-4000-8000-000000000000", { t: "title", title: "Elsewhere" }, at);
    expect((await openRun()).title).toBe("Reading the fixture");
  });
});

describe("threads", () => {
  it("lists the session's Space, reopens a cloud run by replaying its stream, and clears for a new one", async () => {
    await session.host.startDelegation("First");
    const first = await openRun();
    session.host.receiveRunEvent(first.runId, { t: "title", title: "The first thread" }, new Date().toISOString());
    // The run has to end before the console will let go of it.
    await session.host.revokeRun();

    await session.host.newThread();
    expect((await session.host.getSnapshot()).run).toBeNull();
    expect(await session.host.getEvidence()).toEqual([]);

    await session.host.startDelegation("Second");
    const second = await openRun();
    await session.host.revokeRun();
    await session.host.refreshThreads();
    const listed = (await session.host.getSnapshot()).threads.map((item) => item.runId);
    expect(listed).toContain(first.runId);
    expect(listed).toContain(second.runId);

    // Reopening the first: control has no `RunSummary` for a cloud run, so
    // the conversation is rebuilt from its own events — including the sealed
    // ones, opened here with the session's Space keys.
    const sealed = await seal(
      keys.sealKey,
      utf8(JSON.stringify({ t: "message", message: { role: "assistant", content: "done" } })),
      runEventSealAad(first.runId, "e-sealed"),
    );
    fake.run(first.runId).events.push({
      seq: 999,
      eventId: "e-sealed",
      at: new Date().toISOString(),
      event: { t: "sealed", spaceId: SPACE, sealed: toBase64(sealed) },
    });
    await session.host.openThread(first.runId);
    const reopened = await openRun();
    expect(reopened.runId).toBe(first.runId);
    expect(reopened.messages.map((message) => message.content)).toContain("done");
  });

  it("opens a conversation a desktop executor mirrored straight from its sealed snapshot", async () => {
    const run = fake.addRun({ userId: USER_A, spaceId: SPACE, intent: "From the Mac" });
    const summary = { runId: run.record.id, title: "From the Mac", status: "completed", messages: [] };
    run.thread = {
      spaceId: SPACE,
      sealed: toBase64(
        await seal(keys.sealKey, utf8(JSON.stringify({ version: 2, run: summary })), runThreadSealAad(run.record.id)),
      ),
    };
    await session.host.openThread(run.record.id);
    expect((await openRun()).title).toBe("From the Mac");
  });

  it("refuses to open a conversation over one that is still acting", async () => {
    await session.host.startDelegation("Still going");
    const other = fake.addRun({ userId: USER_A, spaceId: SPACE, intent: "Elsewhere" });
    await expect(session.host.openThread(other.record.id)).rejects.toThrow(/pause or end the current task/u);
  });
});

describe("the live view members", () => {
  it("refuse to open a second live view: the pane the person is looking at IS one", async () => {
    // `openLiveView` used to answer `liveState: "open"`, which raised the
    // store's overlay — over a stream that never arrives, since `onCloudFrame`
    // never emits and `sendLiveInput` does nothing. A blank overlay saying
    // "you have control" and discarding every click is worse than a refusal,
    // and the refusal is what the shell renders as an unavailable affordance.
    await session.host.startDelegation("Watch me");
    await openRun();
    await expect(session.host.openLiveView()).rejects.toThrow(/live view/u);
    await expect(session.host.openLiveView()).rejects.toSatisfy(isUnsupportedShellMethod);
    // The other two stay no-ops: closing something that was never open, and
    // input that travels as `{t:'input'}` under the session's own fence.
    await expect(session.host.closeLiveView()).resolves.toBeUndefined();
    expect(
      session.host.sendLiveInput({ t: "focus", tabId: "cloud:1" }),
    ).toBeUndefined();
  });
});

/* ------------------------- adversarial review fixes ------------------------ */

describe("who the console acts as", () => {
  it("audits each command as the device whose viewer made it, not the last one to attach", async () => {
    // Two browser tabs on the same session — a laptop and a phone. One
    // remembered `viewerDeviceId` made every action by A read as B's, and
    // revoking B killed A's console with `403 viewer_device` while A was
    // still attached and still proving the Space key every minute.
    const laptop = fake.addWebDevice(USER_A).id;
    const phone = fake.addWebDevice(USER_A).id;
    session.setViewerDevice(phone);
    fake.revokeDevice(phone);

    await withViewer({ id: "laptop", deviceId: laptop, downloadKey: "k1" }, () =>
      session.host.startDelegation("Read the fixture page"),
    );
    expect((await session.host.getSnapshot()).run?.purpose).toBe("Read the fixture page");

    await expect(
      withViewer({ id: "phone", deviceId: phone, downloadKey: "k2" }, () =>
        session.host.sendAgentMessage("from the revoked device"),
      ),
    ).rejects.toThrow();
  });
});

describe("the control fence on a conversation this console does not have open", () => {
  it("still moves, rather than waiting for the next heartbeat", async () => {
    await session.host.startDelegation("The open one");
    const open = await openRun();
    const before = session.control.generation;
    // A hand-back from a run started on another device belongs to this pane
    // too: the fence is the SESSION's, not the conversation's. Mirroring it
    // after the "is this the open conversation" guard left the agent's veil
    // up until the heartbeat noticed.
    session.host.receiveRunEvent(
      `${open.runId}-elsewhere`,
      { t: "control", control: "human", generation: before + 5 } as never,
      new Date().toISOString(),
    );
    expect(session.control).toEqual({ holder: "human", generation: before + 5 });
  });
});
