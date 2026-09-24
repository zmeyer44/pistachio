/**
 * The world the hero's browser lives in.
 *
 * Nothing in the hero loads a real page: a landing page cannot frame the web
 * (every site below refuses to be framed), and the point of the demo is the
 * chrome, not the sites. So every address the seeded tabs and favorites point
 * at is a real site described here — its title, its own icon (shipped in
 * public/img/favicons, taken from the site) and which sketch paints its pane
 * (./pages.tsx). Anything typed that is not in the catalog still "loads": it
 * gets a title from its hostname and the generic page, so the address bar
 * always does something.
 */

export type MockPage =
  | "x"
  | "youtube"
  | "google"
  | "google-calendar"
  | "chatgpt"
  | "claude"
  | "wikipedia"
  | "github"
  | "article"
  | "reader"
  | "read-aloud"
  | "generic";

export interface SiteInfo {
  url: string;
  title: string;
  faviconUrl: string;
  page: MockPage;
  /** The tone the page's chrome is drawn in, as a CSS colour. */
  accent: string;
}

/** A rounded square with one letter, the way a site with no icon gets one. */
export function letterMark(letter: string, bg: string, fg = "#fff"): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>` +
    `<rect width='64' height='64' rx='16' fill='${bg}'/>` +
    `<text x='32' y='42' text-anchor='middle' font-family='-apple-system,Inter,Helvetica,Arial,sans-serif' font-weight='700' font-size='32' fill='${fg}'>${letter}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const icon = (name: string): string => `/img/favicons/${name}.png`;

/** The videos the YouTube sketch lists; the first is the seeded tab's. */
export const VIDEOS: Array<{ id: string; title: string; channel: string; views: string; age: string; length: string; tone: string; thumbnail: string; description?: string; tags?: string }> = [
  { id: "PFDu9oVAE-g", title: "Eigenvectors and eigenvalues | Chapter 14, Essence of linear algebra", channel: "3Blue1Brown", views: "6.3M views", age: "10 years ago", length: "17:15", tone: "#285b73", thumbnail: "/img/demo/3blue1brown-eigenvectors.webp", description: "A visual introduction to eigenvectors and eigenvalues, and how they reveal the geometry of a linear transformation. Chapter 14 of Essence of linear algebra.", tags: "#linearalgebra #eigenvectors #3Blue1Brown" },
  { id: "f6g7h8i9j0k", title: "Pistachio orchards from above — harvest season in 4K", channel: "Farm & Field", views: "1.2M views", age: "2 weeks ago", length: "12:07", tone: "#3f6b3a", thumbnail: "/img/demo/orchard-aerial.webp" },
  { id: "l1m2n3o4p5q", title: "Split panes, tab groups, and the end of tab hoarding", channel: "Tabless", views: "88K views", age: "1 day ago", length: "9:41", tone: "#7c2d12", thumbnail: "/img/demo/tab-groups.webp" },
  { id: "r6s7t8u9v0w", title: "Lo-fi beats for planning your quarter", channel: "Quiet Room", views: "6.8M views", age: "1 year ago", length: "2:01:33", tone: "#4c1d95", thumbnail: "/img/demo/lofi-room.webp" },
  { id: "x1y2z3a4b5c", title: "SFO to JFK in economy — is the 7am worth it?", channel: "Seat 32C", views: "230K views", age: "5 days ago", length: "14:58", tone: "#0e7490", thumbnail: "/img/demo/economy-flight.webp" },
  { id: "d6e7f8g9h0i", title: "How favicons work (and why yours is blurry)", channel: "Pixel Pushers", views: "51K views", age: "3 weeks ago", length: "7:12", tone: "#be123c", thumbnail: "/img/demo/favicons.webp" },
  { id: "j1k2l3m4n5o", title: "Salted vs. unsalted: a blind pistachio taste test", channel: "Snack Lab", views: "940K views", age: "1 month ago", length: "11:36", tone: "#a16207", thumbnail: "/img/demo/taste-test.webp" },
  { id: "p6q7r8s9t0u", title: "The keyboard shortcuts I actually use every day", channel: "Tabless", views: "310K views", age: "4 days ago", length: "8:05", tone: "#334155", thumbnail: "/img/demo/keyboard-shortcuts.webp" },
  { id: "v1w2x3y4z5a", title: "Building a tiny cabin in 30 days — full timelapse", channel: "Northwoods", views: "3.4M views", age: "8 months ago", length: "24:51", tone: "#57534e", thumbnail: "/img/demo/cabin-build.webp" },
  { id: "b6c7d8e9f0g", title: "Why every app is becoming a browser", channel: "Ada Builds", views: "205K views", age: "2 weeks ago", length: "16:20", tone: "#0f766e", thumbnail: "/img/demo/apps-browser.webp" },
  { id: "h1i2j3k4l5m", title: "Tokyo in the rain — 3 hour walking tour, no talking", channel: "Slow Cities", views: "12M views", age: "2 years ago", length: "3:04:12", tone: "#1e293b", thumbnail: "/img/demo/tokyo-rain.webp" },
  { id: "n6o7p8q9r0s", title: "I tried every note-taking app so you don't have to", channel: "Pixel Pushers", views: "780K views", age: "6 days ago", length: "21:47", tone: "#9333ea", thumbnail: "/img/demo/note-apps.webp" },
];

