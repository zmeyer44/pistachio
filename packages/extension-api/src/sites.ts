/**
 * The places of the shell an extension fills with **rows** (docs/primitives.md
 * §4.5): the **band** — a strip along the desk's foot, beside the Bar — and
 * a **section** of the sidebar. Both take the same value: a few rows of the
 * shell's own making, each a mark, a text, a quieter detail, a trailing
 * value and at most two buttons. The extension says what a row holds; the
 * shell decides how a row looks in a thirty-pixel strip and in a sidebar,
 * in light and dark — so there is no tree to lay out wrong, and nothing an
 * extension hands over is ever markup.
 *
 * A row with an `id` can be pressed, and so can its buttons: the press wakes
 * the worker (`pistachio.ui.band.onPress`), as the person's own act.
 *
 * Declared in `pistachio.json` (`"band": true`, `"sidebar": true`), so the
 * sheet says what the extension adds before any of its code has run.
 *
 * Pure — the shapes and their bounds — so the runtime, main and the tests
 * share them.
 */

import { z } from "zod";
import { MARK_TONES, isMarkGlyph } from "./theme.js";

export const SITES = ["band", "sidebar"] as const;
export type Site = (typeof SITES)[number];

export function isSite(value: unknown): value is Site {
  return typeof value === "string" && (SITES as readonly string[]).includes(value);
}

/** How many rows each place holds: a strip is short; a section is a short list, never a page. */
export const SITE_ROWS_MAX: Record<Site, number> = { band: 6, sidebar: 12 };
export const ROW_TEXT_MAX = 80;
export const ROW_VALUE_MAX = 24;
export const ROW_BUTTONS_MAX = 2;
export const ROW_BUTTON_TITLE_MAX = 24;
export const SITE_TITLE_MAX = 40;

/** What a press names: a row's id, a button's. Letters, digits and `. _ : -`, so an id can carry one of the extension's own (`game:401`). */
export const ROW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const id = z.string().regex(ROW_ID_PATTERN, "an id like game:401 — letters, digits and . _ : - (64 at most)");
/** One line, as the shell will draw it: text with something in it, no line breaks. */
const line = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), { message: "one line: no line breaks or control characters" });

/** A row's leading mark: a `glyph` (one or two characters; a dot when left out) in a `tone`. */
export const rowMarkSchema = z
  .object({
    glyph: z.string().refine(isMarkGlyph, { message: "one or two characters: a letter, a digit, an emoji" }).optional(),
    tone: z.enum(MARK_TONES).optional(),
  })
  .strict();

export const rowButtonSchema = z.object({ id, title: line(ROW_BUTTON_TITLE_MAX, 1) }).strict();

/**
 * One row. `text` is what it says; `detail` is said after it, quieter; `value` stands at its trailing end, in
 * figures that line up (a score, a count, a time). With an `id` the row can be pressed. `buttons` are pressed on
 * their own.
 */
export const rowSchema = z
  .object({
    id: id.optional(),
    mark: rowMarkSchema.optional(),
    text: line(ROW_TEXT_MAX).refine((value) => value.trim() !== "", { message: "what the row says, in a few words" }),
    detail: line(ROW_TEXT_MAX).optional(),
    value: line(ROW_VALUE_MAX).optional(),
    buttons: z.array(rowButtonSchema).max(ROW_BUTTONS_MAX).optional(),
  })
  .strict();

export type RowInput = z.infer<typeof rowSchema>;

/**
 * What a place is handed, whole: `set` replaces what the extension had there. `spaceId` names one space the person
 * gave it; left out, every space. `title` heads a sidebar section (the extension's name when left out); the band
 * draws none.
 */
export const siteViewSchema = z
  .object({
    title: line(SITE_TITLE_MAX, 1).optional(),
    rows: z.array(rowSchema).max(Math.max(...Object.values(SITE_ROWS_MAX))),
    spaceId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type SiteViewInput = z.infer<typeof siteViewSchema>;

/** What `superRefine` would say of a view for a place: too many rows for it, an id twice. Empty when it is fine. */
export function siteViewIssues(site: Site, view: Pick<SiteViewInput, "rows">): string[] {
  const issues: string[] = [];
  const max = SITE_ROWS_MAX[site];
  if (view.rows.length > max) issues.push(`${site === "band" ? "the band" : "a sidebar section"} holds ${String(max)} rows at most (${String(view.rows.length)} given): show the few that matter, and open a page for the rest`);
  const rows = new Set<string>();
  // (A press says `{ row, button }`, and a row with no id is `row: null`: the buttons of all such rows are told
  // apart by their own ids alone.)
  const unnamed = new Set<string>();
  for (const row of view.rows) {
    if (row.id !== undefined) {
      if (rows.has(row.id)) issues.push(`the row id "${row.id}" is used twice: a press could not say which row it was`);
      rows.add(row.id);
    }
    const buttons = new Set<string>();
    for (const button of row.buttons ?? []) {
      if (buttons.has(button.id)) issues.push(`the button id "${button.id}" is used twice in one row`);
      else if (row.id === undefined && unnamed.has(button.id)) issues.push(`the button id "${button.id}" is used in two rows that have no id: give those rows ids, or a press could not say which row it was`);
      buttons.add(button.id);
    }
    if (row.id === undefined) for (const button of buttons) unnamed.add(button);
  }
  return issues;
}

/** What the sheet says an extension adds for a place it declares. */
export const SITE_ADDS: Record<Site, string> = {
  band: "a strip beside the Bar",
  sidebar: "a section in the sidebar",
};

/** A place as the person reads it elsewhere (the extensions page, an error): "the strip beside the Bar", "the sidebar section". */
export const SITE_WORDS: Record<Site, string> = {
  band: "strip beside the Bar",
  sidebar: "sidebar section",
};
