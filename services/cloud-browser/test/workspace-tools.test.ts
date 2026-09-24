import { describe, expect, it } from "vitest";
import { DeviceRegistryVerifier, type HubTransport } from "@pistachio/sync-engine";
import {
  deriveSpaceKeys,
  generateSpaceRootSecret,
  fromBase64,
  fromUtf8,
  open,
  seal,
  toBase64,
  utf8,
  workspaceSealAad,
  workspaceSigningBytes,
  type WorkspaceRecordWire,
  type ArtifactRecord,
} from "@pistachio/sync-protocol";
import { WorkspaceToolStore } from "../src/sync/workspace-tools.js";
import { EMPTY_BROWSER_SESSION_STATE } from "@pistachio/shell-contracts/tab-session";
import { SessionStateStore } from "../src/sessions/session-state.js";

it("hydrates signed checkpoints and chooses newer desktop state without overwriting newer cloud state", async () => {
  const keys = await deriveSpaceKeys("__workspace__", generateSpaceRootSecret());
  const signing = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const verifier = new DeviceRegistryVerifier("reject");
  for (const id of ["mac-old", "mac-new", "cloud-device"]) verifier.addDevice(id, signing.publicKey);
  const store = new WorkspaceToolStore({
    deviceId: "cloud-device", privateKey: signing.privateKey, keys: Promise.resolve(keys),
    transport: { publishWorkspace: () => undefined } as unknown as HubTransport,
    verifier: async () => verifier,
  });
  const point = (deviceId: string, savedAtMs: number, spaceId = "work") => ({
    kind: "deviceWorkspace", deviceId, deviceKind: "desktop", name: "Mac", savedAtMs,
    session: { version: 1, spaces: { [spaceId]: {
      tabs: [{ id: deviceId, spaceId, title: deviceId, url: `https://example.com/${deviceId}`, faviconUrl: null, anchorId: null, lastActiveAt: savedAtMs }],
      activeTabId: deviceId, recentTabIds: [deviceId], splitGroups: [],
    } } },
  });
  const wire = async (deviceId: string, value: unknown, physicalMs: number, key = `device-workspace:${deviceId}`): Promise<WorkspaceRecordWire> => {
    const hlc = { deviceId, physicalMs, logical: 0 };
    const sealedValue = value === null ? null : toBase64(await seal(keys.sealKey, utf8(JSON.stringify(value)), workspaceSealAad(key)));
    const signature = await crypto.subtle.sign("Ed25519", signing.privateKey, workspaceSigningBytes(key, sealedValue, hlc) as BufferSource);
    return { key, sealedValue, hlc, deviceSig: toBase64(new Uint8Array(signature)) };
  };
  store.receive([await wire("mac-old", point("mac-old", 10), 10), await wire("mac-new", point("mac-new", 20), 20)]);
  store.hydrated();
  await store.ready;
  const state = new SessionStateStore({ workspace: store, spaceId: "work" });
  expect(state.read()).toMatchObject({ activeTabId: "mac-new", tabs: [{ id: "mac-new", url: "https://example.com/mac-new", kind: "human" }] });
  expect(state.writable).toBe(true);
  expect(store.desktopSession("other")).toBeNull();

  // A correctly signed record still cannot impersonate another device's key.
  store.receive([await wire("mac-old", point("mac-new", 50), 50, "device-workspace:mac-new")]);
  const forged = await wire("mac-old", point("mac-old", 60), 60);
  const sig = fromBase64(forged.deviceSig);
  sig[0] = (sig[0] ?? 0) ^ 1;
  store.receive([{ ...forged, deviceSig: toBase64(sig) }]);
  await store.settled();
  expect(store.desktopSession("work")?.activeTabId).toBe("mac-new");

  // A newer cloud choice wins until desktop actually changes again.
  store.putBrowserSession({ ...structuredClone(EMPTY_BROWSER_SESSION_STATE), spaceId: "work", updatedAt: 100 });
  expect(state.read()?.tabs).toEqual([]);
  const newer = point("mac-new", 200);
  newer.session.spaces.work!.tabs[0]!.title = "Changed on desktop";
  store.receive([await wire("mac-new", newer, 200)]);
  await store.settled();
  expect(state.desktopHandoff()?.tabs[0]?.title).toBe("Changed on desktop");
  expect(state.read()?.tabs[0]?.title).toBe("Changed on desktop");
  store.putBrowserSession({ ...structuredClone(EMPTY_BROWSER_SESSION_STATE), spaceId: "work", version: 999 } as never);
  expect(state.read()).toBeNull();
  expect(state.writable).toBe(false);

  // Deleted points and points from other Spaces cannot win the fallback.
  store.receive([await wire("mac-new", null, 270), await wire("mac-old", point("mac-old", 80, "other"), 80)]);
  await store.settled();
  expect(store.desktopSession("work")).toBeNull();
  await store.settled();
  state.stop();
});

