/**
 * `/` commands in the Bar (docs/desk-agent.md, *Commands*): when the menu is
 * up, what it offers for what was typed, how a message reads as a command,
 * and what each request to Pistachio says.
 */

import { describe, expect, it } from "vitest";
import {
  BAR_COMMAND_GROUPS,
  BAR_COMMANDS,
  commandCandidates,
  commandDescription,
  commandPrompt,
  commandQuery,
  commandSpan,
  commandWaiting,
  insertCommand,
  parseCommand,
} from "../src/lib/desk/slash-commands";

const names = (query: string): string[] => commandCandidates(query).map((command) => command.name);
const command = (name: string) => BAR_COMMANDS.find((entry) => entry.name === name)!;

describe("the catalog", () => {
  it("names each command once, and no alias is another's name", () => {
    const all = BAR_COMMANDS.flatMap((entry) => [entry.name, ...entry.aliases]);
    expect(new Set(all).size).toBe(all.length);
    for (const entry of BAR_COMMANDS) {
      expect(entry.name).toMatch(/^[a-z]+$/);
      expect(BAR_COMMAND_GROUPS).toContain(entry.group);
      // A request to Pistachio has words for the asking, at least once what it takes is there.
      if (entry.kind === "prompt") expect(commandPrompt(entry.id, "the pricing")).not.toBeNull();
    }
  });

  it("names the person's search engine", () => {
    expect(commandDescription(command("search"), { webProvider: "duckduckgo" })).toBe("Search DuckDuckGo in a new tab");
  });
});

describe("when the menu is up", () => {
  it("is the field's first word while the caret is in it", () => {
    expect(commandQuery("/", 1)).toEqual({ query: "", end: 1 });
    expect(commandQuery("/sea", 4)).toEqual({ query: "sea", end: 4 });
    // The caret back in the word of a command already followed by what it takes.
    expect(commandQuery("/sea tacos", 2)).toEqual({ query: "s", end: 4 });
  });

  it("is not for a slash anywhere else, or once the name is done", () => {
    expect(commandQuery("search /", 8)).toBeNull();
    expect(commandQuery(" /search", 8)).toBeNull();
    expect(commandQuery("/search ", 8)).toBeNull();
    expect(commandQuery("", 0)).toBeNull();
  });
});

describe("what the menu offers", () => {
  it("is everything, in the catalog's order, for a bare slash", () => {
    expect(names("")).toEqual(BAR_COMMANDS.map((entry) => entry.name));
  });

  it("puts names that start so first, then the names they go by", () => {
    expect(names("s")).toEqual(["search", "summarize", "screenshot", "share"]);
    expect(names("goo")).toEqual(["search"]);
    expect(names("TL")[0]).toBe("summarize");
  });

  it("finds a command by what it does from two letters on", () => {
    expect(names("tab")).toContain("open");
    expect(names("new tab")).toEqual(["search", "open"]);
    expect(names("context")).toEqual(["remember"]);
    expect(names("zzz")).toEqual([]);
  });
});

describe("a command chosen", () => {
  it("takes the word's place, and the caret goes after a space", () => {
    expect(insertCommand("/sea", 4, command("search"))).toEqual({ text: "/search ", caret: 8 });
    // What was typed after it stays.
    expect(insertCommand("/s   tacos near me", 2, command("search"))).toEqual({ text: "/search tacos near me", caret: 8 });
  });
});

describe("a message read as a command", () => {
  it("is its first word's command and the rest", () => {
    expect(parseCommand("/search  tacos near me ")).toMatchObject({ command: { id: "search" }, args: "tacos near me" });
    expect(parseCommand("/Google tacos")).toMatchObject({ command: { id: "search" }, args: "tacos" });
    expect(parseCommand("/new")).toMatchObject({ command: { id: "new" }, args: "" });
    // Lines after the first are what it takes too.
    expect(parseCommand("/remember Gate B12\nboards 10:40")?.args).toBe("Gate B12\nboards 10:40");
  });

  it("is a message when the word is no command, or the slash is not first", () => {
    expect(parseCommand("/shrug hello")).toBeNull();
    expect(parseCommand("search /search")).toBeNull();
    expect(parseCommand("/")).toBeNull();
  });

  it("waits for what a command must have", () => {
    expect(commandWaiting("/search")).toBe(true);
    expect(commandWaiting("/search   ")).toBe(true);
    expect(commandWaiting("/search tacos")).toBe(false);
    expect(commandWaiting("/summarize")).toBe(false);
    expect(commandWaiting("hello")).toBe(false);
  });
});

describe("the command in the field", () => {
  it("is marked, its hint drawn while nothing follows it", () => {
    expect(commandSpan("/search ")).toMatchObject({ end: 7, hint: "what to search for" });
    expect(commandSpan("/search tacos")).toMatchObject({ end: 7, hint: null });
    // Still being typed: marked, but the hint waits for the space.
    expect(commandSpan("/search")).toMatchObject({ end: 7, hint: null });
    // A command that takes nothing has no hint.
    expect(commandSpan("/new ")).toMatchObject({ end: 4, hint: null });
    expect(commandSpan("/shrug ")).toBeNull();
  });
});

describe("what a request to Pistachio says", () => {
  it("asks as a person would, with what was typed", () => {
    expect(commandPrompt("summarize", "")).toBe("Summarize the page in the window I'm using.");
    expect(commandPrompt("summarize", "the refund policy")).toBe("Summarize the page in the window I'm using, focusing on the refund policy.");
    expect(commandPrompt("translate", "Spanish")).toBe("Translate the page in the window I'm using into Spanish.");
    expect(commandPrompt("arrange", "mail on the left")).toBe("Arrange the windows on this desk: mail on the left.");
  });

  it("is nothing without what it must have, or for what the Bar does itself", () => {
    expect(commandPrompt("translate", " ")).toBeNull();
    expect(commandPrompt("research", "")).toBeNull();
    // Bare, the windows are arranged by the desk's own layout; it is no message.
    expect(commandPrompt("arrange", "")).toBeNull();
    expect(commandPrompt("search", "tacos")).toBeNull();
  });
});
