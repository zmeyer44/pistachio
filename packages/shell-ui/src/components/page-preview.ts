/**
 * A page the shell draws (home, the brief, notes) shown as a picture of
 * itself — small, in one of the desk's hover cards — rather than as the
 * page a person is using. It shows what it would show, and starts nothing
 * that opening it starts: no brief made, no note written, no tab renamed.
 */

import { createContext, useContext } from "react";

export const PagePreview = createContext(false);

/** This page is drawn as a preview of itself (PagePreview): show, never start or write. */
export function usePagePreview(): boolean {
  return useContext(PagePreview);
}
