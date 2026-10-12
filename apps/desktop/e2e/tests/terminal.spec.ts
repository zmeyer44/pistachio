/**
 * Terminals (docs/terminal.md): ⌘J opens a shell on this Mac in a tab of its
 * own — a shell page the shell draws with xterm.js, its shell in main's
 * terminal host on a pseudo-terminal. The shell is a login zsh with
 * Pistachio's integration (it names the tab, says where it is), in an
 * environment that is the app's less what is the app's alone; a new terminal
 * opens where the one in use is; ⌘ keys stay the app's while ⌘F and ⌘K are
 * the terminal's; a shell window that loads again finds its terminals as
 * they were (the host's mirror replays them); a flood of output is drawn
 * and the shell keeps up; `exit` closes the tab, and closing the tab ends
 * the shell.
 *
 * zsh is pointed at an empty folder (ZDOTDIR) so the prompt is zsh's own and
 * nothing of the person's — their .zshrc, their history — is read or written.
 */

import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launchApp } from "./app";
import { fromFrameMenu, launchDesk, settled, snapshot } from "./desk-harness";
import { captureShell, visibleTabViews } from "./pages-harness";
import { shellReady } from "./windows";

const TERMINAL_URL = /^pistachio:\/\/terminal\/([a-f0-9]{12})$/u;

type ProbeMethod = "text" | "status" | "cwd" | "fontSize";

/** What the shell's terminal registry says of terminal `id` (lib/terminal/sessions.ts's e2e hook). */
function probe(shell: Page, method: ProbeMethod, id: string): Promise<unknown> {
  return shell.evaluate(
    ([name, terminal]) => {
      const terminals = (globalThis as unknown as { __pistachioTerminals?: Record<string, (id: string) => unknown> }).__pistachioTerminals;
      return terminals?.[name]?.(terminal) ?? null;
    },
    [method, id] as const,
  );
}

const textOf = async (shell: Page, id: string): Promise<string> => String((await probe(shell, "text", id)) ?? "");

async function activeTerminal(shell: Page): Promise<{ tabId: string; id: string; title: string }> {
  const current = await snapshot(shell);
  const tab = current.tabs.find((candidate) => candidate.id === current.activeTabId);
  const match = tab === undefined ? null : TERMINAL_URL.exec(tab.url);
  if (tab === undefined || match === null) throw new Error(`the tab in use is no terminal: ${tab?.url ?? "none"}`);
  return { tabId: tab.id, id: match[1]!, title: tab.title };
}

