/**
 * The things a person can CHANGE in settings, each pointing at the page that
 * changes it (docs/smart-suggestions.md §5).
 *
 * `SETTINGS_SECTIONS` names twenty-one pages, and a page name is a poor
 * answer to a sentence: "change theme color", "make the sidebar smaller" and
 * "stop the agent from remembering things" share no letters with
 * "Appearance", "General" or "Memory". This catalog is the vocabulary in
 * between. Each entry is one recognisable errand with a title a person would
 * say, a literal description of what the page does, and the words they might
 * reach for instead. Several errands may share a section.
 *
 * Both readers take it literally, so it is written for literal readers:
 *
 * - the fuzzy ranker matches `title` and `keywords`, which is why the rows
 *   are useful with no model reachable at all;
 * - the intent model (@pistachio/shell-contracts/address-intent) reads
 *   `description` as the whole meaning of the row. It is poor with negation
 *   and indirection, so every description is one positive sentence that
 *   starts with a verb and says only what the page truly controls. "Change
 *   the theme, accent color…", never "Settings you might want if…".
 *
 * A test asserts every section is reachable from at least one entry, so a
 * new settings page cannot be added without a way to ask for it.
 *
 * Nothing here is a permission or a promise: choosing a row only OPENS the
 * page. The person still turns the knob.
 */

import { SETTINGS_SECTIONS, type SettingsSection } from "@pistachio/shell-contracts/settings";

export interface SettingsIntent {
  /** Stable, unique, and part of the palette row's id — never a section name. */
  id: string;
  /** The page this errand is done on. */
  section: SettingsSection;
  /** A noun phrase, as the person would name it: "Theme & colors". */
  title: string;
  /** One positive sentence, starting with a verb, about what the page does. */
  description: string;
  /** The other words someone might type for it. Fuzzy-matched, never shown. */
  keywords: string[];
}

/**
 * Ordered, and the order matters twice: the FIRST entry of a section is that
 * section's canonical row (see `settingsIntentEntryId`), and ties in the
 * fuzzy ranker fall to whichever candidate was built first.
 */
