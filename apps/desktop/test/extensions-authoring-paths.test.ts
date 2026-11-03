/**
 * What the dev folder's generated files say about where things are (main/extensions/watch.ts GENERATED_FILES):
 * the templates' `$schema`, the guide's and the skill's references must reach the files where they are laid.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GENERATED_FILES } from "../src/main/extensions/watch";

const API = resolve(__dirname, "..", "..", "..", "packages", "extension-api");

describe("the authoring files' paths", () => {
  it("lay the types and the schema under .pistachio/, and every template, the guide and the skill point there", () => {
    const laid = new Set(GENERATED_FILES.map((file) => file.to));
    expect(laid.has(".pistachio/pistachio.d.ts")).toBe(true);
    expect(laid.has(".pistachio/pistachio-extension.schema.json")).toBe(true);
    for (const template of readdirSync(join(API, "templates"))) {
      const manifest = JSON.parse(readFileSync(join(API, "templates", template, "pistachio.json"), "utf8")) as { $schema?: string };
      expect(manifest.$schema, template).toBe("../.pistachio/pistachio-extension.schema.json");
    }
    const guide = readFileSync(join(API, "AGENTS.md"), "utf8");
    const skill = readFileSync(join(API, "skill", "SKILL.md"), "utf8");
    for (const text of [guide, skill]) {
      expect(text).not.toMatch(/"\.\.\/pistachio-extension\.schema\.json"/);
      expect(text).not.toMatch(/path="\.\.\/pistachio\.d\.ts"/);
      expect(text).not.toMatch(/Extensions\/pistachio(\.d\.ts|-extension\.schema\.json)/);
    }
    expect(guide).toContain('"$schema": "../.pistachio/pistachio-extension.schema.json"');
    expect(guide).toContain('/// <reference path="../.pistachio/pistachio.d.ts" />');
  });
});
