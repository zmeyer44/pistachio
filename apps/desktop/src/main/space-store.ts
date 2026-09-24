/** Persistent Space metadata and active selection: `<userData>/spaces.json`. */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_SPACE,
  DEFAULT_SPACE_ID,
  MAX_SPACE_NAME,
  SPACE_COLORS,
  sanitizeSpaceInfo,
  type SpaceEgressPolicy,
  type SpaceInfo,
} from "@pistachio/shell-contracts/spaces";

interface PersistedSpaces {
  version: 1;
  activeSpaceId: string;
  spaces: SpaceInfo[];
}

/**
 * What changed, for the listeners that mirror Spaces elsewhere (workspace
 * sync, egress). `remote: true` marks a change that arrived FROM another
 * device through `upsertRemote`/`removeRemote`, so a mirror can avoid echoing
 * it straight back out.
 */
export interface SpaceChange {
  kind: "created" | "updated" | "removed" | "active";
  spaceId: string;
  remote: boolean;
}

export class SpaceStore {
  readonly #path: string;
  readonly #listeners = new Set<(change: SpaceChange) => void>();
  #activeSpaceId: string;
  #spaces: SpaceInfo[];

  constructor(userDataDir: string) {
    this.#path = join(userDataDir, "spaces.json");
    const initial = this.#read();
    this.#spaces = initial.spaces;
    this.#activeSpaceId = initial.activeSpaceId;
  }

  activeId(): string {
    return this.#activeSpaceId;
  }

