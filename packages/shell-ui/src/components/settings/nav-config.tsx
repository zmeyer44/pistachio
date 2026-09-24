/**
 * The settings sidebar's nav tree.
 *
 * Every leaf's `section` is a key of SETTINGS_SECTIONS (shared with main), so
 * a route cannot appear here without the rest of the app knowing what to call
 * it. Groups own a route PREFIX, plus whatever sections their own entries
 * name (Account's pages predate the group and keep their flat addresses):
 * landing on any of them — a deep link, a console action — opens that group's
 * menu, which is what makes the drill-down a function of the address rather
 * than of click history.
 */

import type { LucideIcon } from "lucide-react";
import {
  AlarmClock,
  Bookmark,
  Bot,
  Boxes,
  Brain,
  CircleUserRound,
  Cloud,
  Database,
  FileClock,
  Fingerprint,
  Globe,
  Info,
  Keyboard,
  KeyRound,
  Laptop,
  LockKeyhole,
  Palette,
  Plug,
  RefreshCw,
  ScrollText,
  Settings,
  ShieldCheck,
  Layers,
} from "lucide-react";
import { SETTINGS_SECTIONS, type SettingsSection } from "@pistachio/shell-contracts/settings";
import { copyFor, type CopySurface } from "../../lib/surface-copy";

export interface NavItem {
  key: string;
  icon: LucideIcon;
  section: SettingsSection;
  /** Defaults to the section's shared label. */
  label?: string;
  /** One-line caption under the label. */
  note?: string;
}

/**
 * A nav entry that owns its own menu. Selecting it swaps the sidebar's list
 * for `items` instead of only navigating — recursive, so a group may itself
 * contain groups.
 */
export interface NavGroup {
  key: string;
  label: string;
  icon: LucideIcon;
  /**
   * Route prefix the group owns; any section at or under it opens the menu,
   * as does any section one of its `items` names.
   */
  match: string;
  /** Section entered when the group is selected. */
  section: SettingsSection;
  /** Caption under the title in the group's menu header. */
  description: string;
  items: NavEntry[];
}

export type NavEntry = NavItem | NavGroup;

export interface NavSection {
  key: string;
  /** Rendered as an eyebrow; omit for a hairline-separated group. */
  label?: string;
  items: NavEntry[];
}

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return "items" in entry;
}

/** Whether `section` is one of the group's own: under its prefix, or named by an entry in it. */
export function ownsSection(group: NavGroup, section: string): boolean {
  if (section === group.match || section.startsWith(`${group.match}/`)) return true;
  return group.items.some((entry) => (isNavGroup(entry) ? ownsSection(entry, section) : entry.section === section));
}

export function labelFor(entry: NavEntry): string {
  if (isNavGroup(entry)) return entry.label;
  return entry.label ?? SETTINGS_SECTIONS[entry.section];
}

export const SETTINGS_NAV: NavSection[] = [
  {
    key: "browser",
    label: "Browser",
    items: [
      { key: "general", icon: Settings, section: "", note: "Layout, new tabs, search" },
      { key: "appearance", icon: Palette, section: "appearance", note: "Themes, gradients, material" },
      { key: "tabs", icon: Layers, section: "tabs", note: "Archiving idle tabs, groups, favorites" },
      { key: "shortcuts", icon: Keyboard, section: "shortcuts", label: "Shortcuts", note: "Key combinations for commands" },
      {
        key: "privacy",
        icon: ShieldCheck,
        label: "Privacy & security",
        match: "privacy",
        section: "privacy",
        description: "Site data, spaces, isolation",
        items: [
          { key: "site-data", icon: Database, section: "privacy", note: "Recents, cookies, cache" },
          { key: "spaces", icon: Boxes, section: "privacy/spaces", note: "One cookie jar each" },
          { key: "isolation", icon: LockKeyhole, section: "privacy/isolation", note: "What the agent cannot keep" },
        ],
      },
    ],
  },
  {
    key: "delegation",
    label: "Agent",
    items: [
      {
        key: "delegation",
        icon: Bot,
        label: "Agent",
        match: "delegation",
        section: "delegation",
        description: "Instructions, memory, approvals",
        items: [
          { key: "instructions", icon: Bot, section: "delegation", label: "Agent", note: "Instructions and browser access" },
          { key: "memory", icon: Brain, section: "memory", note: "What the agent knows about you" },
          { key: "approvals", icon: Fingerprint, section: "approvals", label: "Approvals", note: "Pauses, alerts" },
          { key: "evidence", icon: ScrollText, section: "evidence", note: "Signing, replay" },
        ],
      },
      { key: "reminders", icon: AlarmClock, section: "reminders", note: "Scheduled messages and tasks" },
      { key: "bookmarks", icon: Bookmark, section: "bookmarks", note: "Saving pages, and what the model reads" },
      { key: "watchtower", icon: FileClock, section: "watchtower", note: "Saving what you read, and forgetting it" },
      { key: "integrations", icon: Plug, section: "integrations", note: "Gmail, Google Calendar, and other apps the agent may use" },
    ],
  },
  {
    key: "app",
    items: [
      {
        key: "account",
        icon: CircleUserRound,
        label: "Account",
        match: "account",
        section: "account",
        description: "Sign-in, devices, sync, cloud",
        items: [
          { key: "profile", icon: CircleUserRound, section: "account", note: copyFor("native").nav.account },
          { key: "devices", icon: Laptop, section: "devices", note: "Keys, last seen, revoking" },
          { key: "sync", icon: RefreshCw, section: "sync", note: "Sessions, Spaces, restore points" },
          { key: "cloud", icon: Cloud, section: "cloud", note: "Runs elsewhere, channels" },
          { key: "egress", icon: Globe, section: "egress", note: "Your own address per Space" },
          { key: "vault", icon: KeyRound, section: "vault", note: "Sign-ins the agent may type" },
        ],
      },
      { key: "about", icon: Info, section: "about", note: "Version, data location" },
    ],
  },
];

/**
 * The same tree, in the words of the surface it is rendered on.
 *
 * Only one caption depends on where the shell is running: Account's, which
 * on a Mac ends "this Mac" — the machine whose keys the section enrolls. In
 * a browser tab there is no such machine, and the section itself renders
 * `Unavailable` with the host's own reason, so the caption beside the icon
 * must not promise one either. Everything else is the same on both.
 */
export function settingsNavFor(surface: CopySurface): NavSection[] {
  const note = copyFor(surface).nav.account;
  const reword = (entry: NavEntry): NavEntry => {
    if (isNavGroup(entry)) return { ...entry, items: entry.items.map(reword) };
    return entry.section === "account" ? { ...entry, note } : entry;
  };
  return SETTINGS_NAV.map((section) => ({ ...section, items: section.items.map(reword) }));
}
