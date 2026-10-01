/**
 * An Excel workbook (.xlsx), read (docs/desk-documents.md §3): each sheet's
 * cells as the person sees them in Excel — numbers and dates through their
 * number formats, shared and rich strings as their text, formulas as the
 * values Excel last worked out — with the look that matters to reading one
 * (bold, italics, colours, fills, alignment), column widths, merged cells
 * and frozen panes. Nothing is written back.
 */

import { mainPart, readRels, type Rel } from "./opc.js";
import { attr, descendant, is, kid, kids, NS, parseXml, textOf, type Element } from "./xml.js";
import { DocumentError, readZip, zipText, type ZipEntries } from "./zip.js";

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** CSS colours. */
  color?: string;
  fill?: string;
  /** In points. */
  size?: number;
  align?: "left" | "center" | "right" | "justify";
  valign?: "top" | "middle" | "bottom";
  wrap?: boolean;
}

export interface SheetCell {
  row: number;
  col: number;
  /** As Excel shows it. */
  text: string;
  /** A number (or a date, a time): right-aligned unless its style says otherwise. */
  numeric: boolean;
  /** Its style, in `Workbook.styles`. */
  style: number;
}

export interface SheetRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface Sheet {
  name: string;
  hidden: boolean;
  /** One past the last row and column that hold anything. */
  rowCount: number;
  colCount: number;
  cells: Map<number, SheetCell>;
  merges: SheetRange[];
  /** Column widths in px, where the sheet sets them; `defaultWidth` elsewhere. */
  colWidths: Map<number, number>;
  hiddenCols: Set<number>;
  hiddenRows: Set<number>;
  defaultWidth: number;
  frozen: { rows: number; cols: number };
  /** More cells than are read (MAX_CELLS): the rest are not shown. */
  truncated: boolean;
}

export interface Workbook {
  sheets: Sheet[];
  styles: CellStyle[];
}

/** No sheet is read past this many cells, nor a workbook past the next. */
const MAX_CELLS_PER_SHEET = 400_000;
const MAX_CELLS = 1_000_000;
/** Excel's last column is XFD, the 16,384th. */
const MAX_COLS = 16_384;

