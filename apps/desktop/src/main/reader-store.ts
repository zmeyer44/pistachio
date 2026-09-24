/**
 * Reader view: the article, the page that shows it, and the actions that page
 * can take.
 *
 * An extracted article (main/reader-extract.ts) is kept in memory and exposed
 * at `pistachio://reader/<id>`, the way a read-aloud clip is. The page it
 * serves carries no state of its own: every action the toolbar offers is a
 * POST back to `pistachio://reader/<id>/action/<name>`, answered here and
 * delegated to the host through `ReaderActions`. That keeps the page inert —
 * it may run its own reading controls and nothing else — and keeps the
 * privileged work (speech, the clipboard, the save dialog, the agent panel)
 * in main where the app's policy already applies.
 *
 * The page's look follows Vercel's brand design system: monochrome surfaces,
 * Geist for prose and Geist Mono for code, hierarchy carried by typography
 * rather than color or decoration, restrained radii, and no shadows,
 * gradients, or ornament. Its tokens use that system's `--vbg-*` names.
 */

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  hostOf,
  isReaderId,
  MAX_READER_BLOCKS,
  readerOutline,
  readerUrl,
  READER_HOST,
  renderReaderMarkdown,
  type ReaderArticle,
  type ReaderBlock,
  type ReaderInline,
} from "@pistachio/shell-contracts/reader";

/** Articles kept in memory; the oldest goes when a new one arrives. */
const ARTICLE_LIMIT = 12;

export type ReaderActionName = "speak" | "copy" | "save" | "chat" | "bookmark";

export const READER_ACTION_NAMES: readonly ReaderActionName[] = ["speak", "copy", "save", "chat", "bookmark"];

/** What the host does when the reader page's toolbar is used. */
export interface ReaderActions {
  /** Synthesize the whole article and open its player. */
  speak(article: ReaderArticle): Promise<void>;
  /** Put the Markdown on the system clipboard, subject to the copy policy. */
  copy(article: ReaderArticle, markdown: string): Promise<void>;
  /** Ask for a location and write the Markdown there; false when cancelled. */
  save(article: ReaderArticle, markdown: string): Promise<boolean>;
  /** Hand the article to the agent panel as context. */
  chat(article: ReaderArticle): Promise<void>;
  /** Bookmark the article's own address. */
  bookmark(article: ReaderArticle): Promise<void>;
}

export interface ReaderEntry {
  id: string;
  article: ReaderArticle;
  /** The tab the article was read from, so "back" has somewhere to go. */
  sourceTabId: string | null;
  createdAt: number;
}

function isReaderActionName(value: string): value is ReaderActionName {
  return (READER_ACTION_NAMES as readonly string[]).includes(value);
}

export class ReaderStore {
  readonly #entries = new Map<string, ReaderEntry>();
  #actions: ReaderActions | null = null;

  /** The host wires its actions once, at startup. */
  setActions(actions: ReaderActions): void {
    this.#actions = actions;
  }

