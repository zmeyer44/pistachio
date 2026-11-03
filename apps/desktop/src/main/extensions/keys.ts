/**
 * Extensions' key commands (docs/extensions.md §2 "Say them", §12): a
 * manifest's `commands[].key` is an author's words — `Cmd+Shift+6` — and the
 * app binds keys in its own portable form (`Mod+Shift+6`,
 * @pistachio/shell-contracts/shortcuts). This maps one to the other and
 * decides which declared keys are bound: never one the app holds (a binding
 * in the person's shortcuts, one the app keeps for editing or the OS, one its
 * menu holds), never one an extension earlier in the person's order holds.
 * A key left unbound says why, in the extension's status file. Pure, tested
 * (test/extensions-keys.test.ts); main asks it again whenever the shortcuts
 * or the extensions change, and the app's own binding always wins at the
 * moment of the key (ExtensionService.takeKey).
 */

import { normalizeShortcut, reservedShortcutReason, SHORTCUT_DEFINITIONS, shortcutOffered, type ShortcutSettings } from "@pistachio/shell-contracts/shortcuts";

/**
 * Keys the app holds that are no setting of the person's: the application
 * menu's DevTools and Hide Others, the Mac's own screenshot keys, the app
 * switcher, Spotlight. (The editing and window keys are
 * reservedShortcutReason's.)
 */
export const APP_FIXED_KEYS: ReadonlyMap<string, string> = new Map([
  ["Mod+Alt+I", "the developer tools"],
  ["Mod+Alt+H", "Hide Others"],
  ["Mod+Shift+3", "the Mac's screenshot of the screen"],
  ["Mod+Shift+4", "the Mac's screenshot of an area"],
  ["Mod+Shift+5", "the Mac's screenshot tool"],
  ["Mod+Space", "Spotlight"],
]);

/** The manifest's spelling of a modifier, as the app's binding has it (Cmd and Ctrl are both the platform's command key). */
const MODIFIERS: Record<string, "Mod" | "Alt" | "Shift"> = { Cmd: "Mod", Ctrl: "Mod", Alt: "Alt", Shift: "Shift" };
/** The manifest's key names the app's binding spells otherwise. */
const KEY_NAMES: Record<string, string> = { Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };

/**
 * `Cmd+Shift+6` → `Mod+Shift+6`; null for a key the app cannot bind (Escape,
 * Tab, a backquote: none of the app's bindings may hold them either).
 */
export function bindingOfManifestKey(key: string): string | null {
  const parts = key.split("+");
  const last = parts.pop();
  if (last === undefined || last === "") return null;
  const modifiers: string[] = [];
  for (const part of parts) {
    const modifier = MODIFIERS[part];
    if (modifier === undefined) return null;
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return normalizeShortcut([...modifiers, KEY_NAMES[last] ?? last].join("+"));
}

export interface KeyCommandDecl {
  id: string;
  title: string;
  key?: string;
}

/** One declared key command as the app took it. */
export interface KeyBinding {
  extensionId: string;
  commandId: string;
  /** The key as the manifest wrote it, or null when it suggests none. */
  key: string | null;
  /** The app's binding it holds, or null when it is left unbound. */
  binding: string | null;
  /** Why it is unbound (a key it suggested): what holds the key, in words. */
  unbound: string | null;
}

/** What holds `binding` in the app, in words, or null when nothing does. */
export function appHolder(binding: string, shortcuts: ShortcutSettings): string | null {
  const reserved = reservedShortcutReason(binding);
  if (reserved !== null) return reserved === "That shortcut is reserved for editing or the operating system." ? "editing or the Mac" : reserved;
  const fixed = APP_FIXED_KEYS.get(binding);
  if (fixed !== undefined) return fixed;
  // (Only what the desktop offers holds a key here: an action of the web's alone leaves its key to the page.)
  const action = SHORTCUT_DEFINITIONS.find((definition) => shortcuts[definition.id] === binding && shortcutOffered(definition, "native"));
  return action === undefined ? null : `Pistachio's ${action.label}`;
}

/**
 * Every runnable extension's declared keys, in the person's order: bound
 * where free, else unbound with the holder named. An extension's later
 * command on a key its own earlier one took is unbound the same way.
 */
export function keyBindings(extensions: readonly { id: string; name: string; commands: readonly KeyCommandDecl[] }[], shortcuts: ShortcutSettings): KeyBinding[] {
  const taken = new Map<string, string>();
  const bindings: KeyBinding[] = [];
  for (const extension of extensions) {
    for (const command of extension.commands) {
      const base = { extensionId: extension.id, commandId: command.id, key: command.key ?? null };
      if (command.key === undefined) {
        bindings.push({ ...base, binding: null, unbound: null });
        continue;
      }
      const binding = bindingOfManifestKey(command.key);
      if (binding === null) {
        bindings.push({ ...base, binding: null, unbound: `${command.key} is not a key Pistachio can bind: use Cmd, Alt or Shift with a letter, a digit, a function key or an arrow` });
        continue;
      }
      const holder = appHolder(binding, shortcuts) ?? taken.get(binding) ?? null;
      if (holder !== null) {
        bindings.push({ ...base, binding: null, unbound: `${command.key} is held by ${holder}: left unbound` });
        continue;
      }
      taken.set(binding, extension.name);
      bindings.push({ ...base, binding, unbound: null });
    }
  }
  return bindings;
}
