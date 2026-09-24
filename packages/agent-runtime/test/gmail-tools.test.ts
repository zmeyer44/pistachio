/**
 * The Gmail tool family through the real runner with a scripted model and
 * a fake Gmail API: which tools each access level registers, what the
 * prompt says about the account, how a search, read, draft, reply, and
 * send reach the API, and how a refused token and an API error come back
 * to the model.
 */

import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { IntegrationAccess } from "@pistachio/protocol";
import {
  GMAIL_TOOLS_BY_ACCESS,
  TOOL_GROUPS,
  INTEGRATION_TOOL_GROUPS,
  isToolEnabled,
  runAiBrowserAgent,
  userMessage,
  type AgentTabInfo,
  type AiAgentRunCallbacks,
  type BrowserBackend,
  type IntegrationToolHost,
} from "../src/index.js";

/* ------------------------------ the model -------------------------------- */

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];
type Prompt = CallOptions["prompt"];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type Step = (options: CallOptions) => GenerateResult;

let nextCallId = 0;

function usage(prompt: Prompt): GenerateResult["usage"] {
  const tokens = Math.ceil(JSON.stringify(prompt).length / 4);
  return { inputTokens: { total: tokens, noCache: tokens, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
}

function calls(...requests: Array<{ name: string; input: Record<string, unknown> }>): Step {
  return ({ prompt }) => ({
    content: requests.map((request) => ({ type: "tool-call" as const, toolCallId: `call-${String(++nextCallId)}`, toolName: request.name, input: JSON.stringify(request.input) })),
    finishReason: { unified: "tool-calls", raw: "tool_use" },
    usage: usage(prompt),
    warnings: [],
  });
}

function answer(text: string): Step {
  return ({ prompt }) => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "end_turn" }, usage: usage(prompt), warnings: [] });
}

function scripted(steps: Step[]): MockLanguageModelV4 {
  const queue = [...steps];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const step = queue.shift();
      if (step === undefined) throw new Error("model script exhausted");
      return step(options);
    },
  });
  return model;
}

function systemText(prompt: Prompt): string {
  return prompt.filter((message) => message.role === "system").map((message) => message.content).join("\n");
}

function toolResults(prompt: Prompt): Array<{ toolName: string; output: unknown }> {
  const found: Array<{ toolName: string; output: unknown }> = [];
  for (const message of prompt) {
    if (message.role !== "tool") continue;
    for (const part of message.content) if (part.type === "tool-result") found.push({ toolName: part.toolName, output: part.output });
  }
  return found;
}

/* ------------------------------ the browser ------------------------------ */

const tab: AgentTabInfo = { id: "tab-1", spaceId: "work", title: "Home", url: "https://example.test/", loading: false, canGoBack: false, canGoForward: false, kind: "human" };
const browser: BrowserBackend = {
  kind: "desktop",
  listTabs: () => [tab],
  openTab: async () => "tab-2",
  focusTab: async () => undefined,
  navigate: async () => undefined,
  back: async () => undefined,
  forward: async () => undefined,
  reload: async () => undefined,
  inspect: async () => ({ title: "Home", url: "https://example.test/", text: "", controls: [] }),
  click: async () => undefined,
  type: async (_tab, _target, value) => value,
  press: async () => undefined,
  scroll: async () => undefined,
  screenshot: async () => "data:image/png;base64,AAAA",
};

/* ------------------------------ fake Gmail ------------------------------- */

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

interface FakeGmailOptions {
  /** Tokens the API accepts; anything else is 401. */
  tokens?: string[];
  /** The one message's From header. */
  from?: string;
}

