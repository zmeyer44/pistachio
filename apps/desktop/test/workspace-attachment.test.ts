/**
 * Workspace sync's restore-point lane (docs/cloud-sync-design.md §10.2, D9):
 * this device's `device-workspace:<id>` doc follows the tab session 40 ms
 * after it persists, sealed under the workspace key and device-signed;
 * other devices' restore points are offered for Pull/Merge and applied
 * through the browser, never merged into a canonical tab graph; Space docs
 * travel both ways without echo.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveSpaceKeys,
  fromBase64,
  fromUtf8,
  generateDeviceKeypair,
  open,
  seal,
  toBase64,
  utf8,
  workspaceRecordBytes,
  workspaceSealAad,
  workspaceSigningBytes,
  FRAME_BUDGET_BYTES,
  WORKSPACE_PSEUDO_SPACE_ID,
  type Hlc,
  type SpaceKeys,
  type WorkspaceRecordWire,
} from "@pistachio/sync-protocol";
import { ArtifactStore } from "../src/main/artifact-store";
import { BookmarkStore } from "../src/main/bookmark-store";
import { MemoryStore } from "../src/main/memory-store";
import { NoteStore } from "../src/main/note-store";
import { ReminderStore } from "../src/main/reminder-store";
import { SpaceStore } from "../src/main/space-store";
import { WorkspaceRecords } from "../src/main/sync/records";
import { spaceDocFor } from "../src/main/sync/workspace-map";
import { RESTORE_POINT_DEBOUNCE_MS, WorkspaceSyncService } from "../src/main/sync/workspace-sync";
import type { WorkspaceSyncStatus } from "@pistachio/shell-contracts/ipc";
import type { DurableTab, DurableTabSession } from "@pistachio/shell-contracts/tab-session";

const dirs: string[] = [];
const services: WorkspaceSyncService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tab(id: string, url = `https://example.com/${id}`): DurableTab {
  return { id, spaceId: "work", title: id, url, faviconUrl: null, anchorId: null, lastActiveAt: 1 };
}

function restorePoint(tabs: DurableTab[]): DurableTabSession {
  return {
    version: 1,
    spaces: { work: { tabs, activeTabId: tabs[0]?.id ?? null, recentTabIds: tabs.map((t) => t.id), splitGroups: [] } },
  };
}

interface Harness {
  service: WorkspaceSyncService;
  spaces: SpaceStore;
  bookmarks: BookmarkStore;
  reminders: ReminderStore;
  memory: MemoryStore;
  artifacts: ArtifactStore;
  notes: NoteStore;
  keys: SpaceKeys;
  publicKey: CryptoKey;
  /** The one enrolled peer whose docs verify; "device-z" is nobody. */
  peer: CryptoKeyPair;
  published: WorkspaceRecordWire[];
  statuses: WorkspaceSyncStatus[];
  applied: Array<{ spaceId: string; mode: string; tabIds: string[] }>;
  restorePoint: DurableTabSession;
  openDoc(wire: WorkspaceRecordWire): Promise<unknown>;
  seal(key: string, doc: unknown, hlc?: Hlc): Promise<Omit<WorkspaceRecordWire, "deviceSig">>;
  wire(key: string, doc: unknown, hlc?: Hlc): Promise<WorkspaceRecordWire>;
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-workspace-"));
  dirs.push(dir);
  const keypair = await generateDeviceKeypair();
  const peer = await generateDeviceKeypair();
  const keys = await deriveSpaceKeys(WORKSPACE_PSEUDO_SPACE_ID, new Uint8Array(32).fill(8));
  // The enrolled-device registry the real service consults (D15).
  const registry = new Map<string, CryptoKey>([
    ["device-a", keypair.publicKey],
    ["device-b", peer.publicKey],
  ]);
  const h: Harness = {
    service: undefined as unknown as WorkspaceSyncService,
    spaces: new SpaceStore(dir),
    bookmarks: new BookmarkStore(dir),
    reminders: new ReminderStore(dir, { timezone: () => "UTC" }),
    memory: new MemoryStore(dir),
    artifacts: new ArtifactStore(dir),
    notes: new NoteStore(dir),
    keys,
    publicKey: keypair.publicKey,
    peer,
    published: [],
    statuses: [],
    applied: [],
    restorePoint: restorePoint([tab("t1")]),
    openDoc: async (wire) =>
      wire.sealedValue === null
        ? null
        : (JSON.parse(fromUtf8(await open(keys.sealKey, fromBase64(wire.sealedValue), workspaceSealAad(wire.key)))) as unknown),
    seal: async (key, doc, hlc = { physicalMs: Date.now() + 60_000, logical: 0, deviceId: "device-b" }) => ({
      key,
      sealedValue: doc === null ? null : toBase64(await seal(keys.sealKey, utf8(JSON.stringify(doc)), workspaceSealAad(key))),
      hlc,
    }),
    wire: async (key, doc, hlc) => signWith(peer.privateKey, await h.seal(key, doc, hlc)),
  };
  h.service = new WorkspaceSyncService({
    deviceId: "device-a",
    deviceName: () => "Mac A",
    privateKey: keypair.privateKey,
    verifyDoc: async (wire) => {
      const publicKey = registry.get(wire.hlc.deviceId);
      return publicKey === undefined ? false : verifySig(publicKey, wire);
    },
    keys,
    spaces: h.spaces,
    records: new WorkspaceRecords({
      bookmark: h.bookmarks,
      reminder: h.reminders,
      memory: h.memory,
      artifact: {
        all: () => h.artifacts.syncAll(),
        get: (id) => h.artifacts.syncGet(id),
        applyRemote: (value) => h.artifacts.applyRemote(value),
        removeRemote: (id) => h.artifacts.removeRemote(id),
        onRecordChange: (listener) => h.artifacts.onRecordChange(listener),
      },
      note: {
        all: () => h.notes.syncAll("note"),
        get: (id) => h.notes.syncGet("note", id),
        applyRemote: (value) => h.notes.applyRemote("note", value),
        removeRemote: (id) => h.notes.removeRemote("note", id),
        onRecordChange: (listener) =>
          h.notes.onRecordChange((kind, id) => {
            if (kind === "note") listener(id);
          }),
      },
      noteBlob: {
        all: () => h.notes.syncAll("noteBlob"),
        get: (id) => h.notes.syncGet("noteBlob", id),
        applyRemote: (value) => h.notes.applyRemote("noteBlob", value),
        removeRemote: (id) => h.notes.removeRemote("noteBlob", id),
        onRecordChange: (listener) =>
          h.notes.onRecordChange((kind, id) => {
            if (kind === "noteBlob") listener(id);
          }),
      },
    }),
    restorePoint: () => structuredClone(h.restorePoint),
    applyRestorePoint: async (session, spaceId, mode) => {
      h.applied.push({ spaceId, mode, tabIds: (session.spaces[spaceId]?.tabs ?? []).map((t) => t.id) });
    },
    publish: (docs) => h.published.push(...docs),
    onStatusChanged: (status) => h.statuses.push(status),
    registersPath: null,
  });
  services.push(h.service);
  return h;
}

