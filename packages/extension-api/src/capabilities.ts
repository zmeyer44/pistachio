/**
 * What a Pistachio extension may ask for (docs/extensions.md §6.1): one
 * capability per namespace, each with a tier and the fixed sentence the
 * approval sheet shows for it. The sheet never shows an extension's own
 * words about itself, so an LLM-written manifest cannot talk its way past
 * the person.
 */

export const CAPABILITIES = [
  "tabs:read",
  "tabs:write",
  "desk",
  "pages:read",
  "capture:tab",
  "input:events",
  "media:microphone",
  "media:camera",
  "files:data",
  "clipboard:write",
  "clipboard:read",
  "notifications",
  "notes:read",
  "notes:write",
  "agent:tools",
  "agent:ask",
  "power",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilityTier = "low" | "medium" | "high" | "critical";

export interface CapabilityInfo {
  tier: CapabilityTier;
  /** The sheet's sentence. `{hosts}` is replaced by the granted hosts, in words. */
  line: string;
}

export const CAPABILITY_INFO: Record<Capability, CapabilityInfo> = {
  "tabs:read": { tier: "medium", line: "Sees the titles and addresses of your tabs." },
  "tabs:write": { tier: "medium", line: "Opens, moves and closes tabs." },
  desk: { tier: "medium", line: "Sees how your windows are arranged on the desk." },
  "pages:read": { tier: "high", line: "Can read pages on {hosts}." },
  "capture:tab": { tier: "high", line: "Can record a window you choose, with its sound." },
  "input:events": { tier: "high", line: "Sees what you click and where you type in a recorded window (never your passwords, never the characters)." },
  "media:microphone": { tier: "high", line: "Can use the microphone." },
  "media:camera": { tier: "high", line: "Can use the camera." },
  "files:data": { tier: "medium", line: "Keeps files of its own on this Mac." },
  "clipboard:write": { tier: "low", line: "Puts things on your clipboard." },
  "clipboard:read": { tier: "high", line: "Reads your clipboard when you use it." },
  notifications: { tier: "low", line: "Shows notifications." },
  "notes:read": { tier: "medium", line: "Reads your notes." },
  "notes:write": { tier: "high", line: "Reads and writes your notes." },
  "agent:tools": { tier: "high", line: "The agent can call it and send it what it reads, when you let it." },
  "agent:ask": { tier: "high", line: "Can ask the agent on your behalf (spends your AI usage)." },
  power: { tier: "low", line: "Can keep the Mac awake while it works." },
};

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}

/** Hosts a manifest may name; `<all_urls>` is the Critical tier. */
export const ALL_URLS = "<all_urls>";

// Whether a host pattern names every site: `<all_urls>`, or a pattern whose host is `*` under any scheme and any
// port (the star-scheme, star-host, star-path spelling; the https one) — the Critical tier, whichever spelling
// (AGENTS.md §6). (A line comment: that spelling would end a block comment.)
export function isEverySite(pattern: string): boolean {
  return pattern === ALL_URLS || /^(?:\*|https?|wss?):\/\/\*(?::(?:\*|\d+))?\//u.test(pattern);
}

export const TIER_ORDER: Record<CapabilityTier, number> = { critical: 0, high: 1, medium: 2, low: 3 };
