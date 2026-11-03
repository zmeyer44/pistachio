/**
 * `pistachio.json` (docs/extensions.md §3): the one source for the manifest's
 * types, main's validator and the JSON Schema in the dev folder.
 */

import { z } from "zod";
import { ALL_URLS, CAPABILITIES } from "./capabilities.js";

export const EXTENSION_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+){1,4}$/;
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
export const SETTING_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
/** A relative path inside the folder: no `..`, no leading `/`, no `.pistachio/`. */
export const RELATIVE_FILE_PATTERN = /^(?!\.pistachio\/)(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0]+$/;

const relativeFile = z.string().min(1).max(200).regex(RELATIVE_FILE_PATTERN, "a path inside the extension's folder");

/** `https://api.github.com/*`, `*://*.example.com/*`, or `<all_urls>`. */
export const HOST_PATTERN = /^(\*|https?|wss?):\/\/(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*)(:\d+)?\/.*$/;

export const hostPatternSchema = z.string().refine((value) => value === ALL_URLS || HOST_PATTERN.test(value), {
  message: "a match pattern like https://api.github.com/* (or <all_urls>)",
});

export const barCommandSchema = z.object({
  name: z.string().regex(COMMAND_NAME_PATTERN, "lowercase letters, digits and dashes"),
  description: z.string().min(1).max(120),
  arg: z.object({ hint: z.string().min(1).max(60), required: z.boolean().optional() }).optional(),
  run: z.union([z.object({ prompt: z.string().min(1).max(2000) }), z.object({ event: z.literal(true) })]),
});

const jsonSchemaObject = z
  .object({ type: z.literal("object"), properties: z.record(z.string(), z.unknown()).optional(), required: z.array(z.string()).optional() })
  .passthrough();

export const toolSchema = z.object({
  name: z.string().regex(TOOL_NAME_PATTERN, "lowercase letters, digits and underscores"),
  description: z.string().min(1).max(400),
  input: jsonSchemaObject,
  effect: z.enum(["read", "write"]),
});

export const CONTEXT_MENU_CONTEXTS = ["page", "selection", "link", "image", "window"] as const;

export const contextMenuSchema = z.object({
  id: z.string().regex(COMMAND_NAME_PATTERN),
  title: z.string().min(1).max(60),
  contexts: z.array(z.enum(CONTEXT_MENU_CONTEXTS)).min(1),
  hosts: z.array(hostPatternSchema).optional(),
});

