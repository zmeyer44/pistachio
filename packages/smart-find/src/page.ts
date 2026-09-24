/**
 * The page-side half of smart find (docs/smart-find.md §4.1, §4.4): read the
 * page's prose into passages, and later paint the ones the model chose.
 *
 * Each exported function is serialized with `toString()` and evaluated in the
 * page — Electron's isolated world on the desktop, Playwright's
 * `page.evaluate` on the cloud host — so each must be SELF-CONTAINED: no
 * imports, no references to anything outside its own body. Writing them as
 * functions rather than template strings is what lets them type-check.
 *
 * The page's DOM is never mutated. Passages are remembered as lists of text
 * nodes in a registry on `globalThis`, and matches are drawn with the CSS
 * Custom Highlight API, so there are no wrapper elements for the page's own
 * scripts, observers or hydration to trip over.
 */
import {
  SMART_FIND_COLLECT_LIMITS,
  type SmartFindCollection,
  type SmartFindPaint,
  type SmartFindPainted,
} from "./contract.js";

type CollectLimits = { [K in keyof typeof SMART_FIND_COLLECT_LIMITS]: number };

/** What the page remembers between a collect and its paints. */
interface Registry {
  generation: number;
  dirty: boolean;
  observer: MutationObserver | null;
  truncated: boolean;
  /** Passage id → the text nodes of its block, and where in the block's text it sits. */
  parts: Map<string, { nodes: Text[]; start: number; text: string }>;
  /** Text nodes that start a new word whatever their data says: after a <br>, or a table cell. */
  gaps: WeakSet<Text>;
}

type SmartFindGlobal = typeof globalThis & { __pistachioSmartFind?: Registry; __pistachioSmartFindSheet?: CSSStyleSheet };

/**
 * Read the page into passages. `known` is the generation the host already
 * holds: when the page has not changed since, the answer is just
 * `{ generation, unchanged: true }` and nothing is re-read.
 */
