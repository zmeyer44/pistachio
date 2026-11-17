/**
 * What extensions have the shell showing (docs/primitives.md §4): a backdrop
 * in the desk's well, a mark on a space's tile, rows in the band beside the
 * Bar and in a section of the sidebar — values main keeps and the shell
 * draws, named as the extension's, each removed by the person in one press.
 * Apart from the store and the components, so a test reads it without
 * either: which backdrop is in force for a space, what it is in CSS, which
 * marks a tile carries, which rows a place shows, and the page's and the
 * menu's words.
 */

import { DESK_NOTCH_PILL_ACTIONS_MAX, type DeskNotchPill } from "@pistachio/shell-contracts/desk";
import {
  EVERY_SPACE,
  EXTENSION_MARK_TONES,
  EXTENSION_SECTIONS_MAX,
  EXTENSION_SITE_ROWS_MAX,
  type ExtensionBackdrop,
  type ExtensionBackdropValue,
  type ExtensionInfo,
  type ExtensionJournalEntry,
  type ExtensionMarkTone,
  type ExtensionRow,
  type ExtensionShown,
  type ExtensionSite,
  type ExtensionSiteView,
  type ExtensionSpaceMark,
  type ExtensionTabMark,
} from "@pistachio/shell-contracts/extensions";

/** The page's heading over what an extension has the shell showing. */
export const SHOWS_HEADING = "What it shows";

const HEX = /^#[0-9a-fA-F]{6}$/;
/** A picture's address as main serves it to the shell: its own store's, never an extension's page. */
const THEME_URL = /^pistachio-ext:\/\/theme\/[A-Za-z0-9._-]+$/;

/**
 * The backdrop in force for a space: the one set for that space, else the one for every space, else none. A space
 * with a backdrop of its own never shows the every-space one under or beside it.
 */
export function backdropFor(backdrops: readonly ExtensionBackdrop[] | undefined, spaceId: string | null): ExtensionBackdrop | null {
  const all = backdrops ?? [];
  return (spaceId === null ? undefined : all.find((backdrop) => backdrop.spaceId === spaceId)) ?? all.find((backdrop) => backdrop.spaceId === null) ?? null;
}

/** A backdrop as one string: two that read the same are the same picture, and nothing cross-fades between them. */
export function backdropKey(backdrop: ExtensionBackdrop | null): string {
  return backdrop === null ? "" : JSON.stringify([backdrop.extensionId, backdrop.spaceId, backdrop.value, backdrop.dim]);
}

/** The scope an element says a backdrop or a shown thing is for: the space's id, `*` for every space. */
export function scopeOf(spaceId: string | null): string {
  return spaceId ?? EVERY_SPACE;
}

export interface BackdropStyle {
  backgroundColor?: string;
  backgroundImage?: string;
  backgroundSize?: string;
  backgroundRepeat?: string;
  backgroundPosition?: string;
}

/**
 * A backdrop's value as the well's layer paints it. A colour fills; a gradient runs at its angle; a picture covers
 * the well, sits whole in its middle over the well's own fill (`contain`), or repeats (`tile`). Main checked the
 * value; what does not read as one all the same — a colour that is no hex, an address that is not the theme
 * store's — paints nothing, so no string of an extension's ever reaches a style as it is.
 */
export function backdropStyle(value: ExtensionBackdropValue): BackdropStyle {
  switch (value.kind) {
    case "color":
      return HEX.test(value.color) ? { backgroundColor: value.color } : {};
    case "gradient": {
      const colors = value.colors.filter((color) => HEX.test(color));
      if (colors.length < 2 || colors.length !== value.colors.length) return {};
      const angle = Number.isFinite(value.angle) ? Math.round(value.angle) : 180;
      return { backgroundImage: `linear-gradient(${String(angle)}deg, ${colors.join(", ")})` };
    }
    case "image": {
      if (!THEME_URL.test(value.url)) return {};
      const image = `url("${value.url}")`;
      if (value.fit === "tile") return { backgroundImage: image, backgroundRepeat: "repeat", backgroundSize: "auto", backgroundPosition: "0 0" };
      return { backgroundImage: image, backgroundRepeat: "no-repeat", backgroundSize: value.fit === "contain" ? "contain" : "cover", backgroundPosition: "center" };
    }
  }
}

