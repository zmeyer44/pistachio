/**
 * The welcome pages themselves: the documents a first run opens once the
 * walkthrough is done (`WELCOME_TABS`, ./onboarding.ts).
 *
 * Pure on purpose. The desktop serves these from its `pistachio://` protocol
 * handler (apps/desktop/src/main/welcome-pages.ts), reading the font off disk
 * and the videos out of the welcome assets directory; the cloud-browser host
 * has no protocol to serve anything from and renders the same documents into
 * `data:` tabs (docs/web-browser-design.md §14). Everything below is HTML in,
 * HTML out — no fs, no protocol, no Electron — so both hosts draw the same
 * pages from the same source.
 *
 * What the two hosts differ in is three parameters:
 *
 * - `linkBase` — what a lesson link points at. The default is the
 *   `pistachio://` addresses `WELCOME_TABS` declares, which is what the
 *   desktop serves and what the host's welcome tabs display.
 * - `assetBase` — where a relative asset reference (a locally dropped video)
 *   resolves. `null` means nothing local can be served, and such a video
 *   falls back to the "coming soon" card rather than a broken player.
 * - `fontSrc` — the `@font-face` source. `null` draws the pages in a system
 *   font stack and emits no `@font-face` at all, which is the honest answer
 *   where there is no protocol to serve a woff2 from.
 *
 * VIDEOS. Each page keeps a slot for a walkthrough video. `WELCOME_VIDEOS`
 * names each one's source; null draws the "coming soon" card. Sources are
 * the landing page's clips on www.pistachio.run (the page CSP admits https:
 * media and images); a bare file name resolves against `assetBase`.
 */

import { appearanceGradient, DEFAULT_APPEARANCE, type AppearanceSettings } from "./appearance.js";
import { WELCOME_TABS, type WelcomeTab } from "./onboarding.js";
import { shortcutLabel, type ShortcutActionId, type ShortcutPlatform, type ShortcutSettings } from "./shortcuts.js";

/* ------------------------------ the context ------------------------------ */

/** The scheme every welcome address is declared under (`WELCOME_TABS`). */
export const WELCOME_SCHEME = "pistachio://";

/** Where the desktop serves `assets/<file>` from. */
export const DESKTOP_WELCOME_ASSET_BASE = "pistachio://welcome/assets/";

/** The renderer's own face, as the desktop's protocol handler serves it. */
export const DESKTOP_WELCOME_FONT_SRC = "pistachio://welcome/assets/geist.woff2";

/**
 * What a welcome page needs to know about the person and the surface it is
 * drawn on. The first five fields are the same on both hosts; the last three
 * are what the host serving the page can and cannot offer.
 */
export interface WelcomePageContext {
  /** The person's name from memory, or "" for a neutral greeting. */
  name: string;
  appearance: AppearanceSettings;
  shortcuts: ShortcutSettings;
  platform: ShortcutPlatform;
  /** Whether the OS is in dark mode right now, for `scheme: "system"`. */
  systemDark: boolean;
  /** Prefix the lesson links are built on; the `pistachio://` addresses by default. */
  linkBase?: string;
  /** Where a relative asset reference resolves, or null when none can be served. */
  assetBase?: string | null;
  /** The `@font-face` source, or null for a system font stack and no `@font-face`. */
  fontSrc?: string | null;
}

interface Resolved {
  context: WelcomePageContext;
  linkBase: string;
  assetBase: string | null;
  fontSrc: string | null;
}

function resolve(context: WelcomePageContext): Resolved {
  return {
    context,
    linkBase: context.linkBase ?? WELCOME_SCHEME,
    assetBase: context.assetBase === undefined ? DESKTOP_WELCOME_ASSET_BASE : context.assetBase,
    fontSrc: context.fontSrc === undefined ? DESKTOP_WELCOME_FONT_SRC : context.fontSrc,
  };
}

/**
 * The address a welcome tab's link carries under `linkBase`. The tabs declare
 * `pistachio://welcome/` and `pistachio://learn/<lesson>`; a host that serves
 * them from somewhere else passes its own base and gets the same paths under
 * it.
 */
export function welcomeLink(tab: WelcomeTab, linkBase: string = WELCOME_SCHEME): string {
  return `${linkBase}${tab.url.slice(WELCOME_SCHEME.length)}`;
}