export function cellKey(row: number, col: number): number {
  return row * MAX_COLS + col;
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnName(col: number): string {
  let name = "";
  let n = col + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** "B12" → { row: 11, col: 1 }. */
export function parseRef(ref: string): { row: number; col: number } | null {
  const match = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/i.exec(ref.trim());
  if (match === null) return null;
  let col = 0;
  for (const char of match[1]!.toUpperCase()) col = col * 26 + (char.charCodeAt(0) - 64);
  const row = Number(match[2]) - 1;
  if (col < 1 || col > MAX_COLS || row < 0) return null;
  return { row, col: col - 1 };
}

function parseRange(ref: string): SheetRange | null {
  const [from, to] = ref.split(":");
  const start = from === undefined ? null : parseRef(from);
  const end = to === undefined ? start : parseRef(to);
  if (start === null || end === null) return null;
  return { top: Math.min(start.row, end.row), left: Math.min(start.col, end.col), bottom: Math.max(start.row, end.row), right: Math.max(start.col, end.col) };
}

/* ------------------------------- the theme -------------------------------- */

/** The theme's colours in Excel's index order: light 1, dark 1, light 2, dark 2, accents 1–6, hyperlinks. */
function themeColors(entries: ZipEntries, rels: Rel[]): string[] {
  const part = rels.find((rel) => rel.type.endsWith("/theme"))?.target;
  const text = part === undefined ? null : zipText(entries, part);
  if (text === null) return DEFAULT_THEME;
  const scheme = descendant(parseXml(text).documentElement, NS.a, "clrScheme");
  if (scheme === null) return DEFAULT_THEME;
  const color = (name: string): string | null => {
    const slot = kid(scheme, NS.a, name);
    const srgb = kid(slot, NS.a, "srgbClr");
    if (srgb !== null) return `#${(attr(srgb, null, "val") ?? "000000").slice(-6)}`;
    const sys = kid(slot, NS.a, "sysClr");
    if (sys !== null) return `#${(attr(sys, null, "lastClr") ?? "000000").slice(-6)}`;
    return null;
  };
  const order = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  return order.map((name, index) => color(name) ?? DEFAULT_THEME[index]!);
}

const DEFAULT_THEME = ["#FFFFFF", "#000000", "#E7E6E6", "#44546A", "#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47", "#0563C1", "#954F72"];

/** Excel's legacy palette (`indexed`), the 64 its styles may name. */
const INDEXED = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080", "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
  "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF", "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
  "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696", "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
];

/** A colour lightened or darkened by a tint (-1…1), as Excel applies it to a theme colour. */
function tinted(hex: string, tint: number): string {
  if (tint === 0) return hex;
  const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === rgb[0] ? (rgb[1] - rgb[2]) / d + (rgb[1] < rgb[2] ? 6 : 0) : max === rgb[1] ? (rgb[2] - rgb[0]) / d + 2 : (rgb[0] - rgb[1]) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number): number => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const out = s === 0 ? [l, l, l] : [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
  return `#${out.map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function colorOf(el: Element | null, theme: string[]): string | undefined {
  if (el === null) return undefined;
  const rgb = attr(el, null, "rgb");
  const tint = Number(attr(el, null, "tint") ?? "0") || 0;
  if (rgb !== null && /^[0-9a-f]{6,8}$/i.test(rgb)) return tinted(`#${rgb.slice(-6).toUpperCase()}`, tint);
  const themeIndex = attr(el, null, "theme");
  if (themeIndex !== null) {
    const base = theme[Number(themeIndex)];
    return base === undefined ? undefined : tinted(base, tint);
  }
  const indexed = attr(el, null, "indexed");
  if (indexed !== null) {
    const found = INDEXED[Number(indexed)];
    return found === undefined ? undefined : tinted(`#${found}`, tint);
  }
  return undefined;
}

/* ------------------------------- the styles ------------------------------- */

interface Styles {
  cell: CellStyle[];
  /** Each style's number format code. */
  formats: string[];
}

const BUILTIN_FORMATS: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  5: '"$"#,##0_);("$"#,##0)',
  6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)',
  8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "m/d/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

function readStyles(entries: ZipEntries, rels: Rel[], theme: string[]): Styles {
  const part = rels.find((rel) => rel.type.endsWith("/styles"))?.target;
  const text = part === undefined ? null : zipText(entries, part);
  if (text === null) return { cell: [{}], formats: ["General"] };
  const root = parseXml(text).documentElement!;
  const custom = new Map<number, string>();
  for (const format of kids(kid(root, NS.x, "numFmts") ?? root, NS.x, "numFmt")) custom.set(Number(attr(format, null, "numFmtId")), attr(format, null, "formatCode") ?? "General");
  const fonts = kids(kid(root, NS.x, "fonts") ?? root, NS.x, "font").map((font): CellStyle => {
    const style: CellStyle = {};
    const on = (name: string): boolean => {
      const found = kid(font, NS.x, name);
      if (found === null) return false;
      const value = attr(found, null, "val");
      return value === null || (value !== "0" && value !== "false" && value !== "none");
    };
    if (on("b")) style.bold = true;
    if (on("i")) style.italic = true;
    if (on("u")) style.underline = true;
    if (on("strike")) style.strike = true;
    const size = Number(attr(kid(font, NS.x, "sz"), null, "val"));
    if (Number.isFinite(size) && size > 0) style.size = size;
    const color = colorOf(kid(font, NS.x, "color"), theme);
    // Black text on a white sheet is the default: only a colour that differs is kept.
    if (color !== undefined && color !== "#000000") style.color = color;
    return style;
  });
  const fills = kids(kid(root, NS.x, "fills") ?? root, NS.x, "fill").map((fill): string | undefined => {
    const pattern = kid(fill, NS.x, "patternFill");
    if (pattern === null || (attr(pattern, null, "patternType") ?? "none") === "none") return undefined;
    return colorOf(kid(pattern, NS.x, "fgColor"), theme) ?? colorOf(kid(pattern, NS.x, "bgColor"), theme);
  });
  const cell: CellStyle[] = [];
  const formats: string[] = [];
  for (const xf of kids(kid(root, NS.x, "cellXfs") ?? root, NS.x, "xf")) {
    const numFmtId = Number(attr(xf, null, "numFmtId") ?? "0");
    formats.push(custom.get(numFmtId) ?? BUILTIN_FORMATS[numFmtId] ?? "General");
    const style: CellStyle = { ...(fonts[Number(attr(xf, null, "fontId") ?? "0")] ?? {}) };
    const fill = fills[Number(attr(xf, null, "fillId") ?? "0")];
    if (fill !== undefined) style.fill = fill;
    const alignment = kid(xf, NS.x, "alignment");
    const horizontal = attr(alignment, null, "horizontal");
    if (horizontal === "left" || horizontal === "center" || horizontal === "right" || horizontal === "justify") style.align = horizontal;
    else if (horizontal === "centerContinuous") style.align = "center";
    const vertical = attr(alignment, null, "vertical");
    if (vertical === "top") style.valign = "top";
    else if (vertical === "center") style.valign = "middle";
    const wrap = attr(alignment, null, "wrapText");
    if (wrap === "1" || wrap === "true") style.wrap = true;
    cell.push(style);
  }
  if (cell.length === 0) {
    cell.push({});
    formats.push("General");
  }
  return { cell, formats };
}

