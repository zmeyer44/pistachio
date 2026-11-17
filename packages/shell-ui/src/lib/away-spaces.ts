/**
 * Spaces that are away, as the shell asks for them and says them
 * (docs/primitives.md §2; @pistachio/shell-contracts/away): the space's menu
 * sends one away, the rail's Away tile opens the card that lists them
 * (components/space-rail/AwayCard.tsx), a press there brings one back, and
 * main's word that one went or came back — whoever sent it: the person, the
 * agent, an extension, the clock — is a notice carrying the way back
 * (./away-actions). Here, what they say: apart from the store, so a test
 * reads it without one.
 *
 * There is no time to choose here, on purpose: "until Sunday" is said to the
 * agent, or is an extension's to keep. The shell only shows when one is due.
 */

import { awayHolderName, formatReturn, type AwaySpaceInfo } from "@pistachio/shell-contracts/away";

/**
 * What a notice says of a space that went away, or that came back with nobody's press: on main's own clock, or
 * brought by an extension (`broughtBy`, its name on the sheet — named as the sender of one sent is).
 */
export function awayNoticeText(
  event: "sent" | "returned",
  space: Pick<AwaySpaceInfo, "title" | "by" | "until">,
  now: number,
  options: { timeZone?: string; locale?: string; broughtBy?: string } = {},
): string {
  if (event === "returned") {
    const bringer = options.broughtBy?.trim() ?? "";
    return bringer === "" ? `“${space.title}” is back` : `“${space.title}” is back · ${bringer}`;
  }
  const who = awayHolderName(space.by);
  return [
    `“${space.title}” is away`,
    ...(space.until === undefined ? [] : [`back ${formatReturn(space.until, now, options)}`]),
    // (Sent by the person's own press, it says nothing of who: awayHolderName.)
    ...(who === null ? [] : [who]),
  ].join(" · ");
}

/** The Away tile's name, for its tooltip and a screen reader: how many spaces are away. */
export function awayTileLabel(count: number): string {
  return `${String(count)} ${count === 1 ? "space" : "spaces"} away`;
}

/** What the tile's corner says: the count, "9+" past nine (its corner holds two characters). */
export function awayTileCount(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/** How many tabs an away space holds, as its row says it. */
export function awayTabsLabel(count: number): string {
  return count === 0 ? "No tabs" : `${String(count)} ${count === 1 ? "tab" : "tabs"}`;
}
