/**
 * What the shell SAYS about where things are kept, where that depends on the
 * SURFACE rather than on what the person has done.
 *
 * `lib/onboarding-steps.ts` did this for the walkthrough (§14). This module
 * is the same idea for everything the walkthrough hands over to: the settings
 * pages, the bookmarks and reminders windows, and the chrome's own status
 * rows. The shell runs in two places now (`useSurface().kind`), and a great
 * many of its sentences answer one question — WHERE DOES THIS LIVE? — with
 * "this Mac". In a browser tab that is not a stale phrasing, it is a false
 * promise about storage: there is no Mac under the tab and no disk the tab
 * can write to. Settings are the sealed account-global `shell-settings:default`
 * register (docs/web-browser-design.md §6.3); memory, bookmarks and reminders
 * are written by the session host as the person, through the same
 * `WorkspaceToolStore` registers and seals the agent's tools use (§11); site
 * permissions live per origin in the sealed session record; and clearing
 * browsing data clears the Space's cookies and page storage on the worker.
 * All of those are things a person may reasonably want to know before they
 * type, so the wording changes with the surface rather than being shared.
 *
 * THE DESKTOP'S WORDING IS UNTOUCHED. Every `native` value below is the
 * literal that used to sit in the component, byte for byte, and
 * `test/surface-copy.test.ts` pins each one — the whole risk of making copy
 * surface-aware is that the surface that already worked starts saying
 * something new.
 *
 * Where a whole SECTION is refused on the web — account, devices, sync,
 * cloud, egress, the vault, integrations, every one of them "managed from the
 * web app's settings pages" (§11) — its body never renders in a tab, so its
 * strings are not here: `Unavailable` carries the host's own reason and this
 * module must not say it twice. What IS here for those subjects is the copy
 * that renders anyway: the nav description beside the icon. The chrome's own
 * status card answers for them in one folded row instead, whose words are
 * `lib/chrome-status.ts`'s (`MANAGED_ELSEWHERE`) — it has no Mac twin to
 * pair with, so it is not a surface pair.
 *
 * Pure on purpose — no React, no DOM — so every sentence is pinned by vitest.
 * Components read it through `copyFor(useSurface().kind)`.
 */

/** Which surface the shell is running on; `Surface["kind"]` by another name. */
export type CopySurface = "native" | "stream";

/** The settings sidebar's header line, under "Settings". */
export interface SettingsCopy {
  lede: string;
}

/** Nav descriptions that name a machine. The rest of the tree is surface-free. */
export interface NavCopy {
  account: string;
}

export interface AppearanceCopy {
  /** The page's lede. */
  description: string;
  /** Under "Color mode". */
  colorMode: string;
  /** Under "Desktop glass", where the platform can do it. */
  desktopGlass: string;
  /** Under "Desktop glass", where it cannot. */
  desktopGlassUnsupported: string;
  /** The Material group's footer, beside "Restore defaults". */
  materialFooter: string;
}

export interface PrivacyCopy {
  /** Site data's lede. */
  siteData: string;
  /** Under "Recent sites". */
  recents: string;
  /** The group that holds the two rows below: its title and its note. */
  betweenDevicesTitle: string;
  betweenDevices: string;
  /** The "Sessions travel only under your own keys" note. */
  sessions: string;
  /** The row that says where preferences live: its label and its note. */
  preferencesLabel: string;
  preferences: string;
  /** Agent isolation → "In your live tabs". */
  liveTabs: string;
  /** Agent isolation → the cloud browser's per-run network identity. */
  cloudEgress: string;
}

export interface MemoryCopy {
  /** The first item of the time-zone select: follow whatever the host says. */
  followSystemZone: (zone: string) => string;
  /** Under "Use memory". */
  useMemory: string;
  /** Under "Forget everything". */
  forgetEverything: string;
}

export interface BookmarksCopy {
  /** The last segment of the bookmarks window's subtitle. */
  scope: string;
  /** Under "Ask the model what the page is about". */
  enrich: string;
}

