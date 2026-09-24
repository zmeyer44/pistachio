/**
 * First-run onboarding: the walkthrough a new install shows
 * before the browser chrome, and the contract by which it hands what it
 * gathered to main.
 *
 * Four steps, in order (ONBOARDING_STEPS): who the person is (spoken or
 * typed, seeded into the agent's memory), what to bring from the browser
 * they use today (@pistachio/shell-contracts/browser-import), which apps to keep as
 * favorites (FAVORITE_APPS, or a site of their own — SUGGESTED_FAVORITES is
 * a suggestion, none is fine), and how the window
 * should look. There is no account step: a Mac nobody signed in on is given
 * an anonymous account the models run under (docs/anonymous-accounts.md),
 * so the about step only offers a quiet "Or sign in" for someone who already
 * has an account, and making one is Settings → Account's job once the wizard
 * is done — it is the anonymous one, upgraded. The browser is entirely usable
 * without either. Completion is one IPC call
 * (`OnboardingCompletion`): main writes the memories, names the first
 * Space, fills the shelf, marks `settings.onboarding.completed`, and opens
 * the welcome tabs (WELCOME_TABS — pages Pistachio serves itself,
 * main/welcome-pages.ts).
 *
 * Pure on purpose — no Electron, no DOM — so vitest pins it under node.
 */

import { sanitizeOnboardingFacts, type OnboardingFact } from "@pistachio/agent-runtime/onboarding";
import { MAX_MEMORY_CONTENT, MAX_MEMORY_LABEL } from "./memory.js";
import { MAX_FAVORITES } from "./sidebar.js";
import { MAX_SPACE_NAME } from "./spaces.js";
import { withScheme } from "./url.js";

export const ONBOARDING_STEPS = ["about", "import", "favorites", "appearance"] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** How many favorites the step suggests. A recommendation: the step can be left with fewer, or none. */
export const SUGGESTED_FAVORITES = 3;
/** A spoken introduction longer than this is cut before transcription. */
export const MAX_INTRO_SECONDS = 90;
/** The largest recording main accepts, base64 included. */
export const MAX_INTRO_AUDIO_BYTES = 12 * 1024 * 1024;

/* ------------------------------ the catalog ------------------------------ */

/**
 * An app the favorites grid offers. `colors` are the brand's own, in paint
 * order: the selected tile is washed with them, so Figma's tile carries all
 * five of its colours and YouTube's only its red.
 */
export interface FavoriteApp {
  id: string;
  name: string;
  url: string;
  colors: readonly string[];
}

export const FAVORITE_APPS: readonly FavoriteApp[] = [
  { id: "x", name: "X", url: "https://x.com/", colors: ["#111111"] },
  { id: "gmail", name: "Gmail", url: "https://mail.google.com/", colors: ["#EA4335", "#FBBC04", "#34A853", "#4285F4"] },
  { id: "google-calendar", name: "Google Calendar", url: "https://calendar.google.com/", colors: ["#4285F4", "#34A853", "#FBBC04", "#EA4335"] },
  { id: "spotify", name: "Spotify", url: "https://open.spotify.com/", colors: ["#1DB954"] },
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com/", colors: ["#FF0000"] },
  { id: "notion", name: "Notion", url: "https://www.notion.so/", colors: ["#111111"] },
  { id: "slack", name: "Slack", url: "https://app.slack.com/", colors: ["#E01E5A", "#36C5F0", "#2EB67D", "#ECB22E"] },
  { id: "figma", name: "Figma", url: "https://www.figma.com/", colors: ["#F24E1E", "#FF7262", "#A259FF", "#1ABCFE", "#0ACF83"] },
  { id: "outlook", name: "Outlook", url: "https://outlook.live.com/mail/", colors: ["#0078D4", "#28A8EA"] },
  { id: "github", name: "GitHub", url: "https://github.com/", colors: ["#24292F"] },
  { id: "linear", name: "Linear", url: "https://linear.app/", colors: ["#5E6AD2"] },
  { id: "google-docs", name: "Google Docs", url: "https://docs.google.com/", colors: ["#4285F4"] },
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", colors: ["#10A37F"] },
  { id: "claude", name: "Claude", url: "https://claude.ai/", colors: ["#D97757"] },
  { id: "linkedin", name: "LinkedIn", url: "https://www.linkedin.com/", colors: ["#0A66C2"] },
  { id: "instagram", name: "Instagram", url: "https://www.instagram.com/", colors: ["#F58529", "#DD2A7B", "#8134AF", "#515BD4"] },
  { id: "reddit", name: "Reddit", url: "https://www.reddit.com/", colors: ["#FF4500"] },
  { id: "discord", name: "Discord", url: "https://discord.com/app", colors: ["#5865F2"] },
];

