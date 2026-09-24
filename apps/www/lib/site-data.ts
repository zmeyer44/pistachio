/**
 * Landing page copy for the Pistachio desktop browser. Kept in one place so
 * the section components stay purely presentational. Claims here should match
 * what apps/desktop actually ships.
 */

/* ----------------------------- navigation ----------------------------- */

/**
 * Site-wide, so every homepage section is addressed as `/#section`: the same
 * link has to work from /download and /docs, where a bare `#section` would
 * point at the page it is on. Memory, privacy, shortcuts, and import have no
 * homepage section of their own — those sections are on the docs page.
 */
export const navLinks = [
  { label: "Agent", href: "/#agent" },
  { label: "Spaces", href: "/#spaces" },
  { label: "Memory", href: "/docs#memory" },
  // { label: "Privacy", href: "/docs#privacy" },
  // { label: "Open source", href: "https://github.com/zmeyer44/pistachio" },
  { label: "Download", href: "/download" },
] as const;

/* -------------------------- trusted partners -------------------------- */

export type StatCard = {
  logo: string;
  /** Rendered mask width in px at desktop. */
  width: number;
  height: number;
  stat: string;
  caption: string;
  href: string;
};

/** Each tile cross-fades between two brands. */
export type LogoTile = [
  { logo: string; width: number; height: number },
  { logo: string; width: number; height: number },
];

export const microsoftCard: StatCard = {
  logo: "microsoft",
  width: 103,
  height: 22,
  stat: "9",
  caption: "Browsers you can import from, Chrome to Safari",
  href: "/docs#import",
};

export const sweetgreenCard: StatCard = {
  logo: "sweetgreen",
  width: 124,
  height: 18,
  stat: "4",
  caption: "Panes in one split view",
  href: "/#spaces",
};

export const anthropicCard: StatCard = {
  logo: "anthropic",
  width: 107,
  height: 12,
  stat: "20",
  caption: "Shortcuts, every one rebindable",
  href: "/docs#shortcuts",
};

export const simpleModernCard: StatCard = {
  logo: "simple-modern",
  width: 78,
  height: 28,
  stat: "1",
  caption: "Local file holding everything it remembers",
  href: "/docs#memory",
};

/** Tile groups, in the order they appear in each 2x2 block. */
export const tilesA: LogoTile[] = [
  [
    { logo: "okta", width: 76, height: 25 },
    { logo: "replit", width: 75, height: 21 },
  ],
  [
    { logo: "apollo", width: 76, height: 20 },
    { logo: "levis", width: 63, height: 26 },
  ],
  [
    { logo: "keurig-dr-pepper", width: 68, height: 20 },
    { logo: "chubbies", width: 68, height: 15 },
  ],
  [
    { logo: "robinhood", width: 85, height: 16 },
    { logo: "morse", width: 76, height: 11 },
  ],
];

export const tilesB: LogoTile[] = [
  [
    { logo: "clear", width: 74, height: 23 },
    { logo: "skims", width: 68, height: 15 },
  ],
  [
    { logo: "perplexity", width: 82, height: 20 },
    { logo: "sony", width: 75, height: 13 },
  ],
  [
    { logo: "emeritus", width: 75, height: 21 },
    { logo: "bcg", width: 68, height: 28 },
  ],
  [
    { logo: "bissell", width: 78, height: 14 },
    { logo: "dr-squatch", width: 74, height: 26 },
  ],
];

export const tilesC: LogoTile[] = [
  [
    { logo: "google", width: 75, height: 24 },
    { logo: "sofi", width: 68, height: 18 },
  ],
  [
    { logo: "cognition", width: 76, height: 16 },
    { logo: "kantar", width: 75, height: 14 },
  ],
  [
    { logo: "bytedance", width: 82, height: 14 },
    { logo: "chobani", width: 75, height: 15 },
  ],
  [
    { logo: "calendly", width: 75, height: 18 },
    { logo: "square", width: 30, height: 30 },
  ],
];

