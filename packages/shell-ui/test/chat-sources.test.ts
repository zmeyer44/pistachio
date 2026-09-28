/**
 * Where a reply came from (lib/chat-sources.ts): the pages a turn's calls
 * read, once each and numbered, and the link that cites one of them.
 */

import { describe, expect, it } from "vitest";
import type { AgentToolCall } from "@pistachio/protocol";
import { citedSource, sourceHost, sourceKey, turnSources } from "../src/lib/chat-sources";

function call(name: AgentToolCall["name"], source: AgentToolCall["source"], status: AgentToolCall["status"] = "completed"): AgentToolCall {
  return { id: `${name}:${source?.url ?? "none"}`, name, label: name, detail: "", status, startedAt: "2026-09-27T10:00:00.000Z", completedAt: null, tabId: null, turn: 1, ...(source === undefined ? {} : { source }) };
}

describe("turnSources", () => {
  it("numbers the pages a turn read, once each, in the order first read", () => {
    const sources = turnSources([
      call("tabs.list", undefined),
      call("page.inspect", { url: "https://www.example.test/a/", title: "A" }),
      call("page.inspect", { url: "https://example.test/b", title: "B" }),
      call("page.inspect", { url: "https://example.test/a#section", title: "A, scrolled" }),
      call("watchtower.read", { url: "https://saved.test/c", title: "C" }),
    ]);
    expect(sources.map((source) => [source.index, source.host, source.title])).toEqual([
      [1, "example.test", "A, scrolled"],
      [2, "example.test", "B"],
      [3, "saved.test", "C"],
    ]);
  });

  it("counts only calls that completed", () => {
    expect(turnSources([call("page.inspect", { url: "https://example.test/", title: "Home" }, "failed")])).toEqual([]);
  });
});

describe("citedSource", () => {
  const sources = turnSources([call("page.inspect", { url: "https://www.example.test/docs/", title: "Docs" })]);

  it("finds the source a link points at, however the model spelled the address", () => {
    expect(citedSource(sources, "http://example.test/docs")?.index).toBe(1);
    expect(citedSource(sources, "https://www.example.test/docs/#intro")?.index).toBe(1);
    expect(citedSource(sources, "https://example.test/other")).toBeNull();
    expect(citedSource(sources, "not a url")).toBeNull();
  });
});

describe("hosts and keys", () => {
  it("shows a site without its www, and keys a page by host, path and query", () => {
    expect(sourceHost("https://www.Example.test/x")).toBe("example.test");
    expect(sourceKey("https://www.Example.test/x/?q=1#top")).toBe("example.test/x?q=1");
    expect(sourceHost("nonsense")).toBe("nonsense");
  });
});
