/**
 * `/` commands in the Bar (docs/desk-agent.md, *Commands*): typed at the head
 * of a message, a short name stands for something the Bar does itself — a
 * search in a new tab, a fact saved to the space — or for a request to
 * Pistachio put the way it reads best. Pure, so the Bar's tests pin when the
 * menu is up, what it offers for what was typed, how a message reads as a
 * command, and what each request says; the Bar runs them
 * (components/desk/DeskBar.tsx, `runCommand`).
 */

import { extensionBarCommandId, type ExtensionInfo } from "@pistachio/shell-contracts/extensions";
import { webSearchLabel, type WebSearchProvider } from "@pistachio/shell-contracts/search";

/** The Bar's own commands. */
export type BuiltinBarCommandId =
  | "search"
  | "open"
  | "find"
  | "summarize"
  | "compare"
  | "explain"
  | "translate"
  | "research"
  | "new"
  | "arrange"
  | "tidy"
  | "remember"
  | "screenshot"
  | "share"
  | "draw"
  | "note"
  | "brief"
  | "terminal"
  | "extension";

/**
 * A command an extension declared (docs/extensions.md §2, *Say them*):
 * `ext:<extension id>:<command>` (extensionBarCommandId), or — for a Chrome
 * extension on the Ledge, which declares none — `ext:<id>:@action`, its action.
 */
export type ExtensionBarCommandId = `ext:${string}`;

export type BarCommandId = BuiltinBarCommandId | ExtensionBarCommandId;

export type BarCommandGroup = "Browse" | "Ask Pistachio" | "Desk" | "Open" | "Extensions" | "Make";

/** The groups in the menu's order, as an empty `/` lists them. */
export const BAR_COMMAND_GROUPS: readonly BarCommandGroup[] = ["Browse", "Ask Pistachio", "Desk", "Open", "Extensions", "Make"];

/** What an extension's row runs: its declared command (main relays it, a prompt or an event), or a Chrome extension's action. */
export interface BarCommandExtension {
  id: string;
  name: string;
  iconUrl: string | null;
  /** The declared command's name; for an action, `@action`. */
  command: string;
  action: boolean;
}

/** The Chrome action's command name in an `ext:` id. */
export const EXTENSION_ACTION_COMMAND = "@action";

export interface BarCommand {
  id: BarCommandId;
  /** What follows the slash. */
  name: string;
  /** Other names it answers to when typed in full or begun: `/google` is `/search`. */
  aliases: readonly string[];
  /** Other words it is found by, past its name and what it does. */
  keywords: readonly string[];
  /** What it does, in its row ("{engine}": the person's web search engine). */
  description: string;
  group: BarCommandGroup;
  /** What it takes after its name, drawn in the field until something is typed; a `required` one waits for it. */
  arg: { hint: string; required: boolean } | null;
  /** A request to Pistachio (`commandPrompt`), or something the Bar does itself. */
  kind: "prompt" | "action";
  /** An extension's: whose, and what it runs (main runs it: `barCommand`, or the action's `activate`). */
  extension?: BarCommandExtension;
}

