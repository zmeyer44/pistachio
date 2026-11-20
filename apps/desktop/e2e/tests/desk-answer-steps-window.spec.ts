/**
 * A long turn's steps stand in a window of a few lines (shell-ui
 * chat/StepsWindow.tsx; docs/desk-agent.md, *The answer*). The user,
 * 2026-11-19, of a turn that had taken nineteen steps and pushed the rest of
 * the thread out of sight: "we should never let the tools list get this tall
 * in the AI chat, instead we should have some type of max height and
 * autoscrolling effect once a certain number of tools have been called".
 *
 * Through the real controller and runner on a scripted model
 * (PISTACHIO_AGENT_SCRIPT): a turn of sixteen steps, with a pause in it long
 * enough to scroll the list by hand while the turn still works. The window is
 * read every frame — its height, where it is scrolled to, how many steps it
 * holds — so what it did between the checks is checked too.
 */

import { expect, test } from "@playwright/test";
import { createGroup, INVOICES, launchDesk, openTabs, reachBar, screenshots, selectSpace, selectTab, settled } from "./desk-harness";

const capture = screenshots("desk-answer-steps-window");

const read = { tools: [{ name: "page_inspect", input: { tabId: "{{tab:Northstar}}" } }] };
const ANSWER = "Sixteen readings of the invoice agree: $8,420.00 against a purchase order of $8,400.00.";

const SCRIPT = {
  steps: [
    // Twelve steps one after another: the list outgrows its window on the way.
    ...Array.from({ length: 12 }, () => ({ ...read, delayMs: 120 })),
    // A pause with the turn still at work (the list is scrolled by hand in it), then four more — the first of them
    // only once the pause is over.
    { ...read, delayMs: 4_000 },
    ...Array.from({ length: 3 }, () => ({ ...read, delayMs: 150 })),
    { text: ANSWER, delayMs: 1_200 },
  ],
};

/** The window no taller than this (shell.css `.steps-window`'s --steps-window), however many steps it holds. */
const WINDOW = 168;

interface Sample {
  steps: number;
  height: number;
  /** How far short of its foot the window is scrolled (0 at its end). */
  short: number;
  /** How much of the list is past the window's height. */
  over: number;
  follow: boolean;
}

