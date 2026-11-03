/**
 * `/` commands in the Bar (docs/desk-agent.md, *Commands*): when the menu is
 * up, what it offers for what was typed, how a message reads as a command,
 * and what each request to Pistachio says.
 */

import { describe, expect, it } from "vitest";
import { parseExtensionBarCommandId, type ExtensionInfo } from "@pistachio/shell-contracts/extensions";
import {
  BAR_COMMAND_GROUPS,
  BAR_COMMANDS,
  barCommandsFor,
  commandCandidates,
  commandDescription,
  commandPrompt,
  commandQuery,
  commandSpan,
  commandWaiting,
  commandWord,
  extensionBarCommands,
  extensionDraftName,
  extensionPrompt,
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

/** An extension as main publishes it, with only what the Bar reads set. */
function extension(overrides: Partial<ExtensionInfo> & { id: string }): ExtensionInfo {
  return {
    kind: "pistachio",
    name: overrides.id,
    version: "1.0.0",
    description: "",
    iconUrl: null,
    source: { type: "bundled" },
    enabled: true,
    enabledHere: true,
    pinned: true,
    order: 0,
    agentAllowed: false,
    status: "idle",
    error: null,
    badge: null,
    statusPill: null,
    hasPanel: false,
    panelWidth: null,
    hasAction: false,
    pages: [],
    barCommands: [],
    menuItems: [],
    settings: [],
    tools: [],
    grants: null,
    pending: null,
    verdict: null,
    devPath: null,
    ...overrides,
  };
}

const RECORDER = extension({
  id: "com.pistachio.recorder",
  name: "Recorder",
  barCommands: [{ name: "record", description: "Record the window in use", arg: { hint: "window | desk", required: false } }],
});

describe("an extension's commands (docs/extensions.md §2)", () => {
  it("come after the Bar's own, in their group, with their hint", () => {
    const catalog = barCommandsFor([RECORDER]);
    expect(catalog.slice(0, BAR_COMMANDS.length)).toEqual(BAR_COMMANDS);
    const record = catalog.at(-1)!;
    expect(record).toMatchObject({ name: "record", group: "Extensions", description: "Record the window in use", arg: { hint: "window | desk", required: false } });
    expect(parseExtensionBarCommandId(record.id)).toEqual({ extensionId: "com.pistachio.recorder", command: "record" });
    expect(record.extension).toEqual({ id: "com.pistachio.recorder", name: "Recorder", iconUrl: null, command: "record", action: false });
    // The group stands after Open in the menu, and Make (/extension) after it.
    expect(BAR_COMMAND_GROUPS.indexOf("Extensions")).toBe(BAR_COMMAND_GROUPS.indexOf("Open") + 1);
    // None: the catalog is the Bar's own, the same array.
    expect(barCommandsFor([])).toBe(BAR_COMMANDS);
  });

  it("are offered, read and marked like the Bar's own", () => {
    const catalog = barCommandsFor([RECORDER]);
    // (By its name first; /summarize's "recap" after it.)
    expect(commandCandidates("rec", catalog).map((entry) => entry.name)).toEqual(["record", "summarize"]);
    // Found by the extension's name too.
    expect(commandCandidates("recorder", catalog).map((entry) => entry.name)).toContain("record");
    expect(parseCommand("/record desk", catalog)).toMatchObject({ command: { name: "record", extension: { id: "com.pistachio.recorder" } }, args: "desk" });
    expect(commandSpan("/record ", catalog)).toMatchObject({ end: 7, hint: "window | desk" });
    expect(commandWaiting("/record", catalog)).toBe(false);
    // Without the extension, it is a message.
    expect(parseCommand("/record desk")).toBeNull();
  });

  it("are only those of extensions on here and not waiting on the person", () => {
    const waiting = extension({ ...RECORDER, id: "a", pending: { adds: [], can: [], declares: [], manifestHash: "h" } });
    const offHere = extension({ ...RECORDER, id: "b", enabledHere: false });
    const paused = extension({ ...RECORDER, id: "c", status: "paused" });
    expect(extensionBarCommands([waiting, offHere, paused])).toEqual([]);
  });

  it("include a Chrome extension on the Ledge as its action", () => {
    const rows = extensionBarCommands([extension({ id: "eimadpbcbfnmbkopoojfekhnkhdbieeh", kind: "chrome", name: "Dark Reader", hasAction: true })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "dark-reader", description: "Open Dark Reader", group: "Extensions", arg: null, extension: { action: true } });
    expect(commandWord("Grammarly: Grammar Checker")).toBe("grammarly-grammar-checker");
  });

  it("never take a Bar command's name: the Bar's own is what the word runs, and the extension's completes as /<segment>-<name>, running what it declared", () => {
    const clash = extension({ id: "dev.me.wiki", barCommands: [{ name: "search", description: "Search my wiki", arg: null }] });
    const catalog = barCommandsFor([clash]);
    expect(parseCommand("/search tacos", catalog)?.command.id).toBe("search");
    const own = parseCommand("/wiki-search tacos", catalog);
    expect(own).toMatchObject({ command: { name: "wiki-search", extension: { id: "dev.me.wiki", command: "search" } }, args: "tacos" });
    expect(commandCandidates("wiki", catalog).map((entry) => entry.name)).toContain("wiki-search");
    // Two extensions declaring the same word: the second's completes under its own segment too.
    const first = extension({ id: "dev.me.count", barCommands: [{ name: "count", description: "Count words", arg: null }] });
    const second = extension({ id: "dev.you.tally", barCommands: [{ name: "count", description: "Count lines", arg: null }] });
    expect(extensionBarCommands([first, second]).map((row) => [row.name, row.extension?.command])).toEqual([
      ["count", "count"],
      ["tally-count", "count"],
    ]);
    // A pinned Chrome extension named as a built-in: the first eight letters of its id stand in for a segment.
    const translate = extension({ id: "eimadpbcbfnmbkopoojfekhnkhdbieeh", kind: "chrome", name: "Translate", hasAction: true });
    expect(extensionBarCommands([translate]).map((row) => row.name)).toEqual(["eimadpbc-translate"]);
  });
});

describe("/extension", () => {
  it("waits for the wish, and is the Make group's", () => {
    expect(commandWaiting("/extension")).toBe(true);
    expect(parseCommand("/extension hides YouTube Shorts")).toMatchObject({ command: { id: "extension", group: "Make" }, args: "hides YouTube Shorts" });
  });

  it("names its draft folder from the wish's first words", () => {
    expect(extensionDraftName("hides YouTube Shorts on every channel page please")).toBe("hides-youtube-shorts-on-every");
    expect(extensionDraftName("a timer for my pomodoros")).toBe("timer-for-my-pomodoros");
    expect(extensionDraftName("  !!  ")).toBe("my-extension");
  });

  it("asks Pistachio as a person would, naming the folder", () => {
    expect(extensionPrompt("hides YouTube Shorts.", "/Users/z/Pistachio/Extensions/hides-youtube-shorts")).toBe(
      "Build a Pistachio extension that hides YouTube Shorts. Write it in /Users/z/Pistachio/Extensions/hides-youtube-shorts.",
    );
    expect(extensionPrompt("that counts my open tabs", null)).toBe("Build a Pistachio extension that counts my open tabs.");
    expect(extensionPrompt("a pomodoro timer", null)).toBe("Build a Pistachio extension: a pomodoro timer.");
  });

  it("puts the author turn's marker first when main handed the draft's token (docs/extensions.md §8)", () => {
    const token = "0123456789abcdef0123456789abcdef";
    expect(extensionPrompt("counts words", "/Users/z/Pistachio/Extensions/counts-words", { slug: "counts-words", token })).toBe(
      `[pistachio:extension-author slug=counts-words token=${token}]\nBuild a Pistachio extension that counts words. Write it in /Users/z/Pistachio/Extensions/counts-words.`,
    );
  });
});
