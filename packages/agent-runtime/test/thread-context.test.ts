import type { AssistantModelMessage, JSONValue, ModelMessage, ToolResultPart, UserModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  COMPACTION_TAIL,
  DEFAULT_CONTEXT_WINDOW,
  KEEP_FULL_TOOL_RESULTS,
  MAX_KEPT_OUTPUT_CHARS,
  SUMMARY_HEADER,
  applyCompaction,
  assistantText,
  closeDanglingToolCalls,
  compactionPrompt,
  contextBudget,
  countToolCalls,
  estimateTokens,
  isElided,
  renderForSummary,
  splitForCompaction,
  trimHistory,
  userMessage,
} from "../src/thread-context.js";

/* ------------------------------ fixtures --------------------------------- */

function user(text: string): UserModelMessage {
  return { role: "user", content: text };
}

function assistant(text: string): AssistantModelMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function json(value: JSONValue): ToolResultPart["output"] {
  return { type: "json", value };
}

/** One tool step: the assistant's call and the tool's answer. */
function exchange(n: number, toolName: string, output: ToolResultPart["output"]): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: `call-${String(n)}`, toolName, input: { tabId: "tab-1", step: n } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: `call-${String(n)}`, toolName, output }] },
  ];
}

const PAGE: JSONValue = {
  ok: true,
  data: {
    title: "Checkout",
    url: "https://shop.test/cart",
    text: "lorem ipsum ".repeat(1_000),
    controls: [{ id: "pay", label: "Pay now" }],
  },
};

const SMALL_TABS: JSONValue = { ok: true, tabs: [{ id: "tab-1", title: "Home" }] };

function at(messages: ModelMessage[], index: number): ModelMessage {
  const message = messages[index];
  if (message === undefined) throw new Error(`no message at ${String(index)}`);
  return message;
}

function parts(message: ModelMessage): Array<{ type: string } & Record<string, unknown>> {
  if (typeof message.content === "string") throw new Error(`expected parts, got a string on ${message.role}`);
  return message.content as Array<{ type: string } & Record<string, unknown>>;
}

function output(message: ModelMessage, index = 0): ToolResultPart["output"] {
  if (message.role !== "tool") throw new Error(`expected a tool message, got ${message.role}`);
  const part = message.content[index];
  if (part?.type !== "tool-result") throw new Error("expected a tool result");
  return part.output;
}

function jsonValue(value: ToolResultPart["output"]): Record<string, unknown> {
  if (value.type !== "json" || typeof value.value !== "object" || value.value === null || Array.isArray(value.value)) throw new Error("expected a json object output");
  return value.value as Record<string, unknown>;
}

/* ------------------------------ estimates -------------------------------- */