export interface RemindersCopy {
  /** The last segment of the reminders window's subtitle. */
  scope: string;
  /** The first item of the reminder form's time-zone select. */
  systemZone: (zone: string) => string;
  /** The form's refusal when the typed zone is not one the runtime knows. */
  unknownZone: string;
}

export interface AboutCopy {
  /** Under "This app". */
  thisApp: string;
}

export interface ApprovalsCopy {
  /** Under "Alerts". */
  alerts: string;
  /** Under "Desktop notifications". */
  desktopNotifications: string;
}

export interface SurfaceCopy {
  settings: SettingsCopy;
  nav: NavCopy;
  appearance: AppearanceCopy;
  privacy: PrivacyCopy;
  memory: MemoryCopy;
  bookmarks: BookmarksCopy;
  reminders: RemindersCopy;
  about: AboutCopy;
  approvals: ApprovalsCopy;
}

/**
 * The Mac app's wording: every string exactly as it stood in the component
 * before this module existed.
 */
const NATIVE: SurfaceCopy = {
  settings: {
    lede: "Preferences, kept on this Mac",
  },
  nav: {
    account: "Sign in, recovery, this Mac",
  },
  appearance: {
    description: "Shape the whole window material. Themes stay on this Mac and update as you edit.",
    colorMode: "System follows macOS appearance changes automatically.",
    desktopGlass: "Blur the macOS desktop beneath the sidebar and window chrome. Webpages stay opaque.",
    desktopGlassUnsupported: "Native desktop blur is currently available on macOS.",
    materialFooter: "Appearance is stored on this Mac and never synced.",
  },
  privacy: {
    siteData: "What your browsing session keeps on this Mac, and how to clear it.",
    recents: "The chips in the address bar. Kept on this Mac only, in the chrome's own storage — never in a page's.",
    betweenDevicesTitle: "Between your machines",
    betweenDevices: "What a Space carries to your other devices, and what never leaves this one.",
    sessions:
      "With an account, a Space's sign-ins converge across your enrolled devices, sealed under a key derived for that Space alone — the hub stores ciphertext. Without an account, nothing leaves this Mac. Settings → Sync says which sites take part.",
    preferencesLabel: "Preferences stay on this Mac",
    preferences:
      "Settings, shortcuts, and appearance are per-machine. Organization policies and preset links may be shared; your preferences are not.",
    liveTabs:
      "How a task run here, on this Mac, relates to the sites you are signed in to. Settings → Agent lists what it can do in them.",
    cloudEgress:
      "Each run goes out through the egress gateway on a credential minted for that run and revoked when it ends — however it ends. Site state that changed during the run reaches this Mac only through the Space's sync, under your own keys.",
  },
  memory: {
    followSystemZone: (zone) => `Follow this Mac — ${zone}`,
    useMemory: "Memory is stored on this Mac, in its own file, and never synced.",
    forgetEverything:
      "Every fact in use is marked forgotten. The history stays on this Mac until it is pruned, so anything forgotten by mistake can be restored from the list above.",
  },
  bookmarks: {
    scope: "this Mac only",
    enrich:
      "The page's text and tags are sent to the model your account provides to name the thing, describe it, and pick its facts and keywords. Off reads only the page's own tags, which is instant and stays on this Mac.",
  },
  reminders: {
    scope: "this Mac only",
    systemZone: (zone) => `${zone} (this Mac)`,
    unknownZone: "That time zone is not one this Mac knows.",
  },
  about: {
    thisApp: "What is installed on this Mac, and where it keeps its settings.",
  },
  approvals: {
    alerts: "How this Mac tells you a run is waiting.",
    desktopNotifications:
      "A macOS notification for each pause, judgment, step-up, and completion. Clicking it brings the window forward.",
  },
};

