/**
 * Live check of the agent's knowledge of Pistachio itself (docs/agent-pistachio.md):
 * the real model through the real gateway and the real runner, over main's
 * real settings catalog and a real draft folder read by the real loader —
 * only the shell and the browser are stand-ins. Skipped unless
 * PISTACHIO_SELF_LIVE=1 and the workspace has a gateway key in `.env`:
 *
 *   PISTACHIO_SELF_LIVE=1 pnpm vitest run test/pistachio-agent.live.test.ts
 *
 * What it guards is the WORDING of the guide and the tools
 * (packages/agent-runtime/src/pistachio-tools.ts): that a question about the
 * app is answered with an offer to do the thing — not a web search, not a
 * tour of menus — that a wish is carried out with the tools, that a locked
 * setting is left to the person, and that a wish no setting covers is built
 * as an extension that loads and lands waiting. The replies are printed; the
 * assertions are the floor.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createGateway, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { runAiBrowserAgent, userMessage, type AiAgentRunCallbacks, type BrowserBackend, type PistachioToolHost } from "@pistachio/agent-runtime";
import { accentRefusal } from "@pistachio/extension-api/theme";
import type { AgentToolRequest } from "@pistachio/protocol";
import { applySettingsPatch, DEFAULT_SETTINGS, type DesktopSettings } from "@pistachio/shell-contracts/settings";
import { DraftFolders } from "../src/main/extensions/agent";
import { loadExtensionFolder } from "../src/main/extensions/loader";
import { pageCommand, PISTACHIO_PAGES, planSettingsChange, readSettings, settingsSections } from "../src/main/pistachio-agent";

const envPath = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find((path) => existsSync(path));
const live = process.env["PISTACHIO_SELF_LIVE"] === "1";
if (envPath !== undefined && live) process.loadEnvFile(envPath);
const key = process.env["AI_GATEWAY_API_KEY"];
const modelId = process.env["PISTACHIO_AGENT_MODEL"]?.trim() || "openai/gpt-5.6-terra";

const BROWSER_TOOLS = ["tabs.list", "tab.open", "tab.show", "page.inspect", "page.navigate", "page.click", "page.type", "page.press", "page.scroll", "page.screenshot"];

/** A browser with one tab on a news site: there to be left alone. */
const browser: BrowserBackend = {
  kind: "desktop",
  listTabs: () => [{ id: "tab-1", spaceId: "work", title: "Example News", url: "https://news.example/", active: true, loading: false, kind: "human" }] as never,
  openTab: async () => "tab-2",
  focusTab: async () => undefined,
  navigate: async () => undefined,
  back: async () => undefined,
  forward: async () => undefined,
  reload: async () => undefined,
  inspect: async () => ({ title: "Example News", url: "https://news.example/", text: "Headlines of the day.", controls: [] }),
  click: async () => undefined,
  type: async (_tabId: string, _target: string, value: string) => value,
  press: async () => undefined,
  scroll: async () => undefined,
  screenshot: async () => "data:image/png;base64,AAAA",
};

