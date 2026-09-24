import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test";
import { SIDEBAR_EDGE_W, SIDEBAR_TRIGGER_W } from "@pistachio/shell-contracts/chrome";
import { shellPage } from "./windows";

const screenshotDirectory = join(
  process.cwd(),
  "e2e/screenshots/compact-sidebar",
);

interface GeometrySample {
  time: number;
  sidebarWidth: number;
  pageX: number;
}

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      executableSuffix,
    ),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function beginGeometrySampling(shell: Page): Promise<void> {
  await shell.evaluate(() => {
    const target = window as unknown as {
      __compactSamples?: GeometrySample[];
      __compactSamplingDone?: boolean;
    };
    target.__compactSamples = [];
    target.__compactSamplingDone = false;
    const started = performance.now();
    const sample = (now: number) => {
      const slot = document.querySelector<HTMLElement>(
        '[data-testid="sidebar-motion-slot"]',
      );
      const pane = document.querySelector<HTMLElement>(
        '[data-testid="sidebar-pane"]',
      );
      const edge = document.querySelector<HTMLElement>(
        '[data-testid="sidebar-edge"]',
      );
      const primary = document.querySelector<HTMLElement>(
        '[data-testid="primary-pane"]',
      );
      const sidebar =
        slot?.getBoundingClientRect() ??
        pane?.getBoundingClientRect() ??
        edge?.getBoundingClientRect();
      target.__compactSamples?.push({
        time: now - started,
        sidebarWidth: sidebar?.width ?? 0,
        pageX: primary?.getBoundingClientRect().x ?? 0,
      });
      if (now - started < 420) requestAnimationFrame(sample);
      else target.__compactSamplingDone = true;
    };
    requestAnimationFrame(sample);
  });
}

async function finishGeometrySampling(shell: Page): Promise<GeometrySample[]> {
  await expect
    .poll(
      () =>
        shell.evaluate(
          () =>
            (window as unknown as { __compactSamplingDone?: boolean })
              .__compactSamplingDone === true,
        ),
      { intervals: [20] },
    )
    .toBe(true);
  return shell.evaluate(
    () =>
      (window as unknown as { __compactSamples?: GeometrySample[] })
        .__compactSamples ?? [],
  );
}

function geometrySummary(samples: GeometrySample[]) {
  const widths = samples.map((sample) => sample.sidebarWidth);
  const deltas = widths
    .slice(1)
    .map((width, index) => Math.abs(width - widths[index]!));
  const pageXs = samples.map((sample) => sample.pageX);
  return {
    frames: samples.length,
    distinctWidths: new Set(widths.map(Math.round)).size,
    distinctPageXs: new Set(pageXs.map(Math.round)).size,
    maxWidthDelta: Math.max(0, ...deltas),
    minWidth: Math.min(...widths),
    maxWidth: Math.max(...widths),
  };
}

async function captureLeft(shell: Page, filename: string): Promise<void> {
  const viewport = await shell.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  await mkdir(screenshotDirectory, { recursive: true });
  await shell.screenshot({
    path: join(screenshotDirectory, filename),
    clip: {
      x: 0,
      y: 0,
      width: Math.min(360, viewport.width),
      height: viewport.height,
    },
  });
}

async function motionProgress(shell: Page): Promise<number> {
  return shell.getByTestId("sidebar-motion-slot").evaluate((element) => {
    const transition = element
      .getAnimations({ subtree: true })
      .find(
        (animation) =>
          animation instanceof CSSTransition &&
          (animation.transitionProperty === "width" ||
            animation.transitionProperty === "transform"),
      );
    if (transition === undefined) return 0;
    const timing = transition.effect?.getComputedTiming();
    const duration = typeof timing?.duration === "number" ? timing.duration : 0;
    const current =
      typeof transition.currentTime === "number" ? transition.currentTime : 0;
    return duration === 0 ? 1 : current / duration;
  });
}

function expectSmoothTransition(samples: GeometrySample[]): void {
  const summary = geometrySummary(samples);
  expect(summary.distinctWidths).toBeGreaterThanOrEqual(8);
  expect(summary.distinctPageXs).toBeGreaterThanOrEqual(8);
  expect(summary.maxWidthDelta).toBeLessThan(100);
  expect(summary.minWidth).toBeCloseTo(SIDEBAR_EDGE_W, 0);
  expect(summary.maxWidth).toBeGreaterThan(240);
}