export function favoriteApp(id: string): FavoriteApp | null {
  return FAVORITE_APPS.find((app) => app.id === id) ?? null;
}

/* ------------------------------ welcome tabs ----------------------------- */

/**
 * The pages a fresh install opens once the wizard is done: an overview and
 * one lesson per core feature, all served by main at these addresses.
 * Declared here so the completion handler, the pages' own navigation, and
 * the E2E test agree on what exists.
 */
export interface WelcomeTab {
  id: "overview" | "agent" | "spaces" | "memory";
  url: string;
  title: string;
  /** One line under the lesson's name in the overview list. */
  blurb: string;
}

export const WELCOME_URL = "pistachio://welcome/";

export const WELCOME_TABS: readonly WelcomeTab[] = [
  { id: "overview", url: WELCOME_URL, title: "Welcome to Pistachio", blurb: "Let's settle in. Here are the basics." },
  {
    id: "agent",
    url: "pistachio://learn/agent",
    title: "Hand work to the agent",
    blurb: "Ask in plain language; it works inside your signed-in tabs and pauses before anything that matters.",
  },
  {
    id: "spaces",
    url: "pistachio://learn/spaces",
    title: "Spaces, favorites & split view",
    blurb: "One cookie jar per Space, apps at the top of the sidebar, and two pages side by side.",
  },
  {
    id: "memory",
    url: "pistachio://learn/memory",
    title: "Memory & reminders",
    blurb: "What the agent remembers about you, and how to have it come back to you later.",
  },
];

export function isWelcomeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "pistachio:" && (url.host === "welcome" || url.host === "learn");
  } catch {
    return false;
  }
}

/* ------------------------------- the intake ------------------------------ */

/**
 * What a spoken introduction yields, and how it is read.
 *
 * These live in `@pistachio/agent-runtime/onboarding`, beside the model calls
 * that produce them and the memory shapes they are written into, because BOTH
 * hosts need them (docs/web-browser-design.md §14) — the desktop's
 * `main/onboarding.ts` and the web app's own gateway against control's
 * `/v1/ai/*` proxy. They are re-exported here, the way `./memory.ts`
 * re-exports the memory views, so the IPC contract still names one shape and
 * there is only ever one definition of it. `MAX_INTRO_TRANSCRIPT` is the
 * intake's own bound and comes with them.
 */
export {
  heuristicIntake,
  MAX_INTAKE_FACTS,
  MAX_INTRO_TRANSCRIPT,
  sanitizeOnboardingFacts,
  sanitizeOnboardingIntake,
  type OnboardingFact,
  type OnboardingIntake,
} from "@pistachio/agent-runtime/onboarding";

/** A site typed into the favorites step rather than picked from the catalog. */
export interface OnboardingCustomFavorite {
  url: string;
  /** The host, shown on the tile until the page's own title arrives. */
  title: string;
}

/**
 * One favorite picked in the wizard: a catalog app by its FAVORITE_APPS id,
 * or a site typed in by hand. The two share one list because they share one
 * order — the order picked — in the wizard's preview and on the shelf.
 */
export type OnboardingFavoritePick =
  | { kind: "app"; id: string }
  | ({ kind: "site" } & OnboardingCustomFavorite);

