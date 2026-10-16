/**
 * The desk's answer card draws the agent's side of a turn as Trace lines
 * (docs/desk-agent.md, *The answer*; shell-ui chat/trace.tsx): a turn's
 * steps under one line that opens to them, a step that failed red and
 * opening to its error, and a run that stopped on an error ending on a red
 * line open on it. Through the real controller and runner on a scripted
 * model (PISTACHIO_AGENT_SCRIPT): a click on a control the page does not
 * have fails for real, and the second turn writes a note and then its model
 * call throws as a provider's outage would. The words and states are chat-trace.test's.
 */

import { expect, test } from "@playwright/test";
import { createGroup, INVOICES, launchDesk, openTabs, reachBar, screenshots, selectSpace, selectTab, settled } from "./desk-harness";

const capture = screenshots("desk-answer-trace");

const OUTAGE = "The model provider is unavailable (503 Service Unavailable)";

const SCRIPT = {
  steps: [
    {
      tools: [
        { name: "page_inspect", input: { tabId: "{{tab:Northstar}}" } },
        { name: "page_click", input: { tabId: "{{tab:Northstar}}", target: "#approve-everything" } },
      ],
    },
    { text: "The invoice has no approve button I can press, so I left it as it is." },
    { tools: [{ name: "note_create", input: { title: "Approval checklist", markdown: "- Match the PO before approving" } }] },
    { error: OUTAGE },
  ],
};

test("the desk's answer: a turn's steps as a trace, a failed step's error, a run stopped on an error", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(90_000);
  const { app, shell } = await launchDesk({ name: "answer-trace", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } });
  try {
    const [invoice] = (await openTabs(shell, [INVOICES])) as [string];
    await createGroup(shell, "answer-trace", [invoice], "Northstar", "green");
    await selectTab(shell, invoice);
    await selectSpace(shell, "answer-trace");
    await settled(shell, app);
    const answer = shell.getByTestId("desk-answer");

    // ── 1. A turn of two steps, one failing: the line it folds under counts both, and the failure ─
    await reachBar(shell);
    await shell.getByTestId("desk-bar-input").fill("Approve this invoice");
    await shell.getByTestId("desk-bar-input").press("Enter");
    await expect(answer).toContainText("no approve button", { timeout: 20_000 });
    const trace = answer.getByTestId("work-trace");
    await expect(trace).toHaveAttribute("data-state", "done");
    // A step failed on the way: the agent routed round it, so the turn is not red, but it says so.
    await expect(trace.getByTestId("trace-count")).toHaveText("2 steps, 1 failed");
    const head = trace.locator('[data-slot="trace-collapsible-trigger"]').first();
    // The turn shut as it ended; it opens on a click to its steps.
    await expect(head).toHaveAttribute("aria-expanded", "false");
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    const steps = trace.getByTestId("trace-step");
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toHaveAttribute("data-state", "done");
    const failed = steps.nth(1);
    await expect(failed).toHaveAttribute("data-state", "failed");
    await expect(failed).toHaveAttribute("data-status", "error");
    await expect(failed).toHaveText(/^Failed: /);
    // The failed step opens to its error, whole, in a box of its own.
    await failed.click();
    const stepError = trace.getByTestId("trace-error");
    await expect(stepError).toBeVisible();
    await expect(stepError).not.toBeEmpty();
    await capture(app, shell, "01-turn-steps.png");

    // ── 2. The next turn writes a note, then its model call throws: the run ends on a red line, open on the error,
    //       with the note it did write ─
    await reachBar(shell);
    await shell.getByTestId("desk-bar-input").fill("Try again, please");
    await shell.getByTestId("desk-bar-input").press("Enter");
    const failure = answer.getByTestId("run-failure");
    await expect(failure).toBeVisible({ timeout: 20_000 });
    await expect(failure.locator('[data-slot="trace-line"][data-status="error"]')).toHaveText(/^I stopped because .+ failed$/);
    await expect(failure.getByTestId("trace-error")).toHaveText(OUTAGE);
    // The reply's own words are the line now, not a paragraph as well; it can still be retried.
    await expect(answer.getByTestId("assistant-message").filter({ hasText: OUTAGE })).toHaveCount(0);
    await expect(failure.getByTestId("message-retry")).toBeVisible();
    // What the turn made before it stopped is still shown, as under any reply.
    await expect(failure.getByTestId("output-card")).toContainText("Approval checklist");
    await capture(app, shell, "02-run-failure.png");
  } finally {
    await app.close();
  }
});