  /** Remember an article and return the address that shows it. */
  open(article: ReaderArticle, sourceTabId: string | null = null): { id: string; url: string } {
    const id = randomBytes(16).toString("hex");
    this.#entries.set(id, { id, article, sourceTabId, createdAt: Date.now() });
    while (this.#entries.size > ARTICLE_LIMIT) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return { id, url: readerUrl(id) };
  }

  entry(id: string): ReaderEntry | null {
    return this.#entries.get(id) ?? null;
  }

  /** The reader address showing `url`, if one is still open. */
  findByUrl(url: string): ReaderEntry | null {
    for (const entry of [...this.#entries.values()].reverse()) {
      if (entry.article.url === url) return entry;
    }
    return null;
  }

  /**
   * Serve `pistachio://reader/...` — the page, its Markdown, its fonts, its
   * actions. Null (synchronously) for any other host, so a protocol handler
   * can fall through to the next store the way it does for read-aloud.
   */
  respond(url: URL, request?: Request): Promise<Response> | null {
    return url.host === READER_HOST ? this.#respond(url, request) : null;
  }

  async #respond(url: URL, request?: Request): Promise<Response> {
    const font = /^\/font\/(geist|geist-mono)\.woff2$/u.exec(url.pathname);
    if (font !== null) return fontResponse(font[1] === "geist-mono");

    const match = /^\/([0-9a-f]{32})(?:\/(markdown|action\/([a-z]+)))?$/u.exec(url.pathname);
    if (match === null || !isReaderId(match[1] ?? "")) return new Response("Not found", { status: 404 });
    const entry = this.entry(match[1] ?? "");
    if (entry === null) return new Response("This article is no longer open.", { status: 404 });

    if (match[3] !== undefined) return this.#act(entry, match[3], request);
    if (match[2] === "markdown") {
      return new Response(renderReaderMarkdown(entry.article), {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response(readerPageHtml(entry), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // Declared as a header as well as a meta tag: a header cannot be
        // reached by anything the document itself does.
        "content-security-policy": READER_CSP,
      },
    });
  }

  async #act(entry: ReaderEntry, name: string, request?: Request): Promise<Response> {
    // Only a POST acts; a GET of an action address must stay inert.
    if (request !== undefined && request.method !== "POST") {
      return json({ ok: false, message: "Use POST." }, 405);
    }
    if (!isReaderActionName(name)) return json({ ok: false, message: "Unknown action." }, 404);
    const actions = this.#actions;
    if (actions === null) return json({ ok: false, message: "Reader actions are unavailable." }, 503);
    try {
      switch (name) {
        case "speak":
          await actions.speak(entry.article);
          return json({ ok: true, message: "Generating audio…" });
        case "copy":
          await actions.copy(entry.article, renderReaderMarkdown(entry.article));
          return json({ ok: true, message: "Markdown copied" });
        case "save": {
          const saved = await actions.save(entry.article, renderReaderMarkdown(entry.article));
          return json({ ok: true, message: saved ? "Saved" : "Save cancelled" });
        }
        case "chat":
          await actions.chat(entry.article);
          return json({ ok: true, message: "Sent to Pistachio" });
        case "bookmark":
          await actions.bookmark(entry.article);
          return json({ ok: true, message: "Bookmarked" });
      }
    } catch (error) {
      const message = error instanceof Error && error.message !== "" ? error.message : "That did not work.";
      console.error("[reader]", name, error);
      return json({ ok: false, message }, 500);
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ------------------------------------------------------------------ */
/* Fonts                                                               */
/* ------------------------------------------------------------------ */

const fontCache = new Map<string, Buffer | null>();

/**
 * Geist, from the same package the shell uses. A missing file is not an
 * error: the page's @font-face simply fails and its fallback stack stands.
 */
export function fontResponse(mono: boolean): Response {
  const key = mono ? "mono" : "sans";
  if (!fontCache.has(key)) {
    const specifier = mono
      ? "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2"
      : "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2";
    try {
      const require_ = createRequire(import.meta.url);
      fontCache.set(key, readFileSync(require_.resolve(specifier)));
    } catch {
      fontCache.set(key, null);
    }
  }
  const file = fontCache.get(key) ?? null;
  if (file === null) return new Response("Not found", { status: 404 });
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file);
  return new Response(new Blob([bytes], { type: "font/woff2" }), {
    status: 200,
    headers: {
      "content-type": "font/woff2",
      "content-length": String(bytes.byteLength),
      "cache-control": "public, max-age=604800",
    },
  });
}

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function inlineHtml(runs: ReaderInline[]): string {
  return runs
    .map((run) => {
      const text = escapeHtml(run.text);
      switch (run.type) {
        case "text":
          return text;
        case "strong":
          return `<strong>${text}</strong>`;
        case "emphasis":
          return `<em>${text}</em>`;
        case "code":
          return `<code class="vbg-mono">${text}</code>`;
        case "link":
          return `<a href="${escapeHtml(run.href)}" rel="noreferrer noopener">${text}</a>`;
      }
    })
    .join("");
}

function blockHtml(block: ReaderBlock): string {
  switch (block.type) {
    case "heading":
      return `<h${String(block.level)} id="${escapeHtml(block.id)}">${inlineHtml(block.text)}</h${String(block.level)}>`;
    case "paragraph":
      return `<p>${inlineHtml(block.text)}</p>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items.map((item) => `<li>${inlineHtml(item)}</li>`).join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case "quote":
      return `<blockquote>${block.paragraphs.map((p) => `<p>${inlineHtml(p)}</p>`).join("")}</blockquote>`;
    case "code":
      return `<pre class="vbg-mono"><code>${escapeHtml(block.text)}</code></pre>`;
    case "image": {
      const image = `<img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}" loading="lazy" />`;
      return block.caption === null
        ? `<figure>${image}</figure>`
        : `<figure>${image}<figcaption class="vbg-caption">${escapeHtml(block.caption)}</figcaption></figure>`;
    }
    case "rule":
      return `<hr />`;
  }
}

const READER_CSP = [
  "default-src 'none'",
  "img-src https: data:",
  "font-src pistachio: data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The three ways of taking the piece somewhere else, gathered under one
 * "Share" menu. Labels are Title Case, each with a leading icon, per Geist's
 * menu-item convention.
 */
const SHARE_ITEMS: Array<{ name: ReaderActionName; label: string; icon: string }> = [
  { name: "copy", label: "Copy Markdown", icon: iconCopy() },
  { name: "save", label: "Save .md", icon: iconSave() },
  { name: "chat", label: "Send to Chat", icon: iconChat() },
];

export function readerPageHtml(entry: ReaderEntry): string {
  const { article, id } = entry;
  const outline = readerOutline(article);
  const site = article.siteName || hostOf(article.url);
  const meta = [
    article.byline === null ? "" : `<span class="vbg-meta-item">${escapeHtml(article.byline)}</span>`,
    article.published === null ? "" : `<span class="vbg-meta-item">${escapeHtml(displayDate(article.published))}</span>`,
    `<span class="vbg-meta-item vbg-mono">${article.wordCount.toLocaleString("en-US")} words</span>`,
  ]
    .filter((part) => part !== "")
    .join("");

  const toc =
    outline.length < 3
      ? ""
      : `<nav class="vbg-toc" aria-labelledby="toc-heading">
      <h2 class="vbg-label" id="toc-heading">Contents</h2>
      <ol class="vbg-toc-list">
        ${outline
          .map(
            (item) =>
              `<li data-level="${String(item.level)}"><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`,
          )
          .join("")}
      </ol>
    </nav>`;

  const body = article.blocks.slice(0, MAX_READER_BLOCKS).map(blockHtml).join("\n      ");

  return `<!doctype html>
<html lang="${escapeHtml(article.lang || "en")}" data-theme="system" data-size="2" data-measure="normal">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="${READER_CSP}" />
    ${article.faviconUrl === null ? "" : `<link rel="icon" href="${escapeHtml(article.faviconUrl)}" />`}
    <title>${escapeHtml(article.title)}</title>
    <style>${READER_CSS}</style>
  </head>
  <body>
    <a class="vbg-skip-link" href="#article">Skip to the article</a>
    <div class="vbg-progress" aria-hidden="true"><span id="progress"></span></div>

    <header class="vbg-header">
      <div class="vbg-header-inner">
        <div class="vbg-identity">
          <a class="vbg-source" href="${escapeHtml(article.url)}" title="${escapeHtml(article.url)}">
            <span class="vbg-wordmark">${escapeHtml(site)}</span>
            <span class="vbg-source-path vbg-mono">${escapeHtml(shortPath(article.url))}</span>
          </a>
        </div>
      </div>
    </header>

    <main class="vbg-report">
      <article class="vbg-article" id="article">
        <div class="vbg-opening">
          <h1 class="vbg-page-title">${escapeHtml(article.title)}</h1>
          <p class="vbg-document-meta">${meta}</p>
        </div>

        <div class="vbg-controls">
          <div class="vbg-controls-row" role="toolbar" aria-label="Article actions">
            <div class="vbg-cluster">
              <button class="vbg-play" type="button" data-action="speak" aria-label="Listen to the article">
                ${iconPlay()}
              </button>
              <button class="vbg-listen" type="button" data-action="speak">Listen to article</button>
              <span class="vbg-controls-divider" aria-hidden="true"></span>
              <span class="vbg-listen-time vbg-mono">${escapeHtml(listenLength(article.readingMinutes))}</span>
            </div>
            <div class="vbg-cluster">
              ${shareMenuHtml()}
              <button class="vbg-button vbg-button-icon" type="button" data-action="bookmark" title="Bookmark this article" aria-label="Bookmark this article">
                ${iconBookmark()}
              </button>
              ${displayMenuHtml()}
            </div>
          </div>
          <p class="vbg-status" id="status" role="status" aria-live="polite"></p>
        </div>
        ${toc}
        <div class="vbg-flow">
          ${body}
        </div>
      </article>
      <footer class="vbg-footer">
        <p class="vbg-meta">Reader view of
          <a href="${escapeHtml(article.url)}" rel="noreferrer noopener">${escapeHtml(article.url)}</a>
        </p>
      </footer>
    </main>

    <script>${readerScript(id)}</script>
  </body>
</html>`;
}

function displayDate(raw: string): string {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function shortPath(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/u, "");
    return path === "" ? "/" : path.length > 48 ? `${path.slice(0, 45)}…` : path;
  } catch {
    return "";
  }
}

/** How long the piece is, in the slot the reference puts a running time. */
function listenLength(minutes: number): string {
  return `${String(minutes)} min read`;
}

/**
 * "Share", as a Geist menu: a chevron trigger whose popover carries the three
 * ways of taking the article somewhere else.
 */
function shareMenuHtml(): string {
  const items = SHARE_ITEMS.map(
    (item) => `<button class="vbg-menu-item" type="button" role="menuitem" data-action="${item.name}">
                <span class="vbg-menu-prefix" aria-hidden="true">${item.icon}</span>${escapeHtml(item.label)}
              </button>`,
  ).join("\n              ");
  return `<div class="vbg-menu-container">
                <button class="vbg-button vbg-menu-trigger" type="button" id="share-trigger" data-menu="share"
                        aria-haspopup="menu" aria-expanded="false" aria-controls="share-menu">
                  ${iconShare()}<span>Share</span>${iconChevron()}
                </button>
                <div class="vbg-menu" id="share-menu" role="menu" aria-labelledby="share-trigger" hidden>
                  ${items}
                </div>
              </div>`;
}

/**
 * The reading controls, gathered behind one "Aa" trigger the way Safari's
 * reader does: the row stays a row, and the settings keep their labels.
 */
function displayMenuHtml(): string {
  const measures: Array<[string, string, string]> = [
    ["narrow", "Narrow", iconNarrow()],
    ["normal", "Normal", iconNormal()],
    ["wide", "Wide", iconWide()],
  ];
  const themes: Array<[string, string, string]> = [
    ["light", "Light", iconLight()],
    ["sepia", "Sepia", iconSepia()],
    ["dark", "Dark", iconDark()],
  ];
  const radios = (
    attribute: string,
    rows: Array<[string, string, string]>,
  ): string =>
    rows
      .map(
        ([value, label, icon]) =>
          `<button class="vbg-menu-item" type="button" role="menuitemradio" aria-checked="false" ${attribute}="${value}">
                    <span class="vbg-menu-prefix" aria-hidden="true">${icon}</span>${label}
                    <span class="vbg-menu-suffix" aria-hidden="true">${iconCheck()}</span>
                  </button>`,
      )
      .join("\n                  ");
  return `<div class="vbg-menu-container">
                <button class="vbg-button vbg-button-icon vbg-menu-trigger" type="button" id="display-trigger" data-menu="display"
                        title="Display options" aria-label="Display options"
                        aria-haspopup="menu" aria-expanded="false" aria-controls="display-menu">
                  <span class="vbg-aa" aria-hidden="true">Aa</span>
                </button>
                <div class="vbg-menu vbg-menu-display" id="display-menu" role="menu" aria-labelledby="display-trigger" hidden>
                  <div class="vbg-menu-section">
                    <span class="vbg-menu-label" id="size-label">Text Size</span>
                    <div class="vbg-menu-stepper" role="group" aria-labelledby="size-label">
                      <button class="vbg-stepper-button" type="button" data-size-step="-1" aria-label="Smaller text">${iconMinus()}</button>
                      <span class="vbg-stepper-value vbg-mono" id="size-value" aria-live="polite">100%</span>
                      <button class="vbg-stepper-button" type="button" data-size-step="1" aria-label="Larger text">${iconPlus()}</button>
                    </div>
                  </div>
                  <div class="vbg-menu-divider" role="separator"></div>
                  <div class="vbg-menu-section">
                    <span class="vbg-menu-label">Column Width</span>
                  </div>
                  ${radios("data-measure-set", measures)}
                  <div class="vbg-menu-divider" role="separator"></div>
                  <div class="vbg-menu-section">
                    <span class="vbg-menu-label">Theme</span>
                  </div>
                  ${radios("data-theme-set", themes)}
                </div>
              </div>`;
}

/* Icons: 16px, 1.5 stroke, currentColor — the design's monochrome rule. */
function stroke(paths: string): string {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
function iconCopy(): string {
  return stroke(`<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5H3.5a1 1 0 0 0-1 1v7"/>`);
}
function iconSave(): string {
  return stroke(`<path d="M8 2.5v8"/><path d="M4.5 7.5 8 11l3.5-3.5"/><path d="M2.5 12.5h11"/>`);
}
function iconChat(): string {
  return stroke(`<path d="M13.5 8.5a4.5 4.5 0 0 1-4.5 4.5H5l-2.5 1.5V8.5a4.5 4.5 0 0 1 4.5-4.5h1.5a4.5 4.5 0 0 1 4.5 4.5Z"/>`);
}
function iconBookmark(): string {
  return stroke(`<path d="M4 2.5h8v11l-4-3-4 3v-11Z"/>`);
}
function iconPlay(): string {
  // Solid: the one filled mark on the page, because it is the primary action.
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M5.5 3.6a.6.6 0 0 1 .92-.5l5.2 3.4a.6.6 0 0 1 0 1l-5.2 3.4a.6.6 0 0 1-.92-.5V3.6Z"/></svg>`;
}
function iconShare(): string {
  return stroke(`<path d="M6.5 9.5a2.5 2.5 0 0 0 3.6.1l2.1-2.1a2.5 2.5 0 0 0-3.5-3.5l-.9.9"/><path d="M9.5 6.5a2.5 2.5 0 0 0-3.6-.1l-2.1 2.1a2.5 2.5 0 0 0 3.5 3.5l.9-.9"/>`);
}
function iconChevron(): string {
  return stroke(`<path d="M4.5 6.5 8 10l3.5-3.5"/>`);
}
function iconCheck(): string {
  return stroke(`<path d="M3.5 8.5 6.5 11.5l6-7"/>`);
}
function iconMinus(): string {
  return stroke(`<path d="M3.5 8h9"/>`);
}
function iconPlus(): string {
  return stroke(`<path d="M8 3.5v9M3.5 8h9"/>`);
}
/** Column width reads as lines of text at that measure, not as two rules. */
function iconMeasure(left: number, right: number): string {
  return stroke(
    [4.5, 8, 11.5].map((y) => `<path d="M${String(left)} ${String(y)}h${String(right - left)}"/>`).join(""),
  );
}
function iconNarrow(): string {
  return iconMeasure(5, 11);
}
function iconNormal(): string {
  return iconMeasure(3.5, 12.5);
}
function iconWide(): string {
  return iconMeasure(2, 14);
}
function iconLight(): string {
  return stroke(`<circle cx="8" cy="8" r="2.75"/><path d="M8 1.5v1.5M8 13v1.5M2.6 2.6l1 1M12.4 12.4l1 1M1.5 8H3M13 8h1.5M2.6 13.4l1-1M12.4 3.6l1-1"/>`);
}
/** The tone between light and dark: a disc half filled. */
function iconSepia(): string {
  return stroke(`<circle cx="8" cy="8" r="5.25"/><path d="M8 2.75a5.25 5.25 0 0 0 0 10.5Z" fill="currentColor" stroke="none"/>`);
}
function iconDark(): string {
  return stroke(`<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z"/>`);
}

/**
 * The page's own behavior: the reading controls, the progress line, and the
 * toolbar's POSTs. Nothing else — every privileged action is main's.
 */
function readerScript(id: string): string {
  return `
(() => {
  const root = document.documentElement;
  const status = document.getElementById("status");
  const progress = document.getElementById("progress");
  const KEY = "pistachio.reader.preferences";
  const SIZES = [1, 2, 3, 4, 5];

  const load = () => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw === null ? {} : JSON.parse(raw);
    } catch {
      return {};
    }
  };
  const save = (preferences) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(preferences));
    } catch {
      /* A private window simply does not remember. */
    }
  };

  let preferences = load();
  const SIZE_LABELS = { 1: "90%", 2: "100%", 3: "110%", 4: "125%", 5: "140%" };
  const apply = () => {
    root.dataset.theme = preferences.theme || "system";
    root.dataset.size = String(SIZES.includes(preferences.size) ? preferences.size : 2);
    root.dataset.measure = preferences.measure || "normal";
    for (const button of document.querySelectorAll("[data-theme-set]")) {
      button.setAttribute("aria-checked", String(button.dataset.themeSet === root.dataset.theme));
    }
    for (const button of document.querySelectorAll("[data-measure-set]")) {
      button.setAttribute("aria-checked", String(button.dataset.measureSet === root.dataset.measure));
    }
    const value = document.getElementById("size-value");
    if (value !== null) value.textContent = SIZE_LABELS[Number(root.dataset.size)] || "100%";
  };
  apply();

  /* ---- Menus ---------------------------------------------------------- */

  const ITEMS = "[role='menuitem'], [role='menuitemradio'], .vbg-stepper-button";
  let openMenu = null;

  const closeMenu = (focusTrigger) => {
    if (openMenu === null) return;
    const { trigger, menu } = openMenu;
    openMenu = null;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (focusTrigger) trigger.focus();
  };

  const showMenu = (trigger) => {
    const menu = document.getElementById(trigger.getAttribute("aria-controls"));
    if (menu === null) return;
    closeMenu(false);
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    openMenu = { trigger: trigger, menu: menu };
  };

  const menuItems = () => (openMenu === null ? [] : [...openMenu.menu.querySelectorAll(ITEMS)].filter((item) => !item.disabled));

  const moveFocus = (delta, from) => {
    const items = menuItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement);
    const next = from !== undefined ? from : current + delta;
    items[(next + items.length) % items.length].focus();
  };

  document.addEventListener("keydown", (event) => {
    const trigger = event.target.closest("[data-menu]");
    if (trigger !== null && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      showMenu(trigger);
      moveFocus(0, event.key === "ArrowDown" ? 0 : menuItems().length - 1);
      return;
    }
    if (openMenu === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      closeMenu(false);
      return;
    }
    if (!openMenu.menu.contains(document.activeElement)) return;
    if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(-1); }
    else if (event.key === "Home") { event.preventDefault(); moveFocus(0, 0); }
    else if (event.key === "End") { event.preventDefault(); moveFocus(0, menuItems().length - 1); }
  });

  // A press anywhere else closes the open menu, the trigger included.
  document.addEventListener("pointerdown", (event) => {
    if (openMenu === null) return;
    if (openMenu.menu.contains(event.target) || openMenu.trigger.contains(event.target)) return;
    closeMenu(false);
  });

  const say = (message, ok) => {
    status.textContent = message;
    status.dataset.tone = ok === false ? "error" : "info";
    if (message !== "") window.setTimeout(() => { if (status.textContent === message) status.textContent = ""; }, 4000);
  };

  document.addEventListener("click", async (event) => {
    const trigger = event.target.closest("[data-menu]");
    if (trigger !== null) {
      if (openMenu !== null && openMenu.trigger === trigger) closeMenu(true);
      else showMenu(trigger);
      return;
    }

    const themeButton = event.target.closest("[data-theme-set]");
    if (themeButton !== null) {
      preferences.theme = root.dataset.theme === themeButton.dataset.themeSet ? "system" : themeButton.dataset.themeSet;
      save(preferences);
      apply();
      closeMenu(true);
      return;
    }
    const measureButton = event.target.closest("[data-measure-set]");
    if (measureButton !== null) {
      preferences.measure = measureButton.dataset.measureSet;
      save(preferences);
      apply();
      closeMenu(true);
      return;
    }
    const sizeButton = event.target.closest("[data-size-step]");
    if (sizeButton !== null) {
      const next = Number(root.dataset.size) + Number(sizeButton.dataset.sizeStep);
      preferences.size = Math.min(5, Math.max(1, next));
      save(preferences);
      apply();
      return;
    }
    const actionButton = event.target.closest("[data-action]");
    if (actionButton === null) return;
    const name = actionButton.dataset.action;
    // The stepper stays open for a second press; a chosen action does not.
    closeMenu(false);
    actionButton.disabled = true;
    say("Working…");
    try {
      const response = await fetch("pistachio://${READER_HOST}/${id}/action/" + name, { method: "POST" });
      const result = await response.json();
      say(result.message || (result.ok ? "Done" : "That did not work."), result.ok !== false);
    } catch (error) {
      say("That did not work.", false);
    } finally {
      actionButton.disabled = false;
    }
  });

  // The progress line is the one moving thing: it reports position, nothing else.
  const trackProgress = () => {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = scrollable <= 0 ? 1 : Math.min(1, Math.max(0, window.scrollY / scrollable));
    progress.style.width = (ratio * 100).toFixed(2) + "%";
  };
  window.addEventListener("scroll", trackProgress, { passive: true });
  window.addEventListener("resize", trackProgress);
  trackProgress();
})();`;
}

/**
 * The design system's tokens, named as it names them. Light is the base;
 * sepia and dark redefine only the token values, so every rule below is
 * written once.
 */
const READER_CSS = `
@font-face {
  font-family: "Geist Reader";
  src: url("pistachio://${READER_HOST}/font/geist.woff2") format("woff2-variations");
  font-weight: 100 900;
  font-display: swap;
}
@font-face {
  font-family: "Geist Mono Reader";
  src: url("pistachio://${READER_HOST}/font/geist-mono.woff2") format("woff2-variations");
  font-weight: 100 900;
  font-display: swap;
}

:root {
  --vbg-surface-primary: #ffffff;
  --vbg-surface-secondary: #fafafa;
  --vbg-surface-contrast: #171717;
  --vbg-text-primary: #171717;
  --vbg-text-secondary: #666666;
  --vbg-text-on-contrast: #fafafa;
  --vbg-border-subtle: #ededed;
  --vbg-border-default: #e0e0e0;
  --vbg-border-strong: #a1a1a1;
  --vbg-focus: #0072f5;

  --vbg-space-1: 4px;  --vbg-space-2: 8px;   --vbg-space-3: 12px;  --vbg-space-4: 16px;
  --vbg-space-5: 20px; --vbg-space-6: 24px;  --vbg-space-7: 32px;  --vbg-space-8: 40px;
  --vbg-space-9: 48px; --vbg-space-10: 56px; --vbg-space-12: 72px; --vbg-space-16: 112px;

  --vbg-radius-small: 4px;
  --vbg-radius: 6px;

  --vbg-font-sans: "Geist Reader", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --vbg-font-mono: "Geist Mono Reader", ui-monospace, SFMono-Regular, Menlo, monospace;

  --vbg-type-page-title: 42px;
  --vbg-type-section: 27px;
  --vbg-type-subsection: 21px;
  --vbg-type-lede: 21px;
  --vbg-type-body: 18px;
  --vbg-type-compact: 15px;
  --vbg-type-label: 13px;
  --vbg-type-metadata: 12.5px;

  --vbg-weight-regular: 400;
  --vbg-weight-medium: 500;
  --vbg-weight-heading: 600;
  --vbg-weight-semibold: 600;

  --vbg-leading-body: 1.75;
  --vbg-leading-compact: 1.5;
  --vbg-leading-caption: 1.45;
  --vbg-leading-page-title: 1.1;
  --vbg-leading-section: 1.25;
  --vbg-leading-subsection: 1.35;
  --vbg-leading-lede: 1.55;

  --vbg-measure: 68ch;
  color-scheme: light;
}

:root[data-theme="sepia"] {
  --vbg-surface-primary: #f8f4ec;
  --vbg-surface-secondary: #f2ece0;
  --vbg-text-primary: #2b2620;
  --vbg-text-secondary: #6b6154;
  --vbg-border-subtle: #e6ddcd;
  --vbg-border-default: #dcd1bd;
  --vbg-border-strong: #b0a48c;
  color-scheme: light;
}

:root[data-theme="dark"] {
  --vbg-surface-primary: #0a0a0a;
  --vbg-surface-secondary: #141414;
  --vbg-surface-contrast: #fafafa;
  --vbg-text-primary: #ededed;
  --vbg-text-secondary: #a1a1a1;
  --vbg-text-on-contrast: #0a0a0a;
  --vbg-border-subtle: #1f1f1f;
  --vbg-border-default: #2e2e2e;
  --vbg-border-strong: #666666;
  --vbg-focus: #3291ff;
  color-scheme: dark;
}

@media (prefers-color-scheme: dark) {
  :root[data-theme="system"] {
    --vbg-surface-primary: #0a0a0a;
    --vbg-surface-secondary: #141414;
    --vbg-surface-contrast: #fafafa;
    --vbg-text-primary: #ededed;
    --vbg-text-secondary: #a1a1a1;
    --vbg-text-on-contrast: #0a0a0a;
    --vbg-border-subtle: #1f1f1f;
    --vbg-border-default: #2e2e2e;
    --vbg-border-strong: #666666;
    --vbg-focus: #3291ff;
    color-scheme: dark;
  }
}

:root[data-size="1"] { --vbg-type-body: 16px; --vbg-type-page-title: 36px; --vbg-type-section: 24px; --vbg-type-subsection: 19px; }
:root[data-size="3"] { --vbg-type-body: 20px; --vbg-type-page-title: 46px; --vbg-type-section: 30px; --vbg-type-subsection: 23px; }
:root[data-size="4"] { --vbg-type-body: 22px; --vbg-type-page-title: 50px; --vbg-type-section: 33px; --vbg-type-subsection: 25px; }
:root[data-size="5"] { --vbg-type-body: 24px; --vbg-type-page-title: 54px; --vbg-type-section: 36px; --vbg-type-subsection: 27px; }

:root[data-measure="narrow"] { --vbg-measure: 56ch; }
:root[data-measure="wide"] { --vbg-measure: 82ch; }

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--vbg-surface-primary);
  color: var(--vbg-text-primary);
  font-family: var(--vbg-font-sans);
  font-size: var(--vbg-type-body);
  line-height: var(--vbg-leading-body);
  -webkit-font-smoothing: antialiased;
}

:focus-visible {
  outline: 2px solid var(--vbg-focus);
  outline-offset: 2px;
  border-radius: var(--vbg-radius-small);
}

.vbg-skip-link {
  position: absolute; left: -9999px; top: var(--vbg-space-2);
  background: var(--vbg-surface-primary); color: var(--vbg-text-primary);
  padding: var(--vbg-space-2) var(--vbg-space-3);
  border: 1px solid var(--vbg-border-default); border-radius: var(--vbg-radius);
  font-size: var(--vbg-type-label); z-index: 20;
}
.vbg-skip-link:focus { left: var(--vbg-space-4); }

.vbg-progress {
  position: fixed; top: 0; left: 0; right: 0; height: 2px; z-index: 12;
  background: transparent;
}
.vbg-progress > span {
  display: block; height: 100%; width: 0;
  background: var(--vbg-text-primary);
}

/* Header ---------------------------------------------------------------- */

.vbg-header {
  position: sticky; top: 0; z-index: 10;
  background: var(--vbg-surface-primary);
  border-bottom: 1px solid var(--vbg-border-subtle);
}
.vbg-header-inner {
  display: flex; align-items: center;
  max-width: 1100px; margin: 0 auto;
  padding: var(--vbg-space-3) var(--vbg-space-6);
}
.vbg-identity { min-width: 0; }
.vbg-source {
  display: flex; align-items: baseline; gap: var(--vbg-space-2);
  text-decoration: none; color: inherit; min-width: 0;
}
.vbg-source:hover .vbg-wordmark { text-decoration: underline; }
.vbg-wordmark {
  font-size: var(--vbg-type-label); font-weight: var(--vbg-weight-semibold);
  letter-spacing: -0.01em; white-space: nowrap;
}
.vbg-source-path {
  font-size: var(--vbg-type-metadata); color: var(--vbg-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.vbg-cluster { display: flex; align-items: center; gap: var(--vbg-space-1); flex-wrap: wrap; }

.vbg-button {
  display: inline-flex; align-items: center; gap: var(--vbg-space-2);
  padding: 6px var(--vbg-space-3);
  font-family: inherit; font-size: var(--vbg-type-label);
  font-weight: var(--vbg-weight-medium); line-height: 1;
  color: var(--vbg-text-secondary);
  background: transparent;
  border: 1px solid transparent; border-radius: var(--vbg-radius);
  cursor: pointer;
}
.vbg-button:hover:not(:disabled) { color: var(--vbg-text-primary); background: var(--vbg-surface-secondary); border-color: var(--vbg-border-subtle); }
.vbg-button:disabled { opacity: 0.5; cursor: default; }
.vbg-button[aria-pressed="true"] { color: var(--vbg-text-primary); border-color: var(--vbg-border-default); background: var(--vbg-surface-secondary); }
.vbg-button-icon { padding: 6px; }
.vbg-button svg { flex: none; }

.vbg-status {
  margin: 0;
  font-size: var(--vbg-type-metadata); color: var(--vbg-text-secondary);
  line-height: var(--vbg-leading-caption);
}
.vbg-status:not(:empty) { padding-top: var(--vbg-space-3); }

/* Controls, under the title ---------------------------------------------- */

.vbg-controls {
  border-top: 1px solid var(--vbg-border-subtle);
  border-bottom: 1px solid var(--vbg-border-subtle);
  padding: var(--vbg-space-3) 0;
  margin-bottom: var(--vbg-space-8);
}
.vbg-controls-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--vbg-space-4); flex-wrap: wrap;
}
.vbg-controls-divider { width: 1px; height: 16px; background: var(--vbg-border-default); margin: 0 var(--vbg-space-2); }

/* The one filled control on the page: the article's primary action. */
.vbg-play {
  display: grid; place-items: center;
  width: 32px; height: 32px; padding: 0;
  border: none; border-radius: 50%;
  background: var(--vbg-surface-secondary); color: var(--vbg-text-primary);
  cursor: pointer;
}
.vbg-play:hover:not(:disabled) { background: var(--vbg-border-subtle); }
.vbg-play:disabled { opacity: 0.5; cursor: default; }
.vbg-listen {
  padding: 0 var(--vbg-space-1);
  background: none; border: none; cursor: pointer;
  font-family: inherit; font-size: var(--vbg-type-label);
  font-weight: var(--vbg-weight-medium); color: var(--vbg-text-primary);
}
.vbg-listen:hover:not(:disabled) { text-decoration: underline; }
.vbg-listen:disabled { opacity: 0.5; cursor: default; text-decoration: none; }
.vbg-listen-time { font-size: var(--vbg-type-label); color: var(--vbg-text-secondary); }

/* Menu ------------------------------------------------------------------- */

.vbg-menu-container { position: relative; display: inline-flex; }
.vbg-menu-trigger[aria-expanded="true"] {
  color: var(--vbg-text-primary);
  background: var(--vbg-surface-secondary);
  border-color: var(--vbg-border-default);
}
.vbg-menu-trigger svg:last-child { opacity: 0.7; }
.vbg-aa { font-size: 12px; font-weight: var(--vbg-weight-semibold); letter-spacing: -0.02em; }

.vbg-menu {
  position: absolute; top: calc(100% + var(--vbg-space-2)); right: 0; z-index: 30;
  min-width: 208px; padding: var(--vbg-space-1);
  background: var(--vbg-surface-primary);
  border: 1px solid var(--vbg-border-default);
  border-radius: var(--vbg-radius);
  /* Elevation only: enough to lift the sheet off the prose it covers. */
  box-shadow: 0 4px 16px oklch(0 0 0 / 0.10);
}
.vbg-menu-display { min-width: 224px; }
.vbg-menu-item {
  display: flex; align-items: center; gap: var(--vbg-space-3);
  width: 100%; padding: 7px var(--vbg-space-2);
  font-family: inherit; font-size: var(--vbg-type-label);
  font-weight: var(--vbg-weight-regular); line-height: 1;
  color: var(--vbg-text-primary); text-align: left;
  background: none; border: none; border-radius: var(--vbg-radius-small);
  cursor: pointer;
}
.vbg-menu-item:hover, .vbg-menu-item:focus-visible { background: var(--vbg-surface-secondary); }
.vbg-menu-prefix { display: inline-grid; place-items: center; color: var(--vbg-text-secondary); }
.vbg-menu-suffix { margin-left: auto; display: inline-grid; place-items: center; visibility: hidden; }
.vbg-menu-item[aria-checked="true"] { font-weight: var(--vbg-weight-medium); }
.vbg-menu-item[aria-checked="true"] .vbg-menu-suffix { visibility: visible; }
.vbg-menu-divider { height: 1px; margin: var(--vbg-space-1) 0; background: var(--vbg-border-subtle); }
.vbg-menu-section { padding: var(--vbg-space-2) var(--vbg-space-2) var(--vbg-space-1); }
.vbg-menu-label {
  display: block;
  font-size: var(--vbg-type-metadata); font-weight: var(--vbg-weight-semibold);
  text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--vbg-text-secondary);
}
.vbg-menu-stepper {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--vbg-space-2); margin-top: var(--vbg-space-2);
  border: 1px solid var(--vbg-border-default); border-radius: var(--vbg-radius-small);
  padding: 2px;
}
.vbg-stepper-button {
  display: grid; place-items: center;
  width: 26px; height: 22px; padding: 0;
  color: var(--vbg-text-primary); background: none;
  border: none; border-radius: var(--vbg-radius-small); cursor: pointer;
}
.vbg-stepper-button:hover { background: var(--vbg-surface-secondary); }
.vbg-stepper-value { font-size: var(--vbg-type-metadata); color: var(--vbg-text-secondary); }
/* A non-color cue accompanies the tone, per the system's accessibility rule. */
.vbg-status[data-tone="error"]::before { content: "! "; font-weight: var(--vbg-weight-semibold); }

/* Article --------------------------------------------------------------- */

.vbg-report { max-width: 1100px; margin: 0 auto; padding: 0 var(--vbg-space-6) var(--vbg-space-16); }
.vbg-article { max-width: var(--vbg-measure); margin: 0 auto; }

.vbg-opening { padding: var(--vbg-space-12) 0 var(--vbg-space-5); }
.vbg-page-title {
  margin: 0 0 var(--vbg-space-4);
  font-size: var(--vbg-type-page-title);
  line-height: var(--vbg-leading-page-title);
  font-weight: var(--vbg-weight-heading);
  letter-spacing: -0.03em;
  text-wrap: balance;
}
.vbg-document-meta {
  margin: 0; display: flex; flex-wrap: wrap; gap: var(--vbg-space-3);
  font-size: var(--vbg-type-label); color: var(--vbg-text-secondary);
  line-height: var(--vbg-leading-caption);
}
.vbg-meta-item { display: inline-flex; align-items: center; }
.vbg-meta-item + .vbg-meta-item::before {
  content: ""; width: 3px; height: 3px; border-radius: 50%;
  background: var(--vbg-border-strong); margin-right: var(--vbg-space-3);
}

.vbg-toc {
  border-bottom: 1px solid var(--vbg-border-subtle);
  padding-bottom: var(--vbg-space-5);
  margin-bottom: var(--vbg-space-8);
}
.vbg-label {
  margin: 0 0 var(--vbg-space-3);
  font-size: var(--vbg-type-metadata); font-weight: var(--vbg-weight-semibold);
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--vbg-text-secondary);
}
.vbg-toc-list { margin: 0; padding: 0; list-style: none; counter-reset: toc; }
.vbg-toc-list li { font-size: var(--vbg-type-compact); line-height: var(--vbg-leading-compact); }
.vbg-toc-list li[data-level="3"] { padding-left: var(--vbg-space-4); }
.vbg-toc-list li[data-level="4"] { padding-left: var(--vbg-space-7); }
.vbg-toc-list a { color: var(--vbg-text-secondary); text-decoration: none; }
.vbg-toc-list a:hover { color: var(--vbg-text-primary); text-decoration: underline; }

.vbg-flow > * { margin: 0 0 var(--vbg-space-6); }
.vbg-flow > h2, .vbg-flow > h3, .vbg-flow > h4 { margin-top: var(--vbg-space-10); }
.vbg-flow > h2:first-child, .vbg-flow > h3:first-child { margin-top: 0; }

.vbg-flow h2 {
  font-size: var(--vbg-type-section); line-height: var(--vbg-leading-section);
  font-weight: var(--vbg-weight-heading); letter-spacing: -0.02em;
  margin-bottom: var(--vbg-space-4);
}
.vbg-flow h3 {
  font-size: var(--vbg-type-subsection); line-height: var(--vbg-leading-subsection);
  font-weight: var(--vbg-weight-heading); letter-spacing: -0.01em;
  margin-bottom: var(--vbg-space-3);
}
.vbg-flow h4 {
  font-size: var(--vbg-type-body); line-height: var(--vbg-leading-subsection);
  font-weight: var(--vbg-weight-semibold);
  margin-bottom: var(--vbg-space-3);
}
.vbg-flow p { margin-bottom: var(--vbg-space-6); }
.vbg-flow a { color: var(--vbg-text-primary); text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; text-decoration-color: var(--vbg-border-strong); }
.vbg-flow a:hover { text-decoration-color: currentColor; }

.vbg-flow ul, .vbg-flow ol { padding-left: var(--vbg-space-6); }
.vbg-flow li { margin-bottom: var(--vbg-space-2); }
.vbg-flow li::marker { color: var(--vbg-text-secondary); }

.vbg-flow blockquote {
  margin-left: 0; margin-right: 0;
  padding-left: var(--vbg-space-5);
  border-left: 2px solid var(--vbg-border-strong);
  color: var(--vbg-text-secondary);
}
.vbg-flow blockquote p:last-child { margin-bottom: 0; }

.vbg-flow pre {
  background: var(--vbg-surface-secondary);
  border: 1px solid var(--vbg-border-subtle);
  border-radius: var(--vbg-radius);
  padding: var(--vbg-space-4);
  overflow-x: auto;
  font-size: var(--vbg-type-compact);
  line-height: var(--vbg-leading-compact);
}
.vbg-flow pre code { background: none; border: none; padding: 0; font-size: inherit; }
.vbg-mono { font-family: var(--vbg-font-mono); font-feature-settings: "liga" 0; }
.vbg-flow code {
  font-family: var(--vbg-font-mono);
  font-size: 0.875em;
  background: var(--vbg-surface-secondary);
  border: 1px solid var(--vbg-border-subtle);
  border-radius: var(--vbg-radius-small);
  padding: 0.1em 0.35em;
}

.vbg-flow figure { margin: var(--vbg-space-8) 0; }
.vbg-flow img { max-width: 100%; height: auto; display: block; border-radius: var(--vbg-radius); }
.vbg-caption {
  margin-top: var(--vbg-space-3);
  font-size: var(--vbg-type-metadata); line-height: var(--vbg-leading-caption);
  color: var(--vbg-text-secondary);
}
.vbg-flow hr { border: none; border-top: 1px solid var(--vbg-border-subtle); margin: var(--vbg-space-9) 0; }

.vbg-footer {
  max-width: var(--vbg-measure); margin: var(--vbg-space-12) auto 0;
  padding-top: var(--vbg-space-5);
  border-top: 1px solid var(--vbg-border-subtle);
}
.vbg-meta { margin: 0; font-size: var(--vbg-type-metadata); color: var(--vbg-text-secondary); word-break: break-all; }
.vbg-meta a { color: inherit; }

@media (max-width: 720px) {
  .vbg-header-inner { padding: var(--vbg-space-3) var(--vbg-space-4); gap: var(--vbg-space-3); }
  .vbg-listen { display: none; }
  .vbg-controls-divider { display: none; }
  .vbg-report { padding: 0 var(--vbg-space-4) var(--vbg-space-12); }
  .vbg-opening { padding-top: var(--vbg-space-8); }
}

/* The system defaults to stillness; motion is reserved for state changes. */
@media (prefers-reduced-motion: no-preference) {
  .vbg-progress > span { transition: width 90ms linear; }
}
`;
