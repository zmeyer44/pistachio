/**
 * Extensions and the agent, both ways (docs/extensions.md §1 X12, §6.2, §8),
 * through the real app on a scripted model (PISTACHIO_AGENT_SCRIPT; only the
 * model's choices are scripted — the runner, the run controller, the
 * extension service, the watcher, the worker and the shell are the app's):
 *
 * 1. `/extension make a word counter` in the Bar: main makes a draft folder
 *    and hands the Bar its token; the turn that carries it is an author turn,
 *    which writes `pistachio.json` and `worker.js` with its draft tools and
 *    reads the status Pistachio writes back. The folder lands waiting on the
 *    person: an amber dot on the Ledge, the sheet on a click.
 * 2. Turned on, its declared tool is the agent's: a desk turn calls
 *    `x_<six hex of the id>_word_count`, the worker's `onToolCall` answers, and
 *    the trace names the extension; the input is on the extension's ledger.
 *
 * What the runner and the service decide by themselves — names, schemas,
 * framing, refusals, the draft's paths — is unit-tested
 * (packages/agent-runtime/test/extension-tools.test.ts,
 * test/extensions-agent.test.ts, test/run-controller.test.ts).
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { launchDesk, reachBar, screenshots, settled, snapshot } from "./desk-harness";

const capture = screenshots("extensions-agent");

const ID = "dev.e2e.word-counter";
const SLUG = "make-a-word-counter";
/** The tool's model-facing name (extension-tools.ts `extensionToolName`). */
const TOOL = `x_${createHash("sha256").update(ID).digest("hex").slice(0, 6)}_word_count`;

const MANIFEST = JSON.stringify(
  {
    api: 1,
    id: ID,
    name: "Word counter",
    version: "0.1.0",
    description: "Counts the words in a text for the agent.",
    permissions: ["agent:tools"],
    worker: { type: "web", main: "worker.js" },
    tools: [{ name: "word_count", description: "Count the words in a text.", effect: "read", input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
  },
  null,
  2,
);

const WORKER = `await pistachio.runtime.ready;

pistachio.agent.onToolCall("word_count", async ({ text }, { progress }) => {
  progress("Counting");
  const words = String(text).trim().split(/\\s+/).filter(Boolean);
  return { words: words.length };
});
`;

const AUTHORED = "Word counter is ready: it gives me a word_count tool. It asks to let me call it — turn it on from the sheet.";
const COUNTED = "There are four words.";

const SCRIPT = {
  steps: [
    // The author turn: the folder, then its status.
    {
      tools: [
        { name: "extension_draft_write", input: { slug: SLUG, path: "pistachio.json", content: MANIFEST } },
        { name: "extension_draft_write", input: { slug: SLUG, path: "worker.js", content: WORKER } },
      ],
    },
    { tools: [{ name: "extension_status", input: { slug: SLUG } }] },
    { text: AUTHORED },
    // A desk turn, once it is on: its tool.
    { tools: [{ name: TOOL, input: { text: "one two three four" } }] },
    { text: COUNTED },
  ],
};

test.describe.serial("extensions and the agent: an author turn drafts one, and a turn calls its tool", { tag: ["@extensions", "@agent"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let devFolder: string;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    devFolder = await mkdtemp(join(tmpdir(), "pistachio-extensions-agent-"));
    ({ app, shell, userData } = await launchDesk({ name: "extensions-agent", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } }));
    // This run's dev folder, off: `/extension` turns Developer mode on as it drafts.
    await shell.evaluate(
      (folder) => (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ extensions: { developerMode: false, devFolder: folder } }),
      devFolder,
    );
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("/extension runs an author turn with the draft tools, and the folder lands waiting on the person", async () => {
    test.setTimeout(60_000);
    await reachBar(shell);
    const input = shell.getByTestId("desk-bar-input");
    await input.fill("/extension make a word counter");
    await input.press("Enter");

    // The person's words, the marker main read gone; the agent's steps, the draft tools'.
    const answer = shell.getByTestId("desk-answer");
    await expect(answer.getByTestId("user-message")).toHaveText(`Build a Pistachio extension that make a word counter. Write it in ${join(devFolder, SLUG)}.`, { timeout: 15_000 });
    await expect(answer).toContainText(AUTHORED, { timeout: 20_000 });
    const run = (await snapshot(shell)).run;
    expect(run?.toolCalls.map((tool) => [tool.name, tool.status])).toEqual([
      ["ext.draft.write", "completed"],
      ["ext.draft.write", "completed"],
      ["ext.status", "completed"],
    ]);
    // The status it read is the one Pistachio wrote after the save: loaded, waiting on approval.
    const status = JSON.parse(await readFile(join(devFolder, SLUG, ".pistachio", "status.json"), "utf8")) as { id: string; state: string; manifestErrors: unknown[] };
    expect(status).toMatchObject({ id: ID, state: "needs-approval", manifestErrors: [] });

    // On the Ledge, waiting: the amber dot, never on by itself.
    const icon = shell.locator(`[data-testid="ledge-icon"][data-extension-id="${ID}"]`);
    await expect(icon).toBeVisible({ timeout: 10_000 });
    await expect(icon).toHaveAttribute("data-dot", "amber");
    await capture(app, shell, "01-drafted.png");

    // The person's click: the sheet, then on.
    await icon.click();
    const sheet = shell.getByTestId("extension-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("extension-sheet-name")).toHaveText("Word counter");
    await capture(app, shell, "02-sheet.png");
    await sheet.getByTestId("extension-sheet-turn-on").click();
    await expect(sheet).toHaveCount(0);
    await expect(icon).not.toHaveAttribute("data-dot", /.+/);
  });

  test("a desk turn calls its tool, the worker answers, and the trace names the extension", async () => {
    test.setTimeout(60_000);
    await reachBar(shell);
    const input = shell.getByTestId("desk-bar-input");
    await input.fill("How many words are in “one two three four”?");
    await input.press("Enter");
    const answer = shell.getByTestId("desk-answer");
    await expect(answer).toContainText(COUNTED, { timeout: 20_000 });
    // Completed means the worker's onToolCall answered through runtime.done (a failure would say why, in red).
    await expect
      .poll(async () => (await snapshot(shell)).run?.toolCalls.filter((tool) => tool.name === "ext.call").map((tool) => [tool.label, tool.status, tool.detail]))
      .toEqual([["Word counter", "completed", "Word counter answered"]]);
    // What the agent sent the extension is on its ledger.
    const ledger = await readFile(join(userData, "ExtensionData", ID, "ledger.ndjson"), "utf8");
    expect(ledger).toContain('"method":"TOOL"');
    expect(ledger).toContain("one two three four");
    await capture(app, shell, "03-tool-called.png");
  });
});
