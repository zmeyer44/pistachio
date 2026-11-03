/**
 * The extensions the shell knows of (docs/extensions.md §2, §10), and the
 * only place that talks to the host about them. Its own zustand store beside
 * the shell's, like the notes' (components/notes/use-notes.ts): the Ledge,
 * the panel card, the status pills, the Bar's `/` commands, a window's ⋯,
 * the extensions page, the approval sheet and Settings all read this one
 * copy of main's snapshot.
 *
 * There is no "get": main publishes `ExtensionsSnapshot` on `onExtensions`
 * whenever it changes (and after every request it answers), and each one is
 * folded in with structural sharing (lib/share.ts), so an extension nobody
 * touched keeps its object and the Ledge's icons do not render for a badge
 * elsewhere. The window subscribes once, as it starts (`startExtensions`,
 * App.tsx), and says hello with a `closePanel` — a shell that has just
 * loaded holds no card for a panel — so main publishes what it has at once.
 *
 * Nothing here throws into React. A refusal is recorded twice, as the notes'
 * are: in the shell's maps (`noteRefusal("extensions", …)`: `unavailable`
 * for a host that will never answer, `failed` otherwise), which Settings →
 * Extensions reads; and here, `unsupported` (the host's own reason: "Extensions
 * run in Pistachio on your Mac") or `error`.
 */

import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  EMPTY_EXTENSIONS_SNAPSHOT,
  type ExtensionInfo,
  type ExtensionRequest,
  type ExtensionResponse,
  type ExtensionsSnapshot,
} from "@pistachio/shell-contracts/extensions";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import { isShellUnsupported } from "@pistachio/shell-contracts/socket";
import { nativeApi, shellApi } from "../../api";
import { useAppStore } from "../../store";
import { share } from "../share";
import { ledgeExtensionsOf } from "./ledge";

/** What the approval sheet is for: an extension's `pending` sheet, or a Chrome Web Store install waiting on one. */
export type ExtensionSheetSubject = { kind: "extension"; id: string } | { kind: "install"; cwsId: string };

/** The reason the shell gives when no host has said one: extensions are a Mac's. */
export const EXTENSIONS_ON_THE_DESKTOP = "Extensions run in the Pistachio desktop app.";

interface ExtensionsState {
  snapshot: ExtensionsSnapshot;
  /** A snapshot has come from main. Before it, the Ledge is the empty one. */
  loaded: boolean;
  /** This host has no extensions and never will: its reason. */
  unsupported: string | null;
  /** The last refusal that was not `unsupported`. */
  error: string | null;
  /** The approval sheet up, and what for. */
  sheet: ExtensionSheetSubject | null;
  /** The Ledge icon a panel was asked for from, in window coordinates: the panel card stands level with it. */
  panelAnchor: ContentBounds | null;
  /** Settings → Extensions opens on this one (an icon's *Options*), its logs or its removal asked for. */
  settingsFocus: ExtensionSettingsFocus | null;
}

/** What Settings → Extensions is opened on: one extension, and what of it. */
export interface ExtensionSettingsFocus {
  id: string;
  /** Its logs read and shown, or its *Remove* asked (and waiting for the confirm). */
  action?: "logs" | "remove";
}

export const useExtensions = create<ExtensionsState>(() => ({
  snapshot: EMPTY_EXTENSIONS_SNAPSHOT,
  loaded: false,
  unsupported: null,
  error: null,
  sheet: null,
  panelAnchor: null,
  settingsFocus: null,
}));

/** One subscription per window, whatever starts it. */
let started = false;

/** An IPC refusal's own words, without Electron's "Error invoking remote method …" wrapper. */
export function refusalMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/u, "");
}

function refuse(cause: unknown): string {
  useAppStore.getState().noteRefusal("extensions", cause);
  const message = refusalMessage(cause);
  if (isShellUnsupported(cause)) useExtensions.setState({ unsupported: message });
  else useExtensions.setState({ error: message });
  return message;
}

/**
 * Subscribe this window to main's snapshot, once. Called as the shell starts
 * (App.tsx) and, harmlessly again, by anything that reads the store first.
 */
export function startExtensions(): void {
  if (started) return;
  started = true;
  try {
    shellApi().onExtensions(foldExtensions);
  } catch (cause) {
    started = false;
    refuse(cause);
    return;
  }
  // The hello: on the Mac, a shell that has just loaded holds no panel card, and main publishes after it answers.
  // (The web's host refuses the member; asking it would only record that, which the settings page does itself.)
  if (nativeApi() !== null) void extensionsRequest({ type: "closePanel" }, { quiet: true });
}

/**
 * A snapshot from main, folded in. Exported for the specs' sake (and a
 * test's): what arrives on `onExtensions` comes through here alone.
 */
