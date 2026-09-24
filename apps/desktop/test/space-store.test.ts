import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SpaceStore, type SpaceChange } from "../src/main/space-store";
import { DEFAULT_SPACE_ID, sanitizeForkSpaceRequest, sanitizeSpaceInfo, spacePartition } from "@pistachio/shell-contracts/spaces";

describe("SpaceStore", () => {
  it("starts with the Operations Space and persists fork lineage and selection", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-spaces-"));
    const store = new SpaceStore(directory);
    expect(store.activeId()).toBe(DEFAULT_SPACE_ID);
    expect(store.all()).toMatchObject([{ id: "work", name: "Operations", parentSpaceId: null }]);

    const child = store.createFork("work", "Quarter close", "Investigate the freight variance", ["https://example.com"]);
    expect(child).toMatchObject({ name: "Quarter close", parentSpaceId: "work", purpose: "Investigate the freight variance" });
    expect(store.activeId()).toBe(child.id);
    expect(spacePartition(child.id)).toBe(`persist:pistachio-space-${child.id}`);

    const reopened = new SpaceStore(directory);
    expect(reopened.activeId()).toBe(child.id);
    expect(reopened.get(child.id)).toEqual(child);
  });

  it("falls back to a valid root when a stored active id is unknown", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-spaces-invalid-"));
    writeFileSync(
      join(directory, "spaces.json"),
      JSON.stringify({ version: 1, activeSpaceId: "missing", spaces: [{ id: "work", name: "Operations", color: "#b8e98f" }] }),
    );
    expect(new SpaceStore(directory).activeId()).toBe("work");
  });

  it("removes an incomplete child during rollback without removing the root", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-spaces-rollback-"));
    const store = new SpaceStore(directory);
    const child = store.createFork("work", "Child", "", []);
    store.remove(child.id);
    store.remove("work");
    expect(store.all().map((space) => space.id)).toEqual(["work"]);
    expect(JSON.parse(readFileSync(join(directory, "spaces.json"), "utf8")).activeSpaceId).toBe("work");
  });
});

describe("sanitizeForkSpaceRequest", () => {
  it("bounds names and purposes and defaults to the conservative transfer", () => {
    expect(sanitizeForkSpaceRequest({ name: "  Related task  ", purpose: " next ", tabs: "wat" })).toEqual({
      name: "Related task",
      purpose: "next",
      tabs: "active",
      includeShelf: true,
      includeSession: true,
    });
    expect(sanitizeForkSpaceRequest({ name: "   " })).toBeNull();
  });
});

describe("SpaceStore egress and cloud fields (docs/cloud-sync-design.md §10.5)", () => {
  it("defaults egressPolicy to direct and cloudEnabled to false, and reads stored values", () => {
    expect(sanitizeSpaceInfo({ id: "work", name: "Operations" })).toMatchObject({ egressPolicy: "direct", cloudEnabled: false });
    expect(sanitizeSpaceInfo({ id: "work", name: "Operations", egressPolicy: "identity", cloudEnabled: true })).toMatchObject({
      egressPolicy: "identity",
      cloudEnabled: true,
    });
    expect(sanitizeSpaceInfo({ id: "work", name: "Operations", egressPolicy: "suma-ip", cloudEnabled: "yes" })).toMatchObject({
      egressPolicy: "direct",
      cloudEnabled: false,
    });
  });

  it("persists policy and cloud changes and reports each with its origin", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-spaces-policy-"));
    const store = new SpaceStore(directory);
    const changes: SpaceChange[] = [];
    const off = store.onChange((change) => changes.push(change));
    expect(store.setEgressPolicy("work", "identity")?.egressPolicy).toBe("identity");
    expect(store.setEgressPolicy("work", "identity")?.egressPolicy).toBe("identity");
    expect(store.setCloudEnabled("work", true)?.cloudEnabled).toBe(true);
    expect(store.setEgressPolicy("missing", "identity")).toBeNull();
    expect(changes).toEqual([
      { kind: "updated", spaceId: "work", remote: false },
      { kind: "updated", spaceId: "work", remote: false },
    ]);
    const reopened = new SpaceStore(directory);
    expect(reopened.get("work")).toMatchObject({ egressPolicy: "identity", cloudEnabled: true });
    // A fork keeps browsing the way its parent does, without the cloud.
    const child = store.createFork("work", "Child", "", []);
    expect(child).toMatchObject({ egressPolicy: "identity", cloudEnabled: false });
    expect(changes.slice(2)).toEqual([
      { kind: "created", spaceId: child.id, remote: false },
      { kind: "active", spaceId: child.id, remote: false },
    ]);
    off();
    store.setCloudEnabled("work", false);
    expect(changes).toHaveLength(4);
  });

  it("upserts and removes Spaces that arrive from another device, flagged remote", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-spaces-remote-"));
    const store = new SpaceStore(directory);
    const changes: SpaceChange[] = [];
    store.onChange((change) => changes.push(change));
    const remote = {
      id: "b2c3",
      name: "Research",
      color: "#9fd8ff",
      parentSpaceId: "work",
      purpose: "reading",
      createdAt: 5,
      carriedOrigins: [],
      egressPolicy: "identity",
      cloudEnabled: true,
    };
    expect(store.upsertRemote(remote)).toMatchObject({ id: "b2c3", name: "Research", egressPolicy: "identity" });
    expect(store.upsertRemote(remote)?.name).toBe("Research");
    expect(store.upsertRemote({ ...remote, name: "Research 2" })?.name).toBe("Research 2");
    expect(store.upsertRemote({ nope: true })).toBeNull();
    store.setActive("b2c3");
    expect(store.removeRemote("b2c3")).toBe(true);
    expect(store.removeRemote("b2c3")).toBe(false);
    expect(store.removeRemote("work")).toBe(false);
    expect(store.activeId()).toBe("work");
    expect(changes).toEqual([
      { kind: "created", spaceId: "b2c3", remote: true },
      { kind: "updated", spaceId: "b2c3", remote: true },
      { kind: "active", spaceId: "b2c3", remote: false },
      { kind: "removed", spaceId: "b2c3", remote: true },
      { kind: "active", spaceId: "work", remote: true },
    ]);
  });
});