describe("estimateTokens", () => {
  it("grows with the text it is given", () => {
    const short = estimateTokens([user("a".repeat(40))]);
    const long = estimateTokens([user("a".repeat(4_000))]);
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
    expect(long - short).toBeGreaterThanOrEqual((4_000 - 40) / 4);
    // Each message carries some overhead of its own.
    expect(estimateTokens([user(""), user("")])).toBeGreaterThan(estimateTokens([user("")]));
  });

  it("charges a file part a flat amount whatever its size", () => {
    const withText: UserModelMessage = { role: "user", content: [{ type: "text", text: "see attached" }] };
    const tiny: UserModelMessage = { role: "user", content: [{ type: "text", text: "see attached" }, { type: "file", data: "AAAA", mediaType: "image/png" }] };
    const huge: UserModelMessage = { role: "user", content: [{ type: "text", text: "see attached" }, { type: "file", data: "A".repeat(200_000), mediaType: "image/png" }] };
    const image: UserModelMessage = { role: "user", content: [{ type: "text", text: "see attached" }, { type: "image", image: "A".repeat(200_000), mediaType: "image/png" }] };
    expect(estimateTokens([tiny])).toBe(estimateTokens([huge]));
    expect(estimateTokens([image])).toBe(estimateTokens([huge]));
    const cost = estimateTokens([tiny]) - estimateTokens([withText]);
    expect(cost).toBeGreaterThan(100);
    expect(cost).toBeLessThan(200_000 / 4);
  });

  it("prices a picture inside a tool result flat, whatever its size", () => {
    const shot = (data: string): ToolResultPart["output"] => ({
      type: "content",
      value: [
        { type: "text", text: '{"ok":true,"summary":"Captured page screenshot"}' },
        { type: "file", data: { type: "data", data }, mediaType: "image/png" },
      ],
    });
    const tiny = exchange(1, "page_screenshot", shot("AAAA"));
    const huge = exchange(1, "page_screenshot", shot("A".repeat(200_000)));
    expect(estimateTokens(tiny)).toBe(estimateTokens(huge));
    const textOnly = exchange(1, "page_screenshot", { type: "content", value: [{ type: "text", text: '{"ok":true,"summary":"Captured page screenshot"}' }] });
    const cost = estimateTokens(huge) - estimateTokens(textOnly);
    expect(cost).toBeGreaterThan(100);
    expect(cost).toBeLessThan(200_000 / 4);
    // The same picture spelled out in JSON would be paid for by the character.
    const spelledOut = exchange(1, "page_screenshot", json({ ok: true, image: "A".repeat(200_000) }));
    expect(estimateTokens(spelledOut)).toBeGreaterThan(estimateTokens(huge) * 10);
  });

  it("counts a tool result by its output", () => {
    const small = exchange(1, "tabs_list", json(SMALL_TABS));
    const big = exchange(1, "page_inspect", json(PAGE));
    expect(estimateTokens(big)).toBeGreaterThan(estimateTokens(small) + 1_000);
    const text = exchange(1, "page_read", { type: "text", value: "word ".repeat(2_000) });
    expect(estimateTokens(text)).toBeGreaterThan(estimateTokens(small) + 1_000);
  });
});

/* ------------------------------- trimming -------------------------------- */

