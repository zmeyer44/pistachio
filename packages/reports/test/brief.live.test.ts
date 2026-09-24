/**
 * Live check of the daily brief against the real models through the real
 * gateway. Skipped unless PISTACHIO_REPORTS_LIVE=1 and the workspace has a
 * gateway key in `.env`. It costs a fraction of a cent and sends only the
 * synthetic day in `fixtures.ts`.
 *
 * What it guards is the WORDING: Jev reads only candidate descriptions, the
 * guidance in `compose.ts` and the criteria in `triage.ts`, so a careless edit
 * there shows up here as a promotion filed under "waiting on you" or a
 * schedule left off the page.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createGateway } from "ai";
import { describe, expect, it } from "vitest";
import { generateBrief } from "../src/brief/generate.js";
import { validateReportSpec } from "../src/validate.js";
import { monday } from "./fixtures.js";

const envPath = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find((path) => existsSync(path));
const live = process.env["PISTACHIO_REPORTS_LIVE"] === "1";
if (envPath !== undefined && live) process.loadEnvFile(envPath);
const key = process.env["AI_GATEWAY_API_KEY"];

describe.skipIf(!live || key === undefined)("daily brief (live models)", () => {
  it("composes a sound page for an ordinary Monday", { timeout: 60000 }, async () => {
    const gateway = createGateway({ apiKey: key });
    const decide = process.env["PISTACHIO_INTENT_MODEL"] ?? "typesafe-ai/jev";
    const write = process.env["PISTACHIO_BRIEF_MODEL"] ?? "anthropic/claude-haiku-4.5";
    const errors: unknown[] = [];
    const brief = await generateBrief(monday({ pagesShareable: true }), {
      decide: { id: decide, model: gateway.evaluationModel(decide) },
      write: { id: write, model: gateway.languageModel(write) },
      onError: (error) => errors.push(error),
    });
    const page = brief.spec.elements[brief.spec.root];
    const slots = (page?.slots ?? {}) as Record<string, string[]>;
    console.log(brief.builtWith, errors);
    console.log((brief.spec.state as { text: { headline: string } }).text.headline);
    console.table(
      (["header", "main", "aside"] as const).flatMap((slot) =>
        (slots[slot] ?? []).map((id) => ({ slot, id, type: brief.spec.elements[id]?.type, title: (brief.spec.elements[id]?.props as { title?: string }).title })),
      ),
    );
    expect(errors).toEqual([]);
    expect(brief.builtWith.composer).toBe("jev");
    expect(brief.builtWith.triage).toBe("jev");
    expect(brief.builtWith.writer).toBe(write);
    expect(validateReportSpec(brief.spec).ok).toBe(true);
    const text = JSON.stringify(brief.spec);
    expect(text).not.toContain("40% off");
    expect(text).toContain("Q4 budget");
  });
});
