/**
 * Whether the conversation main holds is shown in the Profile in view
 * (run-scope.ts; BrowserController.snapshot). A running conversation nobody
 * placed stays with its tab's Profile; one that is the space in front's —
 * the hub's word — is shown there whatever tab it started on.
 */

import { describe, expect, it } from "vitest";
import { runInView } from "../src/main/run-scope";

const driving = { control: "agent", status: "running" } as const;

describe("the conversation in view", () => {
  it("is none where there is none", () => {
    expect(runInView(null, null, "work", true)).toBe(false);
  });

  it("stays with its tab's Profile while the agent drives it, when nobody placed it", () => {
    expect(runInView(driving, "work", "work", false)).toBe(true);
    expect(runInView(driving, "personal", "work", false)).toBe(false);
    // Its tab closed, or none (an empty space's): a conversation, shown where the person is.
    expect(runInView(driving, null, "work", false)).toBe(true);
    // Paused, waiting or finished, it is a conversation, not a tab.
    expect(runInView({ control: "human", status: "interrupted" }, "personal", "work", false)).toBe(true);
    expect(runInView({ control: "agent", status: "completed" }, "personal", "work", false)).toBe(true);
  });

  it("is the space in front's when the hub says so, whatever tab it started on: one at work in another Profile, chosen here, is shown here", () => {
    expect(runInView(driving, "personal", "work", true)).toBe(true);
  });
});
