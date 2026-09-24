/**
 * The surface seam (docs/web-browser-design.md §3.2, §10). A pane is either a
 * hole the desktop places a native `WebContentsView` over, or a DOM element
 * the web app paints a screencast into. Everything else about the shell — the
 * tabs, the splits, the shelf, the console — is the same either way, so the
 * difference lives here rather than in two copies of the chrome.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";

/** The active pane's actual local renderer, reported by the web host. */
export interface SurfaceRendering {
  tabId: string;
  mode: "dom" | "pixels" | "fallback";
  reason?: string;
  mediaCount?: number;
  retryDom?: () => void;
  usePixels?: () => void;
}

export type Surface =
  | { kind: "native" }
  /** `renderPane` goes inside each pane card, where the hole used to be. */
  | {
      kind: "stream";
      renderPane: (tab: BrowserTabInfo, pane: { active: boolean }) => ReactNode;
      rendering?: SurfaceRendering | null;
      /**
       * Where the Mac app is downloaded, for the one place the shell has to
       * point at it: the walkthrough's import step, which can only run on a
       * Mac (§14, W12). The web app knows the address (its own /download
       * page serves it); the shell does not, and must not guess.
       */
      downloadUrl?: string;
      /**
       * Where this person's account lives — the DASHBOARD'S ROOT, not the
       * site's origin (docs/web-browser-design.md §15). The host refuses a
       * whole family of members with "managed from the web app"; the sentence
       * is the host's and the way there is the app's, so the shell renders a
       * link beside the reason rather than leaving a reader to find the other
       * site themselves.
       *
       * The section's own page under it is `lib/account-link.ts`'s job: a
       * reader sent away from Settings → Account should land on the account
       * page, and a marketing homepage is not an answer to any of these.
       */
      accountUrl?: string;
      /**
       * What fills a Glance card. The desktop floats a native view over the
       * card; a host that paints its panes in the DOM can paint the previewed
       * page here instead. Absent, the card stays the empty frame it was.
       */
      renderGlance?: (tab: BrowserTabInfo) => ReactNode;
      /**
       * What fills a background video's sidebar card, where the desktop
       * re-parents the tab's native view. Absent, the card shows its ground.
       */
      renderMediaPreview?: (tabId: string) => ReactNode;
    };

/** The desktop's surface, and the default for anything that renders a pane-free view. */
const NATIVE: Surface = { kind: "native" };

const SurfaceContext = createContext<Surface>(NATIVE);

export function SurfaceProvider({
  value,
  children,
}: {
  value: Surface;
  children: ReactNode;
}): ReactNode {
  return <SurfaceContext.Provider value={value}>{children}</SurfaceContext.Provider>;
}

export function useSurface(): Surface {
  return useContext(SurfaceContext);
}
