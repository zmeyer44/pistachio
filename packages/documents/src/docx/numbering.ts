/**
 * Word's lists (docs/desk-documents.md §3): which numbering each list
 * instance (`w:num`) uses at each level, and the marker a paragraph shows —
 * counted in document order, as Word counts them, a deeper level starting
 * again under each new item above it.
 */

import { attr, kid, kids, NS, val, type Document } from "../xml.js";
import { readParaProps, readRunProps, type ParaProps, type RunProps, type ThemeFonts } from "./styles.js";

export interface ListLevel {
  /** decimal, lowerLetter, upperRoman, bullet, none, … */
  format: string;
  /** "%1.", "%1.%2", "•" */
  text: string;
  start: number;
  /** The level's own indents (a paragraph's own override them). */
  para: ParaProps;
  /** The marker's font and look. */
  run: RunProps;
}

/** Each list instance's levels: `${numId}:${ilvl}` → its level. */
export type ListLevels = Record<string, ListLevel>;

export function readNumbering(doc: Document | null, fonts: ThemeFonts): ListLevels {
  const root = doc?.documentElement ?? null;
  const w = NS.w;
  const abstracts = new Map<string, Map<number, ListLevel>>();
  const levelOf = (lvl: ReturnType<typeof kid>): ListLevel => ({
    format: val(lvl, w, "numFmt") ?? "decimal",
    text: val(lvl, w, "lvlText") ?? "",
    start: Number(val(lvl, w, "start") ?? "1") || 0,
    para: readParaProps(kid(lvl, w, "pPr")),
    run: readRunProps(kid(lvl, w, "rPr"), fonts),
  });
  for (const abstract of root === null ? [] : kids(root, w, "abstractNum")) {
    const levels = new Map<number, ListLevel>();
    for (const lvl of kids(abstract, w, "lvl")) levels.set(Number(attr(lvl, w, "ilvl") ?? "0"), levelOf(lvl));
    abstracts.set(attr(abstract, w, "abstractNumId") ?? "", levels);
  }
  const lists: ListLevels = {};
  for (const num of root === null ? [] : kids(root, w, "num")) {
    const numId = attr(num, w, "numId");
    const levels = abstracts.get(val(num, w, "abstractNumId") ?? "");
    if (numId === null || levels === undefined) continue;
    for (const [ilvl, level] of levels) lists[`${numId}:${String(ilvl)}`] = { ...level };
    for (const override of kids(num, w, "lvlOverride")) {
      const ilvl = Number(attr(override, w, "ilvl") ?? "0");
      const key = `${numId}:${String(ilvl)}`;
      const replaced = kid(override, w, "lvl");
      if (replaced !== null) lists[key] = levelOf(replaced);
      const start = val(override, w, "startOverride");
      if (start !== null && lists[key] !== undefined) lists[key] = { ...lists[key], start: Number(start) || 0 };
    }
  }
  return lists;
}

function roman(value: number): string {
  if (value <= 0 || value >= 4_000) return String(value);
  const table: Array<[number, string]> = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  let rest = value;
  for (const [amount, letters] of table) {
    while (rest >= amount) {
      out += letters;
      rest -= amount;
    }
  }
  return out;
}

function letters(value: number): string {
  if (value <= 0) return String(value);
  // Word doubles the letter past z: aa, bb, cc.
  const letter = String.fromCharCode(97 + ((value - 1) % 26));
  return letter.repeat(Math.floor((value - 1) / 26) + 1);
}

export function formatCounter(value: number, format: string): string {
  switch (format) {
    case "lowerLetter":
      return letters(value);
    case "upperLetter":
      return letters(value).toUpperCase();
    case "lowerRoman":
      return roman(value);
    case "upperRoman":
      return roman(value).toUpperCase();
    case "decimalZero":
      return String(value).padStart(2, "0");
    case "none":
      return "";
    default:
      return String(value);
  }
}

/** The symbol fonts' bullets (private-use code points) as the characters they draw. */
function bulletText(text: string): string {
  if (text === "") return "•";
  const code = text.codePointAt(0) ?? 0;
  switch (code) {
    case 0xf0b7:
    case 0xf06c:
      return "•";
    case 0xf0a7:
    case 0xf06e:
      return "▪";
    case 0xf0d8:
      return "➢";
    case 0xf076:
      return "❖";
    case 0xf0fc:
      return "✓";
    case 0x6f:
      return "◦";
    default:
      return code >= 0xf000 && code <= 0xf0ff ? "•" : text;
  }
}

/**
 * The markers of a run of paragraphs, in document order: each list
 * paragraph's text ("3.", "b)", "•"), or null for one in no list.
 */
export class ListCounter {
  readonly #levels: ListLevels;
  readonly #counters = new Map<string, number[]>();

  constructor(levels: ListLevels) {
    this.#levels = levels;
  }

  next(numId: string | null, ilvl: number): string | null {
    if (numId === null || numId === "0") return null;
    const level = this.#levels[`${numId}:${String(ilvl)}`];
    if (level === undefined) return null;
    const counters = this.#counters.get(numId) ?? [];
    counters[ilvl] = counters[ilvl] === undefined ? level.start : counters[ilvl]! + 1;
    // Deeper levels start again under this item.
    counters.length = ilvl + 1;
    this.#counters.set(numId, counters);
    if (level.format === "bullet") return bulletText(level.text);
    if (level.format === "none") return "";
    return level.text.replace(/%([1-9])/g, (_, digit: string) => {
      const at = Number(digit) - 1;
      const other = this.#levels[`${numId}:${String(at)}`];
      const value = counters[at] ?? other?.start ?? 1;
      return formatCounter(value, at === ilvl ? level.format : (other?.format ?? "decimal"));
    });
  }
}
