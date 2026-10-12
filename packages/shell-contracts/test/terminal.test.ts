import { describe, expect, it } from "vitest";
import { isAllowedNavigation } from "../src/url.js";
import { shellPageOf, shellPagePlaceholderHtml, shellPageTitle } from "../src/shell-pages.js";
import {
  TERMINAL_MAX_COLS,
  TERMINAL_PAGE_TITLE,
  cwdFromOsc7,
  isTerminalRequest,
  isTerminalUrl,
  newTerminalId,
  terminalUrl,
  terminalUrlId,
} from "../src/terminal.js";

describe("a terminal's address", () => {
  it("names one terminal by twelve hex digits, and nothing else", () => {
    const id = newTerminalId();
    expect(id).toMatch(/^[a-f0-9]{12}$/u);
    expect(newTerminalId()).not.toBe(id);
    expect(terminalUrlId(terminalUrl(id))).toBe(id);
    expect(terminalUrlId(`  PISTACHIO://terminal/${id}/ `)).toBe(id);
    expect(terminalUrlId("pistachio://terminal/")).toBeNull();
    expect(terminalUrlId("pistachio://terminal/xyz")).toBeNull();
    expect(terminalUrlId(`pistachio://terminal/${id}?cwd=/tmp`)).toBeNull();
    expect(terminalUrlId(`https://terminal/${id}`)).toBeNull();
    expect(isTerminalUrl(terminalUrl(id))).toBe(true);
  });

  it("is a shell-drawn page, named Terminal until its shell names it", () => {
    const url = terminalUrl("0a1b2c3d4e5f");
    expect(shellPageOf(url)).toBe("terminal");
    expect(shellPageTitle("terminal")).toBe(TERMINAL_PAGE_TITLE);
    expect(shellPagePlaceholderHtml(url)).toContain(`<title>${TERMINAL_PAGE_TITLE}</title>`);
    expect(isAllowedNavigation(url)).toBe(true);
  });
});

describe("the port's requests", () => {
  const id = "0a1b2c3d4e5f";

  it("are taken only whole", () => {
    expect(isTerminalRequest({ type: "open", id, cols: 80, rows: 24, cwd: null })).toBe(true);
    expect(isTerminalRequest({ type: "open", id, cols: 80, rows: 24, cwd: "/tmp" })).toBe(true);
    expect(isTerminalRequest({ type: "input", id, data: "ls\r" })).toBe(true);
    expect(isTerminalRequest({ type: "input", id, data: "\x1b[M !!", binary: true })).toBe(true);
    expect(isTerminalRequest({ type: "resize", id, cols: 120, rows: 40 })).toBe(true);
    expect(isTerminalRequest({ type: "ack", id, chars: 5_000 })).toBe(true);
    expect(isTerminalRequest({ type: "release", id })).toBe(true);
    expect(isTerminalRequest({ type: "clear", id })).toBe(true);
    expect(isTerminalRequest({ type: "open", id, cols: 80, rows: 24, cwd: null, restart: true })).toBe(true);
  });

  it("refuse what no window sends", () => {
    expect(isTerminalRequest(null)).toBe(false);
    expect(isTerminalRequest({ type: "open", id: "nope", cols: 80, rows: 24, cwd: null })).toBe(false);
    expect(isTerminalRequest({ type: "open", id, cols: 80, rows: 24, cwd: "relative/path" })).toBe(false);
    expect(isTerminalRequest({ type: "resize", id, cols: TERMINAL_MAX_COLS + 1, rows: 40 })).toBe(false);
    expect(isTerminalRequest({ type: "resize", id, cols: 0, rows: 40 })).toBe(false);
    expect(isTerminalRequest({ type: "resize", id, cols: 1.5, rows: 40 })).toBe(false);
    expect(isTerminalRequest({ type: "input", id, data: 7 })).toBe(false);
    expect(isTerminalRequest({ type: "input", id, data: "x", binary: false })).toBe(false);
    expect(isTerminalRequest({ type: "ack", id, chars: -1 })).toBe(false);
    expect(isTerminalRequest({ type: "kill", id })).toBe(false);
    expect(isTerminalRequest({ type: "open", id, cols: 80, rows: 24, cwd: null, restart: false })).toBe(false);
  });
});

describe("a shell's report of where it is (OSC 7)", () => {
  it("is its folder, decoded", () => {
    expect(cwdFromOsc7("file://mac.local/Users/ada/My%20Projects")).toBe("/Users/ada/My Projects");
    expect(cwdFromOsc7("file:///tmp")).toBe("/tmp");
    expect(cwdFromOsc7("file://host/Users/ada/caf%C3%A9")).toBe("/Users/ada/café");
    expect(cwdFromOsc7("kitty-shell-cwd://host/srv")).toBe("/srv");
  });

  it("is nothing when it is not one", () => {
    expect(cwdFromOsc7("https://example.com/")).toBeNull();
    expect(cwdFromOsc7("not a url")).toBeNull();
    expect(cwdFromOsc7("file://host/%E0%A4%A")).toBeNull();
  });
});
