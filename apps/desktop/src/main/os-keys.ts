/**
 * The modifier keys as the OS has them now (native/os-keys; docs/desk.md, "Engine notes").
 *
 * The desk follows its grab key and its snap key from the key events the window's views are sent (the controller's
 * `noteDeskKey`), since a mouse event reaching main carries no modifiers. That is the keyboard's last word, not the
 * keyboard: a key let go where the window never hears it — ⌘⇧4 takes the keys for its crosshair, and Shift goes up
 * there — stayed down as far as the desk knew, and every press on a page grabbed its window until some key was pressed
 * again. So what the keyboard last said is only believed while the OS agrees (the controller's `#syncDeskKeys`), and
 * this is the OS's word: AppKit's, through the desktop's own native module, since Electron has none for it.
 *
 * Where it cannot be read — not a Mac, the module not built — the answer is null, and the desk goes by the key events
 * alone, as it did.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The modifier keys held down: Electron's names for them (`Input.shift`, …). */
export interface ModifierKeys {
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

export const MODIFIER_KEYS = ["shift", "control", "alt", "meta"] as const satisfies ReadonlyArray<keyof ModifierKeys>;

interface OsKeysModule {
  modifiers(): unknown;
}

/** What a reader answered, if it is the four keys, each held or not: anything else is no answer. */
export function modifierKeysFrom(value: unknown): ModifierKeys | null {
  if (typeof value !== "object" || value === null) return null;
  const keys = value as Record<string, unknown>;
  if (!MODIFIER_KEYS.every((key) => typeof keys[key] === "boolean")) return null;
  return { shift: keys["shift"] === true, control: keys["control"] === true, alt: keys["alt"] === true, meta: keys["meta"] === true };
}

/** native/os-keys's binary, from out/main (from inside the app's archive, the unpacked copy beside it). */
function modulePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../native/os-keys/build/os_keys.node").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

function load(): OsKeysModule | null {
  if (process.platform !== "darwin") return null;
  try {
    const module = { exports: {} as Partial<OsKeysModule> };
    process.dlopen(module as unknown as NodeJS.Module, modulePath());
    return typeof module.exports.modifiers === "function" ? { modifiers: module.exports.modifiers } : null;
  } catch (error) {
    console.warn("os-keys: the native module did not load; the desk follows its grab key from the key events alone", error);
    return null;
  }
}

/**
 * A reader of the keys held now, or null where there is none to ask. `module`: the native module, loaded here unless
 * given (a test's).
 */
export function osModifierKeys(module: OsKeysModule | null = load()): (() => ModifierKeys | null) | null {
  if (module === null) return null;
  return () => {
    try {
      return modifierKeysFrom(module.modifiers());
    } catch {
      return null;
    }
  };
}
