/**
 * A Word document's look, resolved (docs/desk-documents.md §3): the
 * defaults, then a paragraph's style and the styles it is based on, then a
 * run's character style, then what the paragraph or run says itself — each
 * later word overriding the earlier — and the CSS that draws it.
 *
 * Only what reading a document needs: fonts, sizes, weight and slant,
 * colour, highlight, underline and strike-through, super- and subscript,
 * capitals, hidden text; alignment, indents, spacing, the list a paragraph
 * belongs to, and whether it is a heading.
 */

import { attr, descendant, kid, kids, NS, toggle, val, type Document, type Element } from "../xml.js";

export interface RunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** #RRGGBB */
  color?: string;
  /** Half-points, as Word keeps them. */
  size?: number;
  font?: string;
  highlight?: string;
  shade?: string;
  vertAlign?: "superscript" | "subscript";
  caps?: boolean;
  smallCaps?: boolean;
  hidden?: boolean;
}

export interface ParaProps {
  align?: "left" | "center" | "right" | "justify";
  /** Twips. */
  indLeft?: number;
  indRight?: number;
  firstLine?: number;
  hanging?: number;
  before?: number;
  after?: number;
  line?: number;
  lineRule?: "auto" | "exact" | "atLeast";
  numId?: string;
  ilvl?: number;
  /** 0 for a first-level heading. */
  outline?: number;
}

interface Style {
  id: string;
  type: string;
  name: string;
  basedOn: string | null;
  para: ParaProps;
  run: RunProps;
  table: Element | null;
}

const HIGHLIGHTS: Record<string, string> = {
  yellow: "#FFFF00",
  green: "#00FF00",
  cyan: "#00FFFF",
  magenta: "#FF00FF",
  blue: "#0000FF",
  red: "#FF0000",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#C0C0C0",
  black: "#000000",
  white: "#FFFFFF",
};