/** The welcome tab an address names, or null when it names none of them. */
export function welcomeTabFor(url: string, linkBase: string = WELCOME_SCHEME): WelcomeTab | null {
  const trimmed = url.trim();
  return (
    WELCOME_TABS.find((tab) => {
      const link = welcomeLink(tab, linkBase);
      // `pistachio://welcome/` is also written `pistachio://welcome` by hand.
      return trimmed === link || (link.endsWith("/") && trimmed === link.slice(0, -1));
    }) ?? null
  );
}

/* -------------------------------- videos -------------------------------- */

export interface WelcomeVideo {
  /** A URL a tab may load — hosted (`https://www.pistachio.run/video/…`), or a file name resolved against `assetBase` — or null for the placeholder. */
  src: string | null;
  poster: string | null;
  /** Read out under the video (or the placeholder) so the slot says what it shows. */
  caption: string;
}

/** The landing page's clips, which the site serves at these same paths. */
const hosted = (path: string): string => `https://www.pistachio.run${path}`;

export const WELCOME_VIDEOS: Record<WelcomeTab["id"], WelcomeVideo> = {
  overview: {
    src: hosted("/video/usecase-appearance.mp4"),
    poster: hosted("/img/usecase-appearance.jpg"),
    caption: "Two layouts, and the window's look made yours",
  },
  agent: {
    src: hosted("/video/feature-agent.mp4"),
    poster: hosted("/img/feature-agent.jpg"),
    caption: "Handing a task to the agent, start to finish",
  },
  spaces: {
    src: hosted("/video/feature-split.mp4"),
    poster: hosted("/img/feature-split.jpg"),
    caption: "Splitting the page into panes",
  },
  memory: { src: null, poster: null, caption: "Memory and reminders in practice" },
};

/** An absolute source stays as it is; a bare file name resolves against `assetBase`. */
function asset(value: string | null, assetBase: string | null): string | null {
  if (value === null) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("//")) return value;
  return assetBase === null ? null : `${assetBase}${value}`;
}

/* -------------------------------- content ------------------------------- */

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function key(context: WelcomePageContext, id: ShortcutActionId): string {
  const label = shortcutLabel(context.shortcuts[id], context.platform);
  return label === null ? "" : `<kbd>${escape(label)}</kbd>`;
}

interface Step {
  title: string;
  body: string;
}

export interface WelcomeLesson {
  tab: WelcomeTab;
  eyebrow: string;
  lede: string;
  steps: Step[];
  /** A concrete first thing to do, shown as the page's callout. */
  tryIt: string;
}