export const tilesD: LogoTile[] = [
  [
    { logo: "jones-road", width: 85, height: 10 },
    { logo: "nestle", width: 68, height: 18 },
  ],
  [
    { logo: "mckinney", width: 79, height: 17 },
    { logo: "manscaped", width: 75, height: 14 },
  ],
  [
    { logo: "nbcuniversal", width: 85, height: 8 },
    { logo: "swarovski", width: 82, height: 11 },
  ],
  [
    { logo: "collective-health", width: 85, height: 14 },
    { logo: "psb", width: 33, height: 32 },
  ],
];

/* ----------------------------- how it works ---------------------------- */

export const steps = [
  {
    n: "01",
    title: "An agent in your tab",
    body: "Open the chat with ⌘I and say what you want. The agent clicks, types, and reads inside the sessions you are already signed in to, listing each step as it happens — and typing interrupts it.",
  },
  {
    n: "02",
    title: "Glance at a link",
    body: "Hold a link open in a card floating over the page you are on. Close it and you are exactly where you were, or promote it to a full tab or a split when it earns one.",
  },
  {
    n: "03",
    title: "Split the window",
    body: "Put two pages side by side and work across both. A split is a saved pair, not a passing layout — leave it, come back, and both panes are how you left them.",
  },
  {
    n: "04",
    title: "Read without the clutter",
    body: "Reader view peels an article down to the words, on your background and your type. The same shortcut puts the page back the way it was.",
  },
  {
    n: "05",
    title: "Media follows you",
    body: "Leave a tab mid-song or mid-video and it keeps playing from a card at the bottom of the sidebar. The stack fans out on hover, so pausing never means finding the tab.",
  },
] as const;

/* ----------------------------- case studies ---------------------------- */

export const caseStudies = [
  {
    poster: "/img/uyDRFVVOrlY7Vh1N4Tj574lf8.png",
    video: "/video/feat-4x5eGlQ00YRs.mp4",
    stat: "⌘⇧D",
    label: "Ask about this tab",
    quote:
      "“Summarize this page in three bullets.” The agent reads the visible text and the controls on the page you are looking at, so there is nothing to paste.",
    name: "Works on any page",
    role: "Including ones behind a login",
    href: "/#agent",
  },
  {
    poster: "/img/rbih99LuNvl77lNxsfj3wkN7Eo.png",
    video: "/video/feat-YVqYQYd4AkpJ.mp4",
    stat: "⌘⇧R",
    label: "Reminders that run",
    quote:
      "“Every Monday at 9, summarize my week.” A reminder can be a message or a task the agent carries out on its own. A calendar shows what fired and what it produced.",
    name: "Once, daily, weekly, or monthly",
    role: "In your time zone",
    href: "/docs#memory",
  },
  {
    poster: "/img/lNpDvaJl5LmvqS0p7PymZ2quIu8.png",
    video: "/video/feat-zjQDUJEr5qab.mp4",
    stat: "⌘E",
    label: "Replay any run",
    quote:
      "Every click, page, and keystroke the agent makes is appended to a signed, hash-chained record. Open it after the fact and read exactly what was done.",
    name: "Ed25519 signatures",
    role: "Stored on your Mac",
    href: "/docs#privacy",
  },
] as const;

/* ------------------------------ use cases ------------------------------ */

export const useCases = [
  {
    n: "01",
    title: "Split view",
    body: "Drag a tab to the edge of the page, or press ⌘\\. Up to four resizable panes, remembered as a group and restored when you come back.",
    video: "/video/usecase-split.mp4",
    poster: "/img/usecase-split.jpg",
  },
  {
    n: "02",
    title: "Glance",
    body: "Hold ⌘ and click a link to open it as a preview floating over the page. Esc sends it back. The arrow turns it into a real tab.",
    video: "/video/usecase-glance.mp4",
    poster: "/img/usecase-glance.jpg",
  },
  {
    n: "03",
    title: "Media stack",
    body: "Anything playing in a background tab shows up as a card in the sidebar. Play, pause, scrub, pop it out into picture in picture, or set the speed anywhere from 0.25x to 2x.",
    video: "/video/usecase-media-stack.mp4",
    poster: "/img/usecase-media-stack.jpg",
  },
  {
    n: "04",
    title: "Command bar",
    body: "⌘L searches across open tabs, pins, recent sites, Spaces, settings, and browser actions from one field. Paste a URL and go.",
    video: "/video/usecase-command.mp4",
    poster: "/img/usecase-command.jpg",
  },
  {
    n: "05",
    title: "Appearance",
    body: "Two layouts, sidebar or top tabs, with the same features in each. Pick a gradient, a grain, a corner radius, and how much of the desktop shows through the glass.",
    video: "/video/usecase-appearance.mp4",
    poster: "/img/usecase-appearance.jpg",
  },
] as const;

