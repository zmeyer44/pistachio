/**
 * The dashboard rail's nav tree.
 *
 * Groups own their own menu: selecting one swaps the rail's list for its
 * items rather than only navigating. WHICH MENU IS OPEN IS A FUNCTION OF THE
 * ADDRESS — landing anywhere a group owns opens that group, whether you got
 * there by clicking, by deep link, or by the back button.
 *
 * The desktop's settings rail expresses that ownership as a single route
 * PREFIX, because its sections nest. These routes do not: /app/memory is not
 * under /app/library. So a group here owns the union of its descendants'
 * paths, computed rather than declared, and `href` is where selecting the
 * group lands you.
 */

import type { LucideIcon } from "lucide-react";
import {
  AlarmClock,
  Bookmark,
  Bot,
  Boxes,
  Brain,
  CircleUserRound,
  CreditCard,
  Gauge,
  Globe,
  KeyRound,
  Laptop,
  Layers,
  MessageCircle,
  NotebookPen,
  PanelsTopLeft,
  Radio,
  Server,
  Settings,
  Users,
  Plug,
} from "lucide-react";

/**
 * The browser app (docs/web-browser-design.md §15). A different origin, with
 * its own device and its own keys; this dashboard only points at it.
 */
const BROWSER_URL =
  process.env["NEXT_PUBLIC_PISTACHIO_BROWSER_URL"]?.trim() || "http://localhost:3001";

export interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
  /**
   * Extra route prefixes the item is the active entry for — a run detail page
   * has no nav row of its own, so Agent keeps the highlight while you read it.
   */
  covers?: string[];
  /**
   * An address on another site rather than a route here, so the rail links to
   * it plainly instead of routing to it. Nothing on this site is ever active
   * because of it.
   */
  external?: boolean;
}

/** A nav entry that owns its own menu. Recursive: a group may hold groups. */
export interface NavGroup {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Caption under the title in the group's menu header. */
  description: string;
  /** Where selecting the group lands. Must be one of its descendants. */
  href: string;
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

export const APP_NAV: NavSection[] = [
  {
    key: "work",
    items: [
      {
        key: "agent",
        label: "Agent",
        icon: Bot,
        href: "/app",
        covers: ["/app/runs"],
      },
      // The browser itself, which is its own site now (§15). It sits with the
      // agent because it is the same tabs: what the agent works in is what
      // this opens, and a run started from either acts in the other.
      {
        key: "browse",
        label: "Open the browser",
        icon: Globe,
        href: BROWSER_URL,
        external: true,
      },
      {
        key: "library",
        label: "Library",
        icon: Layers,
        description: "What the agent keeps for you",
        href: "/app/bookmarks",
        items: [
          { key: "bookmarks", label: "Bookmarks", icon: Bookmark, href: "/app/bookmarks" },
          { key: "reminders", label: "Reminders", icon: AlarmClock, href: "/app/reminders" },
          { key: "memory", label: "Memory", icon: Brain, href: "/app/memory" },
          { key: "artifacts", label: "Artifacts", icon: PanelsTopLeft, href: "/app/artifacts" },
          { key: "notes", label: "Notes", icon: NotebookPen, href: "/app/notes" },
          { key: "shared", label: "Shared with me", icon: Users, href: "/app/shared" },
        ],
      },
      {
        key: "infrastructure",
        label: "Infrastructure",
        icon: Server,
        description: "Spaces, devices, channels",
        href: "/app/spaces",
        items: [
          { key: "spaces", label: "Spaces", icon: Boxes, href: "/app/spaces" },
          { key: "devices", label: "Devices", icon: Laptop, href: "/app/devices" },
          { key: "channels", label: "Channels", icon: Radio, href: "/app/channels" },
        ],
      },
      {
        key: "settings",
        label: "Settings",
        icon: Settings,
        description: "Account, usage, billing, vault, integrations",
        // `/app/settings` itself redirects here, so the group opens on its first page.
        href: "/app/settings/account",
        items: [
          { key: "account", label: "Account", icon: CircleUserRound, href: "/app/settings/account" },
          { key: "usage", label: "Model usage", icon: Gauge, href: "/app/settings/usage" },
          { key: "billing", label: "Plan & billing", icon: CreditCard, href: "/app/settings/billing" },
          { key: "imessage", label: "iMessage", icon: MessageCircle, href: "/app/settings/imessage" },
          { key: "vault", label: "Vault", icon: KeyRound, href: "/app/settings/vault" },
          { key: "integrations", label: "Integrations", icon: Plug, href: "/app/settings/integrations" },
        ],
      },
    ],
  },
];

/** Every path an entry answers for, deepest group included. */
export function pathsOf(entry: NavEntry): string[] {
  if (isNavGroup(entry)) return entry.items.flatMap(pathsOf);
  return [entry.href, ...(entry.covers ?? [])];
}

/** Exact match, or a path segment under it — never a bare string prefix. */
export function covers(path: string, pathname: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function isActive(entry: NavEntry, pathname: string): boolean {
  return pathsOf(entry).some((path) => covers(path, pathname));
}