export function collectPassages(
  limits: CollectLimits,
  known: number | null,
): SmartFindCollection | { generation: number; unchanged: true } | null {
  const scope = globalThis as SmartFindGlobal;
  const previous = scope.__pistachioSmartFind;
  if (previous !== undefined && known !== null && previous.generation === known && !previous.dirty)
    return { generation: known, unchanged: true };
  const body = document.body;
  if (body === null) return null;

  const started = performance.now();
  const SKIPPED = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED", "VIDEO", "AUDIO",
    "INPUT", "TEXTAREA", "SELECT", "BUTTON", "NAV", "ASIDE", "DIALOG", "MENU",
  ]);
  const SKIPPED_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "menu", "menubar", "toolbar", "tablist", "dialog", "alert"]);
  const parts: Registry["parts"] = new Map();
  const passages: SmartFindCollection["passages"] = [];
  const seen = new WeakSet<Node>();
  let chars = 0;
  let nodes = 0;
  let blocks = 0;
  let truncated = false;
  const gaps: Registry["gaps"] = new WeakSet();
  let run: Text[] = [];
  let breaks = 0;
  let gap = false;
  /** Inside a table row: its cells are one passage, not a passage each. */
  let row = 0;

  const normalize = (list: Text[]): string => {
    let text = "";
    for (const node of list) text += (gaps.has(node) ? " " : "") + node.data;
    return text.replace(/\s+/g, " ").trim();
  };

  const visible = (element: Element): boolean => {
    let current: Element | null = element;
    // `checkVisibility()` is false for `display: contents` (MDN's <main>),
    // whose children render all the same: ask the nearest boxed ancestor.
    while (current !== null && getComputedStyle(current).display === "contents") current = current.parentElement;
    if (current === null) return false;
    if (typeof current.checkVisibility === "function")
      return current.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    return current.getClientRects().length > 0 && getComputedStyle(current).visibility !== "hidden";
  };

  const split = (text: string): { start: number; text: string }[] => {
    if (text.length <= limits.splitChars) return [{ start: 0, text }];
    const spans: { start: number; end: number }[] = [];
    if (typeof Intl.Segmenter === "function") {
      for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text))
        spans.push({ start: index, end: index + segment.length });
    } else spans.push({ start: 0, end: text.length });
    const out: { start: number; text: string }[] = [];
    let from = -1;
    let to = -1;
    const push = (start: number, end: number): void => {
      // One sentence longer than a part is cut where it must be.
      for (let at = start; at < end; at += limits.splitChars) {
        const raw = text.slice(at, Math.min(end, at + limits.splitChars));
        const lead = raw.length - raw.trimStart().length;
        const trimmed = raw.trim();
        if (trimmed.length > 0) out.push({ start: at + lead, text: trimmed });
      }
    };
    for (const span of spans) {
      if (from === -1) {
        from = span.start;
        to = span.end;
      } else if (span.end - from <= limits.splitChars) to = span.end;
      else {
        push(from, to);
        from = span.start;
        to = span.end;
      }
    }
    if (from !== -1) push(from, to);
    return out;
  };

  const flush = (): void => {
    breaks = 0;
    gap = false;
    if (run.length === 0) return;
    const list = run;
    run = [];
    if (truncated) return;
    const text = normalize(list);
    if (text.length < limits.minChars) return;
    const parent = list[0]!.parentElement;
    if (parent === null || !visible(parent)) return;
    const block = `b${blocks}`;
    const pieces = split(text);
    if (passages.length + pieces.length > limits.passages || chars + text.length > limits.chars) {
      truncated = true;
      return;
    }
    blocks += 1;
    chars += text.length;
    pieces.forEach((piece, index) => {
      const id = pieces.length === 1 ? block : `${block}p${index}`;
      parts.set(id, { nodes: list, start: piece.start, text: piece.text });
      passages.push({ id, text: piece.text, block });
    });
  };

  const skipped = (element: Element): boolean => {
    const tag = element.tagName.toUpperCase();
    if (SKIPPED.has(tag)) return true;
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true;
    const editable = element.getAttribute("contenteditable");
    if (editable !== null && editable !== "false") return true;
    const role = element.getAttribute("role");
    if (role !== null && SKIPPED_ROLES.has(role)) return true;
    // A page's masthead and footer are chrome; an article's own header holds its title.
    if ((tag === "HEADER" || tag === "FOOTER") && element.closest("article, main, [role=main]") === null) return true;
    return false;
  };

  const visit = (node: Node): void => {
    if (truncated) return;
    nodes += 1;
    if (nodes > limits.nodes || ((nodes & 255) === 0 && performance.now() - started > limits.cpuMs)) {
      truncated = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      if (/\S/.test((node as Text).data)) {
        if (gap && run.length > 0) gaps.add(node as Text);
        gap = false;
        run.push(node as Text);
        breaks = 0;
      } else if (run.length > 0) run.push(node as Text);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (seen.has(element)) {
      flush();
      return;
    }
    if (element.tagName === "BR") {
      // One <br> is a line; two are a paragraph, the way forum posts write them.
      breaks += 1;
      gap = true;
      if (breaks >= 2 && row === 0) flush();
      return;
    }
    if (skipped(element)) return;
    const display = getComputedStyle(element).display;
    if (display === "none") return;
    const inline = display.startsWith("inline") || display === "ruby" || display === "ruby-text";
    const isRow = display === "table-row";
    if (row > 0) gap = gap || !inline;
    else if (!inline) flush();
    if (isRow) row += 1;
    const children =
      element.shadowRoot !== null
        ? element.shadowRoot.childNodes
        : element instanceof HTMLSlotElement && element.assignedNodes().length > 0
          ? element.assignedNodes()
          : element.childNodes;
    for (const child of Array.from(children)) visit(child);
    if (isRow) row -= 1;
    if (row > 0) gap = gap || !inline;
    else if (!inline) flush();
  };

  // The main content first, so that a page over the bounds loses its rails
  // and not its article.
  const main = body.querySelector("main, [role=main], article");
  if (main !== null && !skipped(main)) {
    visit(main);
    flush();
    seen.add(main);
  }
  visit(body);
  flush();

  previous?.observer?.disconnect();
  const registry: Registry = {
    generation: (previous?.generation ?? 0) + 1,
    dirty: false,
    observer: null,
    truncated,
    parts,
    gaps,
  };
  if (typeof MutationObserver === "function") {
    registry.observer = new MutationObserver(() => {
      registry.dirty = true;
    });
    registry.observer.observe(body, { subtree: true, childList: true, characterData: true });
  }
  scope.__pistachioSmartFind = registry;
  return { generation: registry.generation, passages, truncated };
}