describe("trimHistory", () => {
  it("keeps only the last three tool outputs whole and stubs page inspections and screenshots before them", () => {
    const history: ModelMessage[] = [
      user("Buy what is in the cart"),
      ...exchange(1, "page_inspect", json(PAGE)),
      ...exchange(2, "page_screenshot", json({ ok: true, image: `data:image/png;base64,${"A".repeat(4_000)}` })),
      ...exchange(3, "page_inspect", json(PAGE)),
      ...exchange(4, "page_inspect", json(PAGE)),
      ...exchange(5, "page_inspect", json(PAGE)),
    ];
    const trimmed = trimHistory(history);
    expect(trimmed).toHaveLength(history.length);
    expect(KEEP_FULL_TOOL_RESULTS).toBe(3);

    // The three most recent tool messages are the very same objects.
    for (const index of [6, 8, 10]) expect(trimmed[index]).toBe(history[index]);
    // Everything that is not a tool message is untouched too.
    for (const index of [0, 1, 3, 5, 7, 9]) expect(trimmed[index]).toBe(history[index]);

    const inspect = output(at(trimmed, 2));
    expect(isElided(inspect)).toBe(true);
    expect(isElided(output(at(history, 2)))).toBe(false);
    const inspected = jsonValue(inspect);
    expect(inspected).toMatchObject({ title: "Checkout", url: "https://shop.test/cart" });
    expect(inspected["note"]).toMatch(/page_inspect/);
    expect(inspected).not.toHaveProperty("text");
    expect(inspected).not.toHaveProperty("controls");
    expect(JSON.stringify(inspect).length).toBeLessThan(400);

    const shot = output(at(trimmed, 4));
    expect(isElided(shot)).toBe(true);
    const shotValue = jsonValue(shot);
    expect(shotValue["note"]).toMatch(/Screenshot elided/);
    expect(shotValue).not.toHaveProperty("image");
    // The tool call ids still line up with the assistant's calls.
    const result = at(trimmed, 2);
    if (result.role !== "tool") throw new Error("expected tool");
    expect(result.content[0]).toMatchObject({ type: "tool-result", toolCallId: "call-1", toolName: "page_inspect" });
  });

  it("keeps every result of the newest tool message whole, even past the quota, and stubs all older ones", () => {
    const ids = [1, 2, 3, 4];
    const burst: ModelMessage[] = [
      { role: "assistant", content: ids.map((n) => ({ type: "tool-call", toolCallId: `burst-${String(n)}`, toolName: "page_inspect", input: { tabId: `tab-${String(n)}` } })) },
      { role: "tool", content: ids.map((n) => ({ type: "tool-result", toolCallId: `burst-${String(n)}`, toolName: "page_inspect", output: json(PAGE) })) },
    ];
    const history: ModelMessage[] = [user("Compare the four carts"), ...exchange(1, "page_inspect", json(PAGE)), ...exchange(2, "page_inspect", json(PAGE)), ...burst];
    const trimmed = trimHistory(history);
    expect(trimmed).toHaveLength(history.length);
    // Four results, more than the quota of three: the message is untouched.
    expect(trimmed[6]).toBe(history[6]);
    for (const part of [0, 1, 2, 3]) expect(isElided(output(at(trimmed, 6), part))).toBe(false);
    // The quota is spent, so both older readings are stubs.
    expect(isElided(output(at(trimmed, 2)))).toBe(true);
    expect(isElided(output(at(trimmed, 4)))).toBe(true);

    // A newest message under the quota leaves the rest to the results just before it.
    const pair: ModelMessage[] = [
      { role: "assistant", content: [1, 2].map((n) => ({ type: "tool-call", toolCallId: `pair-${String(n)}`, toolName: "page_inspect", input: { tabId: `tab-${String(n)}` } })) },
      { role: "tool", content: [1, 2].map((n) => ({ type: "tool-result", toolCallId: `pair-${String(n)}`, toolName: "page_inspect", output: json(PAGE) })) },
    ];
    const smaller = trimHistory([user("Compare two carts"), ...exchange(1, "page_inspect", json(PAGE)), ...exchange(2, "page_inspect", json(PAGE)), ...pair]);
    expect(smaller[6]).toBe(pair[1]);
    expect(isElided(output(at(smaller, 4)))).toBe(false);
    expect(isElided(output(at(smaller, 2)))).toBe(true);

    // With one result per message the last three stay whole, as before.
    const single: ModelMessage[] = [user("Go"), ...exchange(1, "page_inspect", json(PAGE)), ...exchange(2, "page_inspect", json(PAGE)), ...exchange(3, "page_inspect", json(PAGE)), ...exchange(4, "page_inspect", json(PAGE))];
    const singleTrimmed = trimHistory(single);
    expect([2, 4, 6, 8].map((index) => isElided(output(at(singleTrimmed, index))))).toEqual([true, false, false, false]);
  });

  it("keeps small old outputs verbatim and previews large text ones", () => {
    const longText = "word ".repeat(2_000);
    expect(longText.length).toBeGreaterThan(MAX_KEPT_OUTPUT_CHARS);
    const history: ModelMessage[] = [
      user("List my tabs"),
      ...exchange(1, "tabs_list", json(SMALL_TABS)),
      ...exchange(2, "page_read", { type: "text", value: longText }),
      ...exchange(3, "tabs_list", json(SMALL_TABS)),
      ...exchange(4, "tabs_list", json(SMALL_TABS)),
      ...exchange(5, "tabs_list", json(SMALL_TABS)),
    ];
    const trimmed = trimHistory(history);
    // Small and old: kept as the same object.
    expect(trimmed[2]).toBe(history[2]);
    expect(output(at(trimmed, 2))).toEqual(json(SMALL_TABS));

    const preview = output(at(trimmed, 4));
    expect(isElided(preview)).toBe(true);
    const value = jsonValue(preview);
    expect(typeof value["preview"]).toBe("string");
    const text = value["preview"] as string;
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(Math.floor(MAX_KEPT_OUTPUT_CHARS / 2) + 1);
    expect(text.startsWith("word word")).toBe(true);
    expect(value["note"]).toContain(`${String(longText.length)} characters`);
  });

  it("is idempotent", () => {
    const history: ModelMessage[] = [
      user("Go"),
      ...exchange(1, "page_inspect", json(PAGE)),
      ...exchange(2, "page_screenshot", json({ ok: true, image: "A".repeat(3_000) })),
      ...exchange(3, "page_read", { type: "text", value: "word ".repeat(2_000) }),
      ...exchange(4, "tabs_list", json(SMALL_TABS)),
      ...exchange(5, "page_inspect", json(PAGE)),
      ...exchange(6, "page_inspect", json(PAGE)),
    ];
    const once = trimHistory(history);
    const twice = trimHistory(once);
    expect(twice).toEqual(once);
    expect(estimateTokens(once)).toBeLessThan(estimateTokens(history));
  });

  it("stubs attachments in older user messages and keeps them on the latest one that has any", () => {
    const receipt: UserModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "Here is the receipt" },
        { type: "file", data: "data:application/pdf;base64,AAAA", mediaType: "application/pdf", filename: "receipt.pdf" },
        { type: "image", image: "data:image/png;base64,AAAA", mediaType: "image/png" },
        { type: "file", data: "AAAA", mediaType: "text/csv" },
      ],
    };
    const photo: UserModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "And the photo" },
        { type: "file", data: "data:image/jpeg;base64,AAAA", mediaType: "image/jpeg", filename: "photo.jpg" },
      ],
    };
    const history: ModelMessage[] = [receipt, assistant("Got it"), photo, assistant("Thanks"), user("Now file the expense")];
    const trimmed = trimHistory(history);
    expect(parts(at(trimmed, 0))).toEqual([
      { type: "text", text: "Here is the receipt" },
      { type: "text", text: "[attachment omitted from context: receipt.pdf]" },
      { type: "text", text: "[attachment omitted from context: image/png]" },
      { type: "text", text: "[attachment omitted from context: text/csv]" },
    ]);
    expect(trimmed[2]).toBe(photo);
    expect(trimmed[1]).toBe(history[1]);
    expect(trimmed[4]).toBe(history[4]);
    // The originals were not mutated.
    expect(parts(receipt)).toHaveLength(4);
    expect(parts(receipt)[1]?.type).toBe("file");
  });
});

