/**
 * Where terminals are, and where new ones start (docs/terminal.md §2) —
 * apart from the terminals themselves (./sessions.ts), so the store can ask
 * without loading xterm.js.
 */

/** Each open terminal's folder, as its shell last reported it (OSC 7), by the terminal's id. */
const folders = new Map<string, string>();
/** Folders new terminals were asked to open in, by id, until they open. */
const starts = new Map<string, string>();

export function rememberTerminalFolder(id: string, cwd: string): void {
  folders.set(id, cwd);
}

export function forgetTerminal(id: string): void {
  folders.delete(id);
  starts.delete(id);
}

export function terminalFolder(id: string): string | null {
  return folders.get(id) ?? null;
}

/** A terminal about to be opened (its tab not made yet) starts in `cwd`. */
export function startTerminalIn(id: string, cwd: string | null): void {
  if (cwd !== null) starts.set(id, cwd);
}

/** Where terminal `id` was asked to start, once. */
export function takeTerminalStart(id: string): string | null {
  const cwd = starts.get(id) ?? null;
  starts.delete(id);
  return cwd;
}