/** Draw the matches and bring the active one into view. Null when the page no longer holds this reading. */
export function paintMatches(paint: SmartFindPaint): SmartFindPainted | null {
  const scope = globalThis as SmartFindGlobal;
  const registry = scope.__pistachioSmartFind;
  if (registry === undefined || registry.generation !== paint.generation) return null;
  const highlights = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function" ? CSS.highlights : null;
  const NAMES = ["pistachio-find-match", "pistachio-find-weak", "pistachio-find-focus", "pistachio-find-active"];
  if (highlights !== null) for (const name of NAMES) highlights.delete(name);

  /** A range over `[start, end)` of the block's normalized text, or null once the block has changed. */
  const rangeOf = (id: string, from: number, to: number): Range | null => {
    const part = registry.parts.get(id);
    if (part === undefined) return null;
    // Replay the collect's normalization, remembering where each kept
    // character came from.
    const at: [Text, number][] = [];
    let text = "";
    let gap = false;
    for (const node of part.nodes) {
      if (!node.isConnected) return null;
      const data = node.data;
      if (registry.gaps.has(node)) gap = text.length > 0;
      for (let i = 0; i < data.length; i++) {
        if (/\s/.test(data[i]!)) {
          gap = text.length > 0;
          continue;
        }
        if (gap) {
          text += " ";
          at.push([node, i]);
          gap = false;
        }
        text += data[i]!;
        at.push([node, i]);
      }
    }
    if (text.slice(part.start, part.start + part.text.length) !== part.text) return null;
    const first = at[part.start + from];
    const last = at[part.start + to - 1];
    if (first === undefined || last === undefined || to <= from) return null;
    const range = new Range();
    // A collapsed space maps to the character after it; start there, inside the word.
    range.setStart(first[0], first[1]);
    range.setEnd(last[0], last[1] + 1);
    return range;
  };

  const stale: string[] = [];
  const context: Range[] = [];
  const focus: Range[] = [];
  let active: Range[] = [];
  paint.matches.forEach((match, index) => {
    const ranges: Range[] = [];
    for (const id of match.ids) {
      const part = registry.parts.get(id);
      const range = part === undefined ? null : rangeOf(id, 0, part.text.length);
      if (range === null) stale.push(id);
      else ranges.push(range);
    }
    context.push(...ranges);
    const sentence = match.focus === undefined ? null : rangeOf(match.focus.id, match.focus.start, match.focus.end);
    if (sentence !== null) focus.push(sentence);
    if (index === paint.active) active = sentence !== null ? [sentence] : ranges;
  });

  if (highlights !== null) {
    const layer = (name: string, ranges: Range[], priority: number): void => {
      if (ranges.length === 0) return;
      const highlight = new Highlight(...ranges);
      highlight.priority = priority;
      highlights.set(name, highlight);
    };
    layer(paint.weak ? "pistachio-find-weak" : "pistachio-find-match", context, 0);
    layer("pistachio-find-focus", focus, 1);
    layer("pistachio-find-active", active, 2);
  }

  const target = active[0];
  if (paint.scroll && target !== undefined) {
    // A jump, like Chromium's own find, and only when the match is not
    // already comfortably on screen: the repaint that brightens the key
    // sentence a moment later must not move the page a second time.
    const holder = target.startContainer.parentElement;
    const tall = (holder?.getBoundingClientRect().height ?? 0) > innerHeight * 0.8;
    const seen = target.getBoundingClientRect();
    const onScreen = seen.top >= innerHeight * 0.1 && seen.bottom <= innerHeight * 0.9;
    if (holder !== null && !onScreen) {
      // `scrollIntoView` reaches through nested scroll containers; a block
      // taller than the window is then corrected onto the sentence itself.
      holder.scrollIntoView({ behavior: "instant", block: tall ? "nearest" : "center" });
      const now = target.getBoundingClientRect();
      if (now.top < 0 || now.bottom > innerHeight) scrollBy({ top: now.top - innerHeight / 2 + now.height / 2, behavior: "instant" });
    }
  }
  return { stale };
}