/* --------------------------- dangling tool calls ------------------------- */

describe("closeDanglingToolCalls", () => {
  const history: ModelMessage[] = [
    user("Open the cart"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "Opening it." },
        { type: "tool-call", toolCallId: "c1", toolName: "tab_open", input: { url: "https://shop.test" } },
        { type: "tool-call", toolCallId: "c2", toolName: "page_inspect", input: { tabId: "tab-1" } },
      ],
    },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "tab_open", output: json({ ok: true, tabId: "tab-1" }) }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c3", toolName: "web_search", input: { q: "x" }, providerExecuted: true }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c4", toolName: "page_click", input: { id: "pay" } }] },
  ];

  it("answers every unanswered call right after the message that made it", () => {
    const closed = closeDanglingToolCalls(history, "Turn was interrupted.");
    expect(closed).toHaveLength(history.length + 2);
    expect(closed[0]).toBe(history[0]);
    expect(closed[1]).toBe(history[1]);
    expect(closed[2]).toEqual({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c2", toolName: "page_inspect", output: { type: "error-text", value: "Turn was interrupted." } }],
    });
    // The already-answered call keeps its own result, untouched.
    expect(closed[3]).toBe(history[2]);
    // A provider-executed call needs no answer from us.
    expect(closed[4]).toBe(history[3]);
    expect(closed[5]).toBe(history[4]);
    expect(closed[6]).toEqual({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c4", toolName: "page_click", output: { type: "error-text", value: "Turn was interrupted." } }],
    });
  });

  it("changes nothing when every call is answered, and is idempotent", () => {
    const closed = closeDanglingToolCalls(history, "stopped");
    expect(closeDanglingToolCalls(closed, "stopped again")).toEqual(closed);
    const complete: ModelMessage[] = [user("hi"), ...exchange(1, "tabs_list", json(SMALL_TABS)), assistant("done")];
    expect(closeDanglingToolCalls(complete, "stopped")).toEqual(complete);
  });
});

/* ------------------------------ compaction ------------------------------- */

