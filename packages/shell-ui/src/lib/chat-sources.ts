/**
 * Where a reply came from: the pages a turn's tool calls read (AgentToolCall.source),
 * gathered once each under the reply, and matched against the links the
 * reply makes so a link to a page the agent read draws as a citation chip
 * rather than as a bare address. Pure.
 */

import type { AgentSource, AgentToolCall } from "@pistachio/protocol";

/** A source with the number the chat cites it by: [1], [2], … in the order first read. */
export interface CitedSource extends AgentSource {
  index: number;
  host: string;
}

/** The host a source is shown as: the site, without its `www.`. */
export function sourceHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./iu, "");
  } catch {
    return url;
  }
}

/**
 * A page's address as it is compared: the scheme, the `www.`, a trailing
 * slash and a fragment all vary between how a page was read and how the
 * model wrote it back, and none of them make it another page.
 */
export function sourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/u, "");
    return `${parsed.host.replace(/^www\./iu, "").toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * The pages a turn read, once each in the order first read, numbered. A
 * page read twice — inspected, scrolled, inspected again — is one source,
 * and keeps the latest title the page reported.
 */
export function turnSources(toolCalls: readonly AgentToolCall[]): CitedSource[] {
  const byKey = new Map<string, CitedSource>();
  for (const call of toolCalls) {
    const source = call.source;
    if (source === undefined || call.status !== "completed") continue;
    const key = sourceKey(source.url);
    const seen = byKey.get(key);
    if (seen !== undefined) {
      seen.title = source.title;
      continue;
    }
    byKey.set(key, { ...source, index: byKey.size + 1, host: sourceHost(source.url) });
  }
  return [...byKey.values()];
}

/** The source a link points at, when the turn read that page. */
export function citedSource(sources: readonly CitedSource[], href: string): CitedSource | null {
  const key = sourceKey(href);
  return sources.find((source) => sourceKey(source.url) === key) ?? null;
}