/** The three lessons, with this person's own shortcut bindings written in. */
export function welcomeLessons(context: WelcomePageContext): WelcomeLesson[] {
  const k = (id: ShortcutActionId): string => key(context, id);
  const tabs = Object.fromEntries(WELCOME_TABS.map((tab) => [tab.id, tab])) as Record<WelcomeTab["id"], WelcomeTab>;
  return [
    {
      tab: tabs.agent,
      eyebrow: "Lesson 1",
      lede: "Pistachio's agent works inside the tabs you are already signed in to. You say what you want; it clicks, types, reads, and moves between pages — and stops before anything that matters.",
      steps: [
        {
          title: `Open the chat with ${k("toggleConsole")}`,
          body: `The agent lives in the panel on the right. On any page, ${k("delegate")} opens it with that tab already in hand.`,
        },
        {
          title: "Ask in plain words",
          body: "“Find the three cheapest flights on this page and put them in a table.” “Reply to the top email saying I'll be late.” No commands to learn.",
        },
        {
          title: "Watch it work in your tab",
          body: "Every click, page, and specialist it brings in is listed as it goes, and a ring runs around the page while it drives. Interrupt any time by typing.",
        },
        {
          title: "It pauses before anything that changes the world",
          body: "A submit, a purchase, a message sent — the run stops with a card that says exactly what it is about to do. Approve it, reject it, or take over with your own hands and hand back when you are done.",
        },
        {
          title: `Replay what happened with ${k("toggleEvidence")}`,
          body: "Every action is signed into an activity record you can read back, so a task is never a black box.",
        },
      ],
      tryIt: `Open the chat (${k("toggleConsole")}) and ask: “Summarize this page in three bullets.”`,
    },
    {
      tab: tabs.spaces,
      eyebrow: "Lesson 2",
      lede: "The sidebar is where your browsing lives: apps at the top, pages you keep in the middle, today's tabs below — and a Space for each side of your life.",
      steps: [
        {
          title: "Favorites sit at the top",
          body: "The apps you just picked are the grid under the address bar — one click, always the same tab. Drag any tab up there to add another.",
        },
        {
          title: `Pin a page with ${k("togglePin")}`,
          body: "A pin stays above the day's tabs even after you close its page; click it to come back. Folders group pins — right-click a pin to make one.",
        },
        {
          title: `Split the page with ${k("toggleSplit")}`,
          body: "Or drag a tab onto the page's edge. Up to four panes, resizable, remembered together as a group.",
        },
        {
          title: "Glance before you commit",
          body: "Hold ⌘ and click a link: it opens as a preview floating above the page. Esc sends it back; the arrow makes it a tab.",
        },
        {
          title: `Fork a Space with ${k("forkSpace")}`,
          body: "Each Space is its own cookie jar and its own shelf — work and personal, a client and your own. A fork copies what you choose and then goes its own way. The Space menu is at the sidebar's bottom-right.",
        },
      ],
      tryIt: `Press ${k("toggleSplit")} on this page, then drag one of your favorites into the second pane.`,
    },
    {
      tab: tabs.memory,
      eyebrow: "Lesson 3",
      lede: "What you told Pistachio a moment ago is already its memory of you. It grows as you work together, and it is yours to read, correct, and erase.",
      steps: [
        {
          title: `See what it knows in Settings → Memory (${k("openSettings")})`,
          body: "Your name and bio from setup are there, as facts the agent can update. Everything it learns later is versioned rather than overwritten, and what it is not sure of waits for your yes or no.",
        },
        {
          title: "Tell it things as they come up",
          body: "“Remember that I prefer window seats.” “Forget my old address.” The agent keeps and drops facts from conversation, and says so.",
        },
        {
          title: `Set a reminder in the chat, see them all with ${k("openReminders")}`,
          body: "“Remind me at 5 to send the invoice.” “Every Monday at 9, summarize my week.” A reminder can be a message or a task the agent runs on its own; the calendar shows what fired and what is next.",
        },
        {
          title: "It stays on this Mac",
          body: "Memory is one local file. Nothing leaves the machine unless a model call needs it, and a switch in Settings turns memory off entirely.",
        },
      ],
      tryIt: "Open the chat and say: “Remind me in 10 minutes to try split view.”",
    },
  ];
}

/* --------------------------------- pages -------------------------------- */

/** The document a welcome address renders to, whichever of the four it is. */
export function welcomeDocumentHtml(id: WelcomeTab["id"], context: WelcomePageContext): string {
  const tab = WELCOME_TABS.find((candidate) => candidate.id === id) ?? WELCOME_TABS[0]!;
  return tab.id === "overview" ? welcomeOverviewHtml(context) : welcomeLessonHtml(tab, context);
}

