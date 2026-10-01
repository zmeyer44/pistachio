/**
 * The documents a desk may show (docs/desk-documents.md §2): every file of
 * a group's context that has a viewer, and, for a document window, the
 * file it shows — found in whichever group's context holds it, so a window
 * of a group the desk has just passed from keeps its own file while it
 * goes home (and saves an edit there).
 */

import { fileViewerKind, type GroupContextFile, type GroupContextView } from "@pistachio/shell-contracts/desk-agent";
import { fileWindowId } from "./windows";

export function documentWindowIds(context: GroupContextView | null | undefined): string[] {
  return (context?.items ?? []).filter((item) => item.kind === "file" && fileViewerKind(item.mediaType) !== null).map((item) => fileWindowId(item.id));
}

export function fileOf(contexts: readonly GroupContextView[], itemId: string): { groupId: string; item: GroupContextFile & { here: boolean } } | null {
  for (const context of contexts) {
    const item = context.items.find((candidate) => candidate.id === itemId);
    if (item?.kind === "file") return { groupId: context.groupId, item };
  }
  return null;
}
