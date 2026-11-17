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
  "tabs:mark",
  "spaces:write",
  "spaces:close",
  "spaces:all",
  "spaces:mark",
  "theme",
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
  "ai",
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
  // (A mark on a tab's row: the shell's own drawing, named as the extension's, taken off by the person in one press.
  // On any tab it could see — a tab's grant by gesture lapses when the page moves on, and a mark must not. §4.7.)
  "tabs:mark": { tier: "low", line: "Puts a small mark on your tabs." },
  // (Reversible by its nature — a space away comes back as itself — and only for a space the person ran it in: docs/primitives.md §2.)
  "spaces:write": { tier: "medium", line: "Sends spaces away and brings them back." },
  // (Close space, as the person's own menu does it: filed in the archive whole, one Restore away. Its own line —
  // an extension approved to send spaces away was not approved to close them.)
  "spaces:close": { tier: "medium", line: "Closes spaces into the archive, where they can be restored." },
  // (Rule 8's exception, said as one: every space is as if the person had run it there. What it may then DO to them
  // is the other lines'. Docs/primitives.md §2.6.)
  "spaces:all": { tier: "high", line: "Acts on any of your spaces, not only the ones you ran it in." },
  // (What the shell draws for it, where the shell draws such things, named as its own — docs/primitives.md §4. A mark
  // only on a space the person ran it in; a backdrop on one such space, or — with nothing named — on every space.)
  "spaces:mark": { tier: "low", line: "Puts a small mark on the spaces you ran it in." },
  theme: { tier: "medium", line: "Changes the backdrop and accent colour of your spaces." },
  desk: { tier: "medium", line: "Sees how your windows are arranged on the desk." },
  "pages:read": { tier: "high", line: "Can read pages on {hosts}." },
  "capture:tab": { tier: "high", line: "Can record a window you choose, and the pages you move to while it records, with their sound." },
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
  // (A plain question to a model, no tools and no turn in a conversation: what it sends is its own to choose — the
  // other lines say what it can see — and the answer is its alone. Docs/primitives.md §3.8.)
  ai: { tier: "high", line: "Sends what it chooses to Pistachio's AI and reads the answer (spends your AI usage)." },
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