export function welcomeOverviewHtml(context: WelcomePageContext): string {
  const resolved = resolve(context);
  const overview = WELCOME_TABS[0]!;
  const greeting = context.name === "" ? "Let's settle in." : `Let's settle in, ${escape(context.name.split(/\s+/)[0] ?? context.name)}.`;
  const items = welcomeLessons(context)
    .map(
      (lesson, index) => `
      <li class="basic${index === 0 ? " open" : ""}">
        <a href="${escape(welcomeLink(lesson.tab, resolved.linkBase))}">
          <span class="num">${String(index + 1)}</span>
          <span class="text">
            <span class="title">${escape(lesson.tab.title)}</span>
            <span class="blurb">${escape(lesson.tab.blurb)}</span>
          </span>
          <span class="go" aria-hidden="true">→</span>
        </a>
      </li>`,
    )
    .join("");
  const shortcuts: Array<[ShortcutActionId, string]> = [
    ["newTab", "New tab"],
    ["editAddress", "Go to an address"],
    ["delegate", "Ask about this tab"],
    ["toggleConsole", "Agent chat"],
    ["toggleSplit", "Split view"],
    ["togglePin", "Pin tab"],
    ["openReminders", "Reminders"],
    ["openSettings", "Settings"],
  ];
  const rows = shortcuts
    .filter(([id]) => key(context, id) !== "")
    .map(([id, label]) => `<li><span>${escape(label)}</span>${key(context, id)}</li>`)
    .join("");
  return welcomePage(context, {
    title: overview.title,
    body: `
    <header class="top">
      ${brand(resolved.linkBase)}
      <nav class="pills">
        <a class="pill" href="#shortcuts">${ICONS.keyboard} Essential shortcuts</a>
        <a class="pill" href="${escape(welcomeLink(WELCOME_TABS[1]!, resolved.linkBase))}">${ICONS.help} Lessons</a>
      </nav>
    </header>
    <main class="hero">
      <section class="intro">
        <div class="mark" aria-hidden="true">${ICONS.mark}</div>
        <h1>${greeting}<br>Here are the basics.</h1>
        <p class="lede">Three short lessons, one per tab. Skim them now or come back later — this page is always at <code>pistachio://welcome</code>.</p>
        <ol class="basics">${items}</ol>
      </section>
      <aside class="stage">
        ${video(WELCOME_VIDEOS.overview, "The tour", resolved.assetBase)}
        <ul id="shortcuts" class="keys">${rows}</ul>
      </aside>
    </main>
    <footer class="foot">
      <span>Replay setup from Settings → About whenever you like.</span>
      <a href="${escape(welcomeLink(WELCOME_TABS[1]!, resolved.linkBase))}">Start with lesson 1 →</a>
    </footer>`,
  });
}

export function welcomeLessonHtml(tab: WelcomeTab, context: WelcomePageContext): string {
  const resolved = resolve(context);
  const all = welcomeLessons(context);
  const index = all.findIndex((lesson) => lesson.tab.id === tab.id);
  const lesson = all[index]!;
  const previous = index > 0 ? all[index - 1]!.tab : WELCOME_TABS[0]!;
  const next = all[index + 1]?.tab ?? null;
  const steps = lesson.steps
    .map(
      (step, at) => `
      <li>
        <span class="num">${String(at + 1)}</span>
        <div><h3>${step.title}</h3><p>${step.body}</p></div>
      </li>`,
    )
    .join("");
  const crumbs = all
    .map(
      (candidate) =>
        `<a class="crumb${candidate.tab.id === tab.id ? " here" : ""}" href="${escape(welcomeLink(candidate.tab, resolved.linkBase))}">${escape(candidate.eyebrow)}</a>`,
    )
    .join("");
  return welcomePage(context, {
    title: tab.title,
    body: `
    <header class="top">
      <a class="back" href="${escape(welcomeLink(WELCOME_TABS[0]!, resolved.linkBase))}">${ICONS.back} Welcome</a>
      <nav class="crumbs">${crumbs}</nav>
    </header>
    <main class="lesson">
      <section class="intro">
        <p class="eyebrow">${escape(lesson.eyebrow)}</p>
        <h1>${escape(tab.title)}</h1>
        <p class="lede">${lesson.lede}</p>
        <ol class="steps">${steps}</ol>
        <div class="try"><span class="try-label">Try it now</span><p>${lesson.tryIt}</p></div>
      </section>
      <aside class="stage">${video(WELCOME_VIDEOS[tab.id], tab.title, resolved.assetBase)}</aside>
    </main>
    <footer class="foot">
      <a href="${escape(welcomeLink(previous, resolved.linkBase))}">← ${escape(previous.title)}</a>
      ${next === null ? `<a href="${escape(welcomeLink(WELCOME_TABS[0]!, resolved.linkBase))}">Back to the start →</a>` : `<a href="${escape(welcomeLink(next, resolved.linkBase))}">${escape(next.title)} →</a>`}
    </footer>`,
  });
}

function video(source: WelcomeVideo, label: string, assetBase: string | null): string {
  const src = asset(source.src, assetBase);
  const poster = asset(source.poster, assetBase);
  if (src !== null) {
    return `
    <figure class="video">
      <video controls playsinline preload="metadata" src="${escape(src)}"${poster === null ? "" : ` poster="${escape(poster)}"`} aria-label="${escape(label)}"></video>
      <figcaption>${escape(source.caption)}</figcaption>
    </figure>`;
  }
  return `
    <figure class="video placeholder" data-testid="welcome-video-slot">
      <div class="screen">
        <span class="play" aria-hidden="true">${ICONS.play}</span>
        <span class="soon">Video coming soon</span>
      </div>
      <figcaption>${escape(source.caption)}</figcaption>
    </figure>`;
}

