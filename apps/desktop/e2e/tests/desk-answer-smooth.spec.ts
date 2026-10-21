/**
 * The desk's answer holds still while the agent works (shell-ui
 * chat/LiveReply.tsx, chat/SmoothHeight.tsx): through thinking, a step,
 * thinking again, another step, the thread only grows — the reasoning stays
 * open on its latest lines between the steps, the steps' line stays open —
 * and folds once the reply has begun, every change of height eased. Until
 * 2026-10-21 the reasoning folded as each thought ended and opened with the
 * next, so the thread grew and shrank with every step.
 *
 * Through the real controller and runner on a scripted model that streams
 * (PISTACHIO_AGENT_SCRIPT with `stream: true`: reasoning word by word, then
 * the step's tool call or answer). The thread's height is read every frame.
 */

import { expect, test } from "@playwright/test";
import { createGroup, INVOICES, launchDesk, openTabs, reachBar, screenshots, selectSpace, selectTab, settled } from "./desk-harness";

const capture = screenshots("desk-answer-smooth");

const ANSWER = "The invoice is $8,420.00 against a purchase order of $8,400.00: the $20 between them is freight. Everything else matches, so it can be approved once the variance is noted.";

const SCRIPT = {
  stream: true,
  steps: [
    {
      reasoning: "The person wants this invoice checked. I should read the page first, to see its totals and the purchase order it names.",
      streamMs: 900,
      tools: [{ name: "page_inspect", input: { tabId: "{{tab:Northstar}}" } }],
    },
    {
      reasoning: "The totals differ by twenty dollars, which looks like freight. I will read it once more to be sure of the purchase order's own total.",
      streamMs: 900,
      tools: [{ name: "page_inspect", input: { tabId: "{{tab:Northstar}}" } }],
    },
    { reasoning: "That is all I need to answer.", streamMs: 900, text: ANSWER },
  ],
};

interface Sample {
  t: number;
  h: number;
  reasoning: boolean;
  words: boolean;
}

test("the desk's answer holds still while the agent works: the thread only grows until the reply begins", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(90_000);
  const { app, shell } = await launchDesk({ name: "answer-smooth", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } });
  try {
    const [invoice] = (await openTabs(shell, [INVOICES])) as [string];
    await createGroup(shell, "answer-smooth", [invoice], "Northstar", "green");
    await selectTab(shell, invoice);
    await selectSpace(shell, "answer-smooth");
    await settled(shell, app);
    const answer = shell.getByTestId("desk-answer");

    // The thread's height, every frame, from before the question to after the answer.
    await shell.evaluate((first) => {
      const store = window as unknown as { __samples: Sample[]; __sampling: boolean };
      store.__samples = [];
      store.__sampling = true;
      const tick = (): void => {
        const card = document.querySelector('[data-testid="desk-answer"]');
        const content = card?.querySelector(".desk-answer-viewport")?.firstElementChild;
        if (card !== null && card !== undefined && content !== null && content !== undefined) {
          store.__samples.push({
            t: performance.now(),
            h: content.getBoundingClientRect().height,
            reasoning: card.querySelector('[data-testid="reasoning-block"]') !== null,
            words: (card.textContent ?? "").includes(first),
          });
        }
        if (store.__sampling) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, ANSWER.slice(0, 24));

    await reachBar(shell);
    await shell.getByTestId("desk-bar-input").fill("Check this invoice against its purchase order");
    await shell.getByTestId("desk-bar-input").press("Enter");
    // (Mid-turn, for a person reviewing it: a step done, the reasoning held open while the next is thought.)
    await expect(answer.getByTestId("trace-step").first()).toBeVisible({ timeout: 30_000 });
    await capture(app, shell, "00-working.png", 0);
    await expect(answer).toContainText("once the variance is noted", { timeout: 30_000 });
    await expect(answer.getByTestId("assistant-message")).toHaveCount(1);
    // (The fold after the reply has begun, eased, run out.)
    await shell.waitForTimeout(800);
    const samples = await shell.evaluate(() => {
      const store = window as unknown as { __samples: Sample[]; __sampling: boolean };
      store.__sampling = false;
      return store.__samples;
    });
    await capture(app, shell, "01-answered.png");

    // The turn was watched while it worked: its reasoning showed, and the reply began after it.
    const begun = samples.findIndex((sample) => sample.words);
    expect(begun).toBeGreaterThan(0);
    const working = samples.slice(0, begun);
    expect(working.some((sample) => sample.reasoning)).toBe(true);
    expect(working.at(-1)!.t - working[0]!.t).toBeGreaterThan(2_000);
    // Until the reply began, the thread never shrank.
    let drop = 0;
    let at = 0;
    for (let index = 1; index < working.length; index += 1) {
      const fall = working[index - 1]!.h - working[index]!.h;
      if (fall > drop) {
        drop = fall;
        at = working[index]!.t - working[0]!.t;
      }
    }
    expect(drop, `the thread shrank ${drop.toFixed(1)}px ${at.toFixed(0)} ms in`).toBeLessThanOrEqual(1);
  } finally {
    await app.close();
  }
});
