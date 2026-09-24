import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type {
  WatchtowerRequest,
  WatchtowerResponse,
} from "@pistachio/shell-contracts/watchtower";
import { WATCHTOWER_CAPTURE_SCRIPT } from "@pistachio/watchtower/capture";
import { shellReady } from "./windows";

const api = (
  page: Page,
  request: WatchtowerRequest,
): Promise<WatchtowerResponse> =>
  page.evaluate(
    (value) =>
      (window as unknown as { pistachio: PistachioApi }).pistachio.watchtower(
        value,
      ),
    request,
  );
const createTab = async (page: Page, url: string): Promise<string> => {
  await page.evaluate(
    (url) =>
      (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(
        url,
      ),
    url,
  );
  return page.evaluate(
    async () =>
      (
        await (
          window as unknown as { pistachio: PistachioApi }
        ).pistachio.getSnapshot()
      ).activeTabId ?? "",
  );
};
const navigate = (page: Page, tabId: string, url: string): Promise<void> =>
  page.evaluate(
    ({ tabId, url }) =>
      (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(
        tabId,
        url,
      ),
    { tabId, url },
  );
const evidence = resolve(process.cwd(), "../../docs/qa/2026-09-19/watchtower");

// Journey: opt in → real foreground capture → revisit/deduplicate → revise →
// find historic body text → compare versions → saved inert tab → restart → forget.
test("Watchtower remembers substantive content and exact visits end to end", async () => {
  test.setTimeout(240000);
  await mkdir(evidence, { recursive: true });
  let version = "Bronze bearings support the spindle.";
  // A watch page as the web builds them: a player with a ticking clock, a
  // rail of other videos, a sponsored slot — and the facts in structured data.
  const watchPage = `<!doctype html><title>Gearbox teardown</title><meta property="og:type" content="video.other">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoObject","name":"Gearbox teardown","author":{"@type":"Person","name":"Harbor Workshop"},"description":"The full gearbox teardown of a vintage lathe, with every shim measured.","duration":"PT12M","uploadDate":"2026-01-02"}</script>
    <div id="columns"><div id="primary"><div id="player"><video></video><span class="time">0:00 / 12:00</span></div>
    <h1>Gearbox teardown</h1><div id="description"><p>We open the gearbox of a vintage lathe and measure every shim before reassembly.</p><p>Chapters cover the spindle, the back gears and the oil seals in order.</p></div>
    <div class="ad-slot"><p>Sponsored · RivalLathe clearance sale ends tonight</p></div></div>
    <div id="related">${Array.from({ length: 14 }, (_, i) => `<a href="/v/${i}"><h3>Beekeeping basics episode ${i}</h3><span>Apiary Channel · ${i}M views</span></a>`).join("")}</div></div>
    <script>let t=0;setInterval(()=>{t++;document.querySelector(".time").textContent="0:"+String(t%60).padStart(2,"0")+" / 12:00"},250)</script>`;
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    if (request.url?.startsWith("/watch")) {
      response.end(watchPage);
      return;
    }
    response.end(
      `<!doctype html><title>The workshop notebook</title><meta name="author" content="Ada Workshop"><main><h1>A vintage lathe</h1><p>${version}</p><p>The original machine was restored in a small coastal workshop.</p><nav>NavigationNoise</nav><p hidden>HiddenSecret</p><form><input value="FormSecret"><textarea>DraftSecret</textarea></form><div contenteditable>EditableSecret</div><script>window.scriptSecret="ScriptSecret"</script><pre>speed = 42;</pre><a href="/reference">Workshop reference</a></main>`,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture missing");
  const url = `http://127.0.0.1:${address.port}/notebook`;
  const userData = await mkdtemp(join(tmpdir(), "watchtower-e2e-"));
  let app: ElectronApplication | null = null;
  const launch = async (): Promise<Page> => {
    app = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      executablePath: join(
        process.cwd(),
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      env: {
        ...process.env,
        PISTACHIO_E2E: "1",
        PISTACHIO_USER_DATA: userData,
      },
    });
    const page = await shellReady(app);
    await page.waitForLoadState("domcontentloaded");
    // Automation cannot acquire macOS foreground ownership on every runner.
    // Simulate that OS signal only; native view visibility and extraction stay real.
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      for (const window of BrowserWindow.getAllWindows()) {
        window.show();
        window.focus();
        window.isFocused = () => true;
      }
    });
    await expect
      .poll(async () => {
        try {
          return (await api(page, { type: "status" })).settings.enabled;
        } catch {
          return null;
        }
      })
      .not.toBeNull();
    return page;
  };
  try {
    let page = await launch();
    // The sidebar footer menu no longer lists Watchtower; the palette does.
    await page.keyboard.press("Meta+L");
    await page.getByTestId("address-input").fill("watchtower");
    await page.locator('[data-testid="command-result"][data-action-id="chrome:openWatchtower"]').click();
    await expect(page.getByTestId("watchtower-onboarding")).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: join(evidence, "01-onboarding.png"),
    });
    await page
      .getByRole("button", { name: "Enable Watchtower", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Search Watchtower" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close Watchtower", exact: true })
      .click();
    const tabId = await createTab(page, url);
    await app!.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0]?.focus();
    });
    await expect
      .poll(
        async () =>
          (await api(page, { type: "search", query: "bronze spindle" })).results
            ?.length,
        { timeout: 20000 },
      )
      .toBe(1);
    const first = (await api(page, { type: "search", query: "bronze" }))
      .results![0]!;
    const original = (
      await api(page, { type: "read", observationId: first.observationId })
    ).document!;
    expect(original.markdown).toContain("Bronze bearings");
    expect(original.markdown).toContain("speed = 42");
    expect(original.markdown).not.toMatch(
      /Secret|NavigationNoise|scriptSecret/u,
    );
    await navigate(page, tabId, url);
    await expect
      .poll(
        async () =>
          (await api(page, { type: "search", query: "bronze" })).results
            ?.length,
        { timeout: 20000 },
      )
      .toBe(2);
    expect((await api(page, { type: "status" })).stats.snapshots).toBe(1);
    version = "Ceramic bearings replace the bronze spindle supports.";
    await navigate(page, tabId, url);
    await expect
      .poll(
        async () =>
          (await api(page, { type: "search", query: "ceramic" })).results
            ?.length,
        { timeout: 20000 },
      )
      .toBe(1);
    const latest = (await api(page, { type: "search", query: "ceramic" }))
      .results![0]!;
    expect((await api(page, { type: "status" })).stats.snapshots).toBe(2);
    await createTab(page, "pistachio://watchtower");
    await page
      .getByRole("textbox", { name: "Search Watchtower" })
      .fill('"bronze bearings"');
    await expect(page.getByTestId("watchtower-result")).toHaveCount(2);
    await page.getByTestId("watchtower-result").last().click();
    await expect(page.getByTestId("watchtower-document")).toContainText(
      "Bronze bearings support",
    );
    await page.screenshot({
      animations: "disabled",
      path: join(evidence, "02-historical-search.png"),
    });
    await page.evaluate(() =>
      (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.updateSettings({ appearance: { scheme: "dark" } }),
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-scheme",
      "dark",
    );
    await page.screenshot({
      animations: "disabled",
      path: join(evidence, "06-dark-reader.png"),
    });
    await page.evaluate(() =>
      (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.updateSettings({ appearance: { scheme: "light" } }),
    );
    const originalSize = await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getSize(),
    );
    await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1000, 850),
    );
    // In a narrow window the saved page takes the whole surface, over the list.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const surface = document.querySelector('[data-testid="watchtower-page"]')!.getBoundingClientRect();
          const reader = document.querySelector('[data-testid="watchtower-document"]')!.getBoundingClientRect();
          return Math.abs(reader.left - surface.left) < 2 && Math.abs(reader.right - surface.right) < 2;
        }),
      )
      .toBe(true);
    await page.screenshot({
      animations: "disabled",
      path: join(evidence, "08-narrow-reader.png"),
    });
    expect(
      await page
        .getByTestId("watchtower-page")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await app!.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0]!.setSize(size[0]!, size[1]!),
      originalSize,
    );
    await page
      .getByRole("combobox", { name: "Saved version" })
      .selectOption(latest.observationId);
    await expect(page.getByTestId("watchtower-document")).toContainText(
      "Ceramic bearings",
    );
    await page
      .getByRole("button", { name: "What changed", exact: true })
      .click();
    await expect(page.getByTestId("watchtower-diff")).toContainText(
      "Bronze bearings support",
    );
    await expect(page.getByTestId("watchtower-diff")).toContainText(
      "Ceramic bearings replace",
    );
    await page.screenshot({
      animations: "disabled",
      path: join(evidence, "03-version-comparison.png"),
    });
    // How saving behaves is a section of the app's settings, one click away.
    await page
      .getByRole("button", { name: "Watchtower settings", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Watchtower", exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId("watchtower-page")).toHaveCount(0);
    const exclusions = page.getByRole("textbox", { name: "Excluded sites" });
    await exclusions.fill("draft.example");
    // Status is re-read every five seconds; a list being typed must survive it.
    await page.waitForTimeout(5600);
    await expect(exclusions).toHaveValue("draft.example");
    // Agent access is off until chosen.
    const agentAccess = page.getByRole("switch", {
      name: "Let the agent search saved pages",
    });
    await expect(agentAccess).toHaveAttribute("aria-checked", "false");
    await agentAccess.click();
    await expect(agentAccess).toHaveAttribute("aria-checked", "true");
    await agentAccess.click();
    await expect(agentAccess).toHaveAttribute("aria-checked", "false");
    await expect(exclusions).toHaveValue("draft.example");
    await page.screenshot({
      animations: "disabled",
      path: join(evidence, "04-settings.png"),
    });
    // The native folder chooser is controlled; export itself uses the real IPC and worker.
    await app!.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, userData);
    await page
      .getByRole("button", { name: "Export Markdown", exact: true })
      .click();
    await expect(page.getByText(/Exported to .*Watchtower-/u)).toBeVisible({
      timeout: 20000,
    });
    await expect(exclusions).toHaveValue("draft.example");
    const exportDirectory = (await readdir(userData)).find((name) =>
      name.startsWith("Watchtower-"),
    );
    expect(exportDirectory).toBeTruthy();
    expect(
      JSON.parse(
        await readFile(join(userData, exportDirectory!, "visits.json"), "utf8"),
      ),
    ).toHaveLength(3);
    // Forgetting asks the way the app asks anything irreversible; cancel leaves everything.
    await page
      .getByRole("button", { name: "Forget everything…", exact: true })
      .click();
    await expect(page.getByTestId("watchtower-forget")).toContainText(
      "What this does not do",
    );
    await page.screenshot({
      animations: "disabled",
      path: join(evidence, "09-forget-dialog.png"),
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByTestId("watchtower-forget")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Open Watchtower", exact: true })
      .click();
    await expect(page.getByTestId("watchtower-page")).toBeVisible();
    await page
      .getByRole("textbox", { name: "Search Watchtower" })
      .fill("bearings");
    await expect(page.getByTestId("watchtower-result")).toHaveCount(3);
    await page
      .getByRole("textbox", { name: "Search Watchtower" })
      .fill("ceramic");
    await expect(page.getByTestId("watchtower-result")).toHaveCount(1);
    await page.getByTestId("watchtower-result").first().click();
    await expect(page.getByTestId("watchtower-document")).toContainText(
      "Ceramic bearings",
    );
    await page
      .getByRole("button", { name: "Open saved tab", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          await app!.evaluate(async ({ webContents }) => {
            const saved = webContents
              .getAllWebContents()
              .find((contents) =>
                contents.getURL().startsWith("pistachio://watchtower/v/"),
              );
            return saved
              ? (saved.executeJavaScript(
                  "document.body.innerText",
                ) as Promise<string>)
              : "";
          }),
      )
      .toContain("Ceramic bearings");
    const savedSafety = await app!.evaluate(async ({ webContents }) => {
      const saved = webContents
        .getAllWebContents()
        .find((contents) =>
          contents.getURL().startsWith("pistachio://watchtower/v/"),
        )!;
      return saved.executeJavaScript(
        "({ scripts:document.scripts.length, secret:typeof window.scriptSecret })",
      ) as Promise<{ scripts: number; secret: string }>;
    });
    expect(savedSafety).toEqual({ scripts: 0, secret: "undefined" });
    await page
      .getByRole("button", { name: "Edit address", exact: true })
      .click();
    await page.getByTestId("address-input").fill("bronze");
    const savedResult = page
      .getByTestId("command-result")
      .filter({ hasText: "Watchtower" });
    await expect(savedResult).toHaveCount(1);
    await page.screenshot({
      animations: "disabled",
      path: join(evidence, "07-address-recall.png"),
    });
    await savedResult.click();
    // Extract all sibling articles and prefer an explicit main over an earlier article.
    const roots = await app!.evaluate(
      async ({ webContents }, { url, script }) => {
        const target = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url)!;
        return target.executeJavaScriptInIsolatedWorld(992, [
          {
            code: `(async () => {
        const previous=document.body.innerHTML;
        try {
          document.body.innerHTML='<article><p>First sibling evidence</p></article><article><p>Second sibling evidence</p></article>';
          const siblings=await ${script};
          document.body.innerHTML='<article>Secondary article</article><main><p>Primary evidence</p></main>';
          const main=await ${script};
          return {siblings,main};
        } finally {document.body.innerHTML=previous;}
      })()`,
          },
        ]) as Promise<{
          siblings: { blocks: { text: string }[]; truncated: boolean };
          main: { blocks: { text: string }[] };
        }>;
      },
      { url, script: WATCHTOWER_CAPTURE_SCRIPT },
    );
    const textOf = (capture: { blocks: { text: string }[] }): string =>
      capture.blocks.map((block) => block.text).join(" ");
    expect(textOf(roots.siblings)).toContain("First sibling evidence");
    expect(textOf(roots.siblings)).toContain("Second sibling evidence");
    expect(roots.siblings.truncated).toBe(false);
    expect(textOf(roots.main)).toContain("Primary evidence");
    expect(textOf(roots.main)).not.toContain("Secondary article");
    // Bound extraction on a large actual DOM, and prove animation frames can run between slices.
    const extraction = await app!.evaluate(
      async ({ webContents }, { url, script }) => {
        const target = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url)!;
        return target.executeJavaScriptInIsolatedWorld(992, [
          {
            code: `(async () => {
        document.querySelector('main').replaceChildren();
        const main=document.querySelector('main'); for(let i=0;i<5000;i++){const p=document.createElement('p');p.textContent='Paragraph '+i+' '+ 'Detailed source material. '.repeat(60);main.append(p);}
        let frames=0; let counting=true; const beat=()=>{frames++;if(counting)requestAnimationFrame(beat)};requestAnimationFrame(beat);
        const start=performance.now(); const result=await ${script}; counting=false;
        return { elapsed:performance.now()-start, frames, truncated:result.truncated, bytes:new TextEncoder().encode(JSON.stringify(result)).length };
      })()`,
          },
        ]) as Promise<{
          elapsed: number;
          frames: number;
          truncated: boolean;
          bytes: number;
        }>;
      },
      { url, script: WATCHTOWER_CAPTURE_SCRIPT },
    );
    expect(extraction.truncated).toBe(true);
    expect(extraction.bytes).toBeLessThan(256 * 1024);
    expect(extraction.frames).toBeGreaterThan(0);
    expect(extraction.elapsed).toBeLessThan(6000);
    await writeFile(
      join(evidence, "extraction.json"),
      JSON.stringify(extraction, null, 2) + "\n",
    );
    // A video page: what it is about is saved, its furniture is not, and a
    // player clock ticking for half a minute does not become new versions.
    await createTab(page, url.replace("/notebook", "/watch"));
    await expect
      .poll(
        async () =>
          (await api(page, { type: "search", query: "gearbox shim" })).results
            ?.length,
        { timeout: 20000 },
      )
      .toBe(1);
    const watch = (await api(page, { type: "search", query: "kind:video gearbox" })).results![0]!;
    const watched = (await api(page, { type: "read", observationId: watch.observationId })).document!;
    expect(watched.kind).toBe("video");
    expect(watched.markdown).toContain("Creator: Harbor Workshop");
    expect(watched.markdown).toContain("Duration: PT12M");
    expect(watched.markdown).toContain("every shim");
    expect(watched.markdown).not.toMatch(/Beekeeping|Apiary|Sponsored|RivalLathe|12:00/u);
    // The rail's words must not find this page.
    expect((await api(page, { type: "search", query: "beekeeping" })).results).toEqual([]);
    const versionsBefore = (await api(page, { type: "status" })).stats.snapshots;
    await page.waitForTimeout(34000);
    expect((await api(page, { type: "status" })).stats.snapshots).toBe(versionsBefore);
    expect(
      (await api(page, { type: "read", observationId: watch.observationId })).document!.history,
    ).toHaveLength(1);
    // As-you-type recall completes a word and ranks the page about it first.
    expect((await api(page, { type: "search", query: "gearb", limit: 3 })).results?.[0]?.title).toBe("Gearbox teardown");
    await api(page, { type: "settings", patch: { paused: true } });
    await app!.close();
    app = null;
    page = await launch();
    expect(
      (await api(page, { type: "read", observationId: first.observationId }))
        .document?.markdown,
    ).toBe(original.markdown);
    expect((await api(page, { type: "status" })).settings).toMatchObject({
      enabled: true,
      paused: true,
    });
    const count = (await api(page, { type: "status" })).stats.visits;
    await createTab(page, `${url}?paused=1`);
    await page.waitForTimeout(3000);
    expect((await api(page, { type: "status" })).stats.visits).toBe(count);
    await api(page, {
      type: "settings",
      patch: { paused: false, excludedHosts: ["127.0.0.1"] },
    });
    expect((await api(page, { type: "status" })).settings).toMatchObject({
      enabled: true,
      paused: false,
      excludedHosts: ["127.0.0.1"],
    });
    await createTab(page, `${url}?excluded=1`);
    await page.waitForTimeout(3000);
    expect((await api(page, { type: "status" })).stats.visits).toBe(count);
    await api(page, { type: "forget", all: true });
    await expect
      .poll(async () =>
        app!.evaluate(async ({ webContents }) => {
          const readers = webContents
            .getAllWebContents()
            .filter((contents) =>
              contents.getURL().startsWith("pistachio://watchtower/v/"),
            );
          const texts = await Promise.all(
            readers.map(
              (contents) =>
                contents.executeJavaScript(
                  "document.body.innerText",
                ) as Promise<string>,
            ),
          );
          return texts.every(
            (text) =>
              text.includes("unavailable") || text.includes("forgotten"),
          );
        }),
      )
      .toBe(true);
    expect(
      (await api(page, { type: "search", query: "bronze" })).results,
    ).toEqual([]);
    await createTab(page, "pistachio://watchtower");
    await expect(page.getByTestId("watchtower-page")).toBeVisible();
    await expect(
      page.getByText("Nothing saved yet", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("watchtower-result")).toHaveCount(0);
    await page.screenshot({
      animations: "disabled",
      path: join(evidence, "05-forgotten.png"),
    });
  } finally {
    await (app as ElectronApplication | null)?.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
