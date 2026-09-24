/**
 * `ShellHost.rankAddressIntent` (docs/smart-suggestions.md): the web app's
 * half of the address bar's smart suggestions, on the same evaluator the
 * Mac uses.
 *
 * What is pinned here is what a person would notice: the switch in their
 * settings really stops the request, a worker with no model of its own
 * answers null rather than failing, and typing on supersedes the question
 * that was in flight — one live question per session — so an opinion about
 * words they have finished typing never comes back to reorder the list.
 */

import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModel } from "ai";
import type { AgentTabInfo } from "@pistachio/agent-runtime";
import type { AddressIntentRequest } from "@pistachio/shell-contracts/address-intent";
import { ShellHost, type ShellHostSpace } from "../../src/sessions/shell-host.js";

const SPACE = "work";
const SESSION = "88888888-8888-4888-8888-888888888888";
const USER = "99999999-9999-4999-8999-999999999999";

type Backend = ShellHostSpace["browser"]["backend"];

/** No browser behind the host: none of these members is the subject. */
function stubBackend(): Backend {
  return {
    kind: "cloud" as const,
    activeTabId: null,
    guardFor: (): null => null,
    listTabs: (): AgentTabInfo[] => [],
    openTab: async (): Promise<string> => "cloud:1",
    closeTab: async (): Promise<void> => undefined,
    focusTab: async (): Promise<void> => undefined,
    navigate: async (): Promise<void> => undefined,
    back: async (): Promise<void> => undefined,
    forward: async (): Promise<void> => undefined,
    reload: async (): Promise<void> => undefined,
  } as unknown as Backend;
}

/**
 * A model that answers only when the test says so, and remembers what it
 * was asked and whether it was cut off.
 */
function gatedModel(): {
  model: Experimental_EvaluationModel;
  asked: string[];
  aborted: string[];
  answer: (typed: string) => void;
} {
  const pending = new Map<string, () => void>();
  const asked: string[] = [];
  const aborted: string[] = [];
  return {
    asked,
    aborted,
    answer: (typed) => pending.get(typed)?.(),
    model: {
      specificationVersion: "v4",
      provider: "typesafe-ai",
      modelId: "jev",
      supportedQuestionTypes: ["choice", "score", "boolean"],
      doEvaluate: (options) => {
        const typed = String((options.state as { typed?: unknown }).typed);
        asked.push(typed);
        options.abortSignal?.addEventListener("abort", () => aborted.push(typed));
        return new Promise((resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => reject(new Error("superseded")));
          pending.set(typed, () =>
            resolve({
              answers: { intent: { type: "choice", choice: "web_search", probabilities: { web_search: 0.9, ai_prompt: 0.04, open_page: 0.03, browser_command: 0.03 } } },
              warnings: [],
            }),
          );
        });
      },
    } as Experimental_EvaluationModel,
  };
}

function makeHost(intentModel?: () => Experimental_EvaluationModel | null): ShellHost {
  const space: ShellHostSpace = {
    browser: { backend: stubBackend(), onTabsChanged: () => () => undefined },
    workspace: null,
  };
  return new ShellHost({
    sessionId: SESSION,
    userId: USER,
    spaceId: SPACE,
    space,
    control: () => ({ holder: "human", generation: 0 }),
    ...(intentModel === undefined ? {} : { intentModel }),
  });
}

const ASK = (query: string): AddressIntentRequest => ({
  query,
  currentPage: null,
  recentPages: [],
  candidates: [],
});

describe("ShellHost.rankAddressIntent", () => {
  it("answers null when this worker has no model of its own", async () => {
    const host = makeHost();
    expect(await host.rankAddressIntent(ASK("best pistachio gelato"))).toBeNull();
  });

  it("asks the model, and echoes the query the answer belongs to", async () => {
    const gate = gatedModel();
    const host = makeHost(() => gate.model);
    const pending = host.rankAddressIntent(ASK("best pistachio gelato"));
    gate.answer("best pistachio gelato");
    const ranking = await pending;
    expect(gate.asked).toEqual(["best pistachio gelato"]);
    expect(ranking?.query).toBe("best pistachio gelato");
    expect(ranking?.intents.web_search).toBe(0.9);
  });

  it("does not ask once the person turns smart suggestions off", async () => {
    const gate = gatedModel();
    const host = makeHost(() => gate.model);
    await host.updateSettings({ search: { smartSuggestions: false } });
    expect(await host.rankAddressIntent(ASK("best pistachio gelato"))).toBeNull();
    expect(gate.asked).toEqual([]);
  });

  it("refuses a request not worth asking about, before any model is reached", async () => {
    const gate = gatedModel();
    const host = makeHost(() => gate.model);
    expect(await host.rankAddressIntent(ASK("be"))).toBeNull();
    expect(await host.rankAddressIntent({ query: "" } as unknown as AddressIntentRequest)).toBeNull();
    expect(gate.asked).toEqual([]);
  });

  it("keeps one live question: typing on supersedes the last, which answers null", async () => {
    const gate = gatedModel();
    const host = makeHost(() => gate.model);
    const first = host.rankAddressIntent(ASK("best pista"));
    const second = host.rankAddressIntent(ASK("best pistachio gelato"));
    await expect(first).resolves.toBeNull();
    expect(gate.aborted).toEqual(["best pista"]);
    gate.answer("best pistachio gelato");
    expect((await second)?.query).toBe("best pistachio gelato");
  });

  it("lets go of the question in flight when the session closes", async () => {
    const gate = gatedModel();
    const host = makeHost(() => gate.model);
    const pending = host.rankAddressIntent(ASK("best pistachio gelato"));
    host.close();
    await expect(pending).resolves.toBeNull();
  });
});
