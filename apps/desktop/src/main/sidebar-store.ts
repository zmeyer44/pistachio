/**
 * The sidebar shelf's file: `<userData>/sidebar.json` — favorites, pins,
 * folders (@pistachio/shell-contracts/sidebar). The settings store's twin: read once at
 * startup, rewritten whole on every change, atomically by rename. Small by
 * construction (the shelf is capped), and the renderer never touches it —
 * it reads the shelf off the snapshot and sends commands.
 *
 * Commands write at once. The title and favicon a live tab folds into its
 * anchor (syncAnchor) arrive with every tab event instead, so those coalesce
 * behind a short timer the way the tab session does (tab-session-store.ts);
 * `flush()` writes whatever is pending before the process quits.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_SIDEBAR_STATE, sanitizeSidebarState, type SidebarState } from "@pistachio/shell-contracts/sidebar";
import { DEFAULT_SPACE_ID } from "@pistachio/shell-contracts/spaces";

interface PersistedSidebars {
  version: 1;
  spaces: Record<string, SidebarState>;
}

const ANCHOR_WRITE_DELAY_MS = 150;

export class SidebarStore {
  readonly #path: string;
  readonly #listeners = new Set<(spaceId: string, state: SidebarState) => void>();
  #current: Record<string, SidebarState>;
  #timer: NodeJS.Timeout | null = null;

  constructor(userDataDir: string) {
    this.#path = join(userDataDir, "sidebar.json");
    this.#current = this.#read();
  }

  get(spaceId = DEFAULT_SPACE_ID): SidebarState {
    return structuredClone(this.#current[spaceId] ?? DEFAULT_SIDEBAR_STATE);
  }

  /** Replace the shelf. Sanitized on the way in, so a caller cannot store what a read would refuse. */
  set(spaceId: string, next: SidebarState): SidebarState {
    this.#current[spaceId] = sanitizeSidebarState(next);
    this.#write();
    for (const listener of this.#listeners) listener(spaceId, this.get(spaceId));
    return this.get(spaceId);
  }

  fork(parentSpaceId: string, childSpaceId: string, includeShelf: boolean): SidebarState {
    this.#current[childSpaceId] = includeShelf ? this.get(parentSpaceId) : structuredClone(DEFAULT_SIDEBAR_STATE);
    this.#write();
    for (const listener of this.#listeners) listener(childSpaceId, this.get(childSpaceId));
    return this.get(childSpaceId);
  }

  remove(spaceId: string): void {
    if (!(spaceId in this.#current)) return;
    delete this.#current[spaceId];
    this.#write();
  }

  /**
   * Fold a live tab's title and favicon into the entry it is anchored to,
   * WITHOUT telling listeners: this runs on the way to a snapshot that
   * already carries the tab, so a publish here would publish twice. Written
   * to disk only when something changed, and then behind a short timer —
   * page titles update often, and a publish runs on every tab event.
   *
   * A tab with no favicon (null) leaves the entry's icon as it was: Chromium
   * can report a page's icon after the load has settled, and a page that
   * has none is still the same site — its last icon beats a letter.
   */
  syncAnchor(spaceId: string, anchorId: string, title: string, faviconUrl: string | null): void {
    const current = this.#current[spaceId];
    if (current === undefined) return;
    let changed = false;
    for (const favorite of current.favorites) {
      if (favorite.id !== anchorId) continue;
      const nextFavicon = faviconUrl ?? favorite.faviconUrl;
      if (favorite.title !== title || favorite.faviconUrl !== nextFavicon) {
        favorite.title = title;
        favorite.faviconUrl = nextFavicon;
        changed = true;
      }
    }
    for (const entry of current.entries) {
      if (entry.kind !== "pin" || entry.id !== anchorId) continue;
      const nextFavicon = faviconUrl ?? entry.faviconUrl;
      if (entry.title !== title || entry.faviconUrl !== nextFavicon) {
        entry.title = title;
        entry.faviconUrl = nextFavicon;
        changed = true;
      }
    }
    if (changed) this.#scheduleWrite();
  }

  /** Write anything still coalescing. Main calls this on the way out of the process. */
  flush(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#write();
  }

  onChange(listener: (spaceId: string, state: SidebarState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #read(): Record<string, SidebarState> {
    try {
      const raw = JSON.parse(readFileSync(this.#path, "utf8")) as Record<string, unknown>;
      if (raw["version"] === 1 && typeof raw["spaces"] === "object" && raw["spaces"] !== null) {
        const spaces: Record<string, SidebarState> = {};
        for (const [spaceId, state] of Object.entries(raw["spaces"] as Record<string, unknown>)) {
          spaces[spaceId] = sanitizeSidebarState(state);
        }
        return spaces;
      }
      // The pre-Spaces file was a bare SidebarState. Adopt it as the default
      // Space instead of making a person's pins appear to vanish.
      return { [DEFAULT_SPACE_ID]: sanitizeSidebarState(raw) };
    } catch {
      return {};
    }
  }

  #scheduleWrite(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#write();
    }, ANCHOR_WRITE_DELAY_MS);
    this.#timer.unref();
  }

  /** Immediate, whole-file. Anything the timer was holding rides along, so it is cancelled. */
  #write(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      const value: PersistedSidebars = { version: 1, spaces: this.#current };
      writeFileSync(tmp, JSON.stringify(value, null, 2));
      renameSync(tmp, this.#path);
    } catch {
      // The in-memory shelf still holds for this session.
    }
  }
}