export const SETTINGS_INTENTS: readonly SettingsIntent[] = [
  // ── General ──────────────────────────────────────────────────────────
  {
    id: "general",
    section: "",
    title: "General",
    description: "Change where the tabs live, what a new tab opens, which search engine is used, and what the window starts with.",
    keywords: ["general", "preferences", "options", "browser settings", "basics"],
  },
  {
    id: "layout",
    section: "",
    title: "Tabs layout & sidebar",
    description: "Put the tabs in a top row or in a sidebar, and keep the sidebar always visible or reveal it on hover.",
    keywords: ["sidebar", "top tabs", "tab bar", "compact", "hide the sidebar", "narrow", "vertical tabs", "layout"],
  },
  {
    id: "new-tab",
    section: "",
    title: "New tab & home page",
    description: "Choose what a new tab opens, the page it lands on, and the page a new window or Space starts with.",
    keywords: ["new tab", "start page", "homepage", "blank page", "startup page", "default page"],
  },
  {
    id: "search-engine",
    section: "",
    title: "Default search engine",
    description: "Pick the engine that typed words are searched on from the address bar and the page menu.",
    keywords: ["google", "duckduckgo", "bing", "search provider", "change search engine", "default search"],
  },
  {
    id: "ai-assistant",
    section: "",
    title: "AI assistant for typed prompts",
    description: "Pick the assistant the address bar's “Ask” suggestion opens with what you typed as the prompt.",
    keywords: ["chatgpt", "claude", "perplexity", "ai search", "assistant", "chatbot"],
  },
  {
    id: "smart-suggestions",
    section: "",
    title: "Smart suggestions",
    description: "Choose whether what you type in the address bar is sent to a fast model that orders the suggestions.",
    keywords: ["intent model", "suggestions", "autocomplete", "predictions", "address bar", "privacy of typing"],
  },
  {
    id: "confirm-close",
    section: "",
    title: "Confirm closing a working tab",
    description: "Ask for a confirmation before closing a tab the agent is working in.",
    keywords: ["confirm", "warn", "close tab", "live run", "are you sure"],
  },
  {
    id: "chat-on-launch",
    section: "",
    title: "Agent chat on launch",
    description: "Show the agent conversation beside the page when Pistachio starts.",
    keywords: ["console", "agent panel", "sidebar chat", "open on startup"],
  },

  // ── Appearance ───────────────────────────────────────────────────────
  {
    id: "theme",
    section: "appearance",
    title: "Theme & colors",
    description: "Change the theme, the accent colors, the gradient, the window material and the corner radius.",
    keywords: ["dark mode", "light mode", "color", "colour", "background", "wallpaper", "accent", "gradient", "material", "glass", "appearance", "skin", "rounded corners"],
  },
  {
    id: "dark-mode",
    section: "appearance",
    title: "Dark mode",
    description: "Switch the window between the light, dark and system color modes.",
    keywords: ["night mode", "light mode", "system theme", "make it darker", "make it lighter"],
  },
  {
    id: "toast-position",
    section: "appearance",
    title: "Notification position",
    description: "Choose the corner of the page the brief confirmations appear in and stack away from.",
    keywords: ["toast", "notifications", "corner", "url copied", "banner", "position"],
  },

  // ── Agent ────────────────────────────────────────────────────────────
  {
    id: "agent",
    section: "delegation",
    title: "Agent & browser access",
    description: "Read what the agent may do in your tabs, and set the instructions every run starts with.",
    keywords: ["delegation", "assistant", "pistachio", "browser access", "default instructions", "guardrails", "permissions"],
  },

  // ── Memory ───────────────────────────────────────────────────────────
  {
    id: "memory",
    section: "memory",
    title: "Memory",
    description: "Read, edit and delete what the agent remembers about you, and choose whether it learns from conversations.",
    keywords: ["remember", "forget", "facts", "profile", "preferred name", "time zone", "what it knows about me"],
  },

  // ── Reminders ────────────────────────────────────────────────────────
  {
    id: "reminders",
    section: "reminders",
    title: "Reminders & scheduled tasks",
    description: "Turn reminders on, choose how they notify you, and see what the agent can schedule.",
    keywords: ["alarm", "schedule", "recurring", "daily", "notify me", "todo", "scheduled tasks"],
  },

  // ── Bookmarks ────────────────────────────────────────────────────────
  {
    id: "tabs",
    section: "tabs",
    title: "Tabs, auto-archive & groups",
    description: "Choose when idle tabs are archived, whether related tabs are grouped, and whether favorites return to their home page.",
    keywords: ["tidy", "auto archive", "archive tabs", "tab groups", "group tabs", "idle tabs", "clean up tabs", "too many tabs", "favorites reset", "12 hours"],
  },
  {
    id: "bookmarks",
    section: "bookmarks",
    title: "Bookmarks & saving pages",
    description: "Choose how a page is saved, and whether the model reads it to describe what it is about.",
    keywords: ["saved pages", "reading list", "favorites", "double shift", "collections", "keep this page"],
  },

  // ── Watchtower ───────────────────────────────────────────────────────
  {
    id: "watchtower",
    section: "watchtower",
    title: "Watchtower & saved reading",
    description: "Turn saving what you read on or off, pause it, exclude sites, choose what is sent to a model, set the storage limit, export, or forget saved visits.",
    keywords: ["browsing memory", "page history", "saved text", "archive", "remember pages", "exclude a site", "forget visits", "retention", "export markdown"],
  },

  // ── Integrations ─────────────────────────────────────────────────────
  {
    id: "integrations",
    section: "integrations",
    title: "Integrations & connected apps",
    description: "Connect Gmail, Google Calendar, and other apps the agent may use, and choose the access each connection gets.",
    keywords: ["gmail", "google", "email", "calendar", "google calendar", "events", "meetings", "invitations", "connect an app", "api", "grant", "oauth", "disconnect"],
  },

  // ── Approvals & notifications ────────────────────────────────────────
  {
    id: "approvals",
    section: "approvals",
    title: "Approvals & notifications",
    description: "Turn desktop notifications and alerts on or off, and set how long a paused agent run waits for your approval.",
    keywords: ["permission", "confirm", "pause", "alerts", "desktop notifications", "dock bounce", "ask me first"],
  },

  // ── Evidence ─────────────────────────────────────────────────────────
  {
    id: "evidence",
    section: "evidence",
    title: "Evidence & run records",
    description: "Replay the signed record of what the agent did, and show the payload behind each entry.",
    keywords: ["audit", "log", "proof", "signature", "replay", "receipts", "what the agent did"],
  },

  // ── Site data ────────────────────────────────────────────────────────
  {
    id: "site-data",
    section: "privacy",
    title: "Site data, cookies & cache",
    description: "Clear the cookies, site storage and cache that websites keep in this Space.",
    keywords: ["clear cookies", "clear cache", "delete browsing data", "sign out of sites", "privacy", "storage"],
  },
  {
    id: "recent-sites",
    section: "privacy",
    title: "Recent sites",
    description: "Clear the sites the address bar remembers, or stop remembering them at all.",
    keywords: ["history", "clear history", "delete recents", "recently visited", "chips", "forget sites"],
  },

  // ── Spaces ───────────────────────────────────────────────────────────
  {
    id: "spaces",
    section: "privacy/spaces",
    title: "Spaces",
    description: "See, switch and fork your Spaces, each of which keeps its own cookie jar and sign-ins.",
    keywords: ["workspace", "profile", "context", "separate logins", "fork", "containers", "new space"],
  },

  // ── Agent isolation ──────────────────────────────────────────────────
  {
    id: "agent-isolation",
    section: "privacy/isolation",
    title: "Agent isolation",
    description: "Read what bounds the agent's authority in your live tabs and in the cloud browser.",
    keywords: ["sandbox", "limits", "security", "what the agent cannot do", "partitions", "authority"],
  },

  // ── Account ──────────────────────────────────────────────────────────
  {
    id: "account",
    section: "account",
    title: "Account & sign in",
    description: "Sign in, sign out or create your Pistachio account, see this month's model usage, and set the monthly spend cap.",
    keywords: ["sign in", "log in", "sign out", "email", "password", "billing", "subscription", "usage", "spend", "recovery code", "imessage", "phone number"],
  },

  // ── Devices ──────────────────────────────────────────────────────────
  {
    id: "devices",
    section: "devices",
    title: "Devices",
    description: "See the devices enrolled on this account, compare their key fingerprints, and revoke one.",
    keywords: ["machines", "my macs", "laptops", "keys", "fingerprint", "revoke", "enrollment", "logged in devices"],
  },

  // ── Sync ─────────────────────────────────────────────────────────────
  {
    id: "sync",
    section: "sync",
    title: "Sync between devices",
    description: "Sync your tabs, sessions and Spaces between your devices, and choose what is synced.",
    keywords: ["backup", "restore tabs", "other computer", "cookies sync", "hub", "converge", "icloud"],
  },

  // ── Cloud browser ────────────────────────────────────────────────────
  {
    id: "cloud",
    section: "cloud",
    title: "Cloud browser",
    description: "Choose the Spaces the hosted browser may open, run new conversations there by default, and manage channels.",
    keywords: ["remote", "hosted", "server", "run in the cloud", "headless", "channels", "webhook", "runs elsewhere"],
  },

  // ── Identity egress ──────────────────────────────────────────────────
  {
    id: "egress",
    section: "egress",
    title: "Network identity & location",
    description: "Send a Space's traffic through an address that belongs to your account, and read the gateway's health.",
    keywords: ["vpn", "proxy", "ip address", "location", "region", "gateway", "egress", "appear from"],
  },

  // ── Vault ────────────────────────────────────────────────────────────
  {
    id: "vault",
    section: "vault",
    title: "Passwords & vault",
    description: "Keep the sign-ins and other values the agent may type for you on a site without reading them.",
    keywords: ["password", "credentials", "secrets", "logins", "autofill", "keychain", "saved passwords", "one-time code"],
  },

  // ── Keyboard shortcuts ───────────────────────────────────────────────
  {
    id: "shortcuts",
    section: "shortcuts",
    title: "Keyboard shortcuts",
    description: "Change the key combination that runs each browser command.",
    keywords: ["keybinding", "hotkey", "keys", "rebind", "command key", "shortcut", "keyboard"],
  },

  // ── About ────────────────────────────────────────────────────────────
  {
    id: "about",
    section: "about",
    title: "About & updates",
    description: "See which version of Pistachio is installed, check for updates, and find where its data is stored.",
    keywords: ["version", "update", "upgrade", "release notes", "changelog", "reset", "welcome tour", "data location", "open source"],
  },
  {
    id: "updates",
    section: "about",
    title: "Software updates",
    description: "Check for a new release of Pistachio and install it.",
    keywords: ["update", "upgrade", "new version", "install update", "check for updates"],
  },
];