async function hydrated(): Promise<Harness> {
  const h = await harness();
  h.service.start();
  await h.service.handleHydrated();
  return h;
}

describe("this device's restore point", () => {
  it("publishes the restore point after hydration, sealed under the workspace key and device-signed", async () => {
    const h = await hydrated();
    const keys = h.published.map((wire) => wire.key);
    expect(keys).toEqual(expect.arrayContaining(["device-workspace:device-a", "device-activity:device-a", "space:work", "settings:keyMode"]));
    const point = h.published.find((wire) => wire.key === "device-workspace:device-a")!;
    expect(await h.openDoc(point)).toEqual({
      kind: "deviceWorkspace",
      deviceId: "device-a",
      deviceKind: "desktop",
      name: "Mac A",
      session: h.restorePoint,
      savedAtMs: expect.any(Number),
    });
    expect(point.hlc.deviceId).toBe("device-a");
    // Signed with the device key over the protocol's canonical bytes.
    expect(await verifySig(h.publicKey, point)).toBe(true);
    expect(await h.openDoc(h.published.find((wire) => wire.key === "space:work")!)).toEqual(spaceDocFor(h.spaces.get("work")!));
    expect(h.service.status()).toMatchObject({ state: "idle", error: null, remoteRestorePoints: [] });
    expect(h.service.status().lastPushMs).not.toBeNull();
  });

  it("bounds the restore point before sealing so one Mac's tabs cannot break the lane", async () => {
    const h = await hydrated();
    h.published.length = 0;
    // Every tab carrying a 16 KB data: favicon — the shape that made an
    // untrimmed restore point exceed a hub frame.
    const favicon = `data:image/png;base64,${"A".repeat(16_000)}`;
    h.restorePoint = restorePoint(
      Array.from({ length: 200 }, (_, i) => ({ ...tab(`t${String(i)}`), faviconUrl: favicon })),
    );
    h.service.noteSessionPersisted();
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);

    const point = h.published.find((wire) => wire.key === "device-workspace:device-a")!;
    expect(workspaceRecordBytes(point)).toBeLessThan(FRAME_BUDGET_BYTES);
    const doc = (await h.openDoc(point)) as { session: DurableTabSession };
    // The tabs survive; only the refetchable decoration is gone.
    expect(doc.session.spaces["work"]?.tabs).toHaveLength(200);
    expect(doc.session.spaces["work"]?.tabs.every((t) => t.faviconUrl === null)).toBe(true);
  });

  it("follows the tab session 40 ms after it persists, coalescing a burst", async () => {
    const h = await hydrated();
    h.published.length = 0;
    h.restorePoint = restorePoint([tab("t1"), tab("t2")]);
    h.service.noteSessionPersisted();
    h.restorePoint = restorePoint([tab("t1"), tab("t2"), tab("t3")]);
    h.service.noteSessionPersisted();
    await sleep(10);
    expect(h.published).toHaveLength(0);
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    const points = h.published.filter((wire) => wire.key === "device-workspace:device-a");
    expect(points).toHaveLength(1);
    const doc = (await h.openDoc(points[0]!)) as { session: DurableTabSession };
    expect(doc.session.spaces["work"]?.tabs.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("holds the restore point until the workspace stream has hydrated", async () => {
    const h = await harness();
    h.service.start();
    h.service.noteSessionPersisted();
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 40);
    expect(h.published.map((wire) => wire.key)).not.toContain("device-workspace:device-a");
    expect(h.service.status().state).toBe("syncing");
    await expect(h.service.run({ kind: "push" })).rejects.toThrow(/still loading/);
  });
});

describe("other devices' restore points", () => {
  it("offers a remote restore point for Pull and applies it through the browser, never its own echo", async () => {
    const h = await hydrated();
    await h.service.handleRemoteDocs([
      await h.wire("device-workspace:device-a", { kind: "deviceWorkspace", deviceId: "device-a", deviceKind: "desktop", name: "Echo", session: restorePoint([tab("echo")]), savedAtMs: 1 }),
      await h.wire("device-workspace:device-b", { kind: "deviceWorkspace", deviceId: "device-b", deviceKind: "desktop", name: "", session: restorePoint([tab("b1"), tab("b2")]), savedAtMs: 5_000 }),
      await h.wire("device-activity:device-b", { kind: "deviceActivity", deviceId: "device-b", name: "Mac B", platform: "macos", lastActiveMs: 4_000, activeSpaceId: "work" }),
    ]);
    expect(h.service.status().remoteRestorePoints).toEqual([
      { deviceId: "device-b", name: "Mac B", deviceKind: "desktop", savedAtMs: 5_000, tabCount: 2, spaceIds: ["work"] },
    ]);

    await h.service.run({ kind: "pull", deviceId: "device-b", mode: "replace" });
    expect(h.applied).toEqual([{ spaceId: "work", mode: "replace", tabIds: ["b1", "b2"] }]);
    await h.service.run({ kind: "pull", deviceId: "device-b", mode: "merge", spaceIds: ["work"] });
    expect(h.applied.at(-1)?.mode).toBe("merge");
    expect(h.service.status().lastRunMs).not.toBeNull();
    // The person's own point, an unknown device, and a Space this Mac lacks are refused.
    await expect(h.service.run({ kind: "pull", deviceId: "device-a", mode: "replace" })).rejects.toThrow(/no longer available/);
    await expect(h.service.run({ kind: "pull", deviceId: "device-z", mode: "replace" })).rejects.toThrow(/no longer available/);
    await expect(h.service.run({ kind: "pull", deviceId: "device-b", mode: "replace", spaceIds: ["nope"] })).rejects.toThrow(/None of/);
    expect(h.service.status().state).toBe("error");
    expect(h.applied).toHaveLength(2);
  });

  it("keeps the newest restore point per device and drops a tombstoned one", async () => {
    const h = await hydrated();
    const newer = { physicalMs: Date.now() + 90_000, logical: 0, deviceId: "device-b" };
    const older = { physicalMs: Date.now() + 30_000, logical: 0, deviceId: "device-b" };
    await h.service.handleRemoteDocs([
      await h.wire("device-workspace:device-b", { kind: "deviceWorkspace", deviceId: "device-b", deviceKind: "desktop", name: "New", session: restorePoint([tab("n")]), savedAtMs: 2 }, newer),
      await h.wire("device-workspace:device-b", { kind: "deviceWorkspace", deviceId: "device-b", deviceKind: "desktop", name: "Old", session: restorePoint([tab("o")]), savedAtMs: 1 }, older),
    ]);
    expect(h.service.status().remoteRestorePoints.map((point) => point.name)).toEqual(["New"]);
    await h.service.handleRemoteDocs([await h.wire("device-workspace:device-b", null, { ...newer, logical: 1 })]);
    expect(h.service.status().remoteRestorePoints).toEqual([]);
  });

  it("skips a doc sealed under another account's workspace key", async () => {
    const h = await hydrated();
    const foreign = await deriveSpaceKeys(WORKSPACE_PSEUDO_SPACE_ID, new Uint8Array(32).fill(9));
    const key = "device-workspace:device-b";
    await h.service.handleRemoteDocs([
      await signWith(h.peer.privateKey, {
        key,
        sealedValue: toBase64(await seal(foreign.sealKey, utf8(JSON.stringify({ kind: "deviceWorkspace", deviceId: "device-b", deviceKind: "desktop", name: "X", session: restorePoint([tab("x")]), savedAtMs: 1 })), workspaceSealAad(key))),
        hlc: { physicalMs: Date.now() + 60_000, logical: 0, deviceId: "device-b" },
      }),
    ]);
    expect(h.service.status().remoteRestorePoints).toEqual([]);
  });

  it("drops a doc whose device signature is forged, and one from a device the registry does not know (D15)", async () => {
    const h = await hydrated();
    h.spaces.setEgressPolicy("work", "identity");
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    const later = (deviceId: string): Hlc => ({ physicalMs: Date.now() + 120_000, logical: 0, deviceId });
    const rollback = { ...spaceDocFor(h.spaces.get("work")!), egressPolicy: "direct" };
    const point = { kind: "deviceWorkspace", deviceId: "device-z", deviceKind: "desktop", name: "Z", session: restorePoint([tab("z")]), savedAtMs: 9_000 };
    const stranger = await generateDeviceKeypair();
    await h.service.handleRemoteDocs([
      // A stored value re-served with a fabricated newer HLC and a garbage signature.
      { ...(await h.seal("space:work", rollback, later("device-b"))), deviceSig: toBase64(new Uint8Array(64)) },
      // Correctly signed, but by a device that was never enrolled (or was revoked).
      await signWith(stranger.privateKey, await h.seal("device-workspace:device-z", point, later("device-z"))),
    ]);
    expect(h.spaces.get("work")?.egressPolicy).toBe("identity");
    expect(h.service.status().remoteRestorePoints).toEqual([]);
    // The forged HLC never reached the clock either: a legitimate doc from
    // that device still merges, so the rollback was not simply outvoted.
    await h.service.handleRemoteDocs([await h.wire("space:work", rollback, later("device-b"))]);
    expect(h.spaces.get("work")?.egressPolicy).toBe("direct");
  });
});

describe("Space docs both ways", () => {
  it("publishes a local fork, adopts a remote Space without echoing it, and removes a remotely deleted one", async () => {
    const h = await hydrated();
    h.published.length = 0;
    const fork = h.spaces.createFork("work", "Fork", "purpose", ["https://a.example"]);
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    const forkWire = h.published.find((wire) => wire.key === `space:${fork.id}`);
    expect(forkWire).toBeDefined();
    expect(await h.openDoc(forkWire!)).toEqual(spaceDocFor(fork));
    expect(forkWire?.hlc.deviceId).toBe("device-a");

    h.published.length = 0;
    const remote = { ...spaceDocFor(fork), id: "remote-1", name: "From B", parentSpaceId: null };
    await h.service.handleRemoteDocs([await h.wire("space:remote-1", remote)]);
    expect(h.spaces.get("remote-1")).toMatchObject({ id: "remote-1", name: "From B", egressPolicy: "direct", cloudEnabled: false });
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    expect(h.published.map((wire) => wire.key)).not.toContain("space:remote-1");

    await h.service.handleRemoteDocs([await h.wire(`space:${fork.id}`, null)]);
    expect(h.spaces.get(fork.id)).toBeNull();
  });

  it("keeps the default Space when a remote tombstone names it, and republishes it", async () => {
    const h = await hydrated();
    h.published.length = 0;
    await h.service.handleRemoteDocs([await h.wire("space:work", null)]);
    expect(h.spaces.get("work")).not.toBeNull();
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    const republished = h.published.find((wire) => wire.key === "space:work");
    expect(republished).toBeDefined();
    expect(republished?.sealedValue).not.toBeNull();
  });

  it("lets a newer local rename win over an older remote doc, and a newer remote one win over local", async () => {
    const h = await hydrated();
    h.spaces.rename("work", "Renamed here");
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    const stale = { ...spaceDocFor(h.spaces.get("work")!), name: "Stale from B" };
    await h.service.handleRemoteDocs([await h.wire("space:work", stale, { physicalMs: Date.now() - 120_000, logical: 0, deviceId: "device-b" })]);
    expect(h.spaces.get("work")?.name).toBe("Renamed here");
    const fresh = { ...spaceDocFor(h.spaces.get("work")!), name: "Fresh from B" };
    await h.service.handleRemoteDocs([await h.wire("space:work", fresh)]);
    expect(h.spaces.get("work")?.name).toBe("Fresh from B");
  });
});

describe("the personal records (bookmarks, reminders, memory, artifacts, notes)", () => {
  const later = (deviceId = "device-b"): Hlc => ({ physicalMs: Date.now() + 120_000, logical: 0, deviceId });

  it("publishes exactly one sealed doc per record, under its own key, signed by this device", async () => {
    const h = await hydrated();
    h.published.length = 0;
    const bookmark = h.bookmarks.add({ url: "https://example.com/pie" }, { kind: "user", runId: null });
    const reminder = h.reminders.add(
      { title: "Water the plants", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "🌱" } },
      { kind: "user", runId: null },
    );
    const fact = h.memory.add({ content: "Alex prefers window seats" }, { kind: "user", runId: null });
    const artifact = h.artifacts.create(
      { title: "Trip brief", brief: "A compact plan", html: "<!doctype html><title>Trip</title>", builtWith: "test-model" },
      { kind: "agent", runId: "run-1" },
    );
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);

    for (const [key, doc] of [
      [`bookmark:${bookmark.id}`, { kind: "bookmark", bookmark: h.bookmarks.get(bookmark.id) }],
      [`reminder:${reminder.id}`, { kind: "reminder", reminder: h.reminders.get(reminder.id) }],
      [`memory:${fact.id}`, { kind: "memory", memory: h.memory.get(fact.id) }],
      [`artifact:${artifact.id}`, { kind: "artifact", artifact: h.artifacts.syncGet(artifact.id) }],
    ] as const) {
      const wires = h.published.filter((wire) => wire.key === key);
      expect(wires, key).toHaveLength(1);
      expect(await h.openDoc(wires[0]!)).toEqual(doc);
      expect(wires[0]!.sealedValue).not.toBeNull();
      expect(wires[0]!.hlc.deviceId).toBe("device-a");
      expect(await verifySig(h.publicKey, wires[0]!)).toBe(true);
    }
  });

  it("applies a remote record into the store, and a tombstone removes it", async () => {
    const h = await hydrated();
    h.published.length = 0;
    await h.service.handleRemoteDocs([
      await h.wire("bookmark:bk-1", { kind: "bookmark", bookmark: remoteBookmark("bk-1") }),
      await h.wire("reminder:rm-1", { kind: "reminder", reminder: remoteReminder("rm-1") }),
      await h.wire("memory:mem-1", { kind: "memory", memory: remoteMemory("mem-1", 1) }),
      await h.wire("artifact:aaaabbbbcccc", {
        kind: "artifact",
        artifact: {
          id: "aaaabbbbcccc",
          title: "From B",
          brief: "Synced page",
          html: "<!doctype html><title>From B</title>",
          builtWith: "test-model",
          source: { kind: "agent", runId: "run-b" },
          revision: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ]);
    expect(h.bookmarks.get("bk-1")).toMatchObject({ url: "https://example.com/from-b", title: "From B" });
    expect(h.reminders.get("rm-1")).toMatchObject({ title: "From B", status: "active" });
    expect(h.memory.get("mem-1")).toMatchObject({ content: "Alex lives in Boulder", isLatest: true });
    expect(h.artifacts.syncGet("aaaabbbbcccc")).toMatchObject({ title: "From B", html: expect.stringContaining("From B") });
    // Applying another device's writes is not a local change (§10.2 echo rule):
    // publishing them back would hand device B its own doc under OUR HLC.
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    expect(h.published.map((wire) => wire.key)).not.toEqual(
      expect.arrayContaining(["bookmark:bk-1", "reminder:rm-1", "memory:mem-1", "artifact:aaaabbbbcccc"]),
    );

    // A record the store cannot read is not a delete: it leaves nothing behind.
    await h.service.handleRemoteDocs([
      await h.wire("bookmark:bk-2", { kind: "bookmark", bookmark: { id: "bk-2", url: "not-a-url" } }),
    ]);
    expect(h.bookmarks.get("bk-2")).toBeNull();

    h.published.length = 0;
    await h.service.handleRemoteDocs([
      await h.wire("bookmark:bk-1", null, later()),
      await h.wire("reminder:rm-1", null, later()),
      await h.wire("memory:mem-1", null, later()),
      await h.wire("artifact:aaaabbbbcccc", null, later()),
    ]);
    expect(h.bookmarks.get("bk-1")).toBeNull();
    expect(h.reminders.get("rm-1")).toBeNull();
    expect(h.memory.get("mem-1")).toBeNull();
    expect(h.artifacts.get("aaaabbbbcccc")).toBeNull();
    // Nor is applying its deletions.
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    expect(h.published.map((wire) => wire.key)).not.toEqual(
      expect.arrayContaining(["bookmark:bk-1", "reminder:rm-1", "memory:mem-1", "artifact:aaaabbbbcccc"]),
    );
  });

  it("does not republish the echo of a doc it published itself", async () => {
    const h = await hydrated();
    h.published.length = 0;
    const bookmark = h.bookmarks.add({ url: "https://example.com/echo" }, { kind: "user", runId: null });
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    const ours = h.published.find((wire) => wire.key === `bookmark:${bookmark.id}`)!;
    expect(ours).toBeDefined();

    h.published.length = 0;
    // The hub fans our own doc back out to us, exactly as it stored it.
    await h.service.handleRemoteDocs([ours]);
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    expect(h.published.map((wire) => wire.key)).not.toContain(`bookmark:${bookmark.id}`);
    expect(h.bookmarks.get(bookmark.id)).toEqual(bookmark);

    // And a record register this Mac merged from a peer stays the peer's to
    // publish: re-signing it here under B's deviceId yields a wire that fails
    // verification everywhere. A reconnect must not reintroduce it.
    await h.service.handleRemoteDocs([
      await h.wire("bookmark:bk-b", { kind: "bookmark", bookmark: remoteBookmark("bk-b") }),
    ]);
    h.published.length = 0;
    await h.service.handleHydrated();
    expect(h.published.map((wire) => wire.key)).not.toContain("bookmark:bk-b");
    for (const wire of h.published) {
      expect(wire.hlc.deviceId).toBe("device-a");
      expect(await verifySig(h.publicKey, wire)).toBe(true);
    }
    expect(h.published.length).toBeGreaterThan(0);
  });

  it("publishes a note and its picture as two registers, and takes both back from another device (docs/notes.md N2, N3)", async () => {
    const h = await hydrated();
    h.published.length = 0;
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 7, 7, 7]);
    const blob = h.notes.putBlob(bytes, "image/png");
    const note = h.notes.create({ title: "Sunday pie", markdown: `Cherries.\n\n![](note-blob:${blob.id})` }, { kind: "user", runId: null });
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);

    // Text and bytes never share a register: a keystroke re-seals the note alone.
    const noteWires = h.published.filter((wire) => wire.key === `note:${note.id}`);
    const blobWires = h.published.filter((wire) => wire.key === `note-blob:${blob.id}`);
    expect(noteWires).toHaveLength(1);
    expect(blobWires).toHaveLength(1);
    expect(await h.openDoc(noteWires[0]!)).toEqual({ kind: "note", note: h.notes.syncGet("note", note.id) });
    expect(await h.openDoc(blobWires[0]!)).toEqual({ kind: "noteBlob", blob: h.notes.syncGet("noteBlob", blob.id) });
    expect(noteWires[0]!.hlc.deviceId).toBe("device-a");
    expect(await verifySig(h.publicKey, noteWires[0]!)).toBe(true);
    expect(await verifySig(h.publicKey, blobWires[0]!)).toBe(true);

    // A note from device B, and the picture it names arriving in its own register.
    h.published.length = 0;
    const remoteBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);
    const remoteBlobId = createHash("sha256").update(Buffer.from(remoteBytes)).digest("hex").slice(0, 24);
    await h.service.handleRemoteDocs([
      await h.wire("note:aaaabbbbcccc", {
        kind: "note",
        note: {
          id: "aaaabbbbcccc",
          title: "From B",
          markdown: `Written over there.\n\n![](note-blob:${remoteBlobId})`,
          icon: null,
          blobIds: [remoteBlobId],
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
          revision: 2,
          source: { kind: "user", runId: null },
        },
      }),
      await h.wire(`note-blob:${remoteBlobId}`, {
        kind: "noteBlob",
        blob: {
          id: remoteBlobId,
          mediaType: "image/png",
          byteLength: remoteBytes.byteLength,
          data: Buffer.from(remoteBytes).toString("base64"),
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    ]);
    expect(h.notes.get("aaaabbbbcccc")).toMatchObject({ title: "From B", revision: 2, blobIds: [remoteBlobId] });
    expect(h.notes.getBlob(remoteBlobId)?.byteLength).toBe(remoteBytes.byteLength);
    // Applying another device's writes is not a local change (§10.2 echo rule).
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    expect(h.published.map((wire) => wire.key)).not.toEqual(
      expect.arrayContaining(["note:aaaabbbbcccc", `note-blob:${remoteBlobId}`]),
    );

    h.published.length = 0;
    await h.service.handleRemoteDocs([
      await h.wire("note:aaaabbbbcccc", null, later()),
      await h.wire(`note-blob:${remoteBlobId}`, null, later()),
    ]);
    expect(h.notes.get("aaaabbbbcccc")).toBeNull();
    expect(h.notes.getBlob(remoteBlobId)).toBeNull();
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    expect(h.published.map((wire) => wire.key)).not.toEqual(
      expect.arrayContaining(["note:aaaabbbbcccc", `note-blob:${remoteBlobId}`]),
    );
  });

  it("publishes the tombstone of a picture the deleted note was the last to name", async () => {
    const h = await hydrated();
    const blob = h.notes.putBlob(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "image/png");
    const note = h.notes.create({ markdown: `![](note-blob:${blob.id})` }, { kind: "user", runId: null });
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    h.published.length = 0;

    h.notes.remove(note.id);
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    // Both registers go, or every device keeps a megabyte nobody names.
    for (const key of [`note:${note.id}`, `note-blob:${blob.id}`]) {
      const wire = h.published.find((published) => published.key === key);
      expect(wire, key).toBeDefined();
      expect(wire?.sealedValue).toBeNull();
    }
  });

  it("keeps isLatest coherent when a memory version arrives before the one it supersedes", async () => {
    const h = await hydrated();
    // v2 lands first: with only one version of the chain here, it is latest.
    await h.service.handleRemoteDocs([
      await h.wire("memory:mem-2", { kind: "memory", memory: remoteMemory("mem-2", 2, "mem-1") }),
    ]);
    expect(h.memory.get("mem-2")?.isLatest).toBe(true);

    // The version it corrects arrives afterwards, still claiming to be latest
    // on the wire. isLatest is derived, so the chain settles on v2 regardless.
    await h.service.handleRemoteDocs([
      await h.wire("memory:mem-1", { kind: "memory", memory: { ...remoteMemory("mem-1", 1), isLatest: true } }),
    ]);
    expect(h.memory.get("mem-1")?.isLatest).toBe(false);
    expect(h.memory.get("mem-2")?.isLatest).toBe(true);
    expect(h.memory.active().map((entry) => entry.id)).toEqual(["mem-2"]);

    // Deleting the newest version promotes the survivor rather than leaving none.
    await h.service.handleRemoteDocs([await h.wire("memory:mem-2", null, later())]);
    expect(h.memory.get("mem-1")?.isLatest).toBe(true);
  });

  it("publishes a memory correction as its own register, beside the version it supersedes", async () => {
    const h = await hydrated();
    const first = h.memory.add({ content: "Alex works at Northstar", key: "project.current" }, { kind: "user", runId: null });
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);
    h.published.length = 0;

    const second = h.memory.update(first.id, { content: "Alex works at Southstar" }, { kind: "user", runId: null });
    expect(second.id).not.toBe(first.id);
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);

    // Two registers, not one: the correction cannot overwrite — or race — the
    // fact it corrects, and the superseded version travels with isLatest false.
    const keys = h.published.map((wire) => wire.key);
    expect(keys).toEqual(expect.arrayContaining([`memory:${first.id}`, `memory:${second.id}`]));
    const superseded = (await h.openDoc(h.published.find((wire) => wire.key === `memory:${first.id}`)!)) as {
      memory: { isLatest: boolean; version: number };
    };
    expect(superseded.memory).toMatchObject({ isLatest: false, version: 1 });
    const correction = (await h.openDoc(h.published.find((wire) => wire.key === `memory:${second.id}`)!)) as {
      memory: { isLatest: boolean; version: number; parentId: string };
    };
    expect(correction.memory).toMatchObject({ isLatest: true, version: 2, parentId: first.id });
  });

  it("lets a newer local edit win over an older remote doc, and a newer remote one win over local", async () => {
    const h = await hydrated();
    const bookmark = h.bookmarks.add({ url: "https://example.com/race" }, { kind: "user", runId: null });
    h.bookmarks.update(bookmark.id, { title: "Named here" });
    await sleep(RESTORE_POINT_DEBOUNCE_MS + 60);

    const stale = { ...h.bookmarks.get(bookmark.id)!, title: "Stale from B" };
    await h.service.handleRemoteDocs([
      await h.wire(`bookmark:${bookmark.id}`, { kind: "bookmark", bookmark: stale }, { physicalMs: Date.now() - 120_000, logical: 0, deviceId: "device-b" }),
    ]);
    expect(h.bookmarks.get(bookmark.id)?.title).toBe("Named here");

    const fresh = { ...h.bookmarks.get(bookmark.id)!, title: "Fresh from B" };
    await h.service.handleRemoteDocs([await h.wire(`bookmark:${bookmark.id}`, { kind: "bookmark", bookmark: fresh }, later())]);
    expect(h.bookmarks.get(bookmark.id)?.title).toBe("Fresh from B");
  });

  it("seeds what this Mac already held before it ever signed in", async () => {
    const h = await harness();
    const bookmark = h.bookmarks.add({ url: "https://example.com/offline" }, { kind: "user", runId: null });
    // A signed-out Mac still has its notes; enrolment introduces them.
    const note = h.notes.create({ title: "Written before signing in" }, { kind: "user", runId: null });
    h.service.start();
    await h.service.handleHydrated();
    const wires = h.published.filter((wire) => wire.key === `bookmark:${bookmark.id}`);
    expect(wires).toHaveLength(1);
    expect(await h.openDoc(wires[0]!)).toEqual({ kind: "bookmark", bookmark: h.bookmarks.get(bookmark.id) });
    const noteWires = h.published.filter((wire) => wire.key === `note:${note.id}`);
    expect(noteWires).toHaveLength(1);
    expect(await h.openDoc(noteWires[0]!)).toEqual({ kind: "note", note: h.notes.syncGet("note", note.id) });
  });
});