export const BAR_COMMANDS: readonly BarCommand[] = [
  {
    id: "search",
    name: "search",
    aliases: ["google", "web"],
    keywords: ["look up", "query", "bing", "duckduckgo"],
    description: "Search {engine} in a new tab",
    group: "Browse",
    arg: { hint: "what to search for", required: true },
    kind: "action",
  },
  {
    id: "open",
    name: "open",
    aliases: ["go", "visit"],
    keywords: ["url", "address", "site", "link", "tab"],
    description: "Open a site in a new tab",
    group: "Browse",
    arg: { hint: "an address, like nytimes.com", required: true },
    kind: "action",
  },
  {
    id: "find",
    name: "find",
    aliases: ["locate"],
    keywords: ["page", "where", "meaning", "highlight"],
    description: "Find something in the window you're using",
    group: "Browse",
    arg: { hint: "what to look for", required: true },
    kind: "action",
  },
  {
    id: "summarize",
    name: "summarize",
    aliases: ["tldr", "summary"],
    keywords: ["gist", "digest", "short", "recap"],
    description: "Summarize the window you're using",
    group: "Ask Pistachio",
    arg: { hint: "what to focus on (optional)", required: false },
    kind: "prompt",
  },
  {
    id: "compare",
    name: "compare",
    aliases: ["vs"],
    keywords: ["difference", "versus", "table", "side by side", "options"],
    description: "Compare the pages on this desk in a table",
    group: "Ask Pistachio",
    arg: { hint: "what to compare them on (optional)", required: false },
    kind: "prompt",
  },
  {
    id: "explain",
    name: "explain",
    aliases: ["eli5"],
    keywords: ["simple", "plain", "understand", "meaning"],
    description: "Explain the window you're using in plain words",
    group: "Ask Pistachio",
    arg: { hint: "a term or passage (optional)", required: false },
    kind: "prompt",
  },
  {
    id: "translate",
    name: "translate",
    aliases: [],
    keywords: ["language", "english", "spanish", "french", "german", "japanese"],
    description: "Translate the window you're using",
    group: "Ask Pistachio",
    arg: { hint: "into which language", required: true },
    kind: "prompt",
  },
  {
    id: "research",
    name: "research",
    aliases: ["dig"],
    keywords: ["investigate", "sources", "background", "deep", "look into"],
    description: "Look into something across several sources",
    group: "Ask Pistachio",
    arg: { hint: "a topic or question", required: true },
    kind: "prompt",
  },
  {
    id: "new",
    name: "new",
    aliases: ["clear", "reset"],
    keywords: ["conversation", "chat", "fresh", "start over"],
    description: "Start a new conversation",
    group: "Ask Pistachio",
    arg: null,
    kind: "action",
  },
  {
    id: "arrange",
    name: "arrange",
    aliases: ["layout", "tile"],
    keywords: ["windows", "organize", "split", "side by side", "cascade"],
    description: "Arrange the windows on this desk",
    group: "Desk",
    arg: { hint: "how (optional), like mail on the left", required: false },
    kind: "action",
  },
  {
    id: "tidy",
    name: "tidy",
    aliases: ["cleanup"],
    keywords: ["tabs", "archive", "declutter", "close", "put away"],
    description: "Put away tabs you're done with",
    group: "Desk",
    arg: null,
    kind: "action",
  },
  {
    id: "remember",
    name: "remember",
    aliases: ["fact"],
    keywords: ["save", "context", "keep", "stack", "memo"],
    description: "Save a fact to this space's context",
    group: "Desk",
    arg: { hint: "the fact to keep", required: true },
    kind: "action",
  },
  {
    id: "screenshot",
    name: "screenshot",
    aliases: ["capture"],
    keywords: ["picture", "image", "snap", "clipboard", "grab"],
    description: "Take a screenshot of the desk",
    group: "Desk",
    arg: null,
    kind: "action",
  },
  {
    // (docs/live-share.md §1: shared already, it shows the Live card.)
    id: "share",
    name: "share",
    aliases: ["live"],
    keywords: ["invite", "guests", "call", "pair", "together", "collaborate"],
    description: "Share this space live with a link",
    group: "Desk",
    arg: null,
    kind: "action",
  },
  {
    id: "draw",
    name: "draw",
    aliases: ["pen", "ink"],
    keywords: ["annotate", "highlighter", "laser", "sketch", "mark up"],
    description: "Draw over the desk while it's shared live",
    group: "Desk",
    arg: null,
    kind: "action",
  },
  {
    id: "note",
    name: "note",
    aliases: ["notes"],
    keywords: ["write", "jot", "document", "new note"],
    description: "Start a note",
    group: "Open",
    arg: { hint: "a title (optional)", required: false },
    kind: "action",
  },
  {
    id: "brief",
    name: "brief",
    aliases: ["today"],
    keywords: ["daily", "morning", "news", "schedule", "report"],
    description: "Open today's brief",
    group: "Open",
    arg: null,
    kind: "action",
  },
  {
    id: "terminal",
    name: "terminal",
    aliases: ["term", "shell"],
    keywords: ["command line", "console", "zsh", "bash"],
    description: "Open a terminal",
    group: "Open",
    arg: null,
    kind: "action",
  },
  {
    // (docs/extensions.md §8: a draft folder in the dev folder, then the wish to Pistachio, who writes it there; it
    // lands paused, for the person's approval.)
    id: "extension",
    name: "extension",
    aliases: ["ext"],
    keywords: ["make", "build", "create", "add-on", "plugin", "wish"],
    description: "Make an extension with Pistachio",
    group: "Make",
    arg: { hint: "what it should do", required: true },
    kind: "action",
  },
];

/** A Chrome extension's name as a command word: `/dark-reader`. */
export function commandWord(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
}

/**
 * The rows the extensions add (docs/extensions.md §2): each declared Bar
 * command of an extension on in this Profile and not waiting on the person,
 * with its hint; and each Chrome extension on the Ledge with an action, as
 * `/<name>` (its action, as the icon's click). In the extensions' order.
 */