function fakeGmail(options: FakeGmailOptions = {}) {
  const accepted = new Set(options.tokens ?? ["at-1"]);
  const requests: Array<{ method: string; path: string; body: unknown; token: string | null }> = [];
  const messages: Record<string, unknown> = {
    m1: {
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Can you send the deck?",
      internalDate: String(Date.parse("2026-09-05T09:00:00Z")),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: options.from ?? "Sam <sam@vendor.example>" },
          { name: "To", value: "alex@example.com" },
          { name: "Subject", value: "Deck for Monday" },
          { name: "Message-ID", value: "<m1@vendor.example>" },
        ],
        body: { data: b64("Hi Alex, can you send the deck before Monday?\nSam") },
      },
    },
  };
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const token = headers.get("authorization")?.replace(/^Bearer /u, "") ?? null;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    requests.push({ method, path: parsed.pathname + parsed.search, body, token });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (token === null || !accepted.has(token)) return json({ error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } }, 401);
    const path = parsed.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/profile") return json({ emailAddress: "alex@example.com", messagesTotal: 10, threadsTotal: 5 });
    if (path === "/messages" && method === "GET") {
      if (parsed.searchParams.get("q") === "nothing") return json({ resultSizeEstimate: 0 });
      return json({ messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "page-2", resultSizeEstimate: 1 });
    }
    const message = /^\/messages\/([^/]+)$/u.exec(path);
    if (message !== null && method === "GET") {
      const found = messages[message[1]!];
      return found === undefined ? json({ error: { code: 404, message: "Requested entity was not found." } }, 404) : json(found);
    }
    if (path === "/threads/t1") return json({ id: "t1", messages: [messages["m1"]] });
    if (path === "/drafts" && method === "POST") return json({ id: "d1", message: { id: "dm1", threadId: (body as { message: { threadId?: string } }).message.threadId ?? "t-new", labelIds: ["DRAFT"] } });
    if (path === "/messages/send" && method === "POST") return json({ id: "s1", threadId: (body as { threadId?: string }).threadId ?? "t-new", labelIds: ["SENT"] });
    if (path === "/drafts/send" && method === "POST") return json({ id: "s2", threadId: "t1", labelIds: ["SENT"] });
    if (path === "/messages/m1/modify") return json({ id: "m1", threadId: "t1", labelIds: ["INBOX"] });
    if (path === "/messages/m1/trash") return json({ id: "m1", threadId: "t1", labelIds: ["TRASH"] });
    return json({ error: { code: 404, message: `no route for ${method} ${path}` } }, 404);
  });
  return { fetchImpl, requests };
}

function host(access: IntegrationAccess, options: { tokens?: string[] } = {}): IntegrationToolHost & { minted: string[]; uses: number } {
  const tokens = options.tokens ?? ["at-1"];
  let index = 0;
  const bound = {
    provider: "gmail" as const,
    accountLabel: "alex@example.com",
    access,
    minted: [] as string[],
    uses: 0,
    accessToken: async ({ fresh = false } = {}) => {
      if (fresh || bound.minted.length === 0) {
        const token = tokens[Math.min(index, tokens.length - 1)]!;
        index += 1;
        bound.minted.push(token);
      }
      return bound.minted.at(-1)!;
    },
    used: () => {
      bound.uses += 1;
    },
  };
  return bound;
}

function recorder() {
  let next = 0;
  return {
    toolStarted: vi.fn((): string => `tool-${String(++next)}`),
    toolCompleted: vi.fn(),
    toolFailed: vi.fn(),
    questionAsked: vi.fn(),
    takeoverRequested: vi.fn(),
    historyChanged: vi.fn(),
    stepFinished: vi.fn(),
    compacted: vi.fn(),
    changed: vi.fn(),
  } satisfies AiAgentRunCallbacks;
}

async function turn(model: MockLanguageModelV4, hosts: IntegrationToolHost[], fetchImpl: ReturnType<typeof fakeGmail>["fetchImpl"], policy?: { maxSteps: number; enabledToolGroups: string[] }) {
  const callbacks = recorder();
  const result = await runAiBrowserAgent({
    messages: [userMessage("Complete this browser task: deal with my mail")],
    browser,
    callbacks,
    abortSignal: new AbortController().signal,
    notes: { read: () => "", write: (content) => content },
    model,
    modelName: "scripted",
    summarize: async () => "summary",
    budget: { window: 200_000, compactAt: 100_000 },
    integrations: { hosts, fetch: fetchImpl },
    ...(policy === undefined ? {} : { policy }),
    now: () => new Date("2026-09-06T12:00:00Z"),
  });
  return { result, callbacks };
}

/* -------------------------------- tests ---------------------------------- */

describe("tool groups", () => {
  it("registers each integration as its own group, in the catalog's order", () => {
    expect(INTEGRATION_TOOL_GROUPS).toEqual(["gmail", "google_calendar"]);
    expect(TOOL_GROUPS.gmail).toEqual(GMAIL_TOOLS_BY_ACCESS.send);
    expect(isToolEnabled("gmail_send", ["gmail"])).toBe(true);
    expect(isToolEnabled("gmail_send", ["tabs"])).toBe(false);
  });
});