/** ⌘J, and the new terminal's shell up. */
async function newTerminal(shell: Page): Promise<{ tabId: string; id: string }> {
  const before = (await snapshot(shell)).activeTabId;
  await shell.keyboard.press("Meta+J");
  await expect.poll(async () => (await snapshot(shell)).activeTabId).not.toBe(before);
  await expect
    .poll(async () => {
      const current = await snapshot(shell);
      return TERMINAL_URL.test(current.tabs.find((tab) => tab.id === current.activeTabId)?.url ?? "");
    })
    .toBe(true);
  const terminal = await activeTerminal(shell);
  await expect.poll(() => probe(shell, "status", terminal.id), { timeout: 15_000 }).toBe("running");
  // The first prompt: zsh's own, `host% `.
  await expect.poll(() => textOf(shell, terminal.id), { timeout: 15_000 }).toMatch(/[%#] ?$/mu);
  return terminal;
}

/** Type a command line into the terminal in use, and wait for what it prints. */
async function run(shell: Page, id: string, line: string, expected: RegExp | string): Promise<string> {
  await shell.keyboard.type(line);
  await shell.keyboard.press("Enter");
  const pattern = typeof expected === "string" ? new RegExp(escapeRegExp(expected), "u") : expected;
  try {
    await expect.poll(() => textOf(shell, id), { timeout: 15_000 }).toMatch(pattern);
  } catch (error) {
    // (Where the typing went, and what the terminal is doing: a failure here says more than the text.)
    const state = await shell.evaluate((terminalId) => {
      const page = document.querySelector(`[data-testid="terminal-page"][data-terminal-id="${terminalId}"]`)?.getBoundingClientRect();
      const under = page === undefined ? null : document.elementFromPoint(page.x + page.width / 2, page.y + page.height / 2);
      const active = document.activeElement;
      const terminals = (globalThis as unknown as { __pistachioTerminals: Record<string, (id: string) => unknown> }).__pistachioTerminals;
      return {
        status: terminals["status"]?.(terminalId),
        focus: `${active?.tagName ?? ""}.${String(active?.className ?? "").slice(0, 60)}`,
        under: `${under?.tagName ?? ""}.${String(under?.className ?? "").slice(0, 60)}`,
        tail: String(terminals["text"]?.(terminalId) ?? "").split("\n").slice(-3),
      };
    }, id);
    throw new Error(`${line} → ${String(pattern)} not seen: ${JSON.stringify(state)}`, { cause: error });
  }
  return textOf(shell, id);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The terminal's tab in use (its window out and on top). */
async function selectTerminal(shell: Page, tabId: string): Promise<void> {
  await shell.evaluate((id) => (window as unknown as { pistachio: { selectTab(id: string): Promise<void> } }).pistachio.selectTab(id), tabId);
  await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(tabId);
}

function alive(app: ElectronApplication, pid: number): Promise<boolean> {
  return app.evaluate((_electron, target) => {
    try {
      process.kill(target, 0);
      return true;
    } catch {
      return false;
    }
  }, pid);
}

test.describe.serial("terminals", { tag: ["@terminal"] }, () => {
  test.describe.configure({ timeout: 90_000 });
  let app: ElectronApplication;
  let shell: Page;
  let zdotdir: string;
  let userData: string;
  let first: { tabId: string; id: string };

  test.beforeAll(async () => {
    // (Real: macOS's /tmp is /private/tmp, and zsh reports the folder it was given.)
    zdotdir = await realpath(await mkdtemp(join(tmpdir(), "pistachio-terminal-zsh-")));
    // (zsh's emacs keys whatever $EDITOR says — an EDITOR=vim puts an unconfigured zsh in vi mode.)
    await writeFile(join(zdotdir, ".zshrc"), "bindkey -e\n");
    ({ app, userData } = await launchApp({ name: "terminal", size: { width: 1440, height: 900 }, env: { SHELL: "/bin/zsh", ZDOTDIR: zdotdir, TMUX: "/tmp/not-ours,1,0" } }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("⌘J opens a terminal: a login zsh, in an environment of its own", { tag: ["@smoke"] }, async () => {
    first = await newTerminal(shell);
    await expect(shell.locator(`[data-testid="terminal-page"][data-terminal-id="${first.id}"]`)).toBeVisible();
    // Drawn by the shell: no native view stands over it.
    await expect.poll(() => visibleTabViews(app)).toBe(0);

    await run(shell, first.id, "echo hello-$((6*7))", /^hello-42$/mu);
    // What a terminal says of itself, nothing of the app's own (PISTACHIO_E2E), nor of the terminal the app was started
    // in (TMUX); and the person's ZDOTDIR put back after Pistachio's stood in for it.
    await run(shell, first.id, 'echo "[$TERM_PROGRAM|$TERM|$COLORTERM|${PISTACHIO_E2E-none}|${TMUX-none}|$ZDOTDIR]"', `[Pistachio|xterm-256color|truecolor|none|none|${zdotdir}]`);
    // A login shell: zsh says so.
    await run(shell, first.id, "[[ -o login ]] && echo login-yes", /^login-yes$/mu);
    await captureShell(app, "terminal/01-first-terminal.png", 300);
  });

  test("⌥← and ⌥→ move by word, ⌥⌫ takes the word before, as in Ghostty", async () => {
    await shell.keyboard.type("echo one two three");
    await shell.keyboard.press("Alt+ArrowLeft");
    await shell.keyboard.press("Alt+ArrowLeft");
    await shell.keyboard.type("X");
    await shell.keyboard.press("Alt+ArrowRight");
    await shell.keyboard.type("Y");
    await shell.keyboard.press("Enter");
    await expect.poll(() => textOf(shell, first.id)).toMatch(/^one XtwoY three$|^one Xtwo Ythree$/mu);
    await shell.keyboard.type("echo alpha beta");
    await shell.keyboard.press("Alt+Backspace");
    await shell.keyboard.type("gamma");
    await shell.keyboard.press("Enter");
    await expect.poll(() => textOf(shell, first.id)).toMatch(/^alpha gamma$/mu);
  });

  test("its integration names the tab and follows the folder", async () => {
    await run(shell, first.id, "cd /tmp", /cd \/tmp/u);
    await expect.poll(async () => (await activeTerminal(shell)).title).toBe("/tmp");
    await expect.poll(() => probe(shell, "cwd", first.id)).toBe("/tmp");
    // While a command runs, the tab is named after it.
    await shell.keyboard.type("sleep 1.5");
    await shell.keyboard.press("Enter");
    await expect.poll(async () => (await activeTerminal(shell)).title).toBe("sleep 1.5");
    await expect.poll(async () => (await activeTerminal(shell)).title, { timeout: 5_000 }).toBe("/tmp");
  });

  test("a new terminal opens where the one in use is, and ⌘ keys stay the app's", async () => {
    // Even with the kitty keyboard protocol on (Claude Code, Neovim ask for it): ⌘J is still the app's, never the program's.
    await run(shell, first.id, "printf '\\e[>1u'; echo kitty-on", /^kitty-on$/mu);
    const second = await newTerminal(shell);
    expect(second.id).not.toBe(first.id);
    await run(shell, second.id, "pwd", /^\/tmp$/mu);
    await captureShell(app, "terminal/02-second-terminal.png", 300);
    // ⌘W over a terminal is the app's: its tab closes, and its shell with it.
    const text = await run(shell, second.id, "echo pid-$$", /^pid-\d+$/mu);
    const pid = Number(/^pid-(\d+)$/mu.exec(text)?.[1]);
    expect(await alive(app, pid)).toBe(true);
    await shell.keyboard.press("Meta+W");
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === second.tabId)).toBe(false);
    await expect.poll(() => alive(app, pid), { timeout: 10_000 }).toBe(false);
    await shell.locator(`[data-testid="terminal-page"][data-terminal-id="${first.id}"]`).click();
    await run(shell, first.id, "printf '\\e[<u'; echo kitty-off", /^kitty-off$/mu);
  });

  test("⌘F finds in its scrollback, ⌘K clears it, ⌘+ makes the type larger", async () => {
    await shell.locator(`[data-testid="terminal-page"][data-terminal-id="${first.id}"]`).click();
    await shell.keyboard.press("Meta+F");
    await expect(shell.getByTestId("terminal-find")).toBeVisible();
    await shell.keyboard.type("hello");
    // The command line and its output.
    await expect(shell.getByTestId("terminal-find-count")).toHaveText(/of 2$/u);
    await captureShell(app, "terminal/03-find.png", 200);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("terminal-find")).toBeHidden();

    const size = Number(await probe(shell, "fontSize", first.id));
    await shell.keyboard.press("Meta+Equal");
    await expect.poll(() => probe(shell, "fontSize", first.id)).toBe(size + 1);
    await shell.keyboard.press("Meta+0");
    await expect.poll(() => probe(shell, "fontSize", first.id)).toBe(size);

    await shell.keyboard.press("Meta+K");
    await expect.poll(() => textOf(shell, first.id)).not.toContain("hello-42");
    await run(shell, first.id, "echo still-here", /^still-here$/mu);
  });

  test("a shell window that loads again finds its terminal as it was", async () => {
    const text = await run(shell, first.id, "echo pid-$$", /^pid-\d+$/mu);
    const pid = /^pid-(\d+)$/mu.exec(text)?.[1] ?? "";
    await shell.reload();
    shell = await shellReady(app);
    await expect(shell.locator(`[data-testid="terminal-page"][data-terminal-id="${first.id}"]`)).toBeVisible();
    // Replayed from the host's mirror: the same screen, the same shell.
    await expect.poll(() => textOf(shell, first.id), { timeout: 15_000 }).toContain(`pid-${pid}`);
    await shell.locator(`[data-testid="terminal-page"][data-terminal-id="${first.id}"]`).click();
    await run(shell, first.id, "echo again-$$", `again-${pid}`);
  });

  test("⌘K's clearing holds: a shell window that loads again does not bring back what was cleared", async () => {
    await run(shell, first.id, "echo before-the-clear", /^before-the-clear$/mu);
    await shell.keyboard.press("Meta+K");
    await expect.poll(() => textOf(shell, first.id)).not.toContain("before-the-clear");
    await run(shell, first.id, "echo after-the-clear", /^after-the-clear$/mu);
    await shell.reload();
    shell = await shellReady(app);
    await expect.poll(() => textOf(shell, first.id), { timeout: 15_000 }).toContain("after-the-clear");
    expect(await textOf(shell, first.id)).not.toContain("before-the-clear");
    await shell.locator(`[data-testid="terminal-page"][data-terminal-id="${first.id}"]`).click();
  });

  test("a program's copy (OSC 52) reaches the Mac's clipboard; its question about the clipboard is answered empty", async () => {
    await run(shell, first.id, `printf '\\e]52;c;%s\\a' "$(printf from-osc52 | base64)"; echo copy-sent`, /^copy-sent$/mu);
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("from-osc52");
  });

  test("an inline image a program prints leaves the window and the host's copy agreeing on where the text is", async () => {
    // A 2×2 red PNG, sent as iTerm's inline image (OSC 1337) four cells wide.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoAADgYAgLC4OWUAAAAAElFTkSuQmCC";
    await run(shell, first.id, `printf 'before\\e]1337;File=inline=1;width=4;height=3:${png}\\aafter\\n'; echo image-sent`, /^image-sent$/mu);
    const drawn = (await textOf(shell, first.id)).replace(/\s+$/u, "");
    await shell.reload();
    shell = await shellReady(app);
    await expect.poll(async () => (await textOf(shell, first.id)).replace(/\s+$/u, ""), { timeout: 15_000 }).toBe(drawn);
    await shell.locator(`[data-testid="terminal-page"][data-terminal-id="${first.id}"]`).click();
  });

  test("a flood of output is drawn, and the shell keeps up", async () => {
    await run(shell, first.id, "seq 1 200000", /^200000$/mu);
    await run(shell, first.id, "echo after-flood", /^after-flood$/mu);
  });

  test("a program that takes the whole screen: vim, typed into and left", async () => {
    const file = `/tmp/pistachio-terminal-${first.id}.txt`;
    await shell.keyboard.type(`vim -u NONE -N ${file}`);
    await shell.keyboard.press("Enter");
    // Its own screen (the alternate one): empty lines drawn as ~.
    await expect.poll(() => textOf(shell, first.id), { timeout: 15_000 }).toMatch(/^~ *$/mu);
    await shell.keyboard.type("ihello from vim");
    await shell.keyboard.press("Escape");
    await shell.keyboard.type(":wq");
    await shell.keyboard.press("Enter");
    // Back on the shell's screen, the file written.
    await run(shell, first.id, `cat ${file}`, /^hello from vim$/mu);
  });

  test("the desk passing to another space and back keeps it running, as it was", async () => {
    const marker = `passing-${String(Date.now())}`;
    await run(shell, first.id, `echo ${marker}`, new RegExp(`^${marker}$`, "mu"));
    // A new space: the desk passes to it, and the terminal's window goes home into its row.
    const from = (await snapshot(shell)).currentGroupId;
    await shell.keyboard.press("Meta+N");
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).not.toBe(from);
    await shell.keyboard.press("Escape");
    await expect(shell.locator(`[data-testid="terminal-page"][data-terminal-id="${first.id}"]`)).toHaveCount(0);
    // And back: the same terminal, its screen as it was, its shell still there.
    await shell.evaluate((tabId) => (window as unknown as { pistachio: { selectTab(id: string): Promise<void> } }).pistachio.selectTab(tabId), first.tabId);
    await expect(shell.locator(`[data-testid="terminal-page"][data-terminal-id="${first.id}"]`)).toBeVisible();
    expect(await textOf(shell, first.id)).toContain(marker);
    // (Its window flies back out of its row: pressed where it comes to rest.)
    await settled(shell, app);
    await shell.locator(`[data-testid="terminal-page"][data-terminal-id="${first.id}"]`).click();
    await run(shell, first.id, "echo back-again", /^back-again$/mu);
    await captureShell(app, "terminal/04-back-from-another-space.png", 300);
  });

  test("a page never makes itself a terminal: not by a link, a window, or a server's redirect", async () => {
    const ids = { link: "0123456789a1", open: "0123456789a2", redirect: "0123456789a3" };
    const server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: `pistachio://terminal/${ids.redirect}` });
        response.end();
        return;
      }
      // The page tries both itself as it loads, then says it did.
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Fixture</title><a id="go" href="pistachio://terminal/${ids.link}">go</a>
<script>window.open("pistachio://terminal/${ids.open}"); document.getElementById("go").click(); setTimeout(() => { document.title = "tried"; }, 300);</script>`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const api = (call: string, url: string) =>
        shell.evaluate(([name, address]) => (window as unknown as { pistachio: Record<string, (url: string) => Promise<unknown>> }).pistachio[name]!(address), [call, url] as const);
      await api("createTab", `${origin}/page`);
      await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.url.startsWith(origin))?.title).toBe("tried");
      await api("createTab", `${origin}/redirect`);
      // The redirect is refused: the tab never holds a terminal's address (whatever else it shows).
      await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => tab.url.startsWith(origin)).length).toBe(2);
      await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.loading)).toBe(false);
      const tabs = (await snapshot(shell)).tabs;
      for (const id of Object.values(ids)) {
        expect(tabs.some((tab) => tab.url.includes(id))).toBe(false);
        expect(await probe(shell, "status", id)).toBeNull();
      }
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("a shell that died with every key reported (kitty) still restarts on Enter, its modes left behind", async () => {
    const fourth = await newTerminal(shell);
    // Kitty's report-all-keys (8): Enter is an escape sequence, not a carriage return. Then the shell dies.
    await shell.keyboard.type("printf '\\e[>8u'; kill -9 $$");
    await shell.keyboard.press("Enter");
    await expect.poll(() => probe(shell, "status", fourth.id), { timeout: 10_000 }).toBe("exited");
    await shell.keyboard.press("Enter");
    await expect.poll(() => probe(shell, "status", fourth.id), { timeout: 10_000 }).toBe("running");
    // The new shell takes plain keys: the dead program's keyboard mode went with it.
    await run(shell, fourth.id, "echo fresh-shell", /^fresh-shell$/mu);
    await shell.keyboard.press("Meta+W");
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === fourth.tabId)).toBe(false);
    await selectTerminal(shell, first.tabId);
  });

  test("a shell that failed says so beside its text, and its restart replays exactly as the window drew it", async () => {
    const fifth = await newTerminal(shell);
    await run(shell, fifth.id, "echo before-the-failure", /^before-the-failure$/mu);
    await shell.keyboard.type("exit 3");
    await shell.keyboard.press("Enter");
    await expect.poll(() => probe(shell, "status", fifth.id)).toBe("exited");
    const page = shell.locator(`[data-testid="terminal-page"][data-terminal-id="${fifth.id}"]`);
    await expect(page.getByTestId("terminal-note")).toContainText("exited with code 3");
    await shell.keyboard.press("Enter");
    await expect.poll(() => probe(shell, "status", fifth.id)).toBe("running");
    await expect(page.getByTestId("terminal-note")).toHaveCount(0);
    await run(shell, fifth.id, "echo after-the-restart", /^after-the-restart$/mu);
    // The window's text is the host's: nothing of the window's own was written into it.
    const drawn = (await textOf(shell, fifth.id)).replace(/\s+$/u, "");
    await shell.reload();
    shell = await shellReady(app);
    await selectTerminal(shell, fifth.tabId);
    await expect.poll(async () => (await textOf(shell, fifth.id)).replace(/\s+$/u, ""), { timeout: 15_000 }).toBe(drawn);
    await shell.keyboard.press("Meta+W");
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === fifth.tabId)).toBe(false);
    await selectTerminal(shell, first.tabId);
  });

  test("closed and brought back (⌘⇧T) just after the host let its shell go: it opens anew and takes typing", async () => {
    const sixth = await newTerminal(shell);
    await shell.keyboard.press("Meta+W");
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === sixth.tabId)).toBe(false);
    // The time is the point: past the host closing it (1.5 s), short of the window letting it go (2 s).
    await shell.waitForTimeout(1_750);
    await shell.keyboard.press("Meta+Shift+T");
    await expect.poll(async () => (await activeTerminal(shell)).id).toBe(sixth.id);
    await run(shell, sixth.id, "echo revived", /^revived$/mu);
    await shell.keyboard.press("Meta+W");
    await selectTerminal(shell, first.tabId);
  });

  test("exit closes the tab", async () => {
    const third = await newTerminal(shell);
    await shell.keyboard.type("exit");
    await shell.keyboard.press("Enter");
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === third.tabId)).toBe(false);
  });

  test("reopened with the app, a terminal starts again where it was", async () => {
    await selectTerminal(shell, first.tabId);
    await run(shell, first.id, "cd /tmp && echo in-tmp", /^in-tmp$/mu);
    await expect.poll(() => probe(shell, "cwd", first.id)).toBe("/tmp");
    // (The folder is kept on disk a moment after the shell reports it.)
    await shell.waitForTimeout(800);
    await app.close();
    ({ app } = await launchApp({ userData, size: { width: 1440, height: 900 }, env: { SHELL: "/bin/zsh", ZDOTDIR: zdotdir } }));
    shell = await shellReady(app);
    await selectTerminal(shell, first.tabId);
    await expect(shell.locator(`[data-testid="terminal-page"][data-terminal-id="${first.id}"]`)).toBeVisible();
    await expect.poll(() => probe(shell, "status", first.id), { timeout: 15_000 }).toBe("running");
    await shell.locator(`[data-testid="terminal-page"][data-terminal-id="${first.id}"]`).click();
    await run(shell, first.id, "pwd", /^\/tmp$/mu);
  });
});

test("Tidy never archives a terminal: an idle favorite's group holding one comes down instead", { tag: ["@terminal", "@tabs"] }, async () => {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const FAVORITE = "fav-vendors";
  const terminalId = "0123456789b1";
  const tab = (id: string, url: string, idleHours: number, anchorId: string | null = null) => ({
    id,
    spaceId: "work",
    title: id,
    url,
    faviconUrl: null,
    anchorId,
    lastActiveAt: now - idleHours * HOUR,
  });
  const tabs = [
    tab("tab-active", "pistachio://demo/invoices", 0),
    tab("tab-favorite", "pistachio://demo/vendors/atlas-medical", 40, FAVORITE),
    tab("tab-terminal", `pistachio://terminal/${terminalId}`, 40),
  ];
  const { app } = await launchApp({
    name: "terminal-tidy",
    settings: { onboarding: { completed: true, completedAt: null } },
    files: {
      "tab-session.json": {
        version: 1,
        spaces: {
          work: {
            activeTabId: "tab-active",
            recentTabIds: tabs.map((candidate) => candidate.id),
            splitGroups: [],
            tabs,
            // The favorite's page leads its group; a terminal was opened beside it.
            tabGroups: [{ id: "favorite-group", title: "", color: "blue", tabIds: ["tab-favorite", "tab-terminal"], anchorId: FAVORITE, origin: "auto", open: false, createdAt: now - 40 * HOUR }],
          },
        },
      },
      "sidebar.json": { version: 1, spaces: { work: { favorites: [{ id: FAVORITE, url: "pistachio://demo/vendors", title: "Vendors", faviconUrl: null }], entries: [] } } },
    },
    env: { PISTACHIO_TIDY_SCRIPT: JSON.stringify({ groups: [] }) },
  });
  try {
    const shell = await shellReady(app);
    await expect.poll(async () => ((await snapshot(shell)).anchorGroups ?? []).some((group) => group.anchorId === FAVORITE)).toBe(true);
    await shell.evaluate(() => (window as unknown as { pistachio: { tidy(request: { type: "run" }): Promise<unknown> } }).pistachio.tidy({ type: "run" }));
    // The favorite let go of its group (it went home); the terminal stayed — its shell with it.
    await expect.poll(async () => ((await snapshot(shell)).anchorGroups ?? []).some((group) => group.anchorId === FAVORITE)).toBe(false);
    expect((await snapshot(shell)).tabs.some((candidate) => candidate.id === "tab-terminal")).toBe(true);
  } finally {
    await app.close();
  }
});

test("a minimized terminal keeps its size: ⌘+ in another changes its type, not its rows and columns", { tag: ["@terminal", "@desk"] }, async () => {
  const zdotdir = await realpath(await mkdtemp(join(tmpdir(), "pistachio-terminal-zsh-")));
  await writeFile(join(zdotdir, ".zshrc"), "bindkey -e\n");
  const { app, shell } = await launchDesk({ name: "terminal-frozen", env: { SHELL: "/bin/zsh", ZDOTDIR: zdotdir } });
  try {
    const first = await newTerminal(shell);
    const second = await newTerminal(shell);
    const size = (id: string) =>
      shell.evaluate((terminalId) => {
        const terminal = (globalThis as unknown as { __pistachioTerminals: { terminal(id: string): { cols: number; rows: number } | null } }).__pistachioTerminals.terminal(terminalId);
        return terminal === null ? null : { cols: terminal.cols, rows: terminal.rows };
      }, id);
    const firstWindow = shell.locator(`[data-testid="desk-window"][data-tab-id="${first.tabId}"]`);
    // (The second window's coming lays the desk out anew: its frame's buttons are pressed where they come to rest.)
    await settled(shell, app);
    await fromFrameMenu(shell, firstWindow, "desk-minimize");
    await expect(firstWindow).toHaveAttribute("data-mini", /.+/u);
    await expect(firstWindow).not.toHaveAttribute("data-flight", /.+/u);
    const kept = await size(first.id);
    await shell.locator(`[data-testid="terminal-page"][data-terminal-id="${second.id}"]`).click();
    const before = await size(second.id);
    await shell.keyboard.press("Meta+Equal");
    // The terminal in use takes the larger type at its size; the minimized one takes the type, and keeps its size.
    await expect.poll(() => size(second.id)).not.toEqual(before);
    await expect.poll(() => probe(shell, "fontSize", first.id)).toBe(Number(await probe(shell, "fontSize", second.id)));
    expect(await size(first.id)).toEqual(kept);
    await shell.keyboard.press("Meta+0");
    // Loaded again, the minimized terminal is replayed at the size it keeps, not fitted to its zoomed box.
    await expect.poll(() => size(first.id)).toEqual(kept);
    await shell.reload();
    const again = await shellReady(app);
    await expect.poll(() => probe(again, "status", first.id), { timeout: 15_000 }).toBe("running");
    expect(
      await again.evaluate((terminalId) => {
        const terminal = (globalThis as unknown as { __pistachioTerminals: { terminal(id: string): { cols: number; rows: number } | null } }).__pistachioTerminals.terminal(terminalId);
        return terminal === null ? null : { cols: terminal.cols, rows: terminal.rows };
      }, first.id),
    ).toEqual(kept);
  } finally {
    await app.close();
  }
});

test("the terminal host gone, Enter starts a new shell — and a reload replays exactly what the window shows", { tag: ["@terminal"] }, async () => {
  const zdotdir = await realpath(await mkdtemp(join(tmpdir(), "pistachio-terminal-zsh-")));
  await writeFile(join(zdotdir, ".zshrc"), "bindkey -e\n");
  const { app } = await launchApp({ name: "terminal-host-gone", size: { width: 1440, height: 900 }, env: { SHELL: "/bin/zsh", ZDOTDIR: zdotdir } });
  try {
    let shell = await shellReady(app);
    const terminal = await newTerminal(shell);
    await run(shell, terminal.id, "echo before-the-loss", /^before-the-loss$/mu);
    // The shell's parent is the terminal host: it goes, every shell with it.
    await shell.keyboard.type("kill -9 $PPID");
    await shell.keyboard.press("Enter");
    await expect.poll(() => probe(shell, "status", terminal.id), { timeout: 10_000 }).toBe("gone");
    await shell.keyboard.press("Enter");
    await expect.poll(() => probe(shell, "status", terminal.id), { timeout: 15_000 }).toBe("running");
    await run(shell, terminal.id, "echo after-the-loss", /^after-the-loss$/mu);
    const drawn = (await textOf(shell, terminal.id)).replace(/\s+$/u, "");
    expect(drawn).not.toContain("before-the-loss");
    await shell.reload();
    shell = await shellReady(app);
    await expect.poll(async () => (await textOf(shell, terminal.id)).replace(/\s+$/u, ""), { timeout: 15_000 }).toBe(drawn);
  } finally {
    await app.close();
  }
});