/* ---------------------------- number formats ----------------------------- */

/** Split a format code at its `;` sections (not inside quotes or brackets). */
function sections(code: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let bracket = false;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index]!;
    if (char === "\\" && !quoted) {
      current += char + (code[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "[") bracket = true;
    else if (!quoted && char === "]") bracket = false;
    if (char === ";" && !quoted && !bracket) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

/** The code with literals (quoted text, escapes, padding) taken out, to read what kind of format it is. */
function bare(code: string): string {
  return code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/[_*]./g, "").replace(/\[[^\]]*\]/g, "");
}

export function isDateFormat(code: string): boolean {
  const plain = bare(sections(code)[0] ?? "");
  return /[dmyhs]/i.test(plain) && !/^[#0.,%E+-]*$/i.test(plain);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A serial date as a UTC calendar moment (Excel's dates have no zone). */
function serialDate(serial: number, date1904: boolean): Date {
  // The 1900 system counts a 29 February 1900 that never was.
  const days = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial;
  return new Date(Math.round((days - 25569) * 86_400_000));
}

function formatDate(serial: number, code: string, date1904: boolean): string {
  const date = serialDate(serial, date1904);
  const plain = code.replace(/\[[^\]]*\]/g, (match) => (/^\[h+\]$/i.test(match) ? match : ""));
  const hasAmPm = /AM\/PM|A\/P/i.test(plain);
  const tokens = plain.match(/"[^"]*"|\\.|AM\/PM|A\/P|\[h+\]|y+|m+|d+|h+|s+(\.0+)?|./gi) ?? [];
  let out = "";
  let lastWasHour = false;
  tokens.forEach((token, index) => {
    const lower = token.toLowerCase();
    if (token.startsWith('"')) out += token.slice(1, -1);
    else if (token.startsWith("\\")) out += token.slice(1);
    else if (/^\[h+\]$/i.test(token)) {
      // Elapsed hours: the minutes after them are minutes.
      out += String(Math.floor(serial * 24));
      lastWasHour = true;
      return;
    }
    else if (lower.startsWith("y")) out += lower.length <= 2 ? String(date.getUTCFullYear()).slice(-2) : String(date.getUTCFullYear());
    else if (lower.startsWith("m") && lower !== "am/pm") {
      // Minutes after an hour or before seconds; the month otherwise.
      const next = tokens.slice(index + 1).find((candidate) => /^[a-z]/i.test(candidate) && !/^(am\/pm|a\/p)$/i.test(candidate));
      const minutes = lastWasHour || (next !== undefined && next.toLowerCase().startsWith("s"));
      if (minutes) out += lower.length >= 2 ? String(date.getUTCMinutes()).padStart(2, "0") : String(date.getUTCMinutes());
      else if (lower.length === 1) out += String(date.getUTCMonth() + 1);
      else if (lower.length === 2) out += String(date.getUTCMonth() + 1).padStart(2, "0");
      else if (lower.length === 3) out += MONTHS[date.getUTCMonth()]!.slice(0, 3);
      else if (lower.length === 5) out += MONTHS[date.getUTCMonth()]!.slice(0, 1);
      else out += MONTHS[date.getUTCMonth()]!;
    } else if (lower.startsWith("d")) {
      if (lower.length === 1) out += String(date.getUTCDate());
      else if (lower.length === 2) out += String(date.getUTCDate()).padStart(2, "0");
      else if (lower.length === 3) out += DAYS[date.getUTCDay()]!.slice(0, 3);
      else out += DAYS[date.getUTCDay()]!;
    } else if (lower.startsWith("h")) {
      let hours = date.getUTCHours();
      if (hasAmPm) hours = hours % 12 === 0 ? 12 : hours % 12;
      out += lower.length >= 2 ? String(hours).padStart(2, "0") : String(hours);
      lastWasHour = true;
      return;
    } else if (lower.startsWith("s")) {
      const [, fraction] = lower.split(".");
      out += String(date.getUTCSeconds()).padStart(lower.startsWith("ss") ? 2 : 1, "0");
      if (fraction !== undefined) out += `.${String(date.getUTCMilliseconds()).padStart(3, "0").slice(0, fraction.length)}`;
    } else if (lower === "am/pm") out += date.getUTCHours() < 12 ? "AM" : "PM";
    else if (lower === "a/p") out += date.getUTCHours() < 12 ? "A" : "P";
    else if (/^[_*]$/.test(token)) out += "";
    else out += token;
    if (/[a-z]/i.test(token)) lastWasHour = false;
  });
  return out;
}

/** A number as General shows it: up to 10 significant digits, no trailing zeros, exponential when it will not fit. */
export function generalNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const abs = Math.abs(value);
  const exponential = (): string => {
    const [mantissa, exponent] = value.toExponential(5).split("e");
    const power = Number(exponent);
    return `${mantissa!.replace(/\.?0+$/, "")}E${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;
  };
  if (abs >= 1e11 || abs < 1e-9) return exponential();
  const shown = String(Number(value.toPrecision(10)));
  return shown.includes("e") ? exponential() : shown;
}

function formatNumberSection(value: number, section: string): string {
  let code = section.replace(/\[[^\]]*\]/g, (match) => {
    // A currency tag [$€-407] says its symbol.
    const currency = /^\[\$([^-\]]*)/.exec(match);
    return currency !== null ? `"${currency[1] ?? ""}"` : "";
  });
  if (code.trim() === "" || /^general$/i.test(code.trim())) return generalNumber(value);
  let scaled = value;
  if (/%/.test(bare(code))) scaled *= 100;
  // Thousands scaling: a comma right before the decimal point or the end.
  const plain = bare(code);
  const scaling = /,+(?=[^0#?,]*$|\.)/.exec(plain.replace(/[^0#?,.]/g, ""));
  if (scaling !== null && plain.replace(/[^0#?,.]/g, "").endsWith(scaling[0])) scaled /= 1000 ** scaling[0].length;
  const exponential = /E[+-]/i.exec(plain);
  const numberPart = /[0#?][0#?,.]*|\.[0#?]+/.exec(plain)?.[0] ?? "";
  const decimals = (numberPart.split(".")[1] ?? "").replace(/[^0#?]/g, "").length;
  const grouping = /[0#?],[0#?]/.test(numberPart);
  let formatted: string;
  if (exponential !== null) {
    formatted = Math.abs(scaled).toExponential(decimals).toUpperCase().replace(/E([+-])(\d)$/, "E$10$2");
  } else {
    const fixed = Math.abs(scaled).toFixed(decimals);
    const [whole, fraction] = fixed.split(".");
    const minWhole = (numberPart.split(".")[0] ?? "").replace(/[^0]/g, "").length;
    let integer = whole === "0" && minWhole === 0 ? "" : (whole ?? "");
    // Required digits (a 0 in the pattern) are always there: 00000 shows 123 as 00123.
    if (integer.length < minWhole) integer = integer.padStart(minWhole, "0");
    if (grouping) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    formatted = `${integer}${fraction === undefined ? "" : `.${fraction}`}`;
    // Optional decimals (#) are dropped when zero.
    const optional = (numberPart.split(".")[1] ?? "").replace(/[^#]/g, "").length;
    if (optional > 0 && fraction !== undefined) formatted = formatted.replace(new RegExp(`0{1,${String(optional)}}$`), "").replace(/\.$/, "");
  }
  // The literal text around the number, in its place.
  let out = "";
  let placed = false;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index]!;
    if (char === '"') {
      const end = code.indexOf('"', index + 1);
      out += code.slice(index + 1, end < 0 ? undefined : end);
      index = end < 0 ? code.length : end;
    } else if (char === "\\") {
      out += code[index + 1] ?? "";
      index += 1;
    } else if (char === "_") {
      out += " ";
      index += 1;
    } else if (char === "*") index += 1;
    else if ("0#?.,".includes(char) || (/[Ee]/.test(char) && /[+-]/.test(code[index + 1] ?? ""))) {
      if (!placed) {
        out += formatted;
        placed = true;
      }
      if (/[Ee]/.test(char)) index += 1;
    } else if (char === "%") out += "%";
    else if (char === "@") out += "";
    else out += char;
  }
  code = out;
  return placed ? code : `${code}${formatted}`;
}

/** A cell's number as its format shows it. */
export function formatNumber(value: number, code: string, date1904 = false): string {
  if (code === "" || /^general$/i.test(code.trim())) return generalNumber(value);
  if (/^@$/.test(code.trim())) return generalNumber(value);
  const parts = sections(code);
  if (isDateFormat(code)) return formatDate(value, parts[0] ?? code, date1904);
  // Positive; negative (shown without its minus: the section says how); zero.
  if (value < 0 && parts.length >= 2) return formatNumberSection(-value, parts[1]!);
  if (value === 0 && parts.length >= 3) return formatNumberSection(0, parts[2]!);
  const text = formatNumberSection(value, parts[0]!);
  return value < 0 ? `-${text}` : text;
}

/* -------------------------------- the sheets -------------------------------- */

function sharedStrings(entries: ZipEntries, rels: Rel[]): string[] {
  const part = rels.find((rel) => rel.type.endsWith("/sharedStrings"))?.target;
  const text = part === undefined ? null : zipText(entries, part);
  if (text === null) return [];
  const root = parseXml(text).documentElement;
  if (root === null) return [];
  return kids(root, NS.x, "si").map(richText);
}

/** A string item's text: its `t`, or its runs' (phonetic guides left out). */
function richText(el: Element): string {
  const direct = kid(el, NS.x, "t");
  if (direct !== null) return textOf(direct);
  return kids(el, NS.x, "r")
    .map((run) => textOf(kid(run, NS.x, "t")))
    .join("");
}

/** A column width in characters (Excel's unit), in px. */
function widthPx(chars: number): number {
  return Math.max(0, Math.round(chars * 7 + 5));
}

function readSheet(entries: ZipEntries, part: string, name: string, hidden: boolean, strings: string[], styles: Styles, date1904: boolean, budget: { cells: number }): Sheet {
  const sheet: Sheet = {
    name,
    hidden,
    rowCount: 0,
    colCount: 0,
    cells: new Map(),
    merges: [],
    colWidths: new Map(),
    hiddenCols: new Set(),
    hiddenRows: new Set(),
    defaultWidth: widthPx(8.43),
    frozen: { rows: 0, cols: 0 },
    truncated: false,
  };
  const text = zipText(entries, part);
  if (text === null) return sheet;
  const root = parseXml(text).documentElement;
  if (root === null) return sheet;
  const format = kid(root, NS.x, "sheetFormatPr");
  const defaultWidth = Number(attr(format, null, "defaultColWidth") ?? attr(format, null, "baseColWidth") ?? "");
  if (Number.isFinite(defaultWidth) && defaultWidth > 0) sheet.defaultWidth = attr(format, null, "defaultColWidth") !== null ? widthPx(defaultWidth) : widthPx(defaultWidth + 0.43);
  for (const col of kids(kid(root, NS.x, "cols") ?? root, NS.x, "col")) {
    const min = Number(attr(col, null, "min")) - 1;
    const max = Math.min(MAX_COLS, Number(attr(col, null, "max"))) - 1;
    const width = Number(attr(col, null, "width"));
    const isHidden = attr(col, null, "hidden") === "1" || attr(col, null, "hidden") === "true";
    if (!Number.isFinite(min) || !Number.isFinite(max) || max - min > 2_000) continue;
    for (let index = min; index <= max; index += 1) {
      if (Number.isFinite(width) && width > 0) sheet.colWidths.set(index, widthPx(width));
      if (isHidden) sheet.hiddenCols.add(index);
    }
  }
  const view = kid(kid(root, NS.x, "sheetViews"), NS.x, "sheetView");
  const pane = kid(view, NS.x, "pane");
  if (pane !== null && (attr(pane, null, "state") === "frozen" || attr(pane, null, "state") === "frozenSplit")) {
    sheet.frozen = { rows: Math.max(0, Math.floor(Number(attr(pane, null, "ySplit") ?? "0")) || 0), cols: Math.max(0, Math.floor(Number(attr(pane, null, "xSplit") ?? "0")) || 0) };
  }
  const data = kid(root, NS.x, "sheetData");
  let nextRow = 0;
  let cellsRead = 0;
  for (const row of data === null ? [] : kids(data, NS.x, "row")) {
    const rowIndex = attr(row, null, "r") === null ? nextRow : Number(attr(row, null, "r")) - 1;
    nextRow = rowIndex + 1;
    if (!Number.isFinite(rowIndex) || rowIndex < 0) continue;
    if (attr(row, null, "hidden") === "1" || attr(row, null, "hidden") === "true") sheet.hiddenRows.add(rowIndex);
    let nextCol = 0;
    for (const cell of kids(row, NS.x, "c")) {
      const ref = attr(cell, null, "r");
      const at = ref === null ? { row: rowIndex, col: nextCol } : parseRef(ref);
      if (at === null) continue;
      nextCol = at.col + 1;
      const type = attr(cell, null, "t") ?? "n";
      const style = Number(attr(cell, null, "s") ?? "0") || 0;
      const raw = kid(cell, NS.x, "v");
      let shown: string;
      let numeric = false;
      if (type === "s") shown = strings[Number(textOf(raw))] ?? "";
      else if (type === "inlineStr") shown = richText(kid(cell, NS.x, "is") ?? cell);
      else if (type === "str") shown = textOf(raw);
      else if (type === "b") shown = raw === null ? "" : textOf(raw) === "1" ? "TRUE" : "FALSE";
      else if (type === "e") shown = textOf(raw);
      else if (type === "d") {
        shown = textOf(raw);
        numeric = true;
      } else {
        if (raw === null) continue;
        const number = Number(textOf(raw));
        if (!Number.isFinite(number)) shown = textOf(raw);
        else {
          shown = formatNumber(number, styles.formats[style] ?? "General", date1904);
          numeric = true;
        }
      }
      if (shown === "" && style === 0) continue;
      if (cellsRead >= MAX_CELLS_PER_SHEET || budget.cells <= 0) {
        sheet.truncated = true;
        break;
      }
      cellsRead += 1;
      budget.cells -= 1;
      sheet.cells.set(cellKey(at.row, at.col), { row: at.row, col: at.col, text: shown, numeric, style });
      if (shown !== "" || style !== 0) {
        sheet.rowCount = Math.max(sheet.rowCount, at.row + 1);
        sheet.colCount = Math.max(sheet.colCount, at.col + 1);
      }
    }
    if (sheet.truncated) break;
  }
  for (const merge of kids(kid(root, NS.x, "mergeCells") ?? root, NS.x, "mergeCell")) {
    const range = parseRange(attr(merge, null, "ref") ?? "");
    if (range === null) continue;
    sheet.merges.push(range);
    sheet.rowCount = Math.max(sheet.rowCount, range.bottom + 1);
    sheet.colCount = Math.max(sheet.colCount, range.right + 1);
  }
  return sheet;
}

export function readXlsx(bytes: Uint8Array): Workbook {
  const entries = readZip(bytes);
  const workbookPart = mainPart(entries, "xl/workbook.xml");
  const text = zipText(entries, workbookPart);
  if (text === null) throw new DocumentError("the file is not an Excel workbook");
  const root = parseXml(text).documentElement;
  if (root === null || !is(root, NS.x, "workbook")) throw new DocumentError("the file is not an Excel workbook");
  const rels = readRels(entries, workbookPart);
  const theme = themeColors(entries, rels);
  const styles = readStyles(entries, rels, theme);
  const strings = sharedStrings(entries, rels);
  const pr = kid(root, NS.x, "workbookPr");
  const date1904 = attr(pr, null, "date1904") === "1" || attr(pr, null, "date1904") === "true";
  const budget = { cells: MAX_CELLS };
  const sheets: Sheet[] = [];
  for (const entry of kids(kid(root, NS.x, "sheets") ?? root, NS.x, "sheet")) {
    const id = attr(entry, NS.r, "id");
    const rel = rels.find((candidate) => candidate.id === id);
    // Chart sheets and dialog sheets have no cells to show.
    if (rel === undefined || !rel.type.endsWith("/worksheet")) continue;
    const state = attr(entry, null, "state");
    sheets.push(readSheet(entries, rel.target, attr(entry, null, "name") ?? `Sheet${String(sheets.length + 1)}`, state === "hidden" || state === "veryHidden", strings, styles, date1904, budget));
  }
  if (sheets.length === 0) throw new DocumentError("the workbook has no sheets to show");
  return { sheets, styles: styles.cell };
}

/** Columns up to here are laid out as a row's tab-separated fields; a cell further out is named by its reference. */
const TEXT_COLUMNS = 64;

/**
 * The workbook as the agent reads it: each sheet named, then its rows —
 * the ones that hold something, by their numbers — tab-separated, a cell
 * far to the right as `XFD10000=value`. It walks the cells there are, not
 * the sheet's whole rectangle, which a single far cell makes enormous.
 */
export function xlsxText(bytes: Uint8Array, maxChars: number): string {
  const workbook = readXlsx(bytes);
  let out = "";
  for (const sheet of workbook.sheets) {
    if (sheet.hidden) continue;
    out += `## Sheet “${sheet.name}” (${String(sheet.rowCount)} rows × ${String(sheet.colCount)} columns)\n`;
    const rows = new Map<number, SheetCell[]>();
    for (const cell of sheet.cells.values()) {
      if (cell.text === "") continue;
      const row = rows.get(cell.row);
      if (row === undefined) rows.set(cell.row, [cell]);
      else row.push(cell);
    }
    for (const row of [...rows.keys()].sort((a, b) => a - b)) {
      const cells = rows.get(row)!.sort((a, b) => a.col - b.col);
      const fields: string[] = [];
      const far: string[] = [];
      for (const cell of cells) {
        const text = cell.text.replace(/[\t\n\r]+/g, " ");
        if (cell.col < TEXT_COLUMNS) {
          while (fields.length < cell.col) fields.push("");
          fields[cell.col] = text;
        } else far.push(`${columnName(cell.col)}${String(row + 1)}=${text}`);
      }
      const line = `${String(row + 1)}\t${[...fields, ...far].join("\t")}\n`;
      if (out.length + line.length > maxChars) return `${out}[… cut at ${String(maxChars)} characters]`;
      out += line;
    }
    out += "\n";
  }
  return out.trimEnd();
}
