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
  tabs: ["tabs_list", "tab_open", "tab_show"],
  navigate: ["page_navigate", "page_back", "page_forward", "page_reload"],
  read: ["page_inspect"],
  screenshot: ["page_screenshot"],
  interact: ["page_click", "page_type", "page_press", "page_scroll"],
  memory: ["memory_search", "memory_add", "memory_update", "memory_forget"],
  reminders: ["reminder_list", "reminder_create", "reminder_update", "reminder_cancel"],
  artifacts: ["artifact_list", "artifact_create", "artifact_update"],
  bookmarks: ["bookmark_search", "bookmark_create", "bookmark_update", "bookmark_delete"],
  watchtower: ["watchtower_search", "watchtower_read", "watchtower_index", "watchtower_entity"],
  notes: ["task_notes"],
  /** The person's own notes (docs/notes.md N7). `notes` above is the run's scratchpad. */
  user_notes: ["note_list", "note_search", "note_read", "note_create", "note_update", "note_delete"],
  /** The desk a turn works at and its group's context (docs/desk-agent.md §2); host-supplied, desktop only. */
  desk: ["desk_state", "desk_arrange", "desk_note", "desk_ungroup", "context_read", "context_save"],
  // Each dedicated integration is a group of its own, named for its
  // provider, so a policy can allow the browser and memory but not mail.
  gmail: GMAIL_TOOL_NAMES,
  google_calendar: GOOGLE_CALENDAR_TOOL_NAMES,
  /**
   * The tools of the extensions the person installed (docs/extensions.md §6.2,
   * "Agent tools"). Their names are minted per extension at run time
   * (`x_<six hex of the id>_<tool>`, extension-tools.ts), so the list is empty
   * and `toolGroupOf` places every `x_` name here: a policy can turn them off.
   */
  extensions: [],
} as const satisfies Record<string, readonly string[]> & Record<IntegrationProvider, readonly string[]>;

export type ToolGroup = keyof typeof TOOL_GROUPS;

export const ALL_TOOL_GROUPS: readonly ToolGroup[] = Object.keys(TOOL_GROUPS) as ToolGroup[];

/**
 * The author turn's tools (docs/extensions.md §8): writing an extension into
 * its draft folder. A group of their own that is NOT in `TOOL_GROUPS`, so not
 * in `ALL_TOOL_GROUPS` either: no default policy, and no policy a host builds
 * from the groups it lists, ever enables them. Only the runner's author turn
 * (`AiAgentRunInput.author`) names this group, and nothing else beside it.
 */
export const EXTENSION_AUTHOR_TOOL_GROUP = "extension_author";
export const EXTENSION_AUTHOR_TOOLS = ["extension_draft_write", "extension_draft_read", "extension_status"] as const;

/** The prefix of every extension tool's model-facing name (`x_<hex>_<tool>`). */
export const EXTENSION_TOOL_PREFIX = "x_";

/** The groups that are integrations: one per provider in the catalog. */
export const INTEGRATION_TOOL_GROUPS: readonly ToolGroup[] = [...INTEGRATION_PROVIDERS];

/** Tools no policy can turn off: the ones that pause for the person. */
export const ALWAYS_ENABLED_TOOLS: readonly string[] = ["ask_user", "ask_user_text", "request_credentials", "request_takeover"];

const GROUP_OF = new Map<string, ToolGroup>();
for (const group of ALL_TOOL_GROUPS) for (const name of TOOL_GROUPS[group]) GROUP_OF.set(name, group);

/**
 * The group a model-facing tool name belongs to; null for the always-on tools
 * and unknown names. An `x_…` name is an extension's (the `extensions` group);
 * the author turn's three are `extension_author`, a group no default holds.
 */
export function toolGroupOf(toolName: string): ToolGroup | typeof EXTENSION_AUTHOR_TOOL_GROUP | null {
  const known = GROUP_OF.get(toolName);
  if (known !== undefined) return known;
  if (toolName.startsWith(EXTENSION_TOOL_PREFIX)) return "extensions";
  if ((EXTENSION_AUTHOR_TOOLS as readonly string[]).includes(toolName)) return EXTENSION_AUTHOR_TOOL_GROUP;
  return null;
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
