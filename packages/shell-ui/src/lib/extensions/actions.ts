/**
 * What the shell does with an extension, wherever it is asked from — a Ledge
 * icon, its right-click menu, the panel card's head, a row of the extensions
 * page, Settings (docs/extensions.md §2). Each is a request to main
 * (`extensionsRequest`) or a page of the shell's own opened; none of them
 * reaches an extension's code but through main.
 */

import { EXTENSIONS_PAGE_URL, type ExtensionInfo } from "@pistachio/shell-contracts/extensions";
import { extensionDraftName } from "../desk/slash-commands";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import { newTerminalId, terminalUrl } from "@pistachio/shell-contracts/terminal";
import { useAppStore } from "../../store";
import { askDesk } from "../desk/open";
import { startTerminalIn } from "../terminal/places";
import { extensionsRequest, openExtensionSheet, useExtensions, type ExtensionSettingsFocus } from "./use-extensions";

/** An element's box in the window, as main places a popup or a panel by it. */
export function boundsOf(el: Element): ContentBounds {
  const box = el.getBoundingClientRect();
  return { x: Math.round(box.left), y: Math.round(box.top), width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height)) };
}

/**
 * A Ledge icon clicked: one waiting on the person opens its sheet; one whose
 * panel is open closes it; any other runs its action on the window in use —
 * a Chrome popup at the icon, a Pistachio panel beside the sidebar, or its
 * `action` event — main deciding which.
 */
export function activateExtension(extension: ExtensionInfo, el: Element | null): void {
  if (extension.pending !== null) {
    openExtensionSheet({ kind: "extension", id: extension.id });
    return;
  }
  if (useExtensions.getState().snapshot.openPanel === extension.id) {
    void extensionsRequest({ type: "closePanel" });
    return;
  }
  const anchor = el === null ? null : boundsOf(el);
  useExtensions.setState({ panelAnchor: anchor });
  const tabId = useAppStore.getState().snapshot?.activeTabId ?? null;
  void extensionsRequest({ type: "activate", id: extension.id, tabId, anchor });
}

/**
 * An extension's `/` command run from the Bar (docs/extensions.md §2): main
 * runs it on this space and the window in use — its declared command (a
 * prompt template filled and sent, or an event that wakes its worker), or a
 * Chrome extension's action, as its icon's click.
 */
export function runExtensionBarCommand(command: { id: string; command: string; action: boolean }, arg: string, spaceId: string | null): void {
  const tabId = useAppStore.getState().snapshot?.activeTabId ?? null;
  if (command.action) {
    const icon = document.querySelector(`[data-ledge-id="${CSS.escape(command.id)}"]`);
    const anchor = icon === null ? null : boundsOf(icon);
    useExtensions.setState({ panelAnchor: anchor });
    void extensionsRequest({ type: "activate", id: command.id, tabId, anchor });
    return;
  }
  void extensionsRequest({ type: "barCommand", id: command.id, command: command.command, arg, spaceId, tabId });
}

/** `pistachio://extensions/`: the tab showing it, else a new one in the current space. */
export function openExtensionsPage(): void {
  useAppStore.getState().openAddress(EXTENSIONS_PAGE_URL);
}

/** Settings → Extensions, on one extension (its *Options*), its logs or its removal. */
export function openExtensionSettings(focus: ExtensionSettingsFocus | null = null): void {
  useExtensions.setState({ settingsFocus: focus });
  useAppStore.getState().openSettings("extensions");
}

export function setPinned(id: string, pinned: boolean): void {
  void extensionsRequest({ type: "pin", id, pinned });
}

/** On or off in the Profile in front (the master switch stays as it is). */
export function setEnabledHere(id: string, enabled: boolean): void {
  void extensionsRequest({ type: "setEnabled", id, enabled, scope: "here" });
}

export function setAgentAllowed(id: string, allowed: boolean): void {
  void extensionsRequest({ type: "setAgentAllowed", id, allowed });
}

export function reloadExtension(id: string): void {
  void extensionsRequest({ type: "reload", id });
}

export function revealExtensionFolder(id: string): void {
  void extensionsRequest({ type: "revealFolder", id });
}

/** Its logs, newest last; null when main refused (said already). */
export async function extensionLogs(id: string): Promise<string[] | null> {
  const response = await extensionsRequest({ type: "logs", id });
  return response?.type === "logs" ? response.lines : null;
}

/** Removed for good (its data after main's own confirmation, §7). A bundled one cannot be: it is turned off instead. */
export function removeExtension(extension: ExtensionInfo): void {
  if (extension.source.type === "bundled") {
    void extensionsRequest({ type: "setEnabled", id: extension.id, enabled: false, scope: "all" });
    return;
  }
  void extensionsRequest({ type: "uninstall", id: extension.id });
}

/** A tab with this address in the current space (the Chrome Web Store, its search). */
export function openInTab(url: string): void {
  const store = useAppStore.getState();
  store.closePage();
  void store.createTab(url);
}

/**
 * *Make one with Pistachio*: the Bar with `/extension ` in it (and what was
 * typed on the page after it), the keyboard there; with no Bar up (the desk
 * not yet), a draft folder is made and the person is told where.
 */
export function makeWithPistachio(wish: string): void {
  if (askDesk(wish.trim() === "" ? "/extension " : `/extension ${wish.trim()}`)) return;
  void draftThenTell(wish);
}

async function draftThenTell(wish: string): Promise<void> {
  const name = wish.trim() === "" ? "my-extension" : wish.trim();
  const response = await extensionsRequest({ type: "draftFolder", name });
  if (response?.type === "folder") useAppStore.getState().showNotice(`A folder for it is ready: ${response.path}`, { tone: "success" });
}

/** What the terminal runs for *Build with Claude Code*: `claude`, with the wish as its one argument when there is one. */
export function claudeRun(wish: string): { program: string; args: string[] } {
  const asked = wish.trim();
  return { program: "claude", args: asked === "" ? [] : [asked.slice(0, 4_000)] };
}

/**
 * *Build with Claude Code*: a terminal tab in a new draft folder of the dev
 * folder — made for the wish's name, or "my-extension" with none; making it
 * turns Developer mode on, so the folder is watched and carries `AGENTS.md`
 * and the skill that tell `claude` the API and the folder's contract
 * (docs/extensions.md §2) — running `claude`, the wish as its argument, one
 * whatever it says, never a line typed into the shell (§12).
 */
export async function buildWithClaudeCode(wish: string): Promise<void> {
  const store = useAppStore.getState();
  // (The folder's name from the wish as the Bar derives it — bounded; the wish itself goes to claude whole.)
  const response = await extensionsRequest({ type: "draftFolder", name: extensionDraftName(wish) });
  if (response?.type !== "folder") {
    store.showNotice("The folder for it could not be made, so nothing was started.");
    return;
  }
  const id = newTerminalId();
  startTerminalIn(id, response.path, claudeRun(wish));
  store.closePage();
  await store.createTab(terminalUrl(id));
}
