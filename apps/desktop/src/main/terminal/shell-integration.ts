/**
 * Pistachio's shell integration (docs/terminal.md §4): small scripts each
 * known shell runs as it starts, so that it tells the terminal where it is
 * (OSC 7: a new terminal opens there, a reopened one comes back there),
 * where each prompt and command begins and ends (OSC 133: ⌘↑ and ⌘↓ jump
 * between prompts, a long command's end is said), and what to call the
 * tab (OSC 2: the folder at a prompt, the command while it runs).
 *
 * A shell cannot read a file inside the app's archive, so the host writes
 * these into the app's data folder as it starts (installShellIntegration),
 * and only when they changed.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { shellIntegrationPaths, type ShellIntegrationPaths } from "./environment";

/**
 * zsh reads `$ZDOTDIR/.zshenv` before anything else; the terminal points
 * ZDOTDIR here only for that. This puts the person's ZDOTDIR back first, so
 * everything zsh reads after it — their .zshenv, .zprofile, .zshrc — is
 * theirs, from where it always was.
 */
const ZSHENV = `# Pistachio's terminal pointed ZDOTDIR here only so zsh would read this first
# (docs/terminal.md §4). Put the person's ZDOTDIR back, read their own .zshenv,
# and give an interactive shell Pistachio's integration.
if [[ -n "\${PISTACHIO_USER_ZDOTDIR-}" ]]; then
  builtin export ZDOTDIR="$PISTACHIO_USER_ZDOTDIR"
else
  builtin unset ZDOTDIR
fi
builtin unset PISTACHIO_USER_ZDOTDIR
{
  [[ -r "\${ZDOTDIR:-$HOME}/.zshenv" ]] && builtin source -- "\${ZDOTDIR:-$HOME}/.zshenv"
} always {
  if [[ -o interactive && -n "\${PISTACHIO_SHELL_INTEGRATION-}" && -r "$PISTACHIO_SHELL_INTEGRATION" ]]; then
    builtin source -- "$PISTACHIO_SHELL_INTEGRATION"
  fi
  builtin unset PISTACHIO_SHELL_INTEGRATION
}
`;

const ZSH = `# Pistachio's shell integration for zsh (docs/terminal.md §4): where the shell is
# (OSC 7), where prompts and commands begin and end (OSC 133), and the tab's
# name — the folder at a prompt, the command while it runs (OSC 2).
[[ -n "\${_pistachio_integrated-}" ]] && return
typeset -g _pistachio_integrated=1
typeset -g _pistachio_running=

_pistachio_cwd() {
  local url_path='' i ch hexch
  {
    local LC_CTYPE=C LC_COLLATE=C LC_ALL= LANG=
    for ((i = 1; i <= \${#PWD}; ++i)); do
      ch="$PWD[i]"
      if [[ "$ch" =~ [/._~A-Za-z0-9-] ]]; then
        url_path+="$ch"
      else
        builtin printf -v hexch "%02X" "'$ch"
        url_path+="%\${hexch:(-2)}"
      fi
    done
  }
  builtin printf '\\e]7;file://%s%s\\a' "$HOST" "$url_path"
}

_pistachio_title() {
  local title="\${1//[[:cntrl:]]/}"
  builtin printf '\\e]2;%s\\a' "\${title[1,200]}"
}

_pistachio_precmd() {
  local ret=$?
  [[ -n "$_pistachio_running" ]] && builtin printf '\\e]133;D;%s\\a' "$ret"
  _pistachio_running=
  _pistachio_cwd
  _pistachio_title "\${(%):-%~}"
  builtin printf '\\e]133;A\\a'
}

_pistachio_preexec() {
  _pistachio_running=1
  _pistachio_title "$1"
  builtin printf '\\e]133;C\\a'
}

builtin autoload -Uz add-zsh-hook
add-zsh-hook precmd _pistachio_precmd
add-zsh-hook preexec _pistachio_preexec
`;

/**
 * bash is started with this as its startup file (\`--init-file\`): a login
 * bash would read its profiles and nothing else of ours, so this reads what
 * a login bash reads — /etc/profile, then the first of the person's
 * profiles — and then hooks in. Written for macOS's bash 3.2.
 */
