/**
 * The settings file: `<userData>/settings.json`, read once at startup and
 * rewritten whole on every change. Small enough that atomicity is a rename,
 * and the renderer never touches the disk — it gets a copy, sends a patch.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  sanitizeSettings,
  type DesktopSettings,
} from "@pistachio/shell-contracts/settings";

export class SettingsStore {
  readonly #path: string;
  readonly #listeners = new Set<(settings: DesktopSettings) => void>();
  #current: DesktopSettings;

  constructor(userDataDir: string) {
    this.#path = join(userDataDir, "settings.json");
    const { settings, rewrite } = this.#read();
    this.#current = settings;
    if (rewrite) this.#write(settings);
  }

  get(): DesktopSettings {
    return structuredClone(this.#current);
  }

  update(patch: unknown): DesktopSettings {
    const next = applySettingsPatch(this.#current, patch);
    this.#current = next;
    this.#write(next);
    for (const listener of this.#listeners) listener(structuredClone(next));
    return structuredClone(next);
  }

  reset(): DesktopSettings {
    return this.update(DEFAULT_SETTINGS);
  }

  onChange(listener: (settings: DesktopSettings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #read(): { settings: DesktopSettings; rewrite: boolean } {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
      const settings = sanitizeSettings(raw);
      // A file written before models came with the account carries an `ai`
      // section holding a provider key in the clear. Sanitizing drops it in
      // memory; the file is rewritten now so the key leaves the disk on the
      // first launch, not whenever the person next changes a setting.
      const rewrite = typeof raw === "object" && raw !== null && "ai" in raw;
      return { settings, rewrite };
    } catch {
      // Missing or corrupt: defaults, and the next write repairs the file.
      return { settings: structuredClone(DEFAULT_SETTINGS), rewrite: false };
    }
  }

  #write(settings: DesktopSettings): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(settings, null, 2));
      renameSync(tmp, this.#path);
    } catch {
      // The in-memory value still wins for this session; a read-only
      // userData dir should not break the settings page.
    }
  }
}
