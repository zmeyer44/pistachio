/**
 * A person's ChatGPT plan, connected and used for the chat (docs/ai-plans.md),
 * through the real app against a stand-in for OpenAI on 127.0.0.1
 * (test/support/openai-standin.ts; `PISTACHIO_E2E_AI_PLAN` points main at
 * it). The stand-in checks what the real service checks — PKCE, the exact
 * loopback address, the issued client id, a signed ID token, the bearer on
 * each request — so everything between the button and the reply is the
 * app's own: the settings page, main's service, the loopback listener, the
 * sealed file, the run controller's choice of model, the provider library,
 * the request as the plan's route takes it.
 *
 * No browser is opened: under a test run main walks the sign-in page's
 * redirect itself, as the person's browser would.
 *
 * 1. Not connected: Settings → AI plan offers *Continue with ChatGPT*, and
 *    the chat is on Pistachio's models.
 * 2. Signing in: the welcome sheet, once — *You're using your ChatGPT plan*.
 * 3. A turn runs on the plan: the reply is the stand-in's, the request is
 *    the plan route's (stateless, streamed, tools in a namespace), and the
 *    Bar says *Using ChatGPT plan*.
 * 4. A usage limit: the turn stops on Pistachio's own sentence, the Bar says
 *    so with *Manage usage*, and the next turn is not sent at all.
 * 5. *Use Pistachio's models*: the same thread goes on, on the scripted
 *    stand-in for Pistachio's own model.
 * 6. *Try again* once the limit has lifted: back on the plan, same thread.
 * 7. Signing out ends the session at the provider.
 *
 * What main and the shell decide by themselves is unit-tested
 * (test/ai-plans.test.ts, test/run-controller.test.ts,
 * packages/shell-ui/test/ai-plans.test.ts).
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createStandIn, serveStandIn, type StandIn } from "../../test/support/openai-standin";
import { launchDesk, reachBar, screenshots, settled, snapshot } from "./desk-harness";

const capture = screenshots("ai-plan");

const FROM_PISTACHIO = "From Pistachio's own models.";
/** Pistachio's own model, scripted: it answers only once the person has switched to it. Streamed, as the app's turns are. */
const SCRIPT = { stream: true, steps: [{ text: FROM_PISTACHIO, streamMs: 60 }] };