describe("what the model is given", () => {
  it("registers the tools an access level unlocks and describes the account in the prompt", async () => {
    for (const access of ["read", "write", "send"] as const) {
      const gmail = fakeGmail();
      const model = scripted([answer("done")]);
      await turn(model, [host(access)], gmail.fetchImpl);
      const call = model.doGenerateCalls[0]!;
      const names = (call.tools ?? []).map((definition) => definition.name);
      for (const name of GMAIL_TOOLS_BY_ACCESS.send) expect(names.includes(name)).toBe(GMAIL_TOOLS_BY_ACCESS[access].includes(name));
      const system = systemText(call.prompt);
      expect(system).toContain("Gmail rules (connected account alex@example.com");
      if (access === "read") expect(system).toContain("read-only here");
      if (access === "write") expect(system).toContain("may not send from here");
      if (access === "send") expect(system).toContain("Send with gmail_send only when the person explicitly asked");
    }
  });

  it("gives nothing and says nothing when no integration is connected", async () => {
    const model = scripted([answer("done")]);
    await turn(model, [], fakeGmail().fetchImpl);
    const call = model.doGenerateCalls[0]!;
    expect((call.tools ?? []).some((definition) => definition.name.startsWith("gmail_"))).toBe(false);
    expect(systemText(call.prompt)).not.toContain("Gmail");
  });

  it("lets a run policy turn an integration off even when it is connected", async () => {
    const model = scripted([answer("done")]);
    await turn(model, [host("send")], fakeGmail().fetchImpl, { maxSteps: 10, enabledToolGroups: ["tabs", "read"] });
    expect((model.doGenerateCalls[0]!.tools ?? []).some((definition) => definition.name.startsWith("gmail_"))).toBe(false);
  });
});