describe("republication after a merge", () => {
  it("never re-signs a doc it merged, so every wire it publishes verifies at its peers", async () => {
    const h = await hydrated();
    const remoteHlc: Hlc = { physicalMs: Date.now() + 120_000, logical: 0, deviceId: "device-b" };
    const merged = { ...spaceDocFor(h.spaces.get("work")!), purpose: "from device B" };
    // Device B wins the register for space:work, so this Mac adopts B's HLC.
    await h.service.handleRemoteDocs([await h.wire("space:work", merged, remoteHlc)]);

    // A reconnect re-publishes what this Mac has to introduce.
    h.published.length = 0;
    await h.service.handleHydrated();

    // The adopted register is B's to publish; re-signing it here with OUR key
    // under B's deviceId produces a wire that fails verification at every
    // peer (they look the key up by hlc.deviceId), so it is silently dropped
    // and the hub refuses the batch outright.
    expect(h.published.map((wire) => wire.key)).not.toContain("space:work");

    // The invariant that generalises it: anything we publish must verify.
    for (const wire of h.published) {
      expect(wire.hlc.deviceId).toBe("device-a");
      expect(await verifySig(h.publicKey, wire)).toBe(true);
    }
    expect(h.published.length).toBeGreaterThan(0);
  });
});


function remoteBookmark(id: string) {
  return {
    id,
    url: "https://example.com/from-b",
    kind: "article",
    title: "From B",
    description: "",
    imageUrl: null,
    faviconUrl: null,
    siteName: "",
    keywords: [],
    details: [],
    note: "",
    status: "ready",
    provenance: "page",
    editedFields: [],
    source: { kind: "user", runId: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function remoteReminder(id: string) {
  return {
    id,
    title: "From B",
    schedule: { kind: "daily", time: "09:00" },
    action: { kind: "message", text: "hello" },
    timezone: "UTC",
    status: "active",
    source: { kind: "user", runId: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextFireAt: "2099-01-01T09:00:00.000Z",
    lastFiredAt: null,
    until: null,
    maxFires: null,
    fireCount: 0,
  };
}

function remoteMemory(id: string, version: number, parentId: string | null = null) {
  return {
    id,
    rootId: "mem-1",
    parentId,
    version,
    isLatest: true,
    content: version === 1 ? "Alex lives in Boulder" : "Alex lives in Denver",
    label: null,
    key: null,
    kind: "static",
    bucket: "location",
    source: { kind: "user", runId: null },
    confidence: 1,
    review: "approved",
    mentions: 1,
    createdAt: `2026-01-0${String(version)}T00:00:00.000Z`,
    lastRecalledAt: null,
    isForgotten: false,
    forgottenAt: null,
    forgetAfter: null,
    forgetReason: null,
  };
}

async function signWith(privateKey: CryptoKey, wire: Omit<WorkspaceRecordWire, "deviceSig">): Promise<WorkspaceRecordWire> {
  const bytes = workspaceSigningBytes(wire.key, wire.sealedValue, wire.hlc);
  const sig = await crypto.subtle.sign("Ed25519", privateKey, bytes as BufferSource);
  return { ...wire, deviceSig: toBase64(new Uint8Array(sig)) };
}

async function verifySig(publicKey: CryptoKey, wire: WorkspaceRecordWire): Promise<boolean> {
  const bytes = workspaceSigningBytes(wire.key, wire.sealedValue, wire.hlc);
  return crypto.subtle.verify("Ed25519", publicKey, fromBase64(wire.deviceSig) as BufferSource, bytes as BufferSource);
}