/** Pistachio around a conversation: the real catalog over a settings object, the shell's pages recorded, a real draft folder. */
function pistachio() {
  let settings: DesktopSettings = structuredClone(DEFAULT_SETTINGS);
  const opened: string[] = [];
  const parent = mkdtempSync(join(tmpdir(), "pistachio-self-live-"));
  const drafts = new DraftFolders({ settleMs: 0 });
  const names = new Map<string, string>();
  const folderOf = (slug: string): string => drafts.folderOf(slug) ?? join(parent, slug);
  /** The folder as the app would read it after a save: the real loader's verdict, as the status file words it. */
  const statusOf = (slug: string) => {
    const result = loadExtensionFolder(folderOf(slug));
    return result.ok
      ? { id: result.manifest.id, state: "needs-approval", manifestErrors: [], runtimeErrors: [], pendingGrants: { capabilities: result.manifest.permissions ?? [], hosts: result.manifest.hosts ?? [] } }
      : { id: result.id, state: "error", manifestErrors: result.issues.length > 0 ? result.issues : [{ path: "", message: result.error }], runtimeErrors: [] };
  };
  const host: PistachioToolHost = {
    settings: {
      sections: () => settingsSections(),
      read: (section) => readSettings(settings, section),
      change: (changes, context) => {
        const plan = planSettingsChange(settings, changes, context);
        settings = applySettingsPatch(settings, plan.patch);
        return plan.changed;
      },
    },
    pages: () => [...PISTACHIO_PAGES],
    open: async (page) => {
      const target = pageCommand(page);
      if (target === null) throw new Error(`There is no page "${page}".`);
      opened.push(page);
      return target.opened;
    },
    extensions: {
      list: () => [],
      builder: {
        open: async ({ name, extension }) => {
          const slug = extension ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          const folder = join(parent, slug);
          mkdirSync(folder, { recursive: true });
          names.set(slug, name);
          return { slug: drafts.adopt(folder), created: extension === null };
        },
        author: {
          write: (slug, path, content) => drafts.write(slug, path, content),
          read: (slug, path) => drafts.read(slug, path),
          status: async (slug) => JSON.stringify(statusOf(slug)),
        },
        guide: () => readFileSync(resolve(process.cwd(), "../../packages/extension-api/AGENTS.md"), "utf8"),
        outcome: async (slug) => {
          const result = loadExtensionFolder(folderOf(slug));
          return result.ok
            ? { id: result.manifest.id, title: result.manifest.name, slug, waiting: true, adds: result.sheet.adds, asks: result.sheet.can.map((line) => line.text), runs: result.sheet.runs ?? [], errors: [] }
            : { id: null, title: names.get(slug) ?? slug, slug, waiting: false, adds: [], asks: [], runs: [], errors: result.issues.length > 0 ? result.issues.map((issue) => `${issue.path}: ${issue.message}`) : [result.error] };
        },
      },
    },
  };
  return { host, settings: () => settings, opened, parent, folderOf, load: (slug: string) => loadExtensionFolder(folderOf(slug)) };
}

/** One turn on the browser path, as the desk sends it; the calls it made, by the trace's names. */
async function turn(app: ReturnType<typeof pistachio>, history: ModelMessage[], said: string) {
  const called: Array<AgentToolRequest> = [];
  const callbacks: AiAgentRunCallbacks = {
    toolStarted: (request) => {
      called.push(request);
      return `tool-${String(called.length)}`;
    },
    toolCompleted: () => undefined,
    toolFailed: () => undefined,
    questionAsked: () => undefined,
    takeoverRequested: () => undefined,
    historyChanged: () => undefined,
    stepFinished: () => undefined,
    compacted: () => undefined,
    changed: () => undefined,
  };
  const model = createGateway({ apiKey: key }).languageModel(modelId);
  const started = Date.now();
  // The words as the run controller hands a desk's first turn to the browser path (turnText), with its desk block.
  const first = history.length === 0;
  const text = `${first ? `Complete this browser task: ${said}` : said}\n\n[Desk: 1 window on the desk of the space “Reading”.\n- tab tab-1 “Example News” https://news.example/ (in use)]`;
  const result = await runAiBrowserAgent({
    messages: [...history, userMessage(text)],
    browser,
    callbacks,
    abortSignal: AbortSignal.timeout(280_000),
    notes: { read: () => "", write: (content) => content },
    model,
    modelName: modelId,
    pistachio: { host: app.host },
    timezone: "America/Denver",
  });
  const names = called.map((request) => request.name);
  console.log(`\n── “${said}” — ${String(Date.now() - started)} ms, ${String(result.steps)} steps, tools: ${names.join(", ") || "none"}\n${result.text}\n`);
  return { result, called, names };
}

const usedBrowser = (names: string[]): string[] => names.filter((name) => BROWSER_TOOLS.includes(name));