/** The video the seeded YouTube tab is on. */
export const YOUTUBE_WATCH_URL = `https://www.youtube.com/watch?v=${VIDEOS[0]!.id}`;

/**
 * The article the reader-view demo opens: an invented blog, so the words are
 * ours to write. The same text paints the page, its reader view and the
 * "Read aloud" clip, as the app renders all three from one article.
 */
export const ARTICLE = {
  url: "https://thegroveletter.com/p/why-pistachio-trees-take-turns",
  site: "The Grove Letter",
  title: "Why pistachio trees take turns",
  byline: "Noor Haddad",
  published: "Sep 18, 2026",
  minutes: 5,
  tone: "#6b8f4e",
  lead: "Walk an orchard in a heavy year and the branches bend under the clusters. Come back the next autumn and the same trees look almost bare. Growers call it alternate bearing, and pistachios are famous for it.",
  sections: [
    {
      heading: "A tree that keeps score",
      body: "A pistachio sets next year's flower buds while this year's nuts are filling. In a heavy year the nuts win the argument for sugar, and the buds starve and drop. Fewer buds means a light crop, and a light crop leaves plenty for the buds — so the swing sets itself up again.",
    },
    {
      heading: "Why it is hard to break",
      body: "Once a whole block falls into step, weather keeps it there. A late frost or a hot spring knocks out a crop everywhere at once, and every tree starts the next cycle on the same foot. Pruning, thinning and careful nitrogen can soften the swing, but rarely flatten it.",
    },
    {
      heading: "What it means for your snack drawer",
      body: "Prices follow the trees. An 'on' year floods the market and a light one tightens it, which is why the same bag can cost noticeably more from one winter to the next.",
    },
  ],
} as const;

/** The reader page for ARTICLE (the app names reader pages by an opaque id). */
export const ARTICLE_READER_URL = "pistachio://reader/7a1c0e5b9d2f4a6c8e0b1d3f5a7c9e2b";
/** Where a "Read aloud" clip of ARTICLE plays. */
export const READ_ALOUD_URL = "pistachio://read-aloud/7a1c0e5b9d2f";

/** The video a YouTube address is watching, or null on any other page of the site. */
export function youtubeVideo(url: string): (typeof VIDEOS)[number] | null {
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== "/watch") return null;
    const id = parsed.searchParams.get("v");
    return VIDEOS.find((video) => video.id === id) ?? VIDEOS[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * One entry per site. The `url` is the address a favorite opens; a tab may
 * be on any path of the same host and still belongs to the site.
 */
const CATALOG: SiteInfo[] = [
  { url: "https://x.com/home", title: "Home / X", faviconUrl: icon("x"), page: "x", accent: "#000000" },
  { url: "https://www.youtube.com/", title: "YouTube", faviconUrl: icon("youtube"), page: "youtube", accent: "#ff0000" },
  { url: "https://www.google.com/", title: "Google", faviconUrl: icon("google"), page: "google", accent: "#4285f4" },
  {
    url: "https://calendar.google.com/calendar/u/0/r/week",
    title: "Google Calendar - Week",
    faviconUrl: icon("google-calendar"),
    page: "google-calendar",
    accent: "#1a73e8",
  },
  { url: "https://chatgpt.com/", title: "ChatGPT", faviconUrl: icon("chatgpt"), page: "chatgpt", accent: "#10a37f" },
  { url: "https://claude.ai/new", title: "Claude", faviconUrl: icon("claude"), page: "claude", accent: "#d97757" },
  {
    url: "https://en.wikipedia.org/wiki/Pistachio",
    title: "Pistachio - Wikipedia",
    faviconUrl: icon("wikipedia"),
    page: "wikipedia",
    accent: "#36c",
  },
  { url: "https://github.com/", title: "GitHub", faviconUrl: icon("github"), page: "github", accent: "#24292f" },
  { url: ARTICLE.url, title: `${ARTICLE.title} - ${ARTICLE.site}`, faviconUrl: letterMark("G", ARTICLE.tone), page: "article", accent: ARTICLE.tone },
];

/** The repository the GitHub sketch shows when a tab is on it. */
export const GITHUB_REPO_PATH = "/zmeyer44/pistachio";

/** Hosts that belong to a catalog site, beyond the one in its `url`. */
const ALIASES: Record<string, MockPage> = {
  "twitter.com": "x",
  "youtu.be": "youtube",
  "m.youtube.com": "youtube",
  "chat.openai.com": "chatgpt",
  "wikipedia.org": "wikipedia",
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return null;
  }
}