test("a long turn's steps stand in a window of a few lines: kept on the newest while it works, the person's once they scroll it, faded where there is more", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(120_000);
  const { app, shell } = await launchDesk({ name: "answer-steps-window", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } });
  try {
    const [invoice] = (await openTabs(shell, [INVOICES])) as [string];
    await createGroup(shell, "answer-steps-window", [invoice], "Northstar", "green");
    await selectTab(shell, invoice);
    await selectSpace(shell, "answer-steps-window");
    await settled(shell, app);
    const answer = shell.getByTestId("desk-answer");
    const steps = answer.getByTestId("trace-step");
    const list = answer.getByTestId("steps-window");
    const at = (): Promise<{ top: number; short: number; height: number; fadeTop: string; fadeFoot: string }> =>
      list.evaluate((el) => ({
        top: el.scrollTop,
        short: el.scrollHeight - el.scrollTop - el.clientHeight,
        height: el.getBoundingClientRect().height,
        fadeTop: getComputedStyle(el).getPropertyValue("--steps-fade-top").trim(),
        fadeFoot: getComputedStyle(el).getPropertyValue("--steps-fade-foot").trim(),
      }));

    // The window, every frame, from before the question.
    await shell.evaluate(() => {
      const store = window as unknown as { __steps: Sample[]; __sampling: boolean };
      store.__steps = [];
      store.__sampling = true;
      const tick = (): void => {
        const el = document.querySelector<HTMLElement>('[data-testid="desk-answer"] [data-testid="steps-window"]');
        if (el !== null && el.clientHeight > 0) {
          store.__steps.push({
            steps: el.querySelectorAll('[data-testid="trace-step"]').length,
            height: el.getBoundingClientRect().height,
            short: el.scrollHeight - el.scrollTop - el.clientHeight,
            over: el.scrollHeight - el.clientHeight,
            follow: el.hasAttribute("data-follow"),
          });
        }
        if (store.__sampling) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const samples = (): Promise<Sample[]> => shell.evaluate(() => (window as unknown as { __steps: Sample[] }).__steps);

    await reachBar(shell);
    await shell.getByTestId("desk-bar-input").fill("Read this invoice until you are sure of it");
    await shell.getByTestId("desk-bar-input").press("Enter");

    // ── 1. Twelve steps in, the turn pausing: the list is in its window, on its newest step ─
    await expect(steps).toHaveCount(12, { timeout: 30_000 });
    await expect.poll(async () => (await at()).short).toBeLessThanOrEqual(6);
    const working = await samples();
    // No taller than its window, at any frame, however many steps it held.
    expect(Math.max(...working.map((sample) => sample.height))).toBeLessThanOrEqual(WINDOW + 1);
    // A few steps were drawn whole, with nothing to scroll; the rest scroll in the window.
    expect(working.some((sample) => sample.steps >= 2 && sample.over <= 1)).toBe(true);
    expect(working.at(-1)!.over).toBeGreaterThan(100);
    expect(working.every((sample) => sample.follow)).toBe(true);
    // Kept on the newest as they came: never more than a couple of rows behind its foot on the way (the scroll to each
    // is eased), and at it once they stopped coming.
    expect(Math.max(...working.map((sample) => sample.short))).toBeLessThan(90);
    await expect(steps.last()).toBeInViewport();
    // Faded at the top, where there is more above; not at the foot, which is its end.
    const pinned = await at();
    expect(pinned.height).toBeLessThanOrEqual(WINDOW + 1);
    expect(pinned.fadeTop).toBe("28px");
    expect(pinned.fadeFoot).toBe("0px");
    await capture(app, shell, "01-working-on-the-newest.png");

    // ── 2. Scrolled back by hand while the turn works: it is the person's, and the steps that come leave it be ─
    const box = (await list.boundingBox())!;
    await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await shell.mouse.wheel(0, -400);
    await expect.poll(async () => (await at()).top).toBe(0);
    const read = await at();
    expect(read.fadeTop).toBe("0px");
    expect(read.fadeFoot).toBe("28px");
    await expect(steps.first()).toBeInViewport();
    // The pause over, four more steps come: the window stays where it was put.
    await expect(steps).toHaveCount(16, { timeout: 30_000 });
    expect((await at()).top).toBe(0);
    await expect(steps.first()).toBeInViewport();
    await capture(app, shell, "02-scrolled-by-hand.png");
    // Back at its foot, it follows again. (Nothing more comes in this turn: that it is at its end is what is read.)
    await shell.mouse.wheel(0, 2_000);
    await expect.poll(async () => (await at()).short).toBeLessThanOrEqual(6);

    // ── 3. The turn done, it folds to its one line; opened to read, it starts at its first step ─
    await expect(answer).toContainText("Sixteen readings", { timeout: 30_000 });
    const trace = answer.getByTestId("work-trace");
    await expect(trace).toHaveAttribute("data-state", "done");
    const head = trace.locator('[data-slot="trace-collapsible-trigger"]').first();
    await expect(head).toHaveAttribute("aria-expanded", "false");
    // (Folded away, not merely folding: opened again while it is still on its way shut, it is as it was a moment ago —
    // the person never lost sight of it — and stays where it was.)
    await expect(list).toBeHidden();
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await expect(steps).toHaveCount(16);
    await expect.poll(async () => (await at()).height).toBeGreaterThan(100);
    const opened = await at();
    expect(opened.height).toBeLessThanOrEqual(WINDOW + 1);
    expect(opened.top).toBe(0);
    expect(opened.fadeFoot).toBe("28px");
    await expect(steps.first()).toBeInViewport();
    await expect(steps.last()).not.toBeInViewport();
    await capture(app, shell, "03-opened-to-read.png");
    // And scrolls to its last.
    await list.hover();
    await shell.mouse.wheel(0, 2_000);
    await expect.poll(async () => (await at()).short).toBeLessThanOrEqual(6);
    await expect(steps.last()).toBeInViewport();
    expect((await at()).fadeFoot).toBe("0px");
  } finally {
    await shell.evaluate(() => void ((window as unknown as { __sampling: boolean }).__sampling = false)).catch(() => undefined);
    await app.close();
  }
});