/* --------------------------- see listen in action --------------------- */

export const actionStats = [
  {
    stat: "0",
    label: "Accounts to create. Settings and memory live on your Mac.",
  },
  { stat: "2", label: "Model providers to choose from. Bring your own key." },
  { stat: "1", label: "Signed activity record for every run the agent makes" },
] as const;

/* ------------------------------ shortcuts ------------------------------ */

/** Default bindings from apps/desktop/src/shared/shortcuts.ts. All rebindable. */
export const leadShortcut = {
  keys: "⌘I",
  action: "Open the agent chat",
  detail: [
    "⌘⇧D asks about the tab you are on",
    "⌘E replays what the agent did",
    "Typing while it runs interrupts it",
  ],
} as const;

export const shortcuts = [
  { keys: "⌘T", action: "New tab", detail: ["⌘W closes, ⌘⇧T brings it back"] },
  {
    keys: "⌘L",
    action: "Command bar",
    detail: ["Tabs, pins, Spaces, settings"],
  },
  { keys: "⌘\\", action: "Split view", detail: ["Up to four panes"] },
  { keys: "⌘D", action: "Pin this page", detail: ["Stays above today's tabs"] },
  {
    keys: "⌘S",
    action: "Pin the sidebar",
    detail: ["Or let it slide in on hover"],
  },
  {
    keys: "⌘⇧F",
    action: "Fork this Space",
    detail: ["Carry chosen tabs and logins"],
  },
  {
    keys: "⌘⇧R",
    action: "Reminders",
    detail: ["Calendar of what fired and what is next"],
  },
  { keys: "⌘F", action: "Find in page", detail: ["With match counts"] },
  {
    keys: "⌘,",
    action: "Settings",
    detail: ["Rebind any of the 20 shortcuts here"],
  },
] as const;

/* -------------------------------- footer ------------------------------- */

/**
 * Only pages and anchors that exist: the homepage sections that are actually
 * rendered (`#agent`, `#spaces`), the docs section ids, /download,
 * /early-access, /privacy, and the repo. Anything without a destination
 * stays out of here until the page ships.
 */
export const footerColumns = [
  {
    title: "Product",
    links: [
      { label: "Agent", href: "/#agent" },
      { label: "Tabs and Spaces", href: "/#spaces" },
      { label: "Download", href: "/download" },
      { label: "Early access", href: "/early-access" },
    ],
  },
  {
    title: "Docs",
    links: [
      { label: "Getting started", href: "/docs#getting-started" },
      { label: "Memory and reminders", href: "/docs#memory" },
      { label: "Keyboard shortcuts", href: "/docs#shortcuts" },
      { label: "Import from another browser", href: "/docs#import" },
      { label: "Managed policy", href: "/docs#policy" },
    ],
  },
  {
    title: "Privacy",
    links: [
      { label: "Privacy and permissions", href: "/docs#privacy" },
      { label: "Privacy policy", href: "/privacy" },
    ],
  },
  {
    title: "Open source",
    links: [
      {
        label: "Source on GitHub",
        href: "https://github.com/zmeyer44/pistachio",
      },
      {
        label: "License (GPL-3.0)",
        href: "https://github.com/zmeyer44/pistachio/blob/main/LICENSE",
      },
      { label: "Help and source", href: "/docs#help" },
    ],
  },
] as const;

export const socialLinks = [
  // { label: "LinkedIn", href: "https://www.linkedin.com/company/pistachio" },
  { label: "X (Twitter)", href: "https://x.com/zachmeyer_" },
  // { label: "YouTube", href: "https://www.youtube.com/@Pistachio" },
] as const;
