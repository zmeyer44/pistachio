/**
 * `pistachio-extension.schema.json`: the manifest's JSON Schema, generated
 * from the zod schema (src/manifest.ts) so an editor in the dev folder
 * validates `pistachio.json` as it is typed. What JSON Schema cannot say —
 * a host pattern's shape, a tool without `agent:tools`, a command without a
 * worker — main still checks on load and writes to `.pistachio/status.json`.
 * `scripts/write-schema.mjs` writes it; a test keeps the checked-in copy current.
 */

import { z } from "zod";
import { ALL_URLS } from "./capabilities.js";
import { HOST_PATTERN, hostPatternSchema, manifestSchema } from "./manifest.js";

export function manifestJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(manifestSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
    // A host is a refinement zod cannot export: say it in JSON Schema's words.
    override: (context) => {
      if (context.zodSchema === hostPatternSchema) context.jsonSchema.anyOf = [{ const: ALL_URLS }, { pattern: HOST_PATTERN.source }];
    },
  }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return {
    $schema,
    title: "pistachio.json",
    description: "A Pistachio extension's manifest (docs/extensions.md §3). The API is pistachio.d.ts; the guide is AGENTS.md.",
    ...rest,
  };
}

/** The file's text, as checked in. */
export function manifestJsonSchemaText(): string {
  return `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;
}
