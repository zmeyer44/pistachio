/**
 * Which viewer a call is being made by (docs/web-browser-design.md §5, §8).
 *
 * A session outlives its viewers and can have several at once — a laptop and
 * a phone, two tabs of the same browser — but the `ShellHost` is one object
 * shared by all of them. Three things go wrong when it does not know which
 * one is calling:
 *
 *  - control audits a run command by the person's DEVICE, and a
 *    last-writer-wins "the viewer device" makes every action by A read as
 *    B's, and kills A's console the moment B's device is revoked;
 *  - a minted download URL is supposed to be bound to the viewer that asked
 *    for it, which is not a thing a shared field can express;
 *  - a page's file picker belongs to the viewer whose person is going to pick
 *    a file, and another viewer's dismissal must not cancel their upload.
 *
 * So the socket runs each dispatch inside this store. `AsyncLocalStorage` is
 * a Node built-in and survives every `await` inside a member, which the
 * obvious "set a field, clear it after" does not.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** One attached, proven viewer, as the host knows it. */
export interface ViewerIdentity {
  /** Stable for the life of one socket. */
  id: string;
  /** The device this viewer proved the Space key with: the audit actor (§8). */
  deviceId: string;
  /**
   * A secret this viewer alone holds, handed to it over its own proven
   * socket. A download URL minted for this viewer is bound to it, and the
   * HTTP route wants it back in a header.
   */
  downloadKey: string;
}

const storage = new AsyncLocalStorage<ViewerIdentity>();

/** Run `work` as `viewer`; everything it awaits sees the same viewer. */
export function withViewer<T>(viewer: ViewerIdentity, work: () => T): T {
  return storage.run(viewer, work);
}

/** The viewer this call is being made by, or null (a run, a page event, a test). */
export function currentViewer(): ViewerIdentity | null {
  return storage.getStore() ?? null;
}
