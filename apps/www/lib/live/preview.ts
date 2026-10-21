/**
 * What a live share's link says about itself where it is pasted — a chat, a
 * calendar invite, an email (docs/live-share.md §7 Link preview): the page's
 * title and description (`app/live/[token]/page.tsx`) and its card
 * (`app/live/[token]/opengraph-image.tsx`). Read off control on the server,
 * as the lobby reads it: whose share it is, the space's name, and whether it
 * is still live. That is what anyone holding the link sees on opening it;
 * nothing else of the share is asked for.
 */

import { joinInfo } from "./control";

/** A link's token as control mints it (`LINK_TOKEN_RE`, services/control/src/live/lobby.ts). */
const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/u;

/** Long enough for control to answer, short enough that whoever unfurls the link still waits for it. */
const LOOKUP_TIMEOUT_MS = 3_000;

export type LinkPreview =
  | { kind: "live" | "ended"; title: string; host: string | null }
  /** No such share, or control did not answer in time: nothing is claimed about it. */
  | { kind: "unknown" };

export async function linkPreview(token: string): Promise<LinkPreview> {
  if (!LINK_TOKEN_RE.test(token)) return { kind: "unknown" };
  try {
    const info = await joinInfo(token, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
    return { kind: info.status, title: info.title, host: info.hostName };
  } catch {
    return { kind: "unknown" };
  }
}

export interface PreviewText {
  /** The page's `<title>`, as the guest page names its lobby (`TITLES` in guest-app.tsx). */
  page: string;
  /** What a chat shows in bold under the card. */
  title: string;
  description: string;
}

export function previewText(preview: LinkPreview): PreviewText {
  switch (preview.kind) {
    case "live":
      return {
        page: `Join · ${preview.title}`,
        title: preview.host === null ? `Join “${preview.title}” live` : `${preview.host} is sharing “${preview.title}”`,
        description: "Open it in your browser to see this space live, point and draw on its windows, and talk. Nothing to install.",
      };
    case "ended":
      return {
        page: `Live share · ${preview.title}`,
        title: `“${preview.title}” is no longer live`,
        description: `This live share has ended. Ask ${preview.host ?? "whoever sent it"} for a new link.`,
      };
    case "unknown":
      return {
        page: "Live share · Pistachio",
        title: "Live share · Pistachio",
        description: "Join a space shared live from Pistachio.",
      };
  }
}