/** A history whose message at `length - COMPACTION_TAIL` is a tool result. */
function longHistory(): ModelMessage[] {
  const history: ModelMessage[] = [
    user("Book the table"), // 0
    ...exchange(1, "tabs_list", json(SMALL_TABS)), // 1, 2
    ...exchange(2, "page_inspect", json(PAGE)), // 3, 4
    ...exchange(3, "page_click", json({ ok: true })), // 5, 6
    assistant("Clicked."), // 7
    user("Try 8pm instead"), // 8
    ...exchange(4, "page_type", json({ ok: true })), // 9, 10
    assistant("Typed 8pm."), // 11
  ];
  expect(history).toHaveLength(12);
  expect(at(history, history.length - COMPACTION_TAIL).role).toBe("tool");
  return history;
}

describe("splitForCompaction", () => {
  it("returns null when there is too little to summarise", () => {
    expect(splitForCompaction([])).toBeNull();
    expect(splitForCompaction([user("hi")])).toBeNull();
    const short: ModelMessage[] = [user("hi"), ...exchange(1, "tabs_list", json(SMALL_TABS)), ...exchange(2, "tabs_list", json(SMALL_TABS)), assistant("a"), assistant("b"), assistant("c")];
    expect(short).toHaveLength(COMPACTION_TAIL + 2);
    expect(splitForCompaction(short)).toBeNull();
    // Long enough, but stepping the tail back off a tool result leaves a head of one.
    const borderline: ModelMessage[] = [user("hi"), assistant("a"), ...exchange(1, "tabs_list", json(SMALL_TABS)), assistant("b"), assistant("c"), assistant("d"), assistant("e"), assistant("f")];
    expect(borderline).toHaveLength(COMPACTION_TAIL + 3);
    expect(at(borderline, 3).role).toBe("tool");
    expect(splitForCompaction(borderline)).toBeNull();
  });

  it("never starts the tail on a tool result and covers the history exactly", () => {
    const history = longHistory();
    const split = splitForCompaction(history);
    expect(split).not.toBeNull();
    if (split === null) return;
    expect(split.anchor).toBe(history[0]);
    expect(split.tail[0]?.role).toBe("assistant");
    expect(split.tail[0]).toBe(history[5]);
    expect(split.tail).toHaveLength(COMPACTION_TAIL + 1);
    expect(split.head).toEqual(history.slice(1, 5));
    expect([split.anchor, ...split.head, ...split.tail]).toEqual(history);
    // A custom tail size behaves the same way.
    const smaller = splitForCompaction(history, 3);
    expect(smaller?.tail[0]).toBe(history[9]);
    expect(smaller?.head).toEqual(history.slice(1, 9));
  });
});

describe("applyCompaction", () => {
  it("attaches the summary to the task message and keeps the tail verbatim", () => {
    const history = longHistory();
    const split = splitForCompaction(history);
    if (split === null) throw new Error("expected a split");
    const compacted = applyCompaction(split, "  Progress: found the cart.  ");
    expect(compacted).toHaveLength(split.tail.length + 1);
    expect(compacted.slice(1)).toEqual(split.tail);
    const anchor = at(compacted, 0);
    expect(anchor.role).toBe("user");
    const anchorParts = parts(anchor);
    expect(anchorParts).toHaveLength(2);
    expect(anchorParts[0]).toEqual({ type: "text", text: "Book the table" });
    expect(anchorParts[1]).toEqual({ type: "text", text: `${SUMMARY_HEADER}\n\nProgress: found the cart.` });
    // The original task message is untouched.
    expect(history[0]).toEqual(user("Book the table"));
  });

  it("supersedes an earlier summary rather than stacking them", () => {
    const history = longHistory();
    const first = splitForCompaction(history);
    if (first === null) throw new Error("expected a split");
    const once = applyCompaction(first, "First summary");
    // More work happens, then a second compaction.
    const grown: ModelMessage[] = [...once, ...exchange(5, "page_inspect", json(PAGE)), ...exchange(6, "page_click", json({ ok: true })), assistant("Booked.")];
    const second = splitForCompaction(grown);
    if (second === null) throw new Error("expected a split");
    const twice = applyCompaction(second, "Second summary");
    const summaries = parts(at(twice, 0)).filter((part) => part.type === "text" && typeof part["text"] === "string" && part["text"].startsWith(SUMMARY_HEADER));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.["text"]).toContain("Second summary");
    expect(summaries[0]?.["text"]).not.toContain("First summary");
    expect(parts(at(twice, 0))[0]).toEqual({ type: "text", text: "Book the table" });
    expect(twice.slice(1)).toEqual(second.tail);
  });

  it("wraps a non-user anchor into a user message", () => {
    const tail: ModelMessage[] = [assistant("later")];
    const compacted = applyCompaction({ anchor: assistant("The plan was to book a table."), tail }, "Summary");
    const anchor = at(compacted, 0);
    expect(anchor.role).toBe("user");
    expect(parts(anchor)).toEqual([
      { type: "text", text: "[Earlier context]\nThe plan was to book a table." },
      { type: "text", text: `${SUMMARY_HEADER}\n\nSummary` },
    ]);
    expect(compacted.slice(1)).toEqual(tail);
    // A user anchor with string content becomes parts.
    const fromString = applyCompaction({ anchor: user("Task"), tail: [] }, "S");
    expect(parts(at(fromString, 0))).toEqual([
      { type: "text", text: "Task" },
      { type: "text", text: `${SUMMARY_HEADER}\n\nS` },
    ]);
  });
});

