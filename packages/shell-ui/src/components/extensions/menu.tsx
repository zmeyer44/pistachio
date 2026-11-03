/**
 * An extension's menu (docs/extensions.md §2): a Ledge icon's right-click,
 * the panel card's ⋯, a row's ⋯ on the extensions page. *Options*, *Pin /
 * Unpin*, *Off / On in this Profile*, *Agent can use it* (when it declares
 * tools), *Remove…*; one of the person's own adds *Reload*, *Show folder*,
 * *Logs*. Read as the menu opens: it says what is true when it comes up.
 */

import { Bot, FolderOpen, Pin, PinOff, Power, PowerOff, RotateCw, ScrollText, Settings2, Trash2 } from "lucide-react";
import type { ExtensionInfo } from "@pistachio/shell-contracts/extensions";
import {
  openExtensionSettings,
  reloadExtension,
  revealExtensionFolder,
  setAgentAllowed,
  setEnabledHere,
  setPinned,
} from "../../lib/extensions/actions";
import { isOwnSource, urlMatchesHosts } from "../../lib/extensions/ledge";
import { extensionsRequest, useExtensions } from "../../lib/extensions/use-extensions";
import type { MenuEntry } from "../ContextMenu";
import { ExtensionMark } from "./LedgeIcon";

/**
 * A desk window's ⋯ (components/desk/page-entries.tsx): the `window` items the
 * extensions on in this Profile declared (docs/extensions.md §2), under a
 * caption — *Extensions* — each named by its extension past one. Read as the
 * menu opens. A click goes to main (`menu`), which wakes the extension with
 * the window's tab (a gesture grant on it).
 */
export function extensionWindowEntries(tab: { id: string; url: string }): MenuEntry[] {
  const owners = useExtensions
    .getState()
    .snapshot.extensions.filter((extension) => extension.enabled && extension.enabledHere && extension.pending === null)
    .map((extension) => ({ extension, items: extension.menuItems.filter((item) => item.contexts.includes("window") && urlMatchesHosts(tab.url, item.hosts)) }))
    .filter((owner) => owner.items.length > 0);
  if (owners.length === 0) return [];
  const named = owners.length > 1;
  return [
    { note: "Extensions" },
    ...owners.flatMap(({ extension, items }) =>
      items.map(
        (item): MenuEntry => ({
          label: named ? `${extension.name}: ${item.title}` : item.title,
          icon: <ExtensionMark extension={extension} className="extension-menu-mark" />,
          testId: "desk-page-extension-item",
          onSelect: () => void extensionsRequest({ type: "menu", id: extension.id, item: item.id, click: { tabId: tab.id, pageUrl: tab.url, windowTabId: tab.id } }),
        }),
      ),
    ),
  ];
}

export function extensionMenuEntries(extension: ExtensionInfo, options: { pin?: boolean } = {}): MenuEntry[] {
  const entries: MenuEntry[] = [
    { label: "Options", icon: <Settings2 aria-hidden="true" />, testId: "extension-menu-options", onSelect: () => openExtensionSettings({ id: extension.id }) },
  ];
  if (options.pin !== false)
    entries.push({
      label: extension.pinned ? "Unpin" : "Pin",
      icon: extension.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />,
      testId: "extension-menu-pin",
      onSelect: () => setPinned(extension.id, !extension.pinned),
    });
  entries.push({
    label: extension.enabledHere ? "Off in this Profile" : "On in this Profile",
    icon: extension.enabledHere ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />,
    testId: "extension-menu-enabled",
    // (Waiting on the person, nothing of it runs: the sheet turns it on.)
    disabled: extension.pending !== null && !extension.enabledHere,
    onSelect: () => setEnabledHere(extension.id, !extension.enabledHere),
  });
  if (extension.tools.length > 0)
    entries.push({
      label: "Agent can use it",
      icon: <Bot aria-hidden="true" />,
      checked: extension.agentAllowed,
      testId: "extension-menu-agent",
      onSelect: () => setAgentAllowed(extension.id, !extension.agentAllowed),
    });
  if (isOwnSource(extension.source))
    entries.push(
      { separator: true },
      { label: "Reload", icon: <RotateCw aria-hidden="true" />, testId: "extension-menu-reload", onSelect: () => reloadExtension(extension.id) },
      { label: "Show folder", icon: <FolderOpen aria-hidden="true" />, testId: "extension-menu-folder", onSelect: () => revealExtensionFolder(extension.id) },
      { label: "Logs", icon: <ScrollText aria-hidden="true" />, testId: "extension-menu-logs", onSelect: () => openExtensionSettings({ id: extension.id, action: "logs" }) },
    );
  // A bundled one is turned off, never removed (§1, X8).
  if (extension.source.type !== "bundled")
    entries.push(
      { separator: true },
      { label: "Remove…", icon: <Trash2 aria-hidden="true" />, danger: true, testId: "extension-menu-remove", onSelect: () => openExtensionSettings({ id: extension.id, action: "remove" }) },
    );
  return entries;
}