function brand(linkBase: string): string {
  return `<a class="brand" href="${escape(welcomeLink(WELCOME_TABS[0]!, linkBase))}"><span class="brand-mark" aria-hidden="true">${ICONS.brand}</span>Pistachio</a>`;
}

const ICONS = {
  brand: `<svg viewBox="0 0 48 48" width="24" height="24" fill="none"><rect width="48" height="48" rx="14" fill="#52a862"/><path d="M115.10 51.50A13.5 13.5 0 0 1 115.10 65.00L93.40 102.60A13.5 13.5 0 0 1 81.71 109.35L38.29 109.35A13.5 13.5 0 0 1 26.60 102.60L4.90 65.00A13.5 13.5 0 0 1 4.90 51.50L27.47 12.40A3.5 3.5 0 0 1 33.53 12.40L56.54 52.25A4 4 0 0 0 63.46 52.25L86.47 12.40A3.5 3.5 0 0 1 92.53 12.40Z" transform="translate(9.6 9.6) scale(0.24)" fill="#fff"/></svg>`,
  mark: `<svg viewBox="0 0 48 48" width="56" height="56" fill="none"><rect width="48" height="48" rx="14" fill="var(--accent)"/><path d="M115.10 51.50A13.5 13.5 0 0 1 115.10 65.00L93.40 102.60A13.5 13.5 0 0 1 81.71 109.35L38.29 109.35A13.5 13.5 0 0 1 26.60 102.60L4.90 65.00A13.5 13.5 0 0 1 4.90 51.50L27.47 12.40A3.5 3.5 0 0 1 33.53 12.40L56.54 52.25A4 4 0 0 0 63.46 52.25L86.47 12.40A3.5 3.5 0 0 1 92.53 12.40Z" transform="translate(9.6 9.6) scale(0.24)" fill="#fff"/></svg>`,
  keyboard: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/></svg>`,
  help: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/></svg>`,
  back: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>`,
};

/* --------------------------------- shell -------------------------------- */

/** Light and dark, from the same appearance: the window's own palette. */
export function welcomePalette(appearance: AppearanceSettings, dark: boolean): string {
  const [accent = DEFAULT_APPEARANCE.colors[0]!, second = accent, third = second] = appearance.colors;
  const gradient = appearanceGradient(appearance, dark ? 0.9 : 1);
  return `
    --accent: ${accent}; --accent-2: ${second}; --accent-3: ${third};
    --gradient: ${gradient};
    --bg: ${dark ? "#191b1d" : "#f7f8f5"};
    --card: ${dark ? "rgb(36 38 41 / 0.92)" : "rgb(255 255 255 / 0.92)"};
    --ink: ${dark ? "#f2f2f0" : "#1d1f1c"};
    --muted: ${dark ? "#a6a9a2" : "#5f645c"};
    --faint: ${dark ? "#6e726c" : "#9a9f95"};
    --line: ${dark ? "rgb(255 255 255 / 0.1)" : "rgb(0 0 0 / 0.08)"};
    --fill: ${dark ? "rgb(255 255 255 / 0.06)" : "rgb(0 0 0 / 0.04)"};
    --kbd: ${dark ? "rgb(255 255 255 / 0.08)" : "#fff"};
    --shadow: ${dark ? "0 0 0 1px rgb(255 255 255 / 0.08), 0 20px 50px rgb(0 0 0 / 0.45)" : "0 0 0 1px rgb(0 0 0 / 0.06), 0 20px 50px rgb(20 30 20 / 0.12)"};
    color-scheme: ${dark ? "dark" : "light"};`;
}

/** The page shell every welcome document is drawn in: head, theme, and CSS. */
export function welcomePage(context: WelcomePageContext, options: { title: string; body: string }): string {
  const { fontSrc } = resolve(context);
  const scheme = context.appearance.scheme;
  const dark = scheme === "dark" || (scheme === "system" && context.systemDark);
  const radius = Math.max(8, context.appearance.radius + 4);
  const themeCss =
    scheme === "system"
      ? `:root { ${welcomePalette(context.appearance, false)} }
         @media (prefers-color-scheme: dark) { :root { ${welcomePalette(context.appearance, true)} } }`
      : `:root { ${welcomePalette(context.appearance, dark)} }`;
  // With no font to serve there is no `@font-face` and no family that only
  // resolves where one was installed: the pages fall back to the reader's own
  // system stack rather than naming a face the browser will never find.
  const face =
    fontSrc === null
      ? ""
      : `@font-face { font-family: "Geist Welcome"; src: url("${fontSrc}") format("woff2"); font-weight: 100 900; font-display: swap; }
      `;
  const family = fontSrc === null ? `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` : `"Geist Welcome", "Geist Variable", Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' pistachio:; img-src 'self' pistachio: data: https:; media-src 'self' pistachio: https:; font-src 'self' pistachio:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%2352a862'/%3E%3Cpath d='M115.10 51.50A13.5 13.5 0 0 1 115.10 65.00L93.40 102.60A13.5 13.5 0 0 1 81.71 109.35L38.29 109.35A13.5 13.5 0 0 1 26.60 102.60L4.90 65.00A13.5 13.5 0 0 1 4.90 51.50L27.47 12.40A3.5 3.5 0 0 1 33.53 12.40L56.54 52.25A4 4 0 0 0 63.46 52.25L86.47 12.40A3.5 3.5 0 0 1 92.53 12.40Z' transform='translate(12.8 12.8) scale(0.32)' fill='white'/%3E%3C/svg%3E" />
    <title>${escape(options.title)}</title>
    <style>
      ${face}${themeCss}
      :root { --radius: ${String(radius)}px; --texture: ${String(context.appearance.texture * 0.14)}; }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; }
      body {
        color: var(--ink); background-color: var(--bg); background-image: var(--gradient); background-attachment: fixed;
        font: 15px/1.55 ${family};
        -webkit-font-smoothing: antialiased; font-feature-settings: "cv11", "ss01";
      }
      body::after {
        content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none; opacity: var(--texture); mix-blend-mode: soft-light;
        background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.72'/%3E%3C/svg%3E");
        background-size: 180px 180px;
      }
      a { color: inherit; text-decoration: none; }
      code { font: 12.5px ui-monospace, "Geist Mono", SFMono-Regular, Menlo, monospace; padding: 1px 6px; border-radius: 6px; background: var(--fill); }
      kbd {
        display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 6px; margin: 0 1px;
        border-radius: 6px; background: var(--kbd); box-shadow: 0 0 0 1px var(--line), 0 1px 0 var(--line); color: var(--ink);
        font: 600 11.5px/1 inherit; letter-spacing: 0.02em; vertical-align: -3px;
      }
      .wrap { position: relative; z-index: 1; max-width: 1180px; margin: 0 auto; padding: 28px 40px 56px; }
      .top { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 44px; }
      .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 600; letter-spacing: -0.01em; }
      .brand-mark { display: block; width: 24px; height: 24px; }
      .brand-mark svg { display: block; }
      .pills, .crumbs { display: flex; gap: 8px; flex-wrap: wrap; }
      .pill, .crumb, .back {
        display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 13px; border-radius: 999px;
        background: var(--card); box-shadow: 0 0 0 1px var(--line); color: var(--ink); font-size: 13px; font-weight: 500;
        transition: transform 120ms ease, box-shadow 120ms ease;
      }
      .pill:hover, .crumb:hover, .back:hover { transform: translateY(-1px); box-shadow: 0 0 0 1px var(--line), 0 6px 16px rgb(0 0 0 / 0.08); }
      .crumb.here { background: var(--ink); color: var(--bg); box-shadow: none; }
      .hero, .lesson { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(320px, 0.95fr); gap: 48px; align-items: start; }
      .mark { margin-bottom: 22px; }
      .mark svg { display: block; filter: drop-shadow(0 8px 18px color-mix(in srgb, var(--accent) 45%, transparent)); }
      h1 { margin: 0 0 14px; font-size: clamp(30px, 3.6vw, 44px); line-height: 1.08; font-weight: 700; letter-spacing: -0.035em; }
      .eyebrow { margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: color-mix(in srgb, var(--accent) 70%, var(--ink)); }
      .lede { margin: 0 0 30px; max-width: 54ch; font-size: 16px; color: var(--muted); }
      .basics { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; max-width: 600px; }
      .basic a {
        display: grid; grid-template-columns: 30px 1fr auto; align-items: center; gap: 16px; padding: 16px 18px;
        border-radius: var(--radius); background: var(--card); box-shadow: 0 0 0 1px var(--line);
        transition: transform 140ms ease, box-shadow 140ms ease;
      }
      .basic a:hover { transform: translateY(-2px); box-shadow: var(--shadow); }
      .basic .num { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 999px; background: var(--fill); color: var(--muted); font-size: 12.5px; font-weight: 600; }
      .basic.open .num { background: var(--accent); color: #fff; }
      .basic .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .basic .title { font-size: 17px; font-weight: 600; letter-spacing: -0.015em; }
      .basic .blurb { font-size: 13.5px; color: var(--muted); }
      .basic .go { color: var(--faint); font-size: 18px; transition: transform 140ms ease, color 140ms ease; }
      .basic a:hover .go { transform: translateX(3px); color: var(--ink); }
      .stage { position: sticky; top: 28px; display: flex; flex-direction: column; gap: 18px; }
      .video { margin: 0; border-radius: calc(var(--radius) + 4px); background: var(--card); box-shadow: var(--shadow); overflow: hidden; }
      .video video { display: block; width: 100%; aspect-ratio: 16 / 10; background: #000; }
      .video .screen {
        position: relative; display: grid; place-content: center; justify-items: center; gap: 12px; aspect-ratio: 16 / 10;
        background:
          radial-gradient(circle at 80% 15%, color-mix(in srgb, var(--accent-3) 55%, transparent), transparent 40%),
          radial-gradient(circle at 15% 85%, color-mix(in srgb, var(--accent-2) 55%, transparent), transparent 42%),
          linear-gradient(150deg, color-mix(in srgb, var(--accent) 30%, var(--bg)), var(--bg));
      }
      .video .play {
        display: grid; width: 64px; height: 64px; place-items: center; border-radius: 999px; color: var(--ink);
        background: var(--card); box-shadow: var(--shadow);
      }
      .video .soon { font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
      .video figcaption { padding: 12px 16px; font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); }
      .keys { list-style: none; margin: 0; padding: 6px 0; border-radius: var(--radius); background: var(--card); box-shadow: 0 0 0 1px var(--line); display: grid; grid-template-columns: 1fr 1fr; }
      .keys li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 16px; font-size: 13px; color: var(--muted); }
      .keys li:nth-child(odd) { border-right: 1px solid var(--line); }
      .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .steps li { display: grid; grid-template-columns: 28px 1fr; gap: 14px; padding: 14px 16px; border-radius: var(--radius); background: var(--card); box-shadow: 0 0 0 1px var(--line); }
      .steps .num { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 999px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 700; }
      .steps h3 { margin: 2px 0 4px; font-size: 15.5px; font-weight: 600; letter-spacing: -0.01em; }
      .steps p { margin: 0; font-size: 14px; color: var(--muted); }
      .try { margin-top: 22px; padding: 16px 18px; border-radius: var(--radius); background: color-mix(in srgb, var(--accent) 16%, var(--card)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 40%, var(--line)); }
      .try-label { display: block; margin-bottom: 4px; font-size: 11.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: color-mix(in srgb, var(--accent) 65%, var(--ink)); }
      .try p { margin: 0; font-size: 15px; font-weight: 500; }
      .foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
      .foot a { font-weight: 600; color: var(--ink); }
      @media (max-width: 860px) { .hero, .lesson { grid-template-columns: 1fr; } .stage { position: static; } .wrap { padding: 20px 22px 40px; } }
      @media (prefers-reduced-motion: reduce) { .basic a, .pill, .crumb, .back, .basic .go { transition: none; } }
    </style>
  </head>
  <body>
    <div class="wrap">${options.body}</div>
    <script>
      // A video whose file is not there yet shows the placeholder instead of a broken player.
      for (const video of document.querySelectorAll("video")) {
        video.addEventListener("error", () => {
          const figure = video.closest("figure");
          if (figure === null) return;
          figure.classList.add("placeholder");
          video.replaceWith(Object.assign(document.createElement("div"), { className: "screen", innerHTML: '<span class="play" aria-hidden="true">${ICONS.play.replace(/'/g, "\\'")}</span><span class="soon">Video coming soon</span>' }));
        });
      }
    </script>
  </body>
</html>`;
}