describe("renderForSummary", () => {
  it("writes one line per turn, call, and result", () => {
    const history: ModelMessage[] = [
      user("Find   a\n\nrestaurant"),
      {
        role: "user",
        content: [
          { type: "text", text: "with this menu" },
          { type: "file", data: "AAAA", mediaType: "application/pdf", filename: "menu.pdf" },
          { type: "image", image: "AAAA", mediaType: "image/png" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "text", text: "   " },
          { type: "tool-call", toolCallId: "c1", toolName: "page_inspect", input: { tabId: "tab-1" } },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "page_inspect", output: json({ title: "Menu" }) }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c2", toolName: "page_click", output: { type: "error-text", value: "no such control" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c3", toolName: "page_read", output: { type: "text", value: "plain text" } }] },
    ];
    const lines = renderForSummary(history).split("\n");
    expect(lines).toEqual([
      "USER: Find a restaurant",
      "USER: with this menu",
      "USER attached: menu.pdf",
      "USER attached: image",
      "ASSISTANT: Looking.",
      'ASSISTANT → page_inspect({"tabId":"tab-1"})',
      'TOOL page_inspect → {"title":"Menu"}',
      "TOOL page_click (failed) → no such control",
      "TOOL page_read → plain text",
    ]);
  });

  it("truncates long content and caps the whole transcript", () => {
    const long = "x".repeat(5_000);
    const rendered = renderForSummary([user(long), ...exchange(1, "page_read", { type: "text", value: "y".repeat(5_000) })]);
    const [userLine, callLine, toolLine] = rendered.split("\n");
    expect(userLine?.startsWith("USER: ")).toBe(true);
    expect(userLine?.endsWith("…")).toBe(true);
    expect(userLine?.length).toBeLessThan(1_300);
    expect(callLine?.startsWith("ASSISTANT → page_read(")).toBe(true);
    expect(toolLine?.endsWith("…")).toBe(true);
    expect(toolLine?.length).toBeLessThan(900);

    const many: ModelMessage[] = Array.from({ length: 50 }, (_, index) => user(`turn ${String(index)}: ${"z".repeat(100)}`));
    const capped = renderForSummary(many, 500);
    expect(capped.startsWith("…[earlier part omitted]\n")).toBe(true);
    expect(capped.length).toBeLessThanOrEqual(500 + "…[earlier part omitted]\n".length);
    expect(capped).toContain("turn 49:");
    expect(capped).not.toContain("turn 0:");
    // Under the cap nothing is dropped.
    expect(renderForSummary(many).startsWith("USER: turn 0:")).toBe(true);
  });
});