/** The query a Google search address is for, or null when it is not one. */
export function searchQuery(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/u.test(parsed.protocol)) return null;
    if (!/(^|\.)google\.[a-z.]+$/u.test(parsed.hostname) || parsed.pathname !== "/search") return null;
    const q = parsed.searchParams.get("q");
    return q === null || q.trim() === "" ? null : q.trim();
  } catch {
    return null;
  }
}

/** The catalog entry an address belongs to: the same site whatever its path. */
export function catalogSite(url: string): SiteInfo | null {
  const host = hostOf(url);
  if (host === null) return null;
  const direct = CATALOG.find((site) => hostOf(site.url) === host);
  if (direct !== undefined) return direct;
  const alias = ALIASES[host] ?? ALIASES[host.replace(/^[^.]+\./u, "")];
  return alias === undefined ? null : (CATALOG.find((site) => site.page === alias) ?? null);
}

/** Every catalog site, in the order the favorites grid seeds them. */
export function catalogSites(): readonly SiteInfo[] {
  return CATALOG;
}

/**
 * What a tab shows for an address: a catalog site as itself (a search on
 * Google titled by its query, as Google titles it), anything else as a
 * generic page named after its host.
 */
export function describeUrl(url: string): SiteInfo {
  const article = CATALOG.find((entry) => entry.page === "article")!;
  if (url === ARTICLE_READER_URL) return { ...article, url, title: ARTICLE.title, page: "reader" };
  if (url === READ_ALOUD_URL) return { ...article, url, title: `Read aloud · ${ARTICLE.title}`, page: "read-aloud" };
  const site = catalogSite(url);
  if (site !== null) {
    const query = site.page === "google" ? searchQuery(url) : null;
    const video = site.page === "youtube" ? youtubeVideo(url) : null;
    const repo = site.page === "github" && new URL(url).pathname.startsWith(GITHUB_REPO_PATH);
    const title =
      query !== null ? `${query} - Google Search` : video !== null ? `${video.title} - YouTube` : repo ? "zmeyer44/pistachio: A browser built for tomorrow" : site.title;
    return { ...site, url, title };
  }
  const host = hostOf(url) ?? "page";
  const name = host.split(".")[0] ?? host;
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  return { url, title, faviconUrl: letterMark(title.charAt(0), "#6b6b6b"), page: "generic", accent: "#6b6b6b" };
}

/** Catalog sites whose name or subject matches a query — the mock search results. */
export function searchCatalog(query: string): SiteInfo[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const KEYWORDS: Record<MockPage, string[]> = {
    x: ["x", "twitter", "tweet", "post", "feed", "news"],
    youtube: ["video", "youtube", "watch", "music", "tutorial", "how"],
    google: [],
    "google-calendar": ["calendar", "meeting", "week", "schedule", "event", "when"],
    chatgpt: ["chatgpt", "openai", "gpt", "ai", "chat", "write"],
    claude: ["claude", "anthropic", "ai", "chat", "write", "code"],
    wikipedia: ["what", "who", "wiki", "wikipedia", "pistachio", "nut", "history", "encyclopedia"],
    github: ["code", "repo", "git", "github", "pistachio", "browser", "open source"],
    article: ["pistachio", "tree", "trees", "orchard", "harvest", "why", "nut"],
    reader: [],
    "read-aloud": [],
    generic: [],
  };
  const scored = CATALOG.filter((site) => site.page !== "google").map((site) => {
    const hay = [site.title.toLowerCase(), ...KEYWORDS[site.page]];
    const score = words.reduce((total, word) => total + (hay.some((h) => h.includes(word)) ? 1 : 0), 0);
    return { site, score };
  });
  const hits = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  return (hits.length > 0 ? hits : scored).map((entry) => entry.site).slice(0, 5);
}