/**
 * The browser tab's wording. Every sentence has to be true of what the
 * SESSION HOST actually does (docs/web-browser-design.md §6.3, §11 and
 * `services/cloud-browser/src/sessions/shell-host.ts`), which is a stricter
 * test than "does not mention a Mac": settings really are the account's
 * synced register, memory and bookmarks and reminders really are written
 * under this account's keys, and the pane really is a picture of a browser
 * running somewhere else.
 */
const STREAM: SurfaceCopy = {
  settings: {
    lede: "Preferences, synced to your account",
  },
  nav: {
    account: "Sign in, recovery, keys",
  },
  appearance: {
    description: "Shape the whole window material. Themes are saved to your account and update as you edit.",
    colorMode: "System follows your device's appearance changes automatically.",
    desktopGlass:
      "Blurs the desktop beneath the sidebar and window chrome in the Mac app. A browser tab has no desktop behind it, so the choice travels but shows there.",
    desktopGlassUnsupported: "Native desktop blur is available in the Mac app.",
    materialFooter:
      "Appearance is saved to this account's synced settings, so every device that reads them opens wearing it.",
  },
  privacy: {
    siteData: "What this Space keeps in the browser running it, and how to clear it.",
    recents: "The chips in the address bar. Kept by the chrome itself — never in a page's storage.",
    betweenDevicesTitle: "Between your devices",
    betweenDevices: "What a Space carries to your other devices, and what stays in this session.",
    sessions:
      "A Space's sign-ins converge across your enrolled devices, sealed under a key derived for that Space alone — the hub stores ciphertext. This tab holds none of them: the browser running this Space signs in from those sealed copies and sends you pixels.",
    preferencesLabel: "Preferences travel with your account",
    preferences:
      "Settings, shortcuts, and appearance are kept in this account's synced settings, so a change here opens the same way on your other devices. Organization policies and preset links may be shared too.",
    liveTabs:
      "How a task run in this session relates to the sites you are signed in to. Settings → Agent lists what it can do in them.",
    cloudEgress:
      "Each run goes out through the egress gateway on a credential minted for that run and revoked when it ends — however it ends. Site state that changed during the run reaches your other devices only through the Space's sync, under your own keys.",
  },
  memory: {
    followSystemZone: (zone) => `Follow this browser — ${zone}`,
    useMemory: "Memory is sealed under this account's keys and synced to your devices.",
    forgetEverything:
      "Every fact in use is marked forgotten. The history stays in this account's memory until it is pruned, so anything forgotten by mistake can be restored from the list above.",
  },
  bookmarks: {
    scope: "synced to your devices",
    enrich:
      "The page's text and tags are sent to the model your account provides to name the thing, describe it, and pick its facts and keywords. Off reads only the page's own tags, which is instant and sends nothing to a model.",
  },
  reminders: {
    scope: "synced to your devices",
    systemZone: (zone) => `${zone} (this browser)`,
    unknownZone: "That time zone is not one this browser knows.",
  },
  about: {
    thisApp: "What this session runs, and where it keeps its settings.",
  },
  approvals: {
    alerts: "How Pistachio tells you a run is waiting.",
    desktopNotifications:
      "A desktop notification for each pause, judgment, step-up, and completion, shown by the Pistachio app on your devices rather than by this tab.",
  },
};

export const SURFACE_COPY: Record<CopySurface, SurfaceCopy> = { native: NATIVE, stream: STREAM };

/** Everything the shell says about storage, in the words of one surface. */
export function copyFor(surface: CopySurface): SurfaceCopy {
  return SURFACE_COPY[surface];
}

/** Watchtower's archive belongs to the desktop installation; web capture is unavailable. */
export const WATCHTOWER_COPY = {
  unavailable: "Your archive lives on your Mac.",
  local: "Saved on this Mac. No page scripts, images, or form inputs.",
  storage: "on this Mac",
  filterOff: "Off, capture never leaves this Mac and filters less.",
  filterMemory: "then remembers the answer on this Mac",
} as const;