const BASH = `# Pistachio's terminal starts bash with this as its startup file
# (docs/terminal.md §4): read what a login shell reads, then hook in.
if [ -z "\${PISTACHIO_BASH_LOADED-}" ]; then
  PISTACHIO_BASH_LOADED=1
  [ -r /etc/profile ] && . /etc/profile
  if [ -r "$HOME/.bash_profile" ]; then
    . "$HOME/.bash_profile"
  elif [ -r "$HOME/.bash_login" ]; then
    . "$HOME/.bash_login"
  elif [ -r "$HOME/.profile" ]; then
    . "$HOME/.profile"
  fi
fi

__pistachio_cwd() {
  # Byte by byte (C), each byte past the safe ones percent-encoded: by its value, since bash 3.2's
  # bracket ranges take the lead byte of a UTF-8 letter for a letter.
  local url_path='' i ch code LC_CTYPE=C LC_ALL=C
  for ((i = 0; i < \${#PWD}; ++i)); do
    ch="\${PWD:i:1}"
    printf -v code '%d' "'$ch"
    ((code < 0)) && code=$((code + 256))
    if ((code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code == 45 || code == 46 || code == 47 || code == 95 || code == 126)); then
      url_path+="$ch"
    else
      printf -v ch '%%%02X' "$code"
      url_path+="$ch"
    fi
  done
  printf '\\e]7;file://%s%s\\a' "$HOSTNAME" "$url_path"
}

__pistachio_prompt() {
  local ret=$?
  __pistachio_cwd
  printf '\\e]2;%s\\a' "\${PWD/#$HOME/~}"
  printf '\\e]133;A\\a'
  return $ret
}

case ";\${PROMPT_COMMAND-};" in
  *";__pistachio_prompt;"*) ;;
  *) PROMPT_COMMAND="__pistachio_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
`;

/**
 * fish reads every \`vendor_conf.d\` under XDG_DATA_DIRS; the terminal puts
 * this folder first there only for that, and this takes it out again.
 */
const FISH = `# Pistachio's shell integration for fish (docs/terminal.md §4).
if set -q PISTACHIO_FISH_DATA
    set -l rest (string match --invert -- $PISTACHIO_FISH_DATA (string split : -- "$XDG_DATA_DIRS"))
    set -gx XDG_DATA_DIRS (string join : -- $rest)
    set -e PISTACHIO_FISH_DATA
end

if status is-interactive
    function __pistachio_cwd --on-variable PWD
        printf '\\e]7;file://%s%s\\a' $hostname (string escape --style=url -- $PWD)
    end
    function __pistachio_prompt --on-event fish_prompt
        printf '\\e]133;A\\a'
    end
    function __pistachio_preexec --on-event fish_preexec
        printf '\\e]133;C\\a'
    end
    function __pistachio_postexec --on-event fish_postexec
        printf '\\e]133;D;%s\\a' $status
    end
    __pistachio_cwd
end
`;

/** Each file the integration writes, by its path under the integration's folder. */
export function shellIntegrationFiles(paths: ShellIntegrationPaths): ReadonlyArray<{ path: string; content: string }> {
  return [
    { path: join(paths.zshDir, ".zshenv"), content: ZSHENV },
    { path: paths.zshScript, content: ZSH },
    { path: paths.bashScript, content: BASH },
    { path: join(paths.fishDataDir, "fish", "vendor_conf.d", "pistachio.fish"), content: FISH },
  ];
}

/** Write the integration under `dir` (only what changed), and say where it is; null when it could not be written. */
export async function installShellIntegration(dir: string): Promise<ShellIntegrationPaths | null> {
  const paths = shellIntegrationPaths(dir);
  try {
    for (const file of shellIntegrationFiles(paths)) {
      const current = await readFile(file.path, "utf8").catch(() => null);
      if (current === file.content) continue;
      await mkdir(dirname(file.path), { recursive: true });
      // (Whole or not at all: a shell starting meanwhile reads the old file or the new one, never half.)
      const temporary = `${file.path}.${String(process.pid)}.tmp`;
      await writeFile(temporary, file.content, { mode: 0o644 });
      await rename(temporary, file.path);
    }
    return paths;
  } catch {
    return null;
  }
}