/** `Cmd+Shift+6`, `Ctrl+Alt+R`: Cmd/Ctrl/Alt/Shift plus one key. */
export const KEY_PATTERN = /^((Cmd|Ctrl|Alt|Shift)\+){1,4}([A-Z0-9]|F[1-9]|F1[0-2]|Up|Down|Left|Right|Space|Enter|Escape|Tab|Backspace|Delete|[,.\/;'\[\]\\`=-])$/;

export const keyCommandSchema = z.object({
  id: z.string().regex(COMMAND_NAME_PATTERN),
  title: z.string().min(1).max(60),
  key: z.string().regex(KEY_PATTERN, "Cmd/Ctrl/Alt/Shift plus one key, like Cmd+Shift+6").optional(),
});

const settingBase = { key: z.string().regex(SETTING_KEY_PATTERN), title: z.string().min(1).max(60), description: z.string().max(200).optional() };

export const settingSchema = z.discriminatedUnion("type", [
  z.object({ ...settingBase, type: z.literal("boolean"), default: z.boolean().optional() }),
  z.object({ ...settingBase, type: z.literal("string"), default: z.string().max(2000).optional(), placeholder: z.string().max(60).optional() }),
  z.object({ ...settingBase, type: z.literal("number"), default: z.number().optional(), min: z.number().optional(), max: z.number().optional() }),
  z.object({ ...settingBase, type: z.literal("enum"), options: z.array(z.string().min(1).max(40)).min(1).max(20), default: z.string().optional() }),
  z.object({ ...settingBase, type: z.literal("secret") }),
]);

export const manifestSchema = z
  .object({
    $schema: z.string().optional(),
    api: z.literal(1),
    id: z.string().regex(EXTENSION_ID_PATTERN, "a reverse-DNS id like dev.zach.gh-inbox (lowercase, at least one dot)").max(80),
    name: z.string().min(1).max(40),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "semver, like 1.0.0"),
    description: z.string().max(200).optional(),
    icon: relativeFile.optional(),
    permissions: z.array(z.enum(CAPABILITIES)).optional(),
    hosts: z.array(hostPatternSchema).max(50).optional(),
    worker: z.object({ type: z.literal("web"), main: relativeFile }).optional(),
    panel: z.object({ file: relativeFile, width: z.number().int().min(240).max(480).optional(), height: z.number().int().min(120).max(1200).optional() }).optional(),
    pages: z.record(z.string().regex(COMMAND_NAME_PATTERN), z.object({ file: relativeFile, title: z.string().min(1).max(60), singleton: z.boolean().optional() })).optional(),
    action: z.literal(true).optional(),
    bar: z.object({ commands: z.array(barCommandSchema).max(20) }).optional(),
    tools: z.array(toolSchema).max(20).optional(),
    contextMenus: z.array(contextMenuSchema).max(20).optional(),
    commands: z.array(keyCommandSchema).max(10).optional(),
    settings: z.array(settingSchema).max(30).optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const handled = new Set<string>();
    for (const [index, command] of (manifest.bar?.commands ?? []).entries()) {
      if (handled.has(command.name)) ctx.addIssue({ code: "custom", path: ["bar", "commands", index, "name"], message: `"${command.name}" is declared twice` });
      handled.add(command.name);
    }
    const toolNames = new Set<string>();
    for (const [index, tool] of (manifest.tools ?? []).entries()) {
      if (toolNames.has(tool.name)) ctx.addIssue({ code: "custom", path: ["tools", index, "name"], message: `"${tool.name}" is declared twice` });
      toolNames.add(tool.name);
    }
    const needsWorker = (manifest.bar?.commands ?? []).some((c) => "event" in c.run) || (manifest.tools?.length ?? 0) > 0 || (manifest.contextMenus?.length ?? 0) > 0 || (manifest.commands?.length ?? 0) > 0 || manifest.action === true;
    if (needsWorker && manifest.worker === undefined) {
      ctx.addIssue({ code: "custom", path: ["worker"], message: "a Bar command that runs an event, a tool, a menu item, a key command or an action needs a worker: add \"worker\": { \"type\": \"web\", \"main\": \"worker.js\" }" });
    }
    if ((manifest.tools?.length ?? 0) > 0 && !(manifest.permissions ?? []).includes("agent:tools")) {
      ctx.addIssue({ code: "custom", path: ["permissions"], message: 'tools need "agent:tools" in permissions' });
    }
    if (manifest.panel !== undefined && manifest.action === true) {
      ctx.addIssue({ code: "custom", path: ["action"], message: "an extension with a panel has no separate action: the icon opens the panel" });
    }
    const keys = new Set<string>();
    for (const [index, setting] of (manifest.settings ?? []).entries()) {
      if (keys.has(setting.key)) ctx.addIssue({ code: "custom", path: ["settings", index, "key"], message: `"${setting.key}" is declared twice` });
      keys.add(setting.key);
    }
  });

export type PistachioManifest = z.infer<typeof manifestSchema>;
export type BarCommandDecl = z.infer<typeof barCommandSchema>;
export type ToolDecl = z.infer<typeof toolSchema>;
export type ContextMenuDecl = z.infer<typeof contextMenuSchema>;
export type KeyCommandDecl = z.infer<typeof keyCommandSchema>;
export type SettingDecl = z.infer<typeof settingSchema>;

export interface ManifestIssue {
  path: string;
  message: string;
}

export type ManifestResult = { ok: true; manifest: PistachioManifest } | { ok: false; issues: ManifestIssue[] };

/** Parse the text of a `pistachio.json`; issues are worded so the author (a person or an agent) can fix them. */
export function parseManifest(text: string): ManifestResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    return { ok: false, issues: [{ path: "", message: `pistachio.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  return validateManifest(value);
}

export function validateManifest(value: unknown): ManifestResult {
  const result = manifestSchema.safeParse(value);
  if (result.success) return { ok: true, manifest: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map((part) => String(part)).join("."),
      message: issue.message,
    })),
  };
}

/** The files a manifest names, for the loader to check they exist. */
export function manifestFiles(manifest: PistachioManifest): string[] {
  const files: string[] = [];
  if (manifest.icon !== undefined) files.push(manifest.icon);
  if (manifest.worker !== undefined) files.push(manifest.worker.main);
  if (manifest.panel !== undefined) files.push(manifest.panel.file);
  for (const page of Object.values(manifest.pages ?? {})) files.push(page.file);
  return files;
}

/** The capabilities and hosts a manifest asks for, as a grant would record them. */
export function manifestAsks(manifest: PistachioManifest): { capabilities: string[]; hosts: string[] } {
  return {
    capabilities: [...new Set(manifest.permissions ?? [])].sort(),
    hosts: [...new Set(manifest.hosts ?? [])].sort(),
  };
}

/** What a newer manifest asks for beyond an older grant; empty when nothing widened. */
export function widenedAsks(
  grant: { capabilities: readonly string[]; hosts: readonly string[] },
  manifest: PistachioManifest,
): { capabilities: string[]; hosts: string[] } {
  const asks = manifestAsks(manifest);
  return {
    capabilities: asks.capabilities.filter((c) => !grant.capabilities.includes(c)),
    hosts: asks.hosts.filter((h) => !grant.hosts.includes(h)),
  };
}