describe.skipIf(!live || key === undefined)("the agent knows Pistachio and changes it (live model)", () => {
  it("answers a question about the app with an offer to do it — no web, no tour of menus — then does what is asked", { timeout: 300_000 }, async () => {
    const app = pistachio();
    const asked = await turn(app, [], "How can I customize the appearance of Pistachio?");
    // Never the web for a question about the app, and nothing changed before the person chose.
    expect(usedBrowser(asked.names)).toEqual([]);
    expect(asked.names).not.toContain("settings.change");
    expect(asked.names).not.toContain("ext.build");
    expect(asked.result.outcome).toBe("final");
    // An offer and an invitation back — short — naming what a setting does and what an extension adds; not directions to a menu.
    expect(asked.result.text).toMatch(/\?|tell me|let me know/iu);
    expect(asked.result.text).toMatch(/extension|backdrop/iu);
    expect(asked.result.text.length).toBeLessThan(1_400);
    expect(asked.result.text).not.toMatch(/click (on )?(the )?(settings|gear|menu)|go to settings|open settings and/iu);

    const done = await turn(app, asked.result.messages, "Make it dark, with a purple and pink colour wash, and round the corners more.");
    expect(usedBrowser(done.names)).toEqual([]);
    expect(done.names).toContain("settings.change");
    const look = app.settings().appearance;
    expect(look.scheme).toBe("dark");
    expect(look.colors).not.toEqual(DEFAULT_SETTINGS.appearance.colors);
    expect(look.radius).toBeGreaterThan(DEFAULT_SETTINGS.appearance.radius);
    expect(done.result.outcome).toBe("final");
  });

  it("leaves a locked setting to the person, and says so", { timeout: 200_000 }, async () => {
    const app = pistachio();
    const asked = await turn(app, [], "Turn off the ad blocker.");
    expect(usedBrowser(asked.names)).toEqual([]);
    expect(app.settings().shields).toEqual(DEFAULT_SETTINGS.shields);
    expect(asked.result.outcome).toBe("final");
  });

  it("knows a shortcut from the settings, not from memory, and rebinds one", { timeout: 200_000 }, async () => {
    const app = pistachio();
    const asked = await turn(app, [], "What's the shortcut for a new space? Change it to ⌘⇧N.");
    expect(usedBrowser(asked.names)).toEqual([]);
    expect(asked.names).toContain("settings.read");
    expect(app.settings().shortcuts.newSpace).toBe("Mod+Shift+N");
  });

  it("builds an extension for a wish no setting covers, and it loads and lands waiting", { timeout: 300_000 }, async () => {
    const app = pistachio();
    const built = await turn(app, [], "Give every space a starry night backdrop — deep navy with small stars — and a soft blue accent.");
    expect(usedBrowser(built.names)).toEqual([]);
    expect(built.names).toContain("ext.build");
    expect(built.names).toContain("ext.draft.write");
    const request = built.called.find((call) => call.name === "ext.build");
    const slug = (request as { title: string }).title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const loaded = app.load(slug);
    console.log(`folder ${basename(app.folderOf(slug))}: ${loaded.ok ? `loads as ${loaded.manifest.id}, asks ${JSON.stringify(loaded.manifest.permissions ?? [])}` : loaded.error}`);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.manifest.permissions ?? []).toContain("theme");
    // What it wrote would be taken once it runs: every accent written out in it is one theme.set accepts (a "soft blue"
    // is where a pastel fails — the draft tools refuse one at the save, and the builder picks again).
    const accents = readdirSync(app.folderOf(slug))
      .filter((name) => /\.(?:[cm]?[jt]s|json)$/i.test(name))
      .flatMap((name) => [...readFileSync(join(app.folderOf(slug), name), "utf8").matchAll(/\baccent["']?\s*:\s*["'](#[0-9a-fA-F]{6})["']/g)].map((match) => match[1]!));
    console.log(`accents written: ${accents.join(", ") || "none"}; refused at a save: ${String(built.called.filter((call) => call.name === "ext.draft.write").length - readdirSync(app.folderOf(slug)).length)} extra write(s)`);
    expect(accents.length).toBeGreaterThan(0);
    for (const accent of accents) expect(accentRefusal(accent), accent).toBeNull();
    // It says the step that is the person's: nothing is on yet.
    expect(built.result.text).toMatch(/turn (it )?on|approv|review/iu);
  });
});
