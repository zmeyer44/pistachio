/**
 * The agent and Pistachio itself (docs/agent-pistachio.md), through the real
 * app on a scripted model (PISTACHIO_AGENT_SCRIPT; only the model's choices
 * are scripted — the runner, the run controller, the settings file, the
 * extension service, its watcher and worker and the shell are the app's):
 * the journey of a person who asks how to change how Pistachio looks.
 *
 * 1. Asked, the agent answers in the Bar and touches nothing.
 * 2. "Make it dark, with a purple wash": `settings_change` writes the
 *    settings file through the store, and the window is dark — the shell
 *    heard it as it hears the Settings page.
 * 3. "Show me": `pistachio_open` brings up Settings on Appearance.
 * 4. "A deep green backdrop behind every space": `extension_build` makes a
 *    draft folder and runs the builder, whose draft tools write it; it lands
 *    waiting — a card under the reply, an amber dot on the Ledge, nothing on.
 *    The card opens the approval sheet; turned on by the person, the worker
 *    sets its theme and the backdrop is in the desk's well.
 *
 * What the runner and main decide by themselves — the guide, the catalog, a
 * change's checks, the builder's isolation, what a turn that read a page may
 * not do — is unit-tested (packages/agent-runtime/test/pistachio-tools.test.ts,
 * test/pistachio-agent.test.ts, test/extensions-agent.test.ts,
 * test/run-controller.test.ts).
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { launchDesk, reachBar, screenshots, settled, snapshot } from "./desk-harness";

const capture = screenshots("agent-pistachio");

const ID = "dev.local.night-desk";
const SLUG = "night-desk";

const MANIFEST = JSON.stringify(
  {
    api: 1,
    id: ID,
    name: "Night desk",
    version: "1.0.0",
    description: "A deep green backdrop behind every space, with a green accent.",
    permissions: ["theme"],
    worker: { type: "web", main: "worker.js" },
  },
  null,
  2,
);

const WORKER = `await pistachio.runtime.ready;

pistachio.runtime.onInstalled(() =>
  pistachio.theme.set({ backdrop: { gradient: { colors: ["#0b3d2e", "#145c43"], angle: 180 } }, colors: { accent: "#1f8a4c" } }),
);
`;

const OFFER = "I can help with that — what should we change?";
const DARK = "Done — Pistachio is dark now, with a purple and pink wash. Say the word and I'll put it back.";
const SHOWN = "Appearance is open.";
const REPORT = "Night desk puts a deep green gradient behind every space and sets a green accent. It asks to change the backdrop and accent.";
const BUILT = "Night desk is ready. It waits for you: open the card below to turn it on.";
const BRIEF = "Give every space a deep green gradient backdrop, #0b3d2e at the top to #145c43 at the bottom, and the accent #1f8a4c. It applies by itself as soon as it is turned on.";

const SCRIPT = {
  steps: [
    // 1. Asked how: an offer, nothing touched.
    { text: OFFER },
    // 2. The wish: the page read, then changed.
    { tools: [{ name: "settings_read", input: { section: "appearance" } }] },
    {
      tools: [
        {
          name: "settings_change",
          input: {
            changes: [
              { key: "appearance.scheme", value: "dark" },
              { key: "appearance.colors", value: ["#7c3aed", "#ec4899"] },
            ],
          },
        },
      ],
    },
    { text: DARK },
    // 3. "Show me": the page itself.
    { tools: [{ name: "pistachio_open", input: { page: "settings/appearance" } }] },
    { text: SHOWN },
    // 4. What no setting does: a build — the conversation's agent, then its builder's own steps, then the agent again.
    { tools: [{ name: "extension_build", input: { name: "Night desk", brief: BRIEF, extension: null } }] },
    {
      tools: [
        { name: "extension_draft_write", input: { slug: SLUG, path: "pistachio.json", content: MANIFEST } },
        { name: "extension_draft_write", input: { slug: SLUG, path: "worker.js", content: WORKER } },
      ],
    },
    { tools: [{ name: "extension_status", input: { slug: SLUG } }] },
    { text: REPORT },
    { text: BUILT },
  ],
};

test.describe.serial("the agent and Pistachio itself: asked how to change its look, it changes it — a setting, then an extension it builds", { tag: ["@agent", "@extensions", "@settings"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let devFolder: string;

  const settings = () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSettings());
  const ask = async (text: string): Promise<void> => {
    await reachBar(shell);
    const input = shell.getByTestId("desk-bar-input");
    await input.fill(text);
    await input.press("Enter");
  };
  const answer = () => shell.getByTestId("desk-answer");
  const toolCalls = async () => ((await snapshot(shell)).run?.toolCalls ?? []).map((tool) => [tool.name, tool.status]);

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    devFolder = await mkdtemp(join(tmpdir(), "pistachio-agent-pistachio-"));
    ({ app, shell } = await launchDesk({ name: "agent-pistachio", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } }));
    // This run's dev folder, off: a build turns Developer mode on as it drafts. And light, so dark is a change.
    await shell.evaluate(
      (folder) => (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ extensions: { developerMode: false, devFolder: folder }, appearance: { scheme: "light" } }),
      devFolder,
    );
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("asked how its look can be changed, it offers — and touches nothing", async () => {
    test.setTimeout(60_000);
    await ask("How can I customize the appearance of Pistachio?");
    await expect(answer()).toContainText(OFFER, { timeout: 20_000 });
    expect(await toolCalls()).toEqual([]);
    expect((await settings()).appearance.scheme).toBe("light");
    await capture(app, shell, "01-offer.png");
  });

  test("told what to change, it changes the settings — and the window is dark", async () => {
    test.setTimeout(60_000);
    await expect(shell.locator("html")).toHaveAttribute("data-color-scheme", "light");
    await ask("Make it dark, with a purple and pink wash.");
    await expect(answer()).toContainText(DARK, { timeout: 20_000 });
    // The file, through the store: what the Settings page would have written.
    const look = (await settings()).appearance;
    expect(look.scheme).toBe("dark");
    expect(look.colors).toEqual(["#7C3AED", "#EC4899"]);
    // The shell heard it as it hears the Settings page: the theme in force is dark.
    await expect(shell.locator("html")).toHaveAttribute("data-color-scheme", "dark");
    // Its steps say what they did, in the trace.
    const run = (await snapshot(shell)).run;
    expect(run?.toolCalls.filter((tool) => tool.name.startsWith("settings.")).map((tool) => [tool.name, tool.label, tool.status, tool.detail])).toEqual([
      ["settings.read", "Read settings", "completed", expect.stringMatching(/^Appearance: \d+ settings$/)],
      ["settings.change", "Change settings", "completed", "appearance.scheme: light → dark; appearance.colors: #88C999, #67BFB4, #98B9EF → #7C3AED, #EC4899"],
    ]);
    await capture(app, shell, "02-dark.png");
  });

  test("asked to see it, it opens Settings on Appearance", async () => {
    test.setTimeout(60_000);
    await ask("Show me the appearance settings.");
    const page = shell.getByTestId("settings-page");
    await expect(page).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Appearance");
    await capture(app, shell, "03-settings.png");
    // (Read off the run: Settings is a page over the desk, and a press outside a docked answer card closes it.)
    await expect.poll(async () => (await snapshot(shell)).run?.messages.at(-1)?.content, { timeout: 20_000 }).toBe(SHOWN);
    expect((await toolCalls()).at(-1)).toEqual(["app.open", "completed"]);
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page).toHaveCount(0);
  });

  test("asked for what no setting does, it builds an extension that lands waiting — and its card is the way to turn it on", async () => {
    test.setTimeout(90_000);
    await ask("Give every space a deep green backdrop.");
    await expect(answer()).toContainText(BUILT, { timeout: 30_000 });

    // The build, and under it the builder's own steps — in the conversation's trace.
    const built = ((await snapshot(shell)).run?.toolCalls ?? []).filter((tool) => tool.name.startsWith("ext."));
    expect(built.map((tool) => [tool.name, tool.status])).toEqual([
      ["ext.build", "completed"],
      ["ext.draft.write", "completed"],
      ["ext.draft.write", "completed"],
      ["ext.status", "completed"],
    ]);
    expect(built[0]?.output).toEqual({ kind: "extension", action: "created", id: ID, title: "Night desk", waiting: true });

    // Written where the person's own extensions live, and loaded: waiting, never on by itself.
    const status = JSON.parse(await readFile(join(devFolder, SLUG, ".pistachio", "status.json"), "utf8")) as { id: string; state: string; manifestErrors: unknown[] };
    expect(status).toMatchObject({ id: ID, state: "needs-approval", manifestErrors: [] });
    expect((await settings()).extensions.developerMode).toBe(true);
    const icon = shell.locator(`[data-testid="ledge-icon"][data-extension-id="${ID}"]`);
    await expect(icon).toHaveAttribute("data-dot", "amber", { timeout: 10_000 });
    await expect(shell.getByTestId("desk-backdrop")).toHaveCount(0);

    // The card under the reply says where it stands, and is the way to the step that is the person's.
    const card = answer().locator('[data-testid="output-card"][data-kind="extension"]');
    await expect(card).toHaveAttribute("data-waiting", "");
    await expect(card).toContainText("Night desk");
    await expect(card).toContainText("Waiting for you to turn it on");
    await expect(card).toContainText("Review");
    await capture(app, shell, "04-built.png");
    await card.click();
    const sheet = shell.getByTestId("extension-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("extension-sheet-name")).toHaveText("Night desk");
    await expect(sheet).toContainText("Changes the backdrop and accent colour of your spaces.");
    await capture(app, shell, "05-sheet.png");

    // The person's click, and only theirs: on, the worker sets its theme and the backdrop is in the well.
    await sheet.getByTestId("extension-sheet-turn-on").click();
    await expect(sheet).toHaveCount(0);
    const backdrop = shell.getByTestId("desk-backdrop");
    await expect(backdrop).toHaveCount(1, { timeout: 20_000 });
    await expect(backdrop).toHaveAttribute("data-kind", "gradient");
    await expect(backdrop).toHaveAttribute("data-extension-id", ID);
    await expect(icon).not.toHaveAttribute("data-dot", /.+/);
    // What the person set a moment ago is theirs still: the extension's accent is laid over it, never written into it.
    await expect(shell.locator("html")).toHaveAttribute("data-color-scheme", "dark");
    expect((await settings()).appearance).toMatchObject({ scheme: "dark", colors: ["#7C3AED", "#EC4899"] });
    await capture(app, shell, "06-on.png", 1_200);
  });
});