  all(): SpaceInfo[] {
    return structuredClone(this.#spaces);
  }

  get(spaceId: string): SpaceInfo | null {
    const space = this.#spaces.find((candidate) => candidate.id === spaceId);
    return space === undefined ? null : structuredClone(space);
  }

  /** Hear about every change; the returned function unsubscribes. */
  onChange(listener: (change: SpaceChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setActive(spaceId: string): boolean {
    if (!this.#spaces.some((space) => space.id === spaceId)) return false;
    if (this.#activeSpaceId === spaceId) return true;
    this.#activeSpaceId = spaceId;
    this.#write();
    this.#emit({ kind: "active", spaceId, remote: false });
    return true;
  }

  createFork(parentSpaceId: string, name: string, purpose: string, carriedOrigins: string[]): SpaceInfo {
    const parent = this.#spaces.find((candidate) => candidate.id === parentSpaceId);
    if (parent === undefined) throw new Error("The parent Space no longer exists.");
    const id = randomUUID();
    const space: SpaceInfo = {
      id,
      name,
      color: SPACE_COLORS[this.#spaces.length % SPACE_COLORS.length] ?? SPACE_COLORS[0],
      parentSpaceId,
      purpose,
      createdAt: Date.now(),
      carriedOrigins: [...new Set(carriedOrigins)],
      // A fork keeps browsing the way its parent does; the cloud browser is
      // opted into per Space, so a fork starts without it.
      egressPolicy: parent.egressPolicy,
      cloudEnabled: false,
    };
    this.#spaces.push(space);
    this.#activeSpaceId = id;
    this.#write();
    this.#emit({ kind: "created", spaceId: id, remote: false });
    this.#emit({ kind: "active", spaceId: id, remote: false });
    return structuredClone(space);
  }

  /** Give a Space a new name (and optionally colour): the wizard names the first one after its person. */
  rename(spaceId: string, name: string, color?: string): SpaceInfo | null {
    const space = this.#spaces.find((candidate) => candidate.id === spaceId);
    if (space === undefined) return null;
    const trimmed = name.trim().slice(0, MAX_SPACE_NAME);
    if (trimmed === "") return structuredClone(space);
    space.name = trimmed;
    if (color !== undefined && /^#[0-9a-f]{6}$/i.test(color)) space.color = color;
    this.#write();
    this.#emit({ kind: "updated", spaceId, remote: false });
    return structuredClone(space);
  }

  setEgressPolicy(spaceId: string, policy: SpaceEgressPolicy): SpaceInfo | null {
    const space = this.#spaces.find((candidate) => candidate.id === spaceId);
    if (space === undefined) return null;
    if (space.egressPolicy !== policy) {
      space.egressPolicy = policy;
      this.#write();
      this.#emit({ kind: "updated", spaceId, remote: false });
    }
    return structuredClone(space);
  }

  setCloudEnabled(spaceId: string, enabled: boolean): SpaceInfo | null {
    const space = this.#spaces.find((candidate) => candidate.id === spaceId);
    if (space === undefined) return null;
    if (space.cloudEnabled !== enabled) {
      space.cloudEnabled = enabled;
      this.#write();
      this.#emit({ kind: "updated", spaceId, remote: false });
    }
    return structuredClone(space);
  }

  /**
   * A Space as another device knows it (a `space:` workspace doc). Replaces
   * the local record wholesale, or creates one; the change is reported with
   * `remote: true`. Returns null when the doc does not describe a Space.
   */
  upsertRemote(value: unknown): SpaceInfo | null {
    const incoming = sanitizeSpaceInfo(value);
    if (incoming === null) return null;
    const index = this.#spaces.findIndex((candidate) => candidate.id === incoming.id);
    if (index === -1) {
      this.#spaces.push(incoming);
      this.#write();
      this.#emit({ kind: "created", spaceId: incoming.id, remote: true });
    } else {
      const current = this.#spaces[index]!;
      if (JSON.stringify(current) === JSON.stringify(incoming)) return structuredClone(current);
      this.#spaces[index] = incoming;
      this.#write();
      this.#emit({ kind: "updated", spaceId: incoming.id, remote: true });
    }
    return structuredClone(incoming);
  }

  /** Another device deleted the Space. The default Space never goes. */
  removeRemote(spaceId: string): boolean {
    return this.#remove(spaceId, true);
  }

  remove(spaceId: string): void {
    this.#remove(spaceId, false);
  }

  #remove(spaceId: string, remote: boolean): boolean {
    if (spaceId === DEFAULT_SPACE_ID) return false;
    const next = this.#spaces.filter((space) => space.id !== spaceId);
    if (next.length === this.#spaces.length) return false;
    this.#spaces = next;
    const activeChanged = this.#activeSpaceId === spaceId;
    if (activeChanged) this.#activeSpaceId = this.#spaces[0]?.id ?? DEFAULT_SPACE_ID;
    this.#write();
    this.#emit({ kind: "removed", spaceId, remote });
    if (activeChanged) this.#emit({ kind: "active", spaceId: this.#activeSpaceId, remote });
    return true;
  }

  #emit(change: SpaceChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        console.error("[spaces] change listener failed", error);
      }
    }
  }

  #read(): PersistedSpaces {
    try {
      const raw = JSON.parse(readFileSync(this.#path, "utf8")) as Record<string, unknown>;
      const spaces = Array.isArray(raw["spaces"])
        ? raw["spaces"].map(sanitizeSpaceInfo).filter((space): space is SpaceInfo => space !== null)
        : [];
      if (spaces.length === 0) throw new Error("empty Space file");
      const active = typeof raw["activeSpaceId"] === "string" && spaces.some((space) => space.id === raw["activeSpaceId"])
        ? raw["activeSpaceId"]
        : spaces[0]?.id ?? DEFAULT_SPACE_ID;
      return { version: 1, activeSpaceId: active, spaces };
    } catch {
      return { version: 1, activeSpaceId: DEFAULT_SPACE_ID, spaces: [structuredClone(DEFAULT_SPACE)] };
    }
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      const value: PersistedSpaces = { version: 1, activeSpaceId: this.#activeSpaceId, spaces: this.#spaces };
      writeFileSync(tmp, JSON.stringify(value, null, 2));
      renameSync(tmp, this.#path);
    } catch {
      // The in-memory model remains usable for this session.
    }
  }
}
