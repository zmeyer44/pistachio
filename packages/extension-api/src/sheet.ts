/**
 * The approval sheet's lines for a Pistachio extension (docs/extensions.md
 * §2, §6.1): fixed sentences per capability, broadest first, never the
 * extension's own words. Pure, so main and the tests share it.
 */

import { createHash } from "node:crypto";
import { CAPABILITY_INFO, TIER_ORDER, isEverySite, type Capability, type CapabilityTier } from "./capabilities.js";
import { manifestSites, type PistachioManifest } from "./manifest.js";
import { SITE_ADDS } from "./sites.js";
import { triggerInWords, triggerKeys } from "./triggers.js";

export interface SheetLine {
  tier: CapabilityTier;
  text: string;
}

export interface Sheet {
  adds: string[];
  can: SheetLine[];
  /**
   * When it runs by itself, one line a trigger, from the declared data alone (./triggers.ts triggerInWords): "Sundays
   * 8:00 AM–11:00 PM". Empty for an extension that only ever runs when the person runs it.
   */
  runs: string[];
  /** Under those lines, when there are any: what it may do with nobody there (`runsLimit`). */
  runsLimit?: string;
  declares: string[];
  manifestHash: string;
}

/**
 * What an extension that runs by itself may do with nobody there, said from what it asks for — everything main allows
 * then (EXT_UNATTENDED_METHODS) beyond looking, keeping its own notes and telling the person things: what it may do
 * to their spaces, tabs and backdrop (each written down, with its Undo), what it may show (removed where it is
 * shown), the sites it may talk to and the model it may ask. One that asks for none of them changes nothing of the
 * person's, and the sheet says that instead.
 */
export function runsLimit(manifest: Pick<PistachioManifest, "permissions" | "hosts" | "band" | "sidebar">): string {
  const asks = new Set<string>(manifest.permissions ?? []);
  const hosts = manifest.hosts ?? [];
  // (Which spaces: the ones the person ran it in — or, with `spaces:all`, any.)
  const which = asks.has("spaces:all") ? "your spaces" : "spaces you gave it";
  // What main writes down as it happens, each with its way back.
  const listed: string[] = [];
  if (asks.has("spaces:write") && asks.has("spaces:close")) listed.push(`send away, close and bring back ${which}`);
  else if (asks.has("spaces:write")) listed.push(`send away and bring back ${which}`);
  else if (asks.has("spaces:close")) listed.push(`close ${which} into the archive`);
  if (asks.has("tabs:write")) listed.push("open tabs behind what you are doing");
  if (asks.has("theme")) listed.push("change the backdrop");
  // What is not written down: it says whose it is where it is drawn, or it changes nothing of the person's.
  const quiet: string[] = [];
  if (asks.has("spaces:mark") || asks.has("tabs:mark") || manifest.band === true || manifest.sidebar === true) quiet.push("update what it shows");
  if (hosts.length > 0) quiet.push(`talk to ${hostsInWords(hosts)}`);
  if (asks.has("ai")) quiet.push("ask Pistachio's AI");
  const may = [...listed, ...quiet];
  if (may.length === 0) return "With nobody there it changes nothing of yours: it can only look, keep its own notes and tell you things.";
  const list = may.length === 1 ? (may[0] as string) : `${may.slice(0, -1).join(", ")} and ${may[may.length - 1] as string}`;
  const sentence = `With nobody there it can only ${list}.`;
  return listed.length === 0 ? sentence : `${sentence} What it does to your spaces and tabs is listed, and can be undone.`;
}

/**
 * A stable hash of the manifest's asks and surfaces: what an approval names. Its triggers are among them (as
 * triggerKeys names them), and the places it fills with rows — each only when it declares any, so a manifest with
 * none hashes as it did before there were either.
 */
export function manifestHash(manifest: PistachioManifest): string {
  const triggers = triggerKeys(manifest.triggers);
  const sites = manifestSites(manifest);
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
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(sites.length > 0 ? { sites } : {}),
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
  for (const site of manifestSites(manifest)) adds.push(SITE_ADDS[site]);
  const pageCount = Object.keys(manifest.pages ?? {}).length;
  if (pageCount === 1) adds.push("a window of its own");
  else if (pageCount > 1) adds.push(`${pageCount} windows of its own`);
  // (A page's menu, a window's ⋯, a tab's menu, a space's: all the person's right-click, or its ⋯.)
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
    ...(manifest.triggers ?? []).map((t) => `trigger ${t.id}: ${triggerInWords(t, manifest.triggers)}`),
  ];
  const runs = (manifest.triggers ?? []).map((t) => triggerInWords(t, manifest.triggers));
  return { adds, can, runs, ...(runs.length > 0 ? { runsLimit: runsLimit(manifest) } : {}), declares, manifestHash: manifestHash(manifest) };
}