test.describe.serial("the chat on a person's own ChatGPT plan: signing in, a turn, a limit, switching, signing out", { tag: ["@agent", "@settings"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let standIn: StandIn;
  let server: { origin: string; close(): Promise<void> };

  const openPlanSettings = async (): Promise<void> => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("pistachio:shell-command", { type: "openSettings", section: "plan" }));
    await expect(shell.getByTestId("settings-page")).toBeVisible();
  };
  const closeSettings = async (): Promise<void> => {
    await shell.getByRole("button", { name: "Close settings" }).click();
    await expect(shell.getByTestId("settings-page")).toHaveCount(0);
  };
  const ask = async (text: string): Promise<void> => {
    await reachBar(shell);
    const input = shell.getByTestId("desk-bar-input");
    await input.fill(text);
    await input.press("Enter");
  };
  /** The run once its latest turn is over, and what it last said. */
  const lastReply = async (status: "completed" | "failed", messages: number): Promise<string> => {
    await expect.poll(async () => {
      const run = (await snapshot(shell)).run;
      return run === null ? null : [run.status, run.messages.filter((message) => message.role === "user").length];
    }, { timeout: 20_000 }).toEqual([status, messages]);
    return (await snapshot(shell)).run?.messages.at(-1)?.content ?? "";
  };
  const opened = (): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { __pistachioE2EOpened: string[] }).__pistachioE2EOpened);

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    standIn = createStandIn();
    server = await serveStandIn(standIn);
    ({ app, shell } = await launchDesk({ name: "ai-plan", env: { PISTACHIO_E2E_AI_PLAN: server.origin, PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } }));
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
    await server?.close();
  });

  test("not connected: Settings → AI plan offers Continue with ChatGPT, and the chat is on Pistachio's models", async () => {
    await openPlanSettings();
    await expect(shell.getByTestId("ai-plan-connect")).toHaveText("Continue with ChatGPT");
    await expect(shell.getByTestId("ai-plan-chat-source")).toHaveText("Pistachio");
    await expect(shell.getByTestId("ai-plan-status")).toHaveCount(0);
    await capture(app, shell, "01-not-connected.png");
  });

  test("Continue with ChatGPT signs in, and the first sign-in is confirmed once", async () => {
    await shell.getByTestId("ai-plan-connect").click();
    // The first sign-in ever: its confirmation, with the action OpenAI asks for.
    const welcome = shell.getByTestId("ai-plan-welcome");
    await expect(welcome).toBeVisible({ timeout: 15_000 });
    await expect(welcome).toContainText("You're using your ChatGPT plan");
    await capture(app, shell, "02-welcome.png");
    await shell.getByTestId("ai-plan-welcome-done").click();
    await expect(welcome).toHaveCount(0);

    await expect(shell.getByTestId("ai-plan-status")).toHaveAttribute("data-status", "ready");
    await expect(shell.getByTestId("settings-page")).toContainText("person@example.com");
    await expect(shell.getByTestId("ai-plan-chat-source")).toHaveText("ChatGPT plan");
    // The account's own catalog, and the model Pistachio's turns use since it is listed.
    await expect(shell.getByTestId("ai-plan-model").locator("option")).toHaveText(["GPT-6.1 Sol", "GPT-5.6 Terra"]);
    await expect(shell.getByTestId("ai-plan-model")).toHaveValue("gpt-5.6-terra");

    // A registration by name, on the loopback address, exchanged under the id that was issued.
    const asked = standIn.seen.authorize[0]!.searchParams;
    expect(asked.get("client_id")).toBe("dynamic_agent_client");
    expect(asked.get("agent_name_hint")).toBe("Pistachio");
    expect(asked.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(standIn.seen.token[0]!.get("client_id")).toBe("oaiapp_standin_1");
    await capture(app, shell, "03-connected.png");
    await closeSettings();
  });

  test("a turn runs on the plan, through the public Responses API as the plan's route takes it", async () => {
    await ask("Say hello");
    expect(await lastReply("completed", 1)).toBe("Hello from your plan.");

    const sent = standIn.seen.responses[0]!;
    expect(sent.authorization).toBe("Bearer at_standin_1");
    expect(sent.body).toMatchObject({ model: "gpt-5.6-terra", store: false, stream: true });
    // The agent's own tools, grouped as the route asks; and no system-role item.
    const tools = sent.body["tools"] as Array<{ type: string; name?: string; tools?: Array<{ name: string }> }>;
    const namespace = tools.find((tool) => tool.type === "namespace");
    expect(namespace?.name).toBe("pistachio");
    expect(namespace?.tools?.map((tool) => tool.name)).toContain("tabs_list");
    expect((sent.body["input"] as Array<{ role?: string }>).some((item) => item.role === "system")).toBe(false);

    await reachBar(shell);
    const line = shell.getByTestId("plan-line");
    await expect(line).toHaveAttribute("data-status", "ready");
    await expect(line).toContainText("Using ChatGPT plan");
    await expect(line.getByTestId("plan-line-manage-usage")).toHaveText("Manage usage");
    await capture(app, shell, "04-using-plan.png");
  });

  test("a usage limit stops the turn on Pistachio's own sentence, and pauses the plan rather than falling back", async () => {
    standIn.knobs.limit = true;
    await ask("And again");
    const said = await lastReply("failed", 2);
    expect(said).toContain("usage limit was reached");
    expect(said).toContain("https://chatgpt.com/settings/usage");
    // What the provider said named the account: none of it reaches the person.
    expect(said).not.toMatch(/user-standin|person@example/);

    await reachBar(shell);
    const line = shell.getByTestId("plan-line");
    await expect(line).toHaveAttribute("data-status", "limit");
    await expect(line).toContainText("Usage limit reached");
    await capture(app, shell, "05-limit.png");
    // Manage usage opens ChatGPT's own page for it.
    await line.getByTestId("plan-line-manage-usage").click();
    await expect.poll(async () => (await opened()).at(-1)).toBe("https://chatgpt.com/settings/usage");

    // Paused: the next turn is not sent, and Pistachio's model is not asked instead.
    const sentBefore = standIn.seen.responses.length;
    await ask("Once more");
    expect(await lastReply("failed", 3)).toContain("paused");
    expect(standIn.seen.responses).toHaveLength(sentBefore);
  });

  test("Use Pistachio's models: the same thread goes on, on Pistachio's own model", async () => {
    await reachBar(shell);
    await shell.getByTestId("plan-line-use-pistachio").click();
    await expect(shell.getByTestId("plan-line")).toHaveCount(0);
    const sentBefore = standIn.seen.responses.length;
    await ask("Then you answer");
    expect(await lastReply("completed", 4)).toBe(FROM_PISTACHIO);
    expect(standIn.seen.responses).toHaveLength(sentBefore);
  });

  test("Try again once the limit has lifted: the chat is back on the plan, with the thread it had", async () => {
    standIn.knobs.limit = false;
    await openPlanSettings();
    await expect(shell.getByTestId("ai-plan-status")).toHaveAttribute("data-status", "limit");
    await expect(shell.getByTestId("ai-plan-limit")).toContainText("Usage limit reached");
    await capture(app, shell, "06-limit-settings.png");
    await shell.getByTestId("ai-plan-resume").click();
    await expect(shell.getByTestId("ai-plan-status")).toHaveAttribute("data-status", "ready");
    await shell.getByRole("switch", { name: "Use my ChatGPT plan for the chat" }).click();
    await expect(shell.getByTestId("ai-plan-chat-source")).toHaveText("ChatGPT plan");
    await closeSettings();

    await ask("Back to you");
    expect(await lastReply("completed", 5)).toBe("Hello from your plan.");
    // The thread came along — what Pistachio's model said is in what the plan was sent — and the plan's own count moved.
    expect(JSON.stringify(standIn.seen.responses.at(-1)!.body["input"])).toContain(FROM_PISTACHIO);
    await openPlanSettings();
    await expect(shell.getByTestId("ai-plan-usage-total")).toHaveText("2 requests");
    await capture(app, shell, "07-usage.png");
  });

  test("signing out ends the session at the provider, and keeps the account for next time", async () => {
    await shell.getByTestId("ai-plan-disconnect").click();
    await expect(shell.getByTestId("ai-plan-connect")).toBeVisible();
    await expect(shell.getByTestId("settings-page")).toContainText("Last connected as person@example.com");
    await expect(shell.getByTestId("ai-plan-chat-source")).toHaveText("Pistachio");
    expect(standIn.seen.revoked).toHaveLength(1);
    await expect(shell.getByTestId("ai-plan-unconfirmed")).toHaveCount(0);
    await capture(app, shell, "08-signed-out.png");
    await closeSettings();
    await reachBar(shell);
    await expect(shell.getByTestId("plan-line")).toHaveCount(0);
  });
});
