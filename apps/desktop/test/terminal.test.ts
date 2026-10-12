import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cwdFromOsc7 } from "@pistachio/shell-contracts/terminal";
import { inheritedEnvironment, shellKind, shellLaunch, utf8Locale, type ShellIntegrationPaths } from "../src/main/terminal/environment";
import { installShellIntegration, shellIntegrationFiles } from "../src/main/terminal/shell-integration";

const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");

describe("a terminal's environment", () => {
  it("is the app's, less the app's own and another terminal's", () => {
    const env = inheritedEnvironment(
      {
        HOME: "/Users/ada",
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/zsh",
        LANG: "en_GB.UTF-8",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--inspect",
        npm_config_prefix: "/opt/npm",
        npm_lifecycle_event: "dev",
        NODE_ENV: "development",
        PISTACHIO_E2E: "1",
        TMUX: "/tmp/tmux-501/default,1,0",
        TERM_PROGRAM: "ghostty",
        GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app",
        ITERM_SESSION_ID: "w0t0p0",
        SHLVL: "3",
        PWD: "/Users/ada/pistachio",
        OPENAI_API_KEY: "sk-workspace",
      },
      new Set(["OPENAI_API_KEY"]),
    );
    expect(env).toEqual({ HOME: "/Users/ada", PATH: "/usr/bin:/bin", SHELL: "/bin/zsh", LANG: "en_GB.UTF-8" });
  });

  it("keeps the person's NODE_ENV when the app was not started by a package script", () => {
    expect(inheritedEnvironment({ NODE_ENV: "production" })).toEqual({ NODE_ENV: "production" });
  });

  it("says what the terminal is, and gives a shell with no locale one", () => {
    const launch = shellLaunch("/bin/sh", { HOME: "/Users/ada" }, { appVersion: "1.2.3", locale: "fr-CA", integration: null });
    expect(launch).toEqual({
      file: "/bin/sh",
      args: ["-l"],
      env: { HOME: "/Users/ada", TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Pistachio", TERM_PROGRAM_VERSION: "1.2.3", LANG: "fr_CA.UTF-8" },
    });
    expect(shellLaunch("/bin/sh", { LC_ALL: "C" }, { appVersion: "1", locale: "en-US", integration: null }).env["LANG"]).toBeUndefined();
    expect(utf8Locale("en")).toBe("en_US");
    expect(utf8Locale("pt_br")).toBe("pt_BR");
  });

  it("starts each known shell with the integration, keeping the person's own ZDOTDIR and XDG_DATA_DIRS", () => {
    const integration: ShellIntegrationPaths = { zshDir: "/i/zsh", zshScript: "/i/zsh/pistachio.zsh", bashScript: "/i/bash/pistachio.bash", fishDataDir: "/i/fish-data" };
    const options = { appVersion: "1", locale: "en-US", integration };
    const zsh = shellLaunch("/bin/zsh", { ZDOTDIR: "/Users/ada/.config/zsh" }, options);
    expect(zsh.args).toEqual(["-l"]);
    expect(zsh.env).toMatchObject({ ZDOTDIR: "/i/zsh", PISTACHIO_USER_ZDOTDIR: "/Users/ada/.config/zsh", PISTACHIO_SHELL_INTEGRATION: "/i/zsh/pistachio.zsh" });
    expect(shellLaunch("/bin/zsh", {}, options).env["PISTACHIO_USER_ZDOTDIR"]).toBeUndefined();
    expect(shellLaunch("/bin/bash", {}, options).args).toEqual(["--init-file", "/i/bash/pistachio.bash"]);
    const fish = shellLaunch("/opt/homebrew/bin/fish", { XDG_DATA_DIRS: "/opt/share" }, options);
    expect(fish.env).toMatchObject({ XDG_DATA_DIRS: "/i/fish-data:/opt/share", PISTACHIO_FISH_DATA: "/i/fish-data" });
    expect(shellLaunch("/opt/homebrew/bin/nu", {}, options).args).toEqual(["-l"]);
    expect(shellLaunch("/opt/homebrew/bin/elvish", {}, options).args).toEqual([]);
    expect(shellKind("-zsh")).toBe("zsh");
  });
});

describe("the shell integration", () => {
  it("is written once, and again only when it changed", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "pistachio-integration-")), "shell-integration");
    const paths = await installShellIntegration(dir);
    expect(paths).not.toBeNull();
    for (const file of shellIntegrationFiles(paths!)) expect(await readFile(file.path, "utf8")).toBe(file.content);
    await writeFile(paths!.zshScript, "stale");
    await installShellIntegration(dir);
    expect(await readFile(paths!.zshScript, "utf8")).not.toBe("stale");
  });

  /** A shell started as the terminal starts it, with `typed` typed into it: everything it printed. */
  async function session(shell: string, typed: string[], env: Record<string, string>): Promise<string> {
    const dir = join(await mkdtemp(join(tmpdir(), "pistachio-integration-")), "shell-integration");
    const integration = await installShellIntegration(dir);
    const launch = shellLaunch(shell, { HOME: env["HOME"]!, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...env }, { appVersion: "test", locale: "en-US", integration });
    const child = pty.spawn(launch.file, launch.args, { name: "xterm-256color", cols: 100, rows: 30, cwd: env["HOME"]!, env: launch.env });
    let output = "";
    child.onData((data) => {
      output += data;
    });
    const waitFor = async (pattern: RegExp): Promise<void> => {
      const until = Date.now() + 10_000;
      while (!pattern.test(output)) {
        if (Date.now() > until) throw new Error(`timed out waiting for ${String(pattern)} in ${JSON.stringify(output)}`);
        await new Promise((done) => setTimeout(done, 25));
      }
    };
    try {
      // (Each line once the prompt before it is up: the integration's prompt mark says so.)
      let prompts = 0;
      for (const line of typed) {
        await waitFor(new RegExp(`(?:\\x1b\\]133;A\\x07[^]*){${String(prompts + 1)}}`, "u"));
        prompts += 1;
        child.write(`${line}\r`);
      }
      await waitFor(new RegExp(`(?:\\x1b\\]133;A\\x07[^]*){${String(prompts + 1)}}`, "u"));
      return output;
    } finally {
      child.kill();
    }
  }

  // eslint-disable-next-line no-control-regex
  const reports = (output: string): string[] => [...output.matchAll(/\x1b\]7;([^\x07]*)\x07/gu)].map((match) => cwdFromOsc7(match[1]!) ?? "");
  // eslint-disable-next-line no-control-regex
  const titles = (output: string): string[] => [...output.matchAll(/\x1b\]2;([^\x07]*)\x07/gu)].map((match) => match[1]!);

  it("has zsh say where it is, name the tab, and mark each command's end — reading the person's own files", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "pistachio-home-")));
    const zdotdir = join(home, "zdot");
    await (await import("node:fs/promises")).mkdir(join(zdotdir, "My Café"), { recursive: true });
    await writeFile(join(zdotdir, ".zshenv"), "export FROM_ZSHENV=yes\n");
    await writeFile(join(zdotdir, ".zshrc"), "export FROM_ZSHRC=yes\n");
    const output = await session("/bin/zsh", ['cd "$ZDOTDIR/My Café"', 'echo "[$FROM_ZSHENV|$FROM_ZSHRC|$ZDOTDIR]"', "false"], { HOME: home, ZDOTDIR: zdotdir });
    expect(output).toContain(`[yes|yes|${zdotdir}]`);
    expect(reports(output)).toContain(join(zdotdir, "My Café"));
    expect(titles(output)).toContain('cd "$ZDOTDIR/My Café"');
    expect(titles(output)).toContain("~/zdot/My Café");
    // `false` ran (C) and ended with status 1 (D).
    // eslint-disable-next-line no-control-regex
    expect(output).toMatch(/\x1b\]133;C\x07[^]*\x1b\]133;D;1\x07/u);
  }, 30_000);

  it("has bash read what a login bash reads, then say where it is", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "pistachio-home-")));
    await writeFile(join(home, ".bash_profile"), "export FROM_PROFILE=yes\n");
    await (await import("node:fs/promises")).mkdir(join(home, "café"));
    const output = await session("/bin/bash", ["cd café", 'echo "[$FROM_PROFILE]"'], { HOME: home, BASH_SILENCE_DEPRECATION_WARNING: "1" });
    expect(output).toContain("[yes]");
    expect(reports(output)).toContain(join(home, "café"));
    expect(titles(output)).toContain("~/café");
  }, 30_000);
});