export function foldExtensions(next: ExtensionsSnapshot): void {
  const state = useExtensions.getState();
  const previous = state.snapshot;
  const snapshot = share(previous, next);
  const patch: Partial<ExtensionsState> = { loaded: true };
  if (snapshot !== previous) patch.snapshot = snapshot;
  // The sheet follows what it is for: a store install's comes up by itself (the person asked for it, on the page or
  // the store's *Add to Chrome*); one whose subject is gone — approved elsewhere, denied, uninstalled — goes.
  const install = snapshot.pendingInstall;
  if (install !== null && previous.pendingInstall?.cwsId !== install.cwsId) patch.sheet = { kind: "install", cwsId: install.cwsId };
  else if (state.sheet !== null && !sheetStands(state.sheet, snapshot)) patch.sheet = null;
  if (patch.sheet !== undefined) syncSheetOverlay(patch.sheet);
  // A panel closed by main (its own ⎋, the extension's closePanel) forgets where it was asked from.
  if (snapshot.openPanel === null && state.panelAnchor !== null) patch.panelAnchor = null;
  useExtensions.setState(patch);
  // A folder that appeared waits for the person, said once and never as a sheet popping up unbidden: a notice with
  // *Review* (docs/extensions.md §6.2). Not for the first snapshot: what was waiting before is the Ledge's amber dot.
  if (state.loaded) {
    const known = new Set(previous.extensions.map((extension) => extension.id));
    for (const extension of snapshot.extensions) {
      if (known.has(extension.id) || extension.pending === null || extension.status !== "needs-approval") continue;
      // (Its sheet up already — a library entry the person just turned on, turnOnFromLibrary — says it.)
      const sheet = useExtensions.getState().sheet;
      if (sheet?.kind === "extension" && sheet.id === extension.id) continue;
      useAppStore.getState().showNotice(`New extension: ${extension.name}`, { action: { label: "Review", run: () => openExtensionSheet({ kind: "extension", id: extension.id }) } });
    }
  }
}

/** Whether the sheet still has something to ask about in `snapshot`. */
function sheetStands(sheet: ExtensionSheetSubject, snapshot: ExtensionsSnapshot): boolean {
  if (sheet.kind === "install") return snapshot.pendingInstall?.cwsId === sheet.cwsId;
  return snapshot.extensions.some((extension) => extension.id === sheet.id && extension.pending !== null);
}

/** The shell's overlay is the sheet's while it is up: the pages give way under it, and nothing native is drawn over it (§6.3). */
function syncSheetOverlay(sheet: ExtensionSheetSubject | null): void {
  const store = useAppStore.getState();
  if (sheet !== null) {
    if (store.overlay !== "extension-sheet") store.setOverlay("extension-sheet");
  } else if (store.overlay === "extension-sheet") store.setOverlay("none");
}

/** Show the approval sheet for an extension waiting on the person, or a store install. */
export function openExtensionSheet(sheet: ExtensionSheetSubject): void {
  if (!sheetStands(sheet, useExtensions.getState().snapshot)) return;
  useExtensions.setState({ sheet });
  syncSheetOverlay(sheet);
}

/** How long a library entry turned on is watched for its sheet (main loads it and publishes it waiting on the person). */
const LIBRARY_SHEET_WAIT_MS = 10_000;

/**
 * A library entry (*Made for Pistachio*) turned on: main loads it, and it
 * waits on the person — nothing turns itself on. Its sheet comes up at once,
 * as soon as a snapshot shows it waiting (the person asked for it: they
 * should not have to find *Review*).
 */
export async function turnOnFromLibrary(id: string): Promise<void> {
  const response = await extensionsRequest({ type: "setEnabled", id, enabled: true });
  if (response === null) return;
  const waiting = (state: ExtensionsState): boolean => state.snapshot.extensions.some((extension) => extension.id === id && extension.pending !== null);
  if (waiting(useExtensions.getState())) {
    openExtensionSheet({ kind: "extension", id });
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = useExtensions.subscribe((state) => {
    if (!waiting(state)) return;
    off();
    clearTimeout(timer);
    openExtensionSheet({ kind: "extension", id });
  });
  timer = setTimeout(off, LIBRARY_SHEET_WAIT_MS);
}

/**
 * The sheet put down by the person (×, ⎋) with no answer: a store install's is answered — *Not now* — so the same
 * extension can be asked for again (a pending install is shown once, as it arrives); an extension's own just waits.
 */
export function dismissExtensionSheet(): void {
  const sheet = useExtensions.getState().sheet;
  if (sheet?.kind === "install") void extensionsRequest({ type: "denyInstall", cwsId: sheet.cwsId }, { quiet: true });
  closeExtensionSheet();
}

export function closeExtensionSheet(): void {
  if (useExtensions.getState().sheet !== null) useExtensions.setState({ sheet: null });
  syncSheetOverlay(null);
}

/**
 * Ask main to do something with an extension. Answers null when it refused,
 * having recorded why (and, unless `quiet`, said a failure in a notice: a
 * switch that did not take must not look as if it had).
 */
export async function extensionsRequest(request: ExtensionRequest, options: { quiet?: boolean } = {}): Promise<ExtensionResponse | null> {
  try {
    const response = await shellApi().extensions(request);
    if (useExtensions.getState().error !== null) useExtensions.setState({ error: null });
    return response;
  } catch (cause) {
    const message = refuse(cause);
    if (options.quiet !== true && !isShellUnsupported(cause)) useAppStore.getState().showNotice(message, { tone: "warning" });
    return null;
  }
}

/** The whole store, subscribing the window first if nothing has yet. */
export function useExtensionsState<T>(select: (state: ExtensionsState) => T): T {
  useEffect(startExtensions, []);
  return useExtensions(select);
}

/** Every extension main knows of, in its order. */
export function useAllExtensions(): readonly ExtensionInfo[] {
  return useExtensionsState((state) => state.snapshot.extensions);
}

/** The Ledge's icons: pinned and on (or waiting on the person), in the person's order. */
export function useLedgeExtensions(): ExtensionInfo[] {
  useEffect(startExtensions, []);
  return useExtensions(useShallow((state) => ledgeExtensionsOf(state.snapshot.extensions)));
}

/** One extension, or null. */
export function useExtension(id: string | null): ExtensionInfo | null {
  return useExtensionsState((state) => (id === null ? null : (state.snapshot.extensions.find((extension) => extension.id === id) ?? null)));
}
