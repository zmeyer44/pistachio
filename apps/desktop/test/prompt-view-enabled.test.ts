/**
 * Where the desk's prompt is the view's (main/prompt-view-enabled.ts): in the app, always — which is what keeps every
 * window where it is when the prompt opens — and under Playwright only where a spec asks.
 */

import { describe, expect, it } from "vitest";
import { promptViewEnabled } from "../src/main/prompt-view-enabled";

describe("whether the desk's prompt lies over the pages in a view of its own", () => {
  it("does in the app, as it is launched: nothing in the environment turns it on", () => {
    expect(promptViewEnabled({})).toBe(true);
    expect(promptViewEnabled({ HOME: "/Users/someone", NODE_ENV: "production" })).toBe(true);
  });

  it("can be turned off, and then the prompt is the shell's own", () => {
    expect(promptViewEnabled({ PISTACHIO_PROMPT_VIEW: "0" })).toBe(false);
    // (Only that word turns it off.)
    expect(promptViewEnabled({ PISTACHIO_PROMPT_VIEW: "1" })).toBe(true);
    expect(promptViewEnabled({ PISTACHIO_PROMPT_VIEW: "" })).toBe(true);
  });

  it("does not under Playwright unless a spec asks: the older specs write in the shell's own pill, which keeps a band clear for itself", () => {
    expect(promptViewEnabled({ PISTACHIO_E2E: "1" })).toBe(false);
    expect(promptViewEnabled({ PISTACHIO_E2E: "1", PISTACHIO_E2E_PROMPT_VIEW: "1" })).toBe(true);
    // Off is off there too.
    expect(promptViewEnabled({ PISTACHIO_E2E: "1", PISTACHIO_E2E_PROMPT_VIEW: "1", PISTACHIO_PROMPT_VIEW: "0" })).toBe(false);
  });
});
