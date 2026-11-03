#!/usr/bin/env node
// Writes schema/pistachio-extension.schema.json from the manifest's zod schema
// (src/schema.ts → z.toJSONSchema). Run after changing src/manifest.ts:
//   pnpm --filter @pistachio/extension-api schema
// test/manifest.test.ts fails while the checked-in file is stale.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The sources import "./x.js" as TypeScript writes it; Node runs the .ts beside it (type stripping, Node ≥ 22.18).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { manifestJsonSchemaText } = await import("../src/schema.ts");
const target = fileURLToPath(new URL("../schema/pistachio-extension.schema.json", import.meta.url));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, manifestJsonSchemaText());
console.log(`wrote ${target}`);