export function extensionBarCommands(extensions: readonly ExtensionInfo[]): BarCommand[] {
  const rows: BarCommand[] = [];
  // The words taken: the Bar's own commands and their aliases, then each row as it is added — a word names one command.
  const taken = new Set(BAR_COMMANDS.flatMap((command) => [command.name, ...command.aliases]));
  const wordFor = (extensionId: string, declared: string): string => {
    if (!taken.has(declared)) return declared;
    // A name a built-in (or another extension) holds completes and runs as /<its id's last segment>-<name> (docs §12);
    // a Chrome extension's id has no segments, and its first eight letters stand in.
    const segment = commandWord(extensionId.includes(".") ? extensionId.split(".").pop()! : extensionId.slice(0, 8)) || "ext";
    let word = `${segment}-${declared}`;
    for (let n = 2; taken.has(word); n++) word = `${segment}-${declared}-${String(n)}`;
    return word;
  };
  for (const extension of extensions) {
    if (!extension.enabled || !extension.enabledHere || extension.pending !== null) continue;
    if (extension.status === "needs-approval" || extension.status === "paused" || extension.status === "incompatible" || extension.status === "off") continue;
    const owner = { id: extension.id, name: extension.name, iconUrl: extension.iconUrl };
    for (const declared of extension.barCommands) {
      const name = declared.name.replace(/^\//u, "").trim();
      if (name === "" || /\s/u.test(name)) continue;
      const word = wordFor(extension.id, name);
      taken.add(word);
      rows.push({
        id: extensionBarCommandId(extension.id, name),
        name: word,
        aliases: [],
        keywords: [extension.name],
        description: declared.description,
        group: "Extensions",
        arg: declared.arg,
        kind: "action",
        extension: { ...owner, command: name, action: false },
      });
    }
    if (extension.kind === "chrome" && extension.pinned && extension.hasAction) {
      const name = commandWord(extension.name);
      if (name === "") continue;
      const word = wordFor(extension.id, name);
      taken.add(word);
      rows.push({
        id: extensionBarCommandId(extension.id, EXTENSION_ACTION_COMMAND),
        name: word,
        aliases: [],
        keywords: [],
        description: `Open ${extension.name}`,
        group: "Extensions",
        arg: null,
        kind: "action",
        extension: { ...owner, command: EXTENSION_ACTION_COMMAND, action: true },
      });
    }
  }
  return rows;
}

/** The whole catalog with the extensions' rows after the Bar's own (whose names win a clash: a clashing row completes as /<segment>-<name>). */
export function barCommandsFor(extensions: readonly ExtensionInfo[]): readonly BarCommand[] {
  const rows = extensionBarCommands(extensions);
  return rows.length === 0 ? BAR_COMMANDS : [...BAR_COMMANDS, ...rows];
}

/** The draft folder's name for a wish (`draftFolder`): its first words, as a slug. */
export function extensionDraftName(wish: string): string {
  const words = wish
    .toLowerCase()
    .normalize("NFKD")
    .replace(/^(?:an? |the |that |to |which )/u, "")
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)
    .slice(0, 5);
  const slug = words.join("-").slice(0, 40).replace(/-+$/u, "");
  return slug === "" ? "my-extension" : slug;
}

/**
 * What `/extension <wish>` asks Pistachio (docs/extensions.md §8), put as a
 * person would ask it, with the draft folder when main made one. With the
 * draft's `author` (its slug and the one-time token `draftFolder` answered),
 * the first line is the marker main reads and strips: that turn is the author
 * turn, with the draft tools alone (run-controller's #authorMarker).
 */
export function extensionPrompt(wish: string, folder: string | null, author: { slug: string; token: string } | null = null): string {
  let what = wish.trim().replace(/[.!\s]+$/u, "");
  what = what.replace(/^(?:that|which|to)\s+/iu, "");
  const ask = /^(?:an?|the)\s/iu.test(what) ? `Build a Pistachio extension: ${what}.` : `Build a Pistachio extension that ${what}.`;
  const said = folder === null ? ask : `${ask} Write it in ${folder}.`;
  return author === null ? said : `[pistachio:extension-author slug=${author.slug} token=${author.token}]\n${said}`;
}

/** What the person's settings put into a row: the engine `/search` uses. */
export interface CommandSettings {
  webProvider: WebSearchProvider;
}

/** A command's row text, its engine named. */
export function commandDescription(command: BarCommand, settings: CommandSettings): string {
  return command.description.replace("{engine}", webSearchLabel(settings.webProvider));
}

function byName(name: string, commands: readonly BarCommand[]): BarCommand | null {
  const typed = name.toLowerCase();
  return commands.find((command) => command.name === typed || command.aliases.includes(typed)) ?? null;
}

/**
 * The command being typed, if one is: the field starts with `/`, and the
 * caret is still in its first word. (Past it — a space typed after the name
 * — the person is on to what it takes; the menu has done its job.)
 */
