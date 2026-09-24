/**
 * Dedicated integrations, as the runner sees them: a registry of tool
 * families keyed by provider, and the two things a run needs from it — the
 * tools for the accounts a person connected, and the rules that go with
 * them. Adding a provider is one `IntegrationDefinition` here plus its
 * catalog entry in `@pistachio/protocol`.
 */

import type { ToolSet } from "ai";
import type { IntegrationAccess, IntegrationProvider } from "@pistachio/protocol";
import type { AiAgentRunCallbacks } from "../runner.js";
import { GMAIL_INTEGRATION } from "./gmail/tools.js";
import { GOOGLE_CALENDAR_INTEGRATION } from "./google-calendar/tools.js";
import type { IntegrationDefinition, IntegrationToolDeps, IntegrationToolHost } from "./host.js";

export const INTEGRATIONS: Readonly<Record<IntegrationProvider, IntegrationDefinition>> = {
  gmail: GMAIL_INTEGRATION,
  google_calendar: GOOGLE_CALENDAR_INTEGRATION,
};

export function integrationDefinition(provider: IntegrationProvider): IntegrationDefinition {
  return INTEGRATIONS[provider];
}

/** The model-facing tool names an access level unlocks for a provider. */
export function integrationToolNames(provider: IntegrationProvider, access: IntegrationAccess): readonly string[] {
  return INTEGRATIONS[provider].toolNamesFor(access);
}

/**
 * One host per provider: a run binds at most one account of each, since the
 * tools name the account and a second would need every tool to ask which.
 * The first host for a provider wins; the controller decides the order.
 */
function onePerProvider(hosts: readonly IntegrationToolHost[]): IntegrationToolHost[] {
  const seen = new Set<IntegrationProvider>();
  const kept: IntegrationToolHost[] = [];
  for (const host of hosts) {
    if (seen.has(host.provider)) continue;
    seen.add(host.provider);
    kept.push(host);
  }
  return kept;
}

/** The tools for every connected account, each family gated by its access level. */
export function integrationTools(hosts: readonly IntegrationToolHost[], callbacks: AiAgentRunCallbacks, deps: IntegrationToolDeps = {}): ToolSet {
  const tools: ToolSet = {};
  for (const host of onePerProvider(hosts)) Object.assign(tools, INTEGRATIONS[host.provider].tools(host, callbacks, deps));
  return tools;
}

/** The prompt rules for every connected account, in the order the hosts came. */
export function integrationRules(hosts: readonly IntegrationToolHost[]): string {
  return onePerProvider(hosts).map((host) => INTEGRATIONS[host.provider].rules(host)).join("");
}

export type { IntegrationDefinition, IntegrationToolDeps, IntegrationToolHost } from "./host.js";
export { traced } from "./host.js";
export * from "./hosts.js";
export * from "./oauth.js";
export { GmailApiError, GmailClient, GMAIL_API_BASE, type GmailClientOptions, type GmailProfile } from "./gmail/client.js";
export * from "./gmail/mime.js";
export {
  GMAIL_INTEGRATION,
  GMAIL_TOOL_NAMES,
  GMAIL_TOOLS_BY_ACCESS,
  gmailAccountLabel,
  gmailRules,
  gmailTools,
  type GmailSearchHit,
} from "./gmail/tools.js";
export {
  GoogleCalendarApiError,
  GoogleCalendarClient,
  GOOGLE_CALENDAR_API_BASE,
  type CalendarListEntry,
  type GoogleCalendarClientOptions,
} from "./google-calendar/client.js";
export * from "./google-calendar/events.js";
export {
  GOOGLE_CALENDAR_INTEGRATION,
  GOOGLE_CALENDAR_TOOL_NAMES,
  GOOGLE_CALENDAR_TOOLS_BY_ACCESS,
  googleCalendarAccountLabel,
  googleCalendarRules,
  googleCalendarTools,
} from "./google-calendar/tools.js";