/**
 * Give the document the highlight colours as a constructable stylesheet: no
 * <style> element, so nothing in the DOM changes and a strict `style-src`
 * has nothing to refuse. For hosts with no `insertCSS` of their own.
 */
export function adoptHighlightStyle(css: string): boolean {
  const scope = globalThis as SmartFindGlobal;
  if (scope.__pistachioSmartFindSheet !== undefined) return true;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    scope.__pistachioSmartFindSheet = sheet;
    return true;
  } catch {
    return false;
  }
}

/** Take the highlights away and forget the page. */
export function clearMatches(): true {
  const scope = globalThis as SmartFindGlobal;
  const sheet = scope.__pistachioSmartFindSheet;
  if (sheet !== undefined) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
    delete scope.__pistachioSmartFindSheet;
  }
  if (typeof CSS !== "undefined" && "highlights" in CSS)
    for (const name of ["pistachio-find-match", "pistachio-find-weak", "pistachio-find-focus", "pistachio-find-active"])
      CSS.highlights.delete(name);
  scope.__pistachioSmartFind?.observer?.disconnect();
  delete scope.__pistachioSmartFind;
  return true;
}

/**
 * The `__name` shim neutralizes esbuild's `keepNames` helper, which a
 * function serialized out of a bundle still calls.
 */
const evaluate = (fn: (...args: never[]) => unknown, ...args: unknown[]): string =>
  `(()=>{const __name=(f)=>f;return (${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")});})()`;

export const smartFindCollectScript = (known: number | null): string =>
  evaluate(collectPassages, SMART_FIND_COLLECT_LIMITS, known);

export const smartFindPaintScript = (paint: SmartFindPaint): string => evaluate(paintMatches, paint);

export const SMART_FIND_CLEAR_SCRIPT = evaluate(clearMatches);

/**
 * The colours of the three layers. Translucent, so they read on light and
 * dark pages alike; the active sentence is solid with its own text colour.
 * Hosts insert this as a stylesheet (`webContents.insertCSS`,
 * `page.addStyleTag`) — a page with a strict CSP would refuse a <style> the
 * script added itself.
 */
export const SMART_FIND_HIGHLIGHT_CSS = [
  "::highlight(pistachio-find-match){background-color:rgba(147,197,114,.26)}",
  "::highlight(pistachio-find-weak){background-color:rgba(147,197,114,.14)}",
  "::highlight(pistachio-find-focus){background-color:rgba(147,197,114,.5)}",
  "::highlight(pistachio-find-active){background-color:#b4e26b;color:#14210a}",
].join("");

/** `adoptHighlightStyle` with the colours above, for a host that cannot insert CSS from outside the page. */
export const SMART_FIND_ADOPT_STYLE_SCRIPT = evaluate(adoptHighlightStyle, SMART_FIND_HIGHLIGHT_CSS);
