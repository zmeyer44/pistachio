import { FolderInput } from "lucide-react";
import { createElement, type ReactNode } from "react";
import type { SidebarFolder } from "@pistachio/shell-contracts/sidebar";

/**
 * The tab menu's pure pieces (chrome/tab-menu.tsx holds the hook), in a
 * .ts file so the node-side test config, which has no JSX, can import them.
 */

/** One selectable row, shaped as components/ContextMenu.tsx's MenuEntry is (declared here, since that module is JSX). */
export interface FolderMenuEntry {
  label: string;
  icon: ReactNode;
  onSelect(): void;
}

/** "Move to <folder>" entries, one per folder — flat, since folders are one level deep. */
export function moveToFolderEntries(
  folders: readonly SidebarFolder[],
  current: string | null,
  move: (folderId: string) => void,
): FolderMenuEntry[] {
  return folders
    .filter((folder) => folder.id !== current)
    .map((folder) => ({
      label: `Move to “${folder.name || "Untitled"}”`,
      icon: createElement(FolderInput, { "aria-hidden": "true" }),
      onSelect: () => move(folder.id),
    }));
}