describe("compactionPrompt", () => {
  it("carries the transcript and the notes when there are any", () => {
    const withNotes = compactionPrompt("USER: hello\nASSISTANT: hi", "  - tab-1 is the cart\n- price is $40  ");
    expect(withNotes).toContain("Transcript to compact:\nUSER: hello\nASSISTANT: hi");
    expect(withNotes).toContain("The agent's own notes");
    expect(withNotes).toContain("- tab-1 is the cart\n- price is $40");
    expect(withNotes.indexOf("The agent's own notes")).toBeLessThan(withNotes.indexOf("Transcript to compact:"));
  });

  it("leaves the notes section out when the notes are empty", () => {
    for (const notes of ["", "   \n\t"]) {
      const prompt = compactionPrompt("USER: hello", notes);
      expect(prompt).not.toContain("The agent's own notes");
      expect(prompt).toContain("Transcript to compact:\nUSER: hello");
      expect(prompt).toContain("Remaining work");
    }
  });
});

/* ------------------------------- building -------------------------------- */

describe("userMessage", () => {
  it("is a plain string turn without attachments", () => {
    expect(userMessage("Book a table")).toEqual({ role: "user", content: "Book a table" });
    expect(userMessage("Book a table", [])).toEqual({ role: "user", content: "Book a table" });
  });

  it("carries attachments as file parts with their data URLs", () => {
    const message = userMessage("See these", [
      { name: "receipt.pdf", mediaType: "application/pdf", url: "data:application/pdf;base64,AAAA" },
      { name: "photo.png", mediaType: "image/png", url: "data:image/png;base64,BBBB" },
    ]);
    expect(message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "See these" },
        { type: "file", data: "data:application/pdf;base64,AAAA", mediaType: "application/pdf", filename: "receipt.pdf" },
        { type: "file", data: "data:image/png;base64,BBBB", mediaType: "image/png", filename: "photo.png" },
      ],
    });
  });
});

describe("assistantText and countToolCalls", () => {
  it("read the assistant's words and count its calls", () => {
    expect(assistantText(assistant("Done."))).toBe("Done.");
    expect(assistantText({ role: "assistant", content: "plain" })).toBe("plain");
    expect(assistantText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "tool-call", toolCallId: "c", toolName: "t", input: {} }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(countToolCalls([user("hi")])).toBe(0);
    expect(countToolCalls([user("hi"), ...exchange(1, "tabs_list", json(SMALL_TABS)), ...exchange(2, "tabs_list", json(SMALL_TABS)), assistant("done")])).toBe(2);
  });
});

/* -------------------------------- budget --------------------------------- */

describe("contextBudget", () => {
  it("defaults to a 200k window compacted at half", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200_000);
    expect(contextBudget({})).toEqual({ window: 200_000, compactAt: 100_000 });
  });

  it("reads the window and threshold from the environment", () => {
    expect(contextBudget({ PISTACHIO_AGENT_CONTEXT_TOKENS: "50000", PISTACHIO_AGENT_COMPACT_AT: "20000" })).toEqual({ window: 50_000, compactAt: 20_000 });
    expect(contextBudget({ PISTACHIO_AGENT_CONTEXT_TOKENS: "50000" })).toEqual({ window: 50_000, compactAt: 25_000 });
    expect(contextBudget({ PISTACHIO_AGENT_COMPACT_AT: "30000" })).toEqual({ window: 200_000, compactAt: 30_000 });
  });

  it("never compacts above the window", () => {
    expect(contextBudget({ PISTACHIO_AGENT_CONTEXT_TOKENS: "50000", PISTACHIO_AGENT_COMPACT_AT: "999999" })).toEqual({ window: 50_000, compactAt: 50_000 });
    expect(contextBudget({ PISTACHIO_AGENT_COMPACT_AT: "300000" })).toEqual({ window: 200_000, compactAt: 200_000 });
  });

  it("falls back on garbage", () => {
    for (const bad of ["", "abc", "-5", "0", "NaN", "  "]) {
      expect(contextBudget({ PISTACHIO_AGENT_CONTEXT_TOKENS: bad, PISTACHIO_AGENT_COMPACT_AT: bad })).toEqual({ window: 200_000, compactAt: 100_000 });
    }
    // A fractional value is read as its integer part.
    expect(contextBudget({ PISTACHIO_AGENT_CONTEXT_TOKENS: "1000.9" })).toEqual({ window: 1_000, compactAt: 500 });
  });
});