export function commandQuery(text: string, caret: number): { query: string; end: number } | null {
  if (!text.startsWith("/")) return null;
  const before = text.slice(0, caret);
  if (!/^\/\S*$/.test(before)) return null;
  const word = /^\/\S*/.exec(text)?.[0] ?? "/";
  return { query: before.slice(1), end: word.length };
}

/**
 * What `/query` offers, best first. Nothing typed is the whole catalog in its
 * order (the menu groups it). Typed, names that start so come first, then
 * — from two letters, so `/s` is not every row with an s word — other names
 * that do (`/goo` is `/search`), then rows each typed word begins a word of
 * (`/new tab` is `/open`). Never letters scattered through a row: a menu that
 * offers what was not asked for is not one to press Enter in. `commands` is
 * the catalog (`barCommandsFor`: the Bar's own and the extensions').
 */
export function commandCandidates(query: string, commands: readonly BarCommand[] = BAR_COMMANDS): BarCommand[] {
  const typed = query.trim().toLowerCase();
  if (typed === "") return [...commands];
  const byPrefix = commands.filter((command) => command.name.startsWith(typed));
  if (typed.length < 2) return byPrefix;
  const byAlias = commands.filter((command) => !byPrefix.includes(command) && command.aliases.some((alias) => alias.startsWith(typed)));
  const named = [...byPrefix, ...byAlias];
  const tokens = typed.split(/[\s-]+/).filter(Boolean);
  const byWords = commands.filter((command) => {
    if (named.includes(command)) return false;
    const words = [...command.aliases, ...command.keywords, command.description.replace("{engine}", "web")].flatMap((text) => text.toLowerCase().split(/[^a-z0-9']+/));
    return tokens.every((token) => words.some((word) => word.startsWith(token)));
  });
  return [...named, ...byWords];
}

/** The field with the word being typed as `/name` and a space, and the caret after the space. */
export function insertCommand(text: string, end: number, command: BarCommand): { text: string; caret: number } {
  const after = text.slice(end).replace(/^[^\S\n]+/, "");
  const head = `/${command.name} `;
  return { text: `${head}${after}`, caret: head.length };
}

/** A message read as a command: the one its first word names, and what follows it. Any other `/word` is a message. */
export function parseCommand(text: string, commands: readonly BarCommand[] = BAR_COMMANDS): { command: BarCommand; args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match === null) return null;
  const command = byName(match[1]!, commands);
  return command === null ? null : { command, args: (match[2] ?? "").trim() };
}

/**
 * Where the command is in the field, for the mirror to mark, and the hint to
 * draw after it while nothing follows it yet: a command's word, whole, at
 * the head of the field, followed by a space (or still being typed, by
 * nothing — no hint then).
 */
export function commandSpan(text: string, commands: readonly BarCommand[] = BAR_COMMANDS): { end: number; command: BarCommand; hint: string | null } | null {
  const match = /^\/(\S+)(\s*)/.exec(text);
  if (match === null) return null;
  const command = byName(match[1]!, commands);
  if (command === null) return null;
  const end = 1 + match[1]!.length;
  const spaced = match[2]!.length > 0;
  const bare = text.slice(match[0].length) === "";
  return { end, command, hint: spaced && bare && command.arg !== null ? command.arg.hint : null };
}

/** Whether the field holds a command that waits for what it takes: Enter then does nothing. */
export function commandWaiting(text: string, commands: readonly BarCommand[] = BAR_COMMANDS): boolean {
  const parsed = parseCommand(text, commands);
  return parsed !== null && parsed.command.arg?.required === true && parsed.args === "";
}

/**
 * The message a request to Pistachio sends, put as a person would ask it —
 * so the conversation reads as asked, and is named by it.
 */
export function commandPrompt(id: BarCommandId, args: string): string | null {
  const about = args.trim();
  switch (id) {
    case "summarize":
      return about === "" ? "Summarize the page in the window I'm using." : `Summarize the page in the window I'm using, focusing on ${about}.`;
    case "compare":
      return about === ""
        ? "Compare the pages open on this desk in a table: what each offers, where they differ, and which you'd pick."
        : `Compare the pages open on this desk in a table, on ${about}.`;
    case "explain":
      return about === "" ? "Explain the page in the window I'm using in plain words." : `Explain “${about}” in plain words, as it's meant on the page in the window I'm using.`;
    case "translate":
      return about === "" ? null : `Translate the page in the window I'm using into ${about}.`;
    case "research":
      return about === "" ? null : `Research ${about}. Read several good sources in the background, then give me a short answer with links to them.`;
    case "arrange":
      return about === "" ? null : `Arrange the windows on this desk: ${about}.`;
    default:
      return null;
  }
}
