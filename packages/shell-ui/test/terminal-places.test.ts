/** Where a terminal was asked to start, and what to run there (lib/terminal/places.ts): taken once, by the first shell. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { buildWithClaudeCode, claudeRun } from "../src/lib/extensions/actions";
import { startTerminalIn, takeTerminalStart } from "../src/lib/terminal/places";
import { useAppStore } from "../src/store";

afterEach(() => {
  useAppStore.setState({ error: null });
});

describe("a terminal's start", () => {
  it("is taken once, folder and program together; a folder alone, a program alone, or nothing", () => {
    startTerminalIn("t1", "/Users/ada/Pistachio/Extensions/word-counter", { program: "claude", args: ["count words"] });
    expect(takeTerminalStart("t1")).toEqual({ cwd: "/Users/ada/Pistachio/Extensions/word-counter", run: { program: "claude", args: ["count words"] } });
    expect(takeTerminalStart("t1")).toBeNull();
    startTerminalIn("t2", "/srv");
    expect(takeTerminalStart("t2")).toEqual({ cwd: "/srv", run: null });
    startTerminalIn("t3", null);
    expect(takeTerminalStart("t3")).toBeNull();
  });

  it("runs claude with the wish as its one argument, whatever the wish says", () => {
    expect(claudeRun("  make me an extension; rm -rf ~  ")).toEqual({ program: "claude", args: ["make me an extension; rm -rf ~"] });
    expect(claudeRun("   ")).toEqual({ program: "claude", args: [] });
  });
});

describe("Build with Claude Code", () => {
  it("names the draft folder from the wish, bounded, and starts claude there with the wish whole", async () => {
    const asked: { type?: string; name?: string }[] = [];
    const opened: string[] = [];
    setShellApi({
      extensions: async (request: { type?: string; name?: string }) => {
        asked.push(request);
        return request.type === "draftFolder" ? { type: "folder", path: "/Users/ada/Pistachio/Extensions/word-counter" } : null;
      },
      createTab: async (url: string) => void opened.push(url),
      closePage: () => undefined,
    } as unknown as ShellApiBridge);
    const wish = `count the words on every page I read, ${"and more ".repeat(30)}`;
    await buildWithClaudeCode(wish);
    const name = asked.find((request) => request.type === "draftFolder")?.name ?? "";
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).not.toBe("");
    const id = /pistachio:\/\/terminal\/([0-9a-f]+)/.exec(opened[0] ?? "")?.[1] ?? "";
    expect(id).not.toBe("");
    expect(takeTerminalStart(id)).toEqual({ cwd: "/Users/ada/Pistachio/Extensions/word-counter", run: { program: "claude", args: [wish.trim()] } });
  });

  it("starts nothing when the folder could not be made, and says so", async () => {
    const opened: string[] = [];
    setShellApi({ extensions: async () => null, createTab: async (url: string) => void opened.push(url), closePage: () => undefined } as unknown as ShellApiBridge);
    const notices = vi.fn();
    useAppStore.setState({ showNotice: notices } as never);
    await buildWithClaudeCode("a counter");
    expect(opened).toEqual([]);
    expect(notices).toHaveBeenCalledWith(expect.stringMatching(/could not be made/));
  });
});