/**
 * The first entry of each section — the row that keeps the plain
 * `settings:<section>` id the rest of the app (and the e2e suite) knows a
 * section by, so "keyboard shortcuts" still lands on `settings:shortcuts`.
 */
const CANONICAL_IDS: ReadonlySet<string> = new Set(
  (Object.keys(SETTINGS_SECTIONS) as SettingsSection[]).flatMap((section) => {
    const first = SETTINGS_INTENTS.find((intent) => intent.section === section);
    return first === undefined ? [] : [first.id];
  }),
);

/**
 * The palette row's id for an intent. One row per section keeps the old
 * `settings:<section>` name — general's is `settings:general`, since the
 * General section's own key is the empty string — and every further errand
 * on that page gets its own `settings-intent:<id>`. Ids are what the intent
 * model names and what ↑/↓ and React keys index by, so they must be stable.
 */
export function settingsIntentEntryId(intent: SettingsIntent): string {
  return CANONICAL_IDS.has(intent.id) ? `settings:${intent.section || "general"}` : `settings-intent:${intent.id}`;
}

/**
 * What the fuzzy ranker matches a settings row on, beside its title: the
 * words a person might reach for, the description (a sentence is a lot of
 * incidental vocabulary), the SECTION's own name — so "appearance",
 * "shortcuts" and "site data" still find their page even though no title
 * here is a section name — and the two words that make any of them findable
 * by asking for settings at all.
 */
export function settingsIntentKeywords(intent: SettingsIntent): string[] {
  return [...intent.keywords, intent.description, SETTINGS_SECTIONS[intent.section], "settings preferences"];
}