test("the compact sidebar reveals over multiple stable animation frames", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-compact-sidebar-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "compact" } }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");

    // Hidden compact mode must be stable before the reveal is measured.
    const edge = shell.getByTestId("sidebar-edge");
    await expect(edge).toBeVisible();
    await expect(shell.getByTestId("sidebar-pane")).toBeHidden();
    await captureLeft(shell, "01-hidden.png");
    const box = await edge.boundingBox();
    if (box === null) throw new Error("compact sidebar edge has no box");
    expect(box.width).toBeCloseTo(SIDEBAR_TRIGGER_W, 0);
    const hiddenSlot = await shell.getByTestId("sidebar-motion-slot").boundingBox();
    const hiddenPage = await shell.getByTestId("primary-pane").boundingBox();
    if (hiddenSlot === null || hiddenPage === null) throw new Error("compact hidden geometry is missing");
    expect(hiddenSlot.width).toBeCloseTo(SIDEBAR_EDGE_W, 0);
    expect(hiddenPage.x).toBeCloseTo(SIDEBAR_EDGE_W, 0);

    // Sampling from before the gesture exposes jumps that settled screenshots miss.
    await beginGeometrySampling(shell);
    await shell.mouse.move(box.x + 4, box.y + 200);
    await shell.mouse.move(box.x + 5, box.y + 210);
    const pane = shell.getByTestId("sidebar-pane");
    await expect(pane).toBeVisible();
    await expect
      .poll(() => motionProgress(shell), { intervals: [8] })
      .toBeGreaterThan(0.18);
    await captureLeft(shell, "02-revealing.png");
    // Playwright has no OS cursor for main's native drag-region backstop, so
    // carry its synthetic pointer into the now-open shell column.
    await shell.mouse.move(60, box.y + 210);
    const revealSamples = await finishGeometrySampling(shell);
    expectSmoothTransition(revealSamples);
    await expect(shell.getByTestId("sidebar-motion-slot")).not.toHaveAttribute(
      "data-hidden",
      "",
    );
    await captureLeft(shell, "03-revealed.png");

    // The retreat uses the same continuous geometry rather than disappearing first.
    const page = await shell.getByTestId("primary-pane").boundingBox();
    if (page === null) throw new Error("primary pane has no box");
    await beginGeometrySampling(shell);
    await shell.mouse.move(page.x + page.width / 2, page.y + page.height / 2);
    await expect(shell.getByTestId("sidebar-motion-slot")).toHaveAttribute(
      "data-hidden",
      "",
    );
    await expect
      .poll(() => motionProgress(shell), { intervals: [8] })
      .toBeGreaterThan(0.18);
    await captureLeft(shell, "04-hiding.png");
    const hideSamples = await finishGeometrySampling(shell);
    expectSmoothTransition(hideSamples);
    await expect(pane).toBeHidden();
    await expect(edge).toBeVisible();

    // A normal re-entry proves the edge remains live after a completed close.
    await shell.mouse.move(box.x + 4, box.y + 300);
    await shell.mouse.move(box.x + 5, box.y + 310);
    await expect(pane).toBeVisible();
    await expect
      .poll(() => motionProgress(shell), { intervals: [8] })
      .toBeGreaterThan(0.18);
    await shell.mouse.move(60, box.y + 310);
    await expect
      .poll(async () =>
        Math.round(
          (await shell.getByTestId("sidebar-motion-slot").boundingBox())
            ?.width ?? 0,
        ),
      )
      .toBe(248);

    // Re-entering during the next close reverses the live transition instead of snapping.
    await beginGeometrySampling(shell);
    await shell.mouse.move(page.x + page.width / 2, page.y + page.height / 2);
    await expect(shell.getByTestId("sidebar-motion-slot")).toHaveAttribute(
      "data-hidden",
      "",
    );
    await expect
      .poll(() => motionProgress(shell), { intervals: [8] })
      .toBeGreaterThan(0.18);
    await captureLeft(shell, "05-reversing.png");
    await shell.mouse.move(box.x + 4, box.y + 300);
    await shell.mouse.move(box.x + 5, box.y + 310);
    await expect(shell.getByTestId("sidebar-motion-slot")).not.toHaveAttribute(
      "data-hidden",
      "",
    );
    await shell.mouse.move(60, box.y + 310);
    const reversalSamples = await finishGeometrySampling(shell);
    const reversal = geometrySummary(reversalSamples);
    expect(reversal.distinctWidths).toBeGreaterThanOrEqual(5);
    expect(reversal.maxWidthDelta).toBeLessThan(100);
    expect(reversal.minWidth).toBeLessThan(230);
    expect(reversal.maxWidth).toBeCloseTo(248, 0);
    await expect(pane).toBeVisible();
    await captureLeft(shell, "06-reversed-revealed.png");

    console.log(
      `compact-sidebar geometry ${JSON.stringify({ reveal: geometrySummary(revealSamples), hide: geometrySummary(hideSamples), reversal })}`,
    );
  } finally {
    await app.close();
  }
});