describe("search, read, draft, send", () => {
  it("searches with Gmail's query, reads the hit, drafts a reply in its thread, and sends it", async () => {
    const gmail = fakeGmail();
    const bound = host("send");
    const model = scripted([
      calls({ name: "gmail_search", input: { query: "from:sam newer_than:7d", maxResults: null, pageToken: null } }),
      calls({ name: "gmail_read", input: { id: "m1", kind: "message" } }),
      calls({ name: "gmail_draft", input: { to: null, cc: null, bcc: null, subject: null, body: "Sending it now.\nAlex", replyToMessageId: "m1" } }),
      calls({ name: "gmail_send", input: { draftId: "d1", to: null, cc: null, bcc: null, subject: null, body: null, replyToMessageId: null } }),
      answer("Replied to Sam."),
    ]);
    const { result, callbacks } = await turn(model, [bound], gmail.fetchImpl);
    expect(result.outcome).toBe("final");

    const outputs = toolResults(model.doGenerateCalls[4]!.prompt).map((entry) => entry.output as { type: string; value: Record<string, unknown> });
    expect(outputs).toHaveLength(4);
    const search = outputs[0]!.value as { ok: boolean; result: { messages: Array<Record<string, unknown>>; nextPageToken: string } };
    expect(search.ok).toBe(true);
    expect(search.result.nextPageToken).toBe("page-2");
    expect(search.result.messages[0]).toMatchObject({ id: "m1", subject: "Deck for Monday", from: "Sam <sam@vendor.example>", unread: true });
    expect(search.result.messages[0]).not.toHaveProperty("body");
    const read = outputs[1]!.value as { result: { kind: string; message: { body: string } } };
    expect(read.result.message.body).toBe("Hi Alex, can you send the deck before Monday?\nSam");
    const draft = outputs[2]!.value as { result: { draftId: string; to: string[]; subject: string; webUrl: string; threadId: string } };
    expect(draft.result).toMatchObject({ draftId: "d1", to: ["Sam <sam@vendor.example>"], subject: "Re: Deck for Monday", threadId: "t1", webUrl: "https://mail.google.com/mail/u/0/#drafts/dm1" });
    const sent = outputs[3]!.value as { result: { messageId: string; sentDraft: string } };
    expect(sent.result).toMatchObject({ messageId: "s2", sentDraft: "d1" });

    // What reached the API: the search, metadata for the hit, the full
    // message, the reply's headers, the draft in the thread, the send.
    const paths = gmail.requests.map((request) => `${request.method} ${request.path.split("?")[0]!}`);
    expect(paths).toEqual([
      "GET /gmail/v1/users/me/messages",
      "GET /gmail/v1/users/me/messages/m1",
      "GET /gmail/v1/users/me/messages/m1",
      "GET /gmail/v1/users/me/messages/m1",
      "POST /gmail/v1/users/me/drafts",
      "POST /gmail/v1/users/me/drafts/send",
    ]);
    expect(gmail.requests[0]!.path).toContain("q=from%3Asam+newer_than%3A7d");
    expect(gmail.requests[0]!.path).toContain("maxResults=10");
    expect(gmail.requests[1]!.path).toContain("format=metadata");
    expect(gmail.requests[2]!.path).toContain("format=full");
    const draftBody = gmail.requests[4]!.body as { message: { raw: string; threadId: string } };
    expect(draftBody.message.threadId).toBe("t1");
    const raw = Buffer.from(draftBody.message.raw, "base64url").toString("utf8");
    expect(raw).toContain("From: alex@example.com\r\n");
    expect(raw).toContain("To: Sam <sam@vendor.example>\r\n");
    expect(raw).toContain("Subject: Re: Deck for Monday\r\n");
    expect(raw).toContain("In-Reply-To: <m1@vendor.example>\r\n");
    expect(gmail.requests.every((request) => request.token === "at-1")).toBe(true);

    // The trace saw every call, named for the person, and the host heard each success.
    const started = callbacks.toolStarted.mock.calls as unknown as Array<[{ name: string }, string]>;
    expect(started.map((call) => [call[0].name, call[1]])).toEqual([
      ["gmail.search", "Search Gmail"],
      ["gmail.read", "Read email"],
      ["gmail.draft", "Write email draft"],
      ["gmail.send", "Send email"],
    ]);
    expect(callbacks.toolCompleted.mock.calls.map((call) => (call[1] as { summary: string }).summary)).toEqual([
      "1 message found",
      "Read “Deck for Monday” from Sam <sam@vendor.example>",
      "Draft “Re: Deck for Monday” to Sam <sam@vendor.example> saved in Gmail",
      "Sent draft d1",
    ]);
    expect(bound.uses).toBe(4);
  });

  it("composes and sends a new message to named recipients, and tidies", async () => {
    const gmail = fakeGmail();
    const model = scripted([
      calls({ name: "gmail_send", input: { draftId: null, to: "pat@example.com, Kim <kim@example.com>", cc: null, bcc: null, subject: "Lunch?", body: "Thursday works.", replyToMessageId: null } }),
      calls({ name: "gmail_modify", input: { id: "m1", action: "archive" } }),
      calls({ name: "gmail_modify", input: { id: "m1", action: "trash" } }),
      answer("Sent."),
    ]);
    const { callbacks } = await turn(model, [host("send")], gmail.fetchImpl);
    const send = gmail.requests[0]!;
    expect(send.path).toBe("/gmail/v1/users/me/messages/send");
    expect(send.body).not.toHaveProperty("threadId");
    const raw = Buffer.from((send.body as { raw: string }).raw, "base64url").toString("utf8");
    expect(raw).toContain("To: pat@example.com, Kim <kim@example.com>\r\n");
    expect(raw).toContain("Subject: Lunch?\r\n");
    expect(gmail.requests[1]!.body).toEqual({ addLabelIds: [], removeLabelIds: ["INBOX"] });
    expect(gmail.requests[2]!.path).toBe("/gmail/v1/users/me/messages/m1/trash");
    expect(callbacks.toolCompleted.mock.calls.map((call) => (call[1] as { summary: string }).summary)).toEqual([
      "Sent “Lunch?” to pat@example.com, Kim <kim@example.com>",
      "archive: m1",
      "trash: m1",
    ]);
  });

  it("reads a whole thread oldest first", async () => {
    const gmail = fakeGmail();
    const model = scripted([calls({ name: "gmail_read", input: { id: "t1", kind: "thread" } }), answer("ok")]);
    await turn(model, [host("read")], gmail.fetchImpl);
    const output = toolResults(model.doGenerateCalls[1]!.prompt)[0]!.output as { value: { result: { kind: string; messageCount: number; messages: Array<{ id: string }> } } };
    expect(output.value.result).toMatchObject({ kind: "thread", messageCount: 1 });
    expect(output.value.result.messages.map((message) => message.id)).toEqual(["m1"]);
  });
});

