import { describe, expect, it } from "vitest";
import { TASK_STATUSES, type RunSummary, type TaskStatus } from "@pistachio/protocol";
import {
  AGENT_RING_PERIOD_MS,
  agentDrivenTabId,
  agentGlowCss,
  agentIsDriving,
  agentRingDelayMs,
} from "../src/agent-glow.js";

const theme = { colors: ["#88C999", "#67BFB4", "#98B9EF"], radius: 8 };

function run(
  status: TaskStatus,
  control: "agent" | "human",
  rest: Partial<Pick<RunSummary, "humanTabId" | "toolCalls" | "executor">> = {},
): RunSummary {
  return { status, control, humanTabId: "tab-1", toolCalls: [], ...rest } as unknown as RunSummary;
}

function tool(tabId: string | null): RunSummary["toolCalls"][number] {
  return { id: `tool-${String(tabId)}`, tabId } as unknown as RunSummary["toolCalls"][number];
}

describe("agentIsDriving", () => {
  it("is the one condition the ring and the injected glow both key off", () => {
    expect(agentIsDriving(run("running", "agent"))).toBe(true);
    expect(agentIsDriving(null)).toBe(false);
  });

  it("goes out the moment the turn finishes and its answer is sent", () => {
    // `completed` is set before the answer is published, so the publish that
    // carries the response is the one that takes the light off the page.
    expect(agentIsDriving(run("completed", "agent"))).toBe(false);
  });

  it("lights for exactly one status, and never once the person has the page", () => {
    const driving = TASK_STATUSES.filter((status) => agentIsDriving(run(status, "agent")));
    expect(driving).toEqual(["running"]);
    for (const status of TASK_STATUSES)
      expect(agentIsDriving(run(status, "human"))).toBe(false);
  });
});

describe("agentDrivenTabId", () => {
  it("is the tab the run started in until the agent has touched one", () => {
    expect(agentDrivenTabId(run("running", "agent"))).toBe("tab-1");
  });

  it("follows the agent to the tab its latest tool touched", () => {
    // The agent opened a second tab and moved into it: the light goes with
    // it, and the tab it started in goes dark.
    const moved = run("running", "agent", { toolCalls: [tool("tab-1"), tool(null), tool("tab-2")] });
    expect(agentDrivenTabId(moved)).toBe("tab-2");
    // A tool that names no tab (tabs.list, tab.open) does not move it.
    const listed = run("running", "agent", { toolCalls: [tool("tab-2"), tool(null)] });
    expect(agentDrivenTabId(listed)).toBe("tab-2");
  });

  it("names no tab unless the agent is driving", () => {
    for (const status of TASK_STATUSES) {
      const expected = status === "running" ? "tab-1" : null;
      expect(agentDrivenTabId(run(status, "agent"))).toBe(expected);
      expect(agentDrivenTabId(run(status, "human"))).toBeNull();
    }
    expect(agentDrivenTabId(null)).toBeNull();
  });

  it("names no tab here for a cloud run: its page is in the cloud browser", () => {
    const cloud = run("running", "agent", {
      humanTabId: null,
      toolCalls: [tool("cloud:1")],
      executor: { kind: "cloud", deviceId: "d", workerId: "w" },
    });
    expect(agentDrivenTabId(cloud)).toBeNull();
  });
});

describe("agentRingDelayMs", () => {
  it("puts a sweep starting now onto the phase of one anchored to the epoch", () => {
    // Both sides — the chrome ring and the glow injected into a page — offset
    // themselves by this, so both are anchored to a whole period in absolute
    // time however far apart they started.
    const early = agentRingDelayMs(1_000);
    const late = agentRingDelayMs(1_000 + 3 * AGENT_RING_PERIOD_MS);
    expect(early).toBe(late);
  });

  it("is never positive, and never a whole period back", () => {
    for (const now of [0, 1, 12_345, AGENT_RING_PERIOD_MS, Date.now()]) {
      const delay = agentRingDelayMs(now);
      expect(delay).toBeLessThanOrEqual(0);
      expect(delay).toBeGreaterThan(-AGENT_RING_PERIOD_MS);
    }
  });
});

describe("agentGlowCss", () => {
  it("paints the theme's own palette", () => {
    const css = agentGlowCss({ ...theme, delayMs: -100 });
    for (const color of theme.colors) expect(css).toContain(color);
  });

  it("cannot be interactive, cannot be printed, and stops at the pane's radius", () => {
    const css = agentGlowCss({ ...theme, radius: 12, delayMs: 0 });
    expect(css).toContain("pointer-events: none !important");
    expect(css).toContain("border-radius: 12px !important");
    expect(css).toMatch(/@media print \{[^}]*display: none/);
  });

  it("still lights, but stops chasing, when motion is unwelcome", () => {
    const css = agentGlowCss({ ...theme, delayMs: 0 });
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion"));
    expect(reduced).toContain("pistachio-agent-glow-in");
    expect(reduced).not.toContain("pistachio-agent-glow-spin");
  });

  it("carries two comets, half a turn apart, each falling to nothing on its half", () => {
    const css = agentGlowCss({ ...theme, delayMs: 0 });
    const gradient = css.slice(css.indexOf("conic-gradient"), css.indexOf("mask-image"));
    // The heads: the brightest colour, 180deg apart.
    expect(gradient).toContain(`${theme.colors[0]} 165deg`);
    expect(gradient).toContain(`${theme.colors[0]} 345deg`);
    // Each tail starts, and each head falls out, on its own half — so 12
    // o'clock is a seam in nothing rather than a cut through a lit arc.
    expect(gradient).toContain("transparent 60deg");
    expect(gradient).toContain("transparent 180deg");
    expect(gradient).toContain("transparent 240deg");
    expect(gradient).toContain("transparent 360deg");
  });

  it("carries the shared period and the caller's phase into the sweep", () => {
    const css = agentGlowCss({ ...theme, delayMs: -1234 });
    expect(css).toContain(
      `pistachio-agent-glow-spin ${String(AGENT_RING_PERIOD_MS)}ms linear -1234ms infinite`,
    );
  });

  it("refuses a colour that is not a colour: settings on disk must not write rules", () => {
    const css = agentGlowCss({
      colors: ["red; } html { display: none } html::after { color: red"],
      radius: 8,
      delayMs: 0,
    });
    expect(css).not.toContain("display: none } html::after");
    expect(css).toContain("#88C999");
  });

  it("holds the radius to a sane box whatever settings say", () => {
    expect(agentGlowCss({ ...theme, radius: -20, delayMs: 0 })).toContain("border-radius: 0px");
    expect(agentGlowCss({ ...theme, radius: 9_000, delayMs: 0 })).toContain("border-radius: 64px");
  });
});