describe("WorkspaceToolStore", () => {
  it("backs every desktop-parity tool host with signed encrypted workspace records", async () => {
    const signing = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const verifier = new DeviceRegistryVerifier("reject");
    verifier.addDevice("cloud-device", signing.publicKey);
    const published: WorkspaceRecordWire[] = [];
    const changed: ArtifactRecord[] = [];
    const transport = {
      publishWorkspace: (docs: WorkspaceRecordWire[]) => published.push(...docs),
      state: "connected",
    } as unknown as HubTransport;
    const store = new WorkspaceToolStore({
      deviceId: "cloud-device",
      privateKey: signing.privateKey,
      keys: deriveSpaceKeys("__workspace__", generateSpaceRootSecret()),
      transport,
      verifier: async () => verifier,
      artifactWebUrl: "https://app.example",
      onArtifactChanged: (artifact) => changed.push(artifact),
      now: () => new Date("2026-09-03T15:00:00.000Z"),
    });
    store.hydrated();
    await store.ready;

    const memory = store.memory("run-1", "window seats");
    memory.host.add({ content: "Claudius prefers window seats", kind: "static", bucket: "preference" });
    expect(await memory.host.search("window seats")).toHaveLength(1);

    const reminders = store.reminders("run-1");
    reminders.create({
      title: "Check the oven",
      schedule: { kind: "once", at: "2026-09-03T16:00:00.000Z" },
      action: { kind: "message", text: "Check the oven" },
      timezone: "UTC",
    });

    const bookmarks = store.bookmarks("run-1", async () => ({}));
    await bookmarks.create({ url: "https://example.com/", title: "Example" });

    const artifacts = store.artifacts("run-1", async ({ title }) => ({
      html: `<!doctype html><html><title>${title}</title></html>`,
      model: "test-model",
    }));
    const artifact = await artifacts.create({ title: "Briefing", brief: "A small briefing", content: "One item" });
    expect(artifact.url).toMatch(/^https:\/\/app\.example\/app\/artifacts\/[a-f0-9]{12}$/u);
    expect(changed).toMatchObject([{ title: "Briefing", revision: 1, html: expect.stringContaining("Briefing") }]);

    await store.settled();
    expect(published.map((record) => record.key).sort()).toEqual([
      expect.stringMatching(/^artifact:/),
      expect.stringMatching(/^bookmark:/),
      expect.stringMatching(/^memory:/),
      expect.stringMatching(/^reminder:/),
    ]);
    expect(published.every((record) => record.sealedValue !== null && record.deviceSig !== "")).toBe(true);
  });

  it("keeps notes and their pictures as separate sealed registers, and collects a picture nothing references", async () => {
    const keys = await deriveSpaceKeys("__workspace__", generateSpaceRootSecret());
    const signing = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const verifier = new DeviceRegistryVerifier("reject");
    for (const id of ["cloud-device", "mac"]) verifier.addDevice(id, signing.publicKey);
    const published: WorkspaceRecordWire[] = [];
    const store = new WorkspaceToolStore({
      deviceId: "cloud-device",
      privateKey: signing.privateKey,
      keys: Promise.resolve(keys),
      transport: { publishWorkspace: (docs: WorkspaceRecordWire[]) => published.push(...docs) } as unknown as HubTransport,
      verifier: async () => verifier,
      now: () => new Date("2026-09-03T15:00:00.000Z"),
    });
    store.hydrated();
    await store.ready;
    let notified = 0;
    store.onRecordsChanged(() => {
      notified += 1;
    });
    const wire = async (key: string, value: unknown, physicalMs: number): Promise<WorkspaceRecordWire> => {
      const hlc = { deviceId: "mac", physicalMs, logical: 0 };
      const sealedValue = value === null ? null : toBase64(await seal(keys.sealKey, utf8(JSON.stringify(value)), workspaceSealAad(key)));
      const signature = await crypto.subtle.sign("Ed25519", signing.privateKey, workspaceSigningBytes(key, sealedValue, hlc) as BufferSource);
      return { key, sealedValue, hlc, deviceSig: toBase64(new Uint8Array(signature)) };
    };

    const notes = store.notes("run-7");
    const pie = notes.create({ title: "Sunday pie", markdown: "## Filling\n\nSour cherries.\n" });
    expect(pie.id).toMatch(/^[a-f0-9]{12}$/u);
    expect(pie).toMatchObject({ revision: 1, blobIds: [], source: { kind: "agent", runId: "run-7" } });
    expect(notified).toBe(1);

    // A picture is content-addressed: the same bytes twice are one register,
    // and neither write wakes the shell (N3).
    const person = store.person();
    const blob = person.putNoteBlob(Buffer.from("a tiny lattice picture"), "image/png");
    expect(blob.id).toMatch(/^[a-f0-9]{24}$/u);
    expect(person.putNoteBlob(Buffer.from("a tiny lattice picture").toString("base64"), "image/png").id).toBe(blob.id);
    expect(notified).toBe(1);

    const illustrated = notes.update(pie.id, { markdown: `${pie.markdown}\n![lattice](note-blob:${blob.id})\n` });
    expect(illustrated).toMatchObject({ revision: 2, blobIds: [blob.id] });
    expect(notified).toBe(2);
    const crust = person.createNote({ title: "Crust", markdown: `Butter. ![lattice](note-blob:${blob.id})` });
    expect(crust.source).toEqual({ kind: "user", runId: null });

    // A body over the cap is refused, never quietly cut to fit and reported
    // as saved (the desktop store answers the same way).
    const over = "x".repeat(262_145);
    expect(() => person.updateNote(pie.id, { markdown: over })).toThrow(/at most 262144/u);
    expect(() => person.createNote({ title: "Too long", markdown: over })).toThrow(/at most 262144/u);
    expect(person.getNote(pie.id)?.markdown).toBe(illustrated.markdown);
    expect(notified).toBe(3);

    await store.settled();
    expect(published.map((record) => record.key)).toEqual([
      `note:${pie.id}`,
      `note-blob:${blob.id}`,
      `note:${pie.id}`,
      `note:${crust.id}`,
    ]);
    expect(published.every((record) => record.sealedValue !== null && record.deviceSig !== "")).toBe(true);
    // What went on the wire is the note itself, sealed under the workspace key.
    const sent = published[2]!;
    const opened = JSON.parse(fromUtf8(await open(keys.sealKey, fromBase64(sent.sealedValue!), workspaceSealAad(sent.key)))) as { kind: string; note: { markdown: string } };
    expect(opened.kind).toBe("note");
    expect(opened.note.markdown).toContain(`note-blob:${blob.id}`);

    // Another device's newer version of the same note wins; an older one loses.
    store.receive([await wire(`note:${pie.id}`, { kind: "note", note: { ...illustrated, title: "Sunday pie (rhubarb)", revision: 3 } }, 1_900_000_000_000)]);
    store.receive([await wire(`note:${pie.id}`, { kind: "note", note: { ...illustrated, title: "Stale", revision: 9 } }, 1_000)]);
    await store.settled();
    expect(person.getNote(pie.id)?.title).toBe("Sunday pie (rhubarb)");
    expect(notified).toBe(4);

    // A picture arriving from another device changes nothing the shell renders.
    const remoteBlob = { kind: "noteBlob", blob: { ...blob, id: "b".repeat(24), data: toBase64(utf8("another picture")) } };
    store.receive([await wire(`note-blob:${"b".repeat(24)}`, remoteBlob, 1_900_000_000_001)]);
    await store.settled();
    expect(person.getNoteBlob("b".repeat(24))).not.toBeNull();
    expect(notified).toBe(4);

    // Deleting one of the two notes leaves the picture the other still names.
    published.length = 0;
    person.deleteNote(pie.id);
    await store.settled();
    expect(published.map((record) => ({ key: record.key, deleted: record.sealedValue === null }))).toEqual([
      { key: `note:${pie.id}`, deleted: true },
    ]);
    expect(person.getNoteBlob(blob.id)).not.toBeNull();

    // Deleting the last note that names it takes the picture with it.
    published.length = 0;
    person.deleteNote(crust.id);
    await store.settled();
    expect(published.map((record) => ({ key: record.key, deleted: record.sealedValue === null }))).toEqual([
      { key: `note:${crust.id}`, deleted: true },
      { key: `note-blob:${blob.id}`, deleted: true },
    ]);
    expect(person.listNotes()).toEqual([]);
    expect(person.getNoteBlob(blob.id)).toBeNull();
    expect(() => person.deleteNote(pie.id)).toThrow("note not found");
  });
});
