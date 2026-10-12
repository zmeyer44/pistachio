/**
 * What a terminal's shell starts as (docs/terminal.md §4): which program,
 * with which arguments, in which environment. Pure, so it is tested
 * without a shell.
 *
 * The environment is the app's own — what launchd gave it, or the terminal
 * `pnpm dev` ran in — less what is the app's alone (Electron's switches,
 * the workspace's .env, the package manager's script variables) and what
 * belongs to ANOTHER terminal (a tmux the app was started inside, iTerm's
 * session id): a shell that inherited those would think it was somewhere it
 * is not. To that it adds what a terminal says of itself.
 */

import { basename, join } from "node:path";

/** The shell integration's files, as `installShellIntegration` wrote them. */
export interface ShellIntegrationPaths {
  /** zsh reads `.zshenv` from here first (ZDOTDIR). */
  zshDir: string;
  /** What that `.zshenv` sources for an interactive shell. */
  zshScript: string;
  /** bash's startup file (`--init-file`). */
  bashScript: string;
  /** Put first in XDG_DATA_DIRS: fish reads `fish/vendor_conf.d/*.fish` from it. */
  fishDataDir: string;
}

export interface ShellLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/** Keys taken out whatever their value: the app's own, and other terminals'. */
const DROPPED_PREFIXES = [
  "ELECTRON_",
  "npm_",
  "PNPM_",
  "PISTACHIO_",
  "VITE_",
  "VSCODE_",
  "ITERM_",
  "GHOSTTY_",
  "KITTY_",
  "WEZTERM_",
  "ALACRITTY_",
  "WARP_",
];
const DROPPED_KEYS = new Set([
  "NODE_OPTIONS",
  "INIT_CWD",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "TERMINAL_EMULATOR",
  "TERMINFO",
  "COLORTERM",
  "COLORFGBG",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOWID",
  "SHLVL",
  "PWD",
  "OLDPWD",
  "_",
  "__CFBundleIdentifier",
  "XPC_SERVICE_NAME",
  "XPC_FLAGS",
]);

/**
 * The app's environment as a shell may inherit it. `omit`: keys the app put
 * there itself (the workspace's .env, loadWorkspaceEnvironment).
 */
export function inheritedEnvironment(base: NodeJS.ProcessEnv, omit: ReadonlySet<string> = new Set()): Record<string, string> {
  const env: Record<string, string> = {};
  // Run through a package script (`pnpm dev`): NODE_ENV is the script's, not the person's.
  const scripted = base["npm_lifecycle_event"] !== undefined;
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || omit.has(key) || DROPPED_KEYS.has(key)) continue;
    if (DROPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (scripted && key === "NODE_ENV") continue;
    env[key] = value;
  }
  return env;
}

/** The shells the integration knows, by the program's name. */
export type ShellKind = "zsh" | "bash" | "fish" | "other";

export function shellKind(file: string): ShellKind {
  const name = basename(file).replace(/^-/u, "");
  return name === "zsh" || name === "bash" || name === "fish" ? name : "other";
}

/** Shells that take `-l` to start as a login shell, as Terminal.app starts them. */
const LOGIN_FLAG = new Set(["zsh", "fish", "sh", "ksh", "mksh", "dash", "tcsh", "csh", "nu", "xonsh"]);

/**
 * How to start `shell` as a terminal's: a login shell (so a Mac app opened
 * from the Finder still gets the person's PATH — /etc/zprofile's
 * path_helper and their own profile), with Pistachio's integration where
 * the shell is one it knows.
 */
export function shellLaunch(shell: string, inherited: Record<string, string>, options: { appVersion: string; locale: string; integration: ShellIntegrationPaths | null }): ShellLaunch {
  const env: Record<string, string> = {
    ...inherited,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "Pistachio",
    TERM_PROGRAM_VERSION: options.appVersion,
  };
  // A Mac app is given no locale: without one, a shell treats every byte past ASCII as a stranger (`ls` prints `?`).
  if (env["LANG"] === undefined && env["LC_ALL"] === undefined && env["LC_CTYPE"] === undefined) env["LANG"] = `${utf8Locale(options.locale)}.UTF-8`;
  const kind = shellKind(shell);
  const name = basename(shell);
  const integration = options.integration;
  if (kind === "zsh") {
    if (integration !== null) {
      // zsh reads $ZDOTDIR/.zshenv first; ours puts the person's ZDOTDIR back before anything of theirs is read.
      if (env["ZDOTDIR"] !== undefined) env["PISTACHIO_USER_ZDOTDIR"] = env["ZDOTDIR"];
      env["ZDOTDIR"] = integration.zshDir;
      env["PISTACHIO_SHELL_INTEGRATION"] = integration.zshScript;
    }
    return { file: shell, args: ["-l"], env };
  }
  if (kind === "bash") {
    // A login bash reads no startup file but its profiles; the integration's file reads those itself, then hooks in.
    if (integration !== null) return { file: shell, args: ["--init-file", integration.bashScript], env };
    return { file: shell, args: ["-l"], env };
  }
  if (kind === "fish") {
    if (integration !== null) {
      // (XDG's default when it is unset, kept after ours: fish's own vendor files are there.)
      const rest = env["XDG_DATA_DIRS"] ?? "/usr/local/share:/usr/share";
      env["XDG_DATA_DIRS"] = `${integration.fishDataDir}:${rest}`;
      env["PISTACHIO_FISH_DATA"] = integration.fishDataDir;
    }
    return { file: shell, args: ["-l"], env };
  }
  return { file: shell, args: LOGIN_FLAG.has(name) ? ["-l"] : [], env };
}

/** `en-US` (Intl's spelling) as `en_US` (a POSIX locale's); `en_US` for anything that is not a language and region. */
export function utf8Locale(locale: string): string {
  const match = /^([a-z]{2,3})[-_]([A-Za-z]{2})\b/u.exec(locale);
  return match === null ? "en_US" : `${match[1]!}_${match[2]!.toUpperCase()}`;
}

/** Where a shell's integration files go under the terminal's folder. */
export function shellIntegrationPaths(dir: string): ShellIntegrationPaths {
  return {
    zshDir: join(dir, "zsh"),
    zshScript: join(dir, "zsh", "pistachio.zsh"),
    bashScript: join(dir, "bash", "pistachio.bash"),
    fishDataDir: join(dir, "fish-data"),
  };
}