/** The scrim over a backdrop: the shell's own ground laid over it as far as `dim` says (0–0.8); null for none. */
export function backdropScrim(dim: number): string | null {
  const percent = Math.round(Math.min(0.8, Math.max(0, Number.isFinite(dim) ? dim : 0)) * 100);
  return percent === 0 ? null : `color-mix(in oklch, var(--color-background-200) ${String(percent)}%, transparent)`;
}

/** What the space's menu says to take a backdrop off: whose it is, by the name on its sheet. */
export function removeBackdropLabel(backdrop: Pick<ExtensionBackdrop, "extensionName">): string {
  return `Remove backdrop · ${backdrop.extensionName}`;
}

/**
 * The marks on a space's tile, in the order the extensions stand in (the person's order): the tile draws the first,
 * and says every one.
 */
export function marksFor(marks: readonly ExtensionSpaceMark[] | undefined, extensions: readonly Pick<ExtensionInfo, "id">[], spaceId: string): ExtensionSpaceMark[] {
  const order = new Map(extensions.map((extension, index) => [extension.id, index]));
  return (marks ?? [])
    .filter((mark) => mark.spaceId === spaceId)
    .map((mark, index) => ({ mark, index }))
    .sort((a, b) => (order.get(a.mark.extensionId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.mark.extensionId) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
    .map(({ mark }) => mark);
}

/**
 * The marks on a tab's row (docs/primitives.md §4.7), in the order the extensions stand in: the row draws the first,
 * and its tooltip says every one.
 */
export function tabMarksFor(marks: readonly ExtensionTabMark[] | undefined, extensions: readonly Pick<ExtensionInfo, "id">[], tabId: string): ExtensionTabMark[] {
  if (marks === undefined || marks.length === 0) return [];
  const order = new Map(extensions.map((extension, index) => [extension.id, index]));
  return marks
    .filter((mark) => mark.tabId === tabId)
    .map((mark, index) => ({ mark, index }))
    .sort((a, b) => (order.get(a.mark.extensionId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.mark.extensionId) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
    .map(({ mark }) => mark);
}

/** A mark as the shell says it: the extension's words only inside the shell's frame — "Game day: Games on". */
export function markLine(mark: Pick<ExtensionSpaceMark, "extensionName" | "label">): string {
  return `${mark.extensionName}: ${mark.label}`;
}

/** What a tile's name gains for its marks, for a screen reader: ", Game day: Games on" for each. */
export function marksLabel(marks: readonly Pick<ExtensionSpaceMark, "extensionName" | "label">[]): string {
  return marks.map((mark) => `, ${markLine(mark)}`).join("");
}

/* ----------------------------------- rows ----------------------------------- */

/**
 * The rows a place shows for a space, one view an extension, in the order main gave them (the person's order of
 * their extensions): an extension's rows for that space, else the ones it set for every space — never both. The
 * sidebar stacks no more sections than it has room to keep the tabs in sight for.
 */
export function siteViewsFor(sites: readonly ExtensionSiteView[] | undefined, site: ExtensionSite, spaceId: string | null): ExtensionSiteView[] {
  const here = (sites ?? []).filter((view) => view.site === site && view.rows.length > 0 && (view.spaceId === null || view.spaceId === spaceId));
  const chosen: ExtensionSiteView[] = [];
  for (const view of here) {
    const at = chosen.findIndex((kept) => kept.extensionId === view.extensionId);
    if (at === -1) chosen.push(view);
    else if (view.spaceId !== null) chosen[at] = view;
  }
  const bounded = chosen.map((view) => ({ ...view, rows: view.rows.slice(0, EXTENSION_SITE_ROWS_MAX[site]) }));
  return site === "sidebar" ? bounded.slice(0, EXTENSION_SECTIONS_MAX) : bounded;
}

/** A row as a screen reader says it, inside the shell's frame: "Game day: KC 21 – BUF 17, 3rd quarter, 4:12". */
export function rowLabel(extensionName: string, row: Pick<ExtensionRow, "text" | "detail" | "value">): string {
  return `${extensionName}: ${[row.text, row.detail, row.value].filter((part) => part.trim() !== "").join(", ")}`;
}

/** A tone the shell has a colour for; anything else is the quiet one. */
export function rowTone(tone: string | undefined): ExtensionMarkTone {
  return (EXTENSION_MARK_TONES as readonly string[]).includes(tone ?? "") ? (tone as ExtensionMarkTone) : "neutral";
}

/** What heads an extension's section of the sidebar: the title it gave, else its name on the sheet. */
export function sectionTitle(view: Pick<ExtensionSiteView, "title" | "extensionName">): string {
  return view.title ?? view.extensionName;
}

/** What the × on rows says it does, and whose they are. */
export function removeRowsLabel(site: ExtensionSite, extensionName: string): string {
  return site === "band" ? `Remove ${extensionName}’s strip` : `Remove ${extensionName}’s section`;
}

/**
 * A band's rows as chips in the nub's lane (the notch view draws the same ones over a live page): each row a pill
 * of its extension's, an extension's rows one after another, to be drawn together under its mark.
 */
export function bandPills(views: readonly ExtensionSiteView[], extensions: readonly Pick<ExtensionInfo, "id" | "iconUrl">[]): DeskNotchPill[] {
  return views.flatMap((view) => {
    const iconUrl = extensions.find((extension) => extension.id === view.extensionId)?.iconUrl ?? null;
    return view.rows.map(
      (row, index): DeskNotchPill => ({
        id: view.extensionId,
        name: view.extensionName.slice(0, 200),
        iconUrl: iconUrl !== null && iconUrl.length <= 2048 ? iconUrl : null,
        text: row.text.slice(0, 400),
        actions: row.buttons.slice(0, DESK_NOTCH_PILL_ACTIONS_MAX).map((button) => ({ id: button.id, title: button.title.slice(0, 64) })),
        row: {
          index,
          scope: view.spaceId,
          id: row.id,
          mark: row.mark === null ? null : { glyph: row.mark.glyph, tone: rowTone(row.mark.tone) },
          detail: row.detail.slice(0, 200),
          value: row.value.slice(0, 64),
        },
      }),
    );
  });
}

const quoted = (space: string): string => (space.trim() === "" ? "a space" : `“${space}”`);

/**
 * One thing an extension has the shell showing, as the page lists it: `Mark on “Football” · Games on`, `Backdrop on
 * “Football”`, `Backdrop and accent on every space`, `Strip beside the Bar on every space · KC 21 – BUF 17`,
 * `Sidebar section on “Football” · Today’s games`, `Marks on 3 tabs · Not read yet`.
 */
export function shownLine(shown: ExtensionShown): string {
  if (shown.what === "mark") return `Mark on ${quoted(shown.space)} · ${shown.detail}`;
  // Its marks on tabs, together: main says how many and what the newest says ("3 tabs · Not read yet").
  if (shown.what === "tabMarks") return `Marks on ${shown.detail}`;
  const where = shown.spaceId === null ? "every space" : quoted(shown.space);
  if (shown.what === "theme") return `${shown.detail} on ${where}`;
  // Rows: the place in the shell's words, and what they are by — the section's title, or what the first row says.
  const place = shown.what === "band" ? "Strip beside the Bar" : "Sidebar section";
  return `${place} on ${where}${shown.detail.trim() === "" ? "" : ` · ${shown.detail}`}`;
}

/** What a journal entry of a theme set with nobody there says: `Set a backdrop on “Football”`, `… on every space`. */
export function themeJournalLine(entry: Pick<ExtensionJournalEntry, "spaceId" | "title">): string {
  return `Set a backdrop on ${entry.spaceId === EVERY_SPACE ? "every space" : quoted(entry.title)}`;
}
