/**
 * The approval sheet's lines for a Pistachio extension (docs/extensions.md
 * §2, §6.1): fixed sentences per capability, broadest first, never the
 * extension's own words. Pure, so main and the tests share it.
 */

import { createHash } from "node:crypto";
import { CAPABILITY_INFO, TIER_ORDER, isEverySite, type Capability, type CapabilityTier } from "./capabilities.js";
import type { PistachioManifest } from "./manifest.js";

export interface SheetLine {
  tier: CapabilityTier;
  text: string;
}

export interface Sheet {
  adds: string[];
  can: SheetLine[];
  declares: string[];
  manifestHash: string;
}

/** A stable hash of the manifest's asks and surfaces: what an approval names. */
export function manifestHash(manifest: PistachioManifest): string {
  const canonical = JSON.stringify({
    id: manifest.id,
    permissions: [...(manifest.permissions ?? [])].sort(),
    hosts: [...(manifest.hosts ?? [])].sort(),
    worker: manifest.worker ?? null,
    panel: manifest.panel ?? null,
    pages: manifest.pages ?? null,
    action: manifest.action ?? null,
    bar: manifest.bar ?? null,
    tools: manifest.tools ?? null,
    contextMenus: manifest.contextMenus ?? null,
    commands: manifest.commands ?? null,
    settings: manifest.settings ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** Hosts in words: "api.github.com", "api.github.com and 2 other sites", "every site". */
export function hostsInWords(hosts: readonly string[]): string {
  if (hosts.some(isEverySite)) return "every site";
  const names = hosts.map(hostName).filter((name, index, all) => all.indexOf(name) === index);
  if (names.length === 0) return "no sites";
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} other sites`;
}

function hostName(pattern: string): string {
  const match = /^(?:\*|https?|wss?):\/\/([^/]+)\//.exec(pattern);
  const host = match?.[1] ?? pattern;
  return host.startsWith("*.") ? `every ${host.slice(2)} site` : host.replace(/:\d+$/, "");
}

export function sheetFor(manifest: PistachioManifest): Sheet {
  const adds: string[] = [];
  if (manifest.panel !== undefined) adds.push("a panel on the Ledge");
  else if (manifest.action === true) adds.push("a button on the Ledge");
  for (const command of manifest.bar?.commands ?? []) adds.push(`/${command.name} in the Bar`);
  const pageCount = Object.keys(manifest.pages ?? {}).length;
  if (pageCount === 1) adds.push("a window of its own");
  else if (pageCount > 1) adds.push(`${pageCount} windows of its own`);
  const menuCount = manifest.contextMenus?.length ?? 0;
  if (menuCount === 1) adds.push("an item in the right-click menu");
  else if (menuCount > 1) adds.push(`${menuCount} items in the right-click menu`);
  const toolCount = manifest.tools?.length ?? 0;
  if (toolCount === 1) adds.push("a tool the agent can call");
  else if (toolCount > 1) adds.push(`${toolCount} tools the agent can call`);
  for (const key of manifest.commands ?? []) if (key.key !== undefined) adds.push(`the shortcut ${key.key.replace(/\+/g, " ")}`);
  if ((manifest.settings?.length ?? 0) > 0) adds.push("settings of its own");

  const can: SheetLine[] = [];
  const hosts = manifest.hosts ?? [];
  const words = hostsInWords(hosts);
  for (const capability of manifest.permissions ?? []) {
    const info = CAPABILITY_INFO[capability as Capability];
    if (info === undefined) continue;
    can.push({ tier: info.tier, text: info.line.replace("{hosts}", words) });
  }
  if (hosts.length > 0) {
    // (Every site is Critical however it is spelled: `*://*/*` reaches what `<all_urls>` does.)
    const everySite = hosts.some(isEverySite);
    can.push({ tier: everySite ? "critical" : "medium", text: everySite ? "Can talk to every site on the web." : `Talks to ${words}.` });
  }
  can.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);

  const declares = [
    ...(manifest.permissions ?? []).map((p) => `permission ${p}`),
    ...hosts.map((h) => `host ${h}`),
    ...(manifest.tools ?? []).map((t) => `tool ${t.name} (${t.effect}): ${t.description}`),
  ];
  return { adds, can, declares, manifestHash: manifestHash(manifest) };
}