function twips(value: string | null): number | undefined {
  if (value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function readRunProps(rPr: Element | null, fonts: ThemeFonts): RunProps {
  const props: RunProps = {};
  if (rPr === null) return props;
  const w = NS.w;
  const bold = toggle(rPr, w, "b");
  if (bold !== null) props.bold = bold;
  const italic = toggle(rPr, w, "i");
  if (italic !== null) props.italic = italic;
  const underline = val(rPr, w, "u");
  if (kid(rPr, w, "u") !== null) props.underline = underline !== "none";
  const strike = toggle(rPr, w, "strike") ?? toggle(rPr, w, "dstrike");
  if (strike !== null) props.strike = strike;
  const color = val(rPr, w, "color");
  if (color !== null && /^[0-9a-f]{6}$/i.test(color)) props.color = `#${color.toUpperCase()}`;
  else if (color === "auto") props.color = "auto";
  const size = twips(val(rPr, w, "sz"));
  if (size !== undefined && size > 0) props.size = size;
  const rFonts = kid(rPr, w, "rFonts");
  if (rFonts !== null) {
    const direct = attr(rFonts, w, "ascii") ?? attr(rFonts, w, "hAnsi");
    const theme = attr(rFonts, w, "asciiTheme") ?? attr(rFonts, w, "hAnsiTheme");
    const font = direct ?? (theme === null ? null : theme.startsWith("major") ? fonts.major : fonts.minor);
    if (font !== null && font !== "") props.font = font;
  }
  const highlight = val(rPr, w, "highlight");
  if (highlight !== null && highlight !== "none" && HIGHLIGHTS[highlight] !== undefined) props.highlight = HIGHLIGHTS[highlight];
  const shade = attr(kid(rPr, w, "shd"), w, "fill");
  if (shade !== null && /^[0-9a-f]{6}$/i.test(shade)) props.shade = `#${shade.toUpperCase()}`;
  const vertAlign = val(rPr, w, "vertAlign");
  if (vertAlign === "superscript" || vertAlign === "subscript") props.vertAlign = vertAlign;
  const caps = toggle(rPr, w, "caps");
  if (caps !== null) props.caps = caps;
  const smallCaps = toggle(rPr, w, "smallCaps");
  if (smallCaps !== null) props.smallCaps = smallCaps;
  const hidden = toggle(rPr, w, "vanish");
  if (hidden !== null) props.hidden = hidden;
  return props;
}

export function readParaProps(pPr: Element | null): ParaProps {
  const props: ParaProps = {};
  if (pPr === null) return props;
  const w = NS.w;
  const jc = val(pPr, w, "jc");
  if (jc === "left" || jc === "start") props.align = "left";
  else if (jc === "center") props.align = "center";
  else if (jc === "right" || jc === "end") props.align = "right";
  else if (jc === "both" || jc === "distribute") props.align = "justify";
  const ind = kid(pPr, w, "ind");
  if (ind !== null) {
    const left = twips(attr(ind, w, "left") ?? attr(ind, w, "start"));
    if (left !== undefined) props.indLeft = left;
    const right = twips(attr(ind, w, "right") ?? attr(ind, w, "end"));
    if (right !== undefined) props.indRight = right;
    const firstLine = twips(attr(ind, w, "firstLine"));
    if (firstLine !== undefined) props.firstLine = firstLine;
    const hanging = twips(attr(ind, w, "hanging"));
    if (hanging !== undefined) props.hanging = hanging;
  }
  const spacing = kid(pPr, w, "spacing");
  if (spacing !== null) {
    const before = twips(attr(spacing, w, "before"));
    if (before !== undefined) props.before = before;
    const after = twips(attr(spacing, w, "after"));
    if (after !== undefined) props.after = after;
    const line = twips(attr(spacing, w, "line"));
    if (line !== undefined) props.line = line;
    const rule = attr(spacing, w, "lineRule");
    if (rule === "exact" || rule === "atLeast" || rule === "auto") props.lineRule = rule;
  }
  const numPr = kid(pPr, w, "numPr");
  if (numPr !== null) {
    const numId = val(numPr, w, "numId");
    if (numId !== null) props.numId = numId;
    const ilvl = twips(val(numPr, w, "ilvl"));
    if (ilvl !== undefined) props.ilvl = ilvl;
  }
  const outline = twips(val(pPr, w, "outlineLvl"));
  if (outline !== undefined && outline < 9) props.outline = outline;
  return props;
}

export interface ThemeFonts {
  major: string;
  minor: string;
}

export function readThemeFonts(theme: Document | null): ThemeFonts {
  const scheme = theme === null ? null : descendant(theme.documentElement, NS.a, "fontScheme");
  const face = (which: string): string | null => attr(kid(kid(scheme, NS.a, which), NS.a, "latin"), null, "typeface");
  return { major: face("majorFont") ?? "Calibri Light", minor: face("minorFont") ?? "Calibri" };
}

export class DocxStyles {
  readonly #styles = new Map<string, Style>();
  readonly #defaultParagraph: string | null;
  readonly defaults: { para: ParaProps; run: RunProps };
  readonly fonts: ThemeFonts;

  constructor(doc: Document | null, fonts: ThemeFonts) {
    this.fonts = fonts;
    const root = doc?.documentElement ?? null;
    const w = NS.w;
    const defaults = kid(root, w, "docDefaults");
    this.defaults = {
      run: readRunProps(kid(kid(defaults, w, "rPrDefault"), w, "rPr"), fonts),
      para: readParaProps(kid(kid(defaults, w, "pPrDefault"), w, "pPr")),
    };
    let defaultParagraph: string | null = null;
    for (const style of root === null ? [] : kids(root, w, "style")) {
      const id = attr(style, w, "styleId");
      if (id === null) continue;
      const type = attr(style, w, "type") ?? "paragraph";
      if (type === "paragraph" && (attr(style, w, "default") === "1" || attr(style, w, "default") === "true")) defaultParagraph = id;
      this.#styles.set(id, {
        id,
        type,
        name: (val(style, w, "name") ?? id).toLowerCase(),
        basedOn: val(style, w, "basedOn"),
        para: readParaProps(kid(style, w, "pPr")),
        run: readRunProps(kid(style, w, "rPr"), fonts),
        table: kid(style, w, "tblPr"),
      });
    }
    this.#defaultParagraph = defaultParagraph;
  }

  /** A style and those it is based on, the base first (a loop in the chain stops it). */
  #chain(id: string | null): Style[] {
    const chain: Style[] = [];
    const seen = new Set<string>();
    let current = id === null ? undefined : this.#styles.get(id);
    while (current !== undefined && !seen.has(current.id) && chain.length < 20) {
      seen.add(current.id);
      chain.unshift(current);
      current = current.basedOn === null ? undefined : this.#styles.get(current.basedOn);
    }
    return chain;
  }

  /** A paragraph style's paragraph and run properties, over the defaults (the default paragraph style when it names none). */
  paragraph(styleId: string | null): { para: ParaProps; run: RunProps; name: string } {
    const chain = this.#chain(styleId ?? this.#defaultParagraph);
    let para: ParaProps = { ...this.defaults.para };
    let run: RunProps = { ...this.defaults.run };
    for (const style of chain) {
      para = { ...para, ...style.para };
      run = { ...run, ...style.run };
    }
    // A heading style by its name, where the style does not say its level.
    const name = chain.at(-1)?.name ?? "";
    if (para.outline === undefined) {
      const heading = /^heading (\d)$/.exec(name);
      if (heading !== null) para.outline = Number(heading[1]) - 1;
      else if (name === "title") para.outline = 0;
    }
    return { para, run, name };
  }

  /** A character style's run properties alone (its chain; the paragraph's come first). */
  character(styleId: string | null): RunProps {
    let run: RunProps = {};
    for (const style of this.#chain(styleId)) run = { ...run, ...style.run };
    return run;
  }

  /** A table style's borders, if it (or a style it is based on) draws any. */
  tableBorders(styleId: string | null): Element | null {
    for (const style of this.#chain(styleId).reverse()) {
      const borders = kid(style.table, NS.w, "tblBorders");
      if (borders !== null) return borders;
    }
    return null;
  }
}