describe("failures", () => {
  it("retries once with a fresh token when the API refuses the cached one", async () => {
    const gmail = fakeGmail({ tokens: ["at-2"] });
    const bound = host("read", { tokens: ["at-stale", "at-2"] });
    const model = scripted([calls({ name: "gmail_search", input: { query: "", maxResults: 5, pageToken: null } }), answer("ok")]);
    await turn(model, [bound], gmail.fetchImpl);
    expect(gmail.requests.map((request) => request.token)).toEqual(["at-stale", "at-2", "at-2"]);
    expect(bound.minted).toEqual(["at-stale", "at-2"]);
    const output = toolResults(model.doGenerateCalls[1]!.prompt)[0]!.output as { value: { ok: boolean } };
    expect(output.value.ok).toBe(true);
  });

  it("hands the model Google's error and bad input as words, not exceptions", async () => {
    const gmail = fakeGmail();
    const model = scripted([
      calls({ name: "gmail_read", input: { id: "missing", kind: "message" } }),
      calls({ name: "gmail_draft", input: { to: "not an address", cc: null, bcc: null, subject: "x", body: "y", replyToMessageId: null } }),
      calls({ name: "gmail_draft", input: { to: null, cc: null, bcc: null, subject: "x", body: "y", replyToMessageId: null } }),
      calls({ name: "gmail_draft", input: { to: "Mallory\r\nBcc: hidden@example.com <visible@example.com>", cc: null, bcc: null, subject: "x", body: "y", replyToMessageId: null } }),
      answer("could not"),
    ]);
    const { result, callbacks } = await turn(model, [host("write")], gmail.fetchImpl);
    expect(result.outcome).toBe("final");
    const outputs = toolResults(model.doGenerateCalls[4]!.prompt).map((entry) => (entry.output as { value: { ok: boolean; error?: string } }).value);
    expect(outputs[0]).toEqual({ ok: false, error: "Requested entity was not found." });
    expect(outputs[1]!.error).toContain("to: not an email address");
    expect(outputs[2]!.error).toContain("at least one recipient");
    expect(outputs[3]!.error).toContain("line break or control character");
    expect(callbacks.toolFailed).toHaveBeenCalledTimes(4);
    // Nothing with a smuggled header ever reached Gmail.
    expect(gmail.requests.filter((request) => request.path.endsWith("/drafts"))).toHaveLength(0);
  });

  it("replies to a sender whose name carries a comma", async () => {
    const gmail = fakeGmail({ from: '"Rivera, Sam" <sam@vendor.example>' });
    const model = scripted([
      calls({ name: "gmail_draft", input: { to: null, cc: null, bcc: null, subject: null, body: "ok", replyToMessageId: "m1" } }),
      answer("drafted"),
    ]);
    await turn(model, [host("write")], gmail.fetchImpl);
    const output = toolResults(model.doGenerateCalls[1]!.prompt)[0]!.output as { value: { ok: boolean; result: { to: string[] } } };
    expect(output.value.ok).toBe(true);
    expect(output.value.result.to).toEqual(['"Rivera, Sam" <sam@vendor.example>']);
    const raw = Buffer.from((gmail.requests.at(-1)!.body as { message: { raw: string } }).message.raw, "base64url").toString("utf8");
    expect(raw).toContain('To: "Rivera, Sam" <sam@vendor.example>\r\n');
  });

  it("reports a grant the person must renew", async () => {
    const gmail = fakeGmail();
    const dead: IntegrationToolHost = {
      provider: "gmail",
      accountLabel: "alex@example.com",
      access: "read",
      accessToken: async () => {
        throw new Error("Gmail needs to be connected again in Settings → Integrations");
      },
    };
    const model = scripted([calls({ name: "gmail_search", input: { query: "", maxResults: null, pageToken: null } }), answer("stuck")]);
    await turn(model, [dead], gmail.fetchImpl);
    const output = toolResults(model.doGenerateCalls[1]!.prompt)[0]!.output as { value: { ok: boolean; error: string } };
    expect(output.value).toEqual({ ok: false, error: "Gmail needs to be connected again in Settings → Integrations" });
    expect(gmail.requests).toHaveLength(0);
  });
});