/**
 * The favorite a typed address makes, or null when it is not a web
 * address. Normalized the way the General settings' new-tab page is: a
 * bare host gets its scheme, anything that is not http(s) is refused, and
 * a bare word ("news") is a search, never a site.
 */
export function customFavoriteFrom(raw: string): OnboardingCustomFavorite | null {
  const trimmed = raw.trim();
  if (trimmed === "" || /\s/u.test(trimmed)) return null;
  // A scheme is `name:` followed by something other than a port's digits,
  // so `localhost:3000` gets https and `mailto:` is judged as what it is.
  const address = /^[a-z][a-z0-9+.-]*:(?!\d)/iu.test(trimmed) ? trimmed : withScheme(trimmed);
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname;
  if (host === "" || !(host.includes(".") || host === "localhost" || host.endsWith(".localhost"))) return null;
  return { url: url.href, title: host.replace(/^www\./u, "") };
}

/** Which favorites are chosen, and what to remember: the wizard's final word. */
export interface OnboardingCompletion {
  name: string;
  about: string;
  facts: OnboardingFact[];
  /** Catalog apps and sites typed in by hand, in the order picked. */
  favorites: OnboardingFavoritePick[];
  /** A name for the first Space, or null to leave it. */
  spaceName: string | null;
  /** Open WELCOME_TABS in the active Space once the shelf is filled. */
  openWelcomeTabs: boolean;
}

/* ------------------------------- sanitizing ------------------------------ */

function line(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function prose(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "";
}

/** A completion from another process: every field checked, or null when there is nothing to complete. */
export function sanitizeOnboardingCompletion(value: unknown): OnboardingCompletion | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const favorites: OnboardingFavoritePick[] = [];
  const appIds = new Set<string>();
  const siteUrls = new Set<string>();
  const keepSite = (entry: Record<string, unknown>) => {
    const favorite = typeof entry["url"] === "string" ? customFavoriteFrom(entry["url"]) : null;
    if (favorite === null || siteUrls.has(favorite.url) || favorites.length >= MAX_FAVORITES) return;
    siteUrls.add(favorite.url);
    const title = line(entry["title"], MAX_MEMORY_LABEL);
    favorites.push({ kind: "site", url: favorite.url, title: title === "" ? favorite.title : title });
  };
  for (const item of Array.isArray(raw["favorites"]) ? (raw["favorites"] as unknown[]) : []) {
    // A bare id is the shape from before the two lists became one; a shell
    // and a host deployed apart can still meet across that change.
    const entry = typeof item === "string" ? { kind: "app", id: item } : item;
    if (typeof entry !== "object" || entry === null) continue;
    const pick = entry as Record<string, unknown>;
    if (pick["kind"] === "site") keepSite(pick);
    if (pick["kind"] !== "app" || favorites.length >= MAX_FAVORITES) continue;
    const id = pick["id"];
    if (typeof id !== "string" || favoriteApp(id) === null || appIds.has(id)) continue;
    appIds.add(id);
    favorites.push({ kind: "app", id });
  }
  // The same older shape kept typed-in sites in a list of their own, after the catalog picks.
  for (const item of Array.isArray(raw["customFavorites"]) ? (raw["customFavorites"] as unknown[]) : []) {
    if (typeof item === "object" && item !== null) keepSite(item as Record<string, unknown>);
  }
  const spaceName = line(raw["spaceName"], MAX_SPACE_NAME);
  return {
    name: line(raw["name"], MAX_MEMORY_LABEL),
    about: prose(raw["about"], MAX_MEMORY_CONTENT),
    facts: sanitizeOnboardingFacts(raw["facts"]),
    favorites,
    spaceName: spaceName === "" ? null : spaceName,
    openWelcomeTabs: raw["openWelcomeTabs"] !== false,
  };
}

/** The first name, for a Space named after its person ("Alex", not "Alex Rivera"). */
export function spaceNameFor(name: string): string | null {
  const first = line(name, MAX_MEMORY_LABEL).split(/\s+/)[0] ?? "";
  return first === "" ? null : first.slice(0, MAX_SPACE_NAME);
}
