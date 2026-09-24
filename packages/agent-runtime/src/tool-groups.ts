/**
 * The agent's tools by group, for a run policy that enables some of them.
 * Every model-facing tool name belongs to exactly one group, except the
 * four that pause the run for the person — `ask_user`, `ask_user_text`,
 * `request_takeover`, and `request_credentials` — which are always on: a
 * policy that narrows what the agent may do must still let it hand a
 * decision back. `request_credentials` is on this list for the same reason
 * as the others, and a host that does not offer the encrypted handoff never
 * registers it in the first place (runner.ts), so no policy has to.
 */

import type { ToolSet } from "ai";
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from "@pistachio/protocol";
import { GMAIL_TOOL_NAMES } from "./integrations/gmail/tools.js";
import { GOOGLE_CALENDAR_TOOL_NAMES } from "./integrations/google-calendar/tools.js";

export const TOOL_GROUPS = {
  tabs: ["tabs_list", "tab_open", "tab_focus"],
  navigate: ["page_navigate", "page_back", "page_forward", "page_reload"],
  read: ["page_inspect"],
  screenshot: ["page_screenshot"],
  interact: ["page_click", "page_type", "page_press", "page_scroll"],
  memory: ["memory_search", "memory_add", "memory_update", "memory_forget"],
  reminders: ["reminder_list", "reminder_create", "reminder_update", "reminder_cancel"],
  artifacts: ["artifact_list", "artifact_create", "artifact_update"],
  bookmarks: ["bookmark_search", "bookmark_create", "bookmark_update", "bookmark_delete"],
  watchtower: ["watchtower_search", "watchtower_read"],
  notes: ["task_notes"],
  /** The person's own notes (docs/notes.md N7). `notes` above is the run's scratchpad. */
  user_notes: ["note_list", "note_search", "note_read", "note_create", "note_update", "note_delete"],
  // Each dedicated integration is a group of its own, named for its
  // provider, so a policy can allow the browser and memory but not mail.
  gmail: GMAIL_TOOL_NAMES,
  google_calendar: GOOGLE_CALENDAR_TOOL_NAMES,
} as const satisfies Record<string, readonly string[]> & Record<IntegrationProvider, readonly string[]>;

export type ToolGroup = keyof typeof TOOL_GROUPS;

export const ALL_TOOL_GROUPS: readonly ToolGroup[] = Object.keys(TOOL_GROUPS) as ToolGroup[];

/** The groups that are integrations: one per provider in the catalog. */
export const INTEGRATION_TOOL_GROUPS: readonly ToolGroup[] = [...INTEGRATION_PROVIDERS];

/** Tools no policy can turn off: the ones that pause for the person. */
export const ALWAYS_ENABLED_TOOLS: readonly string[] = ["ask_user", "ask_user_text", "request_credentials", "request_takeover"];

const GROUP_OF = new Map<string, ToolGroup>();
for (const group of ALL_TOOL_GROUPS) for (const name of TOOL_GROUPS[group]) GROUP_OF.set(name, group);

/** The group a model-facing tool name belongs to; null for the always-on tools and unknown names. */
export function toolGroupOf(toolName: string): ToolGroup | null {
  return GROUP_OF.get(toolName) ?? null;
}

export function isToolGroup(value: string): value is ToolGroup {
  return Object.hasOwn(TOOL_GROUPS, value);
}

/**
 * Whether a tool is on under a policy that enables `enabledToolGroups`.
 * The always-on tools are; a tool in no group — a name this runtime does
 * not know — is not.
 */
export function isToolEnabled(toolName: string, enabledToolGroups: readonly string[]): boolean {
  if (ALWAYS_ENABLED_TOOLS.includes(toolName)) return true;
  const group = toolGroupOf(toolName);
  return group !== null && enabledToolGroups.includes(group);
}

/** The subset of `tools` a policy enables, in their original order. */
export function filterToolSet(tools: ToolSet, enabledToolGroups: readonly string[]): ToolSet {
  const kept: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    if (isToolEnabled(name, enabledToolGroups)) kept[name] = definition;
  }
  return kept;
}