/* ---------------------------------- CSS ---------------------------------- */

const SERIF = /times|cambria|georgia|garamond|palatino|book antiqua|baskerville|didot|constantia|minion|serif/i;
const MONO = /courier|consolas|menlo|monaco|mono|lucida console/i;

function fontStack(font: string): string {
  const family = `"${font.replace(/["\\;{}<>]/g, "")}"`;
  if (MONO.test(font)) return `${family}, ui-monospace, Menlo, monospace`;
  if (SERIF.test(font)) return `${family}, "Times New Roman", Georgia, serif`;
  return `${family}, "Helvetica Neue", Helvetica, Arial, sans-serif`;
}

/** A twip is a twentieth of a point: 15 of them to a CSS px. */
export function px(twipsValue: number): number {
  return Math.round((twipsValue / 15) * 10) / 10;
}

export function runCss(props: RunProps): string {
  const css: string[] = [];
  if (props.font !== undefined) css.push(`font-family:${fontStack(props.font)}`);
  if (props.size !== undefined) css.push(`font-size:${String(props.size / 2)}pt`);
  if (props.bold === true) css.push("font-weight:700");
  else if (props.bold === false) css.push("font-weight:400");
  if (props.italic === true) css.push("font-style:italic");
  else if (props.italic === false) css.push("font-style:normal");
  const decorations = [props.underline === true ? "underline" : "", props.strike === true ? "line-through" : ""].filter((value) => value !== "");
  if (decorations.length > 0) css.push(`text-decoration:${decorations.join(" ")}`);
  if (props.color !== undefined && props.color !== "auto") css.push(`color:${props.color}`);
  if (props.highlight !== undefined) css.push(`background-color:${props.highlight}`);
  else if (props.shade !== undefined) css.push(`background-color:${props.shade}`);
  if (props.vertAlign === "superscript") css.push("vertical-align:super", "font-size:0.7em");
  else if (props.vertAlign === "subscript") css.push("vertical-align:sub", "font-size:0.7em");
  if (props.caps === true) css.push("text-transform:uppercase");
  if (props.smallCaps === true) css.push("font-variant:small-caps");
  if (props.hidden === true) css.push("display:none");
  return css.join(";");
}

export function paraCss(props: ParaProps): string {
  const css: string[] = [];
  if (props.align !== undefined) css.push(`text-align:${props.align}`);
  if (props.indLeft !== undefined && props.indLeft !== 0) css.push(`margin-left:${String(px(props.indLeft))}px`);
  if (props.indRight !== undefined && props.indRight !== 0) css.push(`margin-right:${String(px(props.indRight))}px`);
  if (props.hanging !== undefined && props.hanging !== 0) css.push(`text-indent:-${String(px(props.hanging))}px`);
  else if (props.firstLine !== undefined && props.firstLine !== 0) css.push(`text-indent:${String(px(props.firstLine))}px`);
  css.push(`margin-top:${String(px(props.before ?? 0))}px`, `margin-bottom:${String(px(props.after ?? 0))}px`);
  if (props.line !== undefined && props.line > 0) {
    if ((props.lineRule ?? "auto") === "auto") css.push(`line-height:${String(Math.round((props.line / 240) * 1.15 * 100) / 100)}`);
    else css.push(`line-height:${String(props.line / 20)}pt`);
  }
  return css.join(";");
}
