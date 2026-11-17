# Writing a Pistachio extension

You are writing an extension for **Pistachio**, a desktop browser. An extension is a folder with a
`pistachio.json`; Pistachio loads it as soon as you save, runs it in sandboxed views, and gives it a
global `pistachio` (types: `.pistachio/pistachio.d.ts`). A person approves what it may do — never you.

## 1. The folder

- One folder per extension in `~/Pistachio/Extensions/<folder>/`, with `pistachio.json` at its root.
  `~/Pistachio/Extensions/` also holds this guide, and its `.pistachio/` folder `pistachio.d.ts` and
  `pistachio-extension.schema.json` (so a folder's `../.pistachio/…` reaches them).
- Every file is served read-only at `pistachio-ext://<id>/<path>`. Paths in the manifest are relative,
  never start with `/`, never contain `..`.
- Pistachio writes `.pistachio/` in the folder (`status.json`, `log.ndjson`, `versions/`). Read it;
  never write it. `node_modules/`, `.git/` and dotfiles are ignored.
- Every save reloads the extension (worker restarted, pages reloaded). There is no build step.

## 2. The loop

1. Write or change files.
2. Wait a second, then read `.pistachio/status.json`:
   `{ id, state, loadedAt, api, manifestErrors, pendingGrants, runtimeErrors, surfaces, triggers }`.
3. `manifestErrors` (`[{ path, message }]`): fix `pistachio.json`; each message says what to change.
4. `runtimeErrors` (`[{ context, message, file, line, at }]`): fix that file and line.
5. `pendingGrants` not empty: the extension is paused until the person approves it in Pistachio
   (the amber dot on the Ledge, or the sheet on `pistachio://extensions`). **You cannot approve, and
   must not try to work around it.** Tell the person what it asks for and why.
6. `.pistachio/log.ndjson` has every context's console and `pistachio.runtime.log` lines.
7. If you declared `triggers` (§9): read `triggers` in the status. It is the schedule as Pistachio
   understood it — check it is the one the person asked for before you say you are done.

Asking for less means fewer, quieter approvals: a manifest that widens its permissions pauses the
extension again; one that narrows them applies at once. So does a trigger whose times changed (§9).

## 3. `pistachio.json`

`$schema` lets an editor check it. `id` is reverse-DNS, lowercase (`dev.<you>.<slug>`): keep it stable,
it is the origin and the storage key. `api` is `1`. `version` is semver.

A panel (the Ledge icon opens a side card):

```json
{
  "$schema": "../.pistachio/pistachio-extension.schema.json",
  "api": 1, "id": "dev.example.tab-list", "name": "Tab list", "version": "1.0.0",
  "description": "Lists the tabs of the space you are in; Show brings one forward.",
  "icon": "icon.svg",
  "permissions": ["tabs:read", "tabs:write"],
  "panel": { "file": "panel.html", "width": 320 }
}
```

A Bar command (`/hello` in the Bar wakes the worker) and a page (a desk window):

```json
{
  "api": 1, "id": "dev.example.hello", "name": "Hello", "version": "1.0.0",
  "worker": { "type": "web", "main": "worker.js" },
  "pages": { "hello": { "file": "hello.html", "title": "Hello" } },
  "bar": { "commands": [
    { "name": "hello", "description": "Say hello", "arg": { "hint": "name" }, "run": { "event": true } }
  ] }
}
```

A tool the agent can call:

```json
{
  "api": 1, "id": "dev.example.word-count", "name": "Word count", "version": "1.0.0",
  "permissions": ["agent:tools"],
  "worker": { "type": "web", "main": "worker.js" },
  "tools": [{
    "name": "word_count", "description": "Count the words in a text.", "effect": "read",
    "input": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }
  }]
}
```

The other keys:

- `hosts`: match patterns `net.fetch` and `pages.read` may reach — `"https://api.github.com/*"`.
- `action: true`: no panel; a click on the icon fires `runtime.onAction` in the worker.
- `bar.commands[].run`: `{ "event": true }` runs `bar.onCommand` in the worker; `{ "prompt": "…" }` is a
  request to the agent with `{arg}`, `{page.title}`, `{page.url}`, `{selection}` filled in (no code).
- `contextMenus`: `[{ "id", "title", "contexts": ["page"|"selection"|"link"|"image"|"window"|"tab"|"space"] }]`.
  `"window"` is a desk window's ⋯; `"tab"` is a tab's own menu (a right-click on its row in the sidebar);
  `"space"` is a space's own menu (a right-click on its tile on the rail).
  **When the wish is about "this space", prefer a `space` item** to a Bar command: the person chooses it on
  the space itself, the handler's `info.spaceId` is that space, and the choice gives you the space (§4).
- `commands`: `[{ "id", "title", "key": "Cmd+Shift+Y" }]` — never overrides one of Pistachio's keys.
- `settings`: `[{ "key", "title", "type": "boolean"|"string"|"number"|"enum"|"secret", "default"? }]`,
  shown in Settings → Extensions; read with `pistachio.settings.get(key)`.
- `band: true`, `sidebar: true`: the extension fills a **strip beside the Bar** / a **section of the sidebar**
  with rows (`pistachio.ui.band`, `pistachio.ui.sidebar`). Declared, so the sheet says it adds one. §11.
- `triggers`: when the extension runs **by itself** — each `{ "id", … }` with exactly one of `during`
  (a window of the week), `at` (a time), `every` (an interval) or `when` (a signal: the Mac's power,
  network, displays, idle time, or a calendar event by a phrase of its name). Pistachio keeps the clock,
  reads the signal, and wakes the worker. All of §9.
- Rules the schema enforces: an event command, a tool, a menu item, a key command, a trigger or `action`
  needs a `worker`; `tools` need `"agent:tools"`; a `panel` and `action` exclude each other; names are unique.

## 4. Capabilities

Ask for the fewest. Each has a fixed sentence on the person's approval sheet, broadest first.

| Tier | Capabilities |
| --- | --- |
| None needed | declared surfaces (commands, menus, keys, pages, panel), `storage`, `settings`, `ui`, file dialogs |
| Low | `notifications`, `clipboard:write`, `power`, `spaces:mark`, `tabs:mark` |
| Medium | `tabs:read`, `tabs:write`, `spaces:write`, `spaces:close`, `theme`, `desk`, `files:data`, `notes:read`, `hosts` (each site named) |
| High | `pages:read`, `capture:tab`, `input:events`, `notes:write`, `agent:tools`, `agent:ask`, `ai`, `spaces:all`, `clipboard:read` |
| Critical | `"hosts": ["<all_urls>"]`, or any pattern naming every site (`*://*/*`, `https://*/*`) — don't |

- **Prefer a gesture grant over `pages:read` and `hosts`.** When the person runs your Bar command,
  menu item or key on a tab, or opens your panel from its window, you may `pages.read` that tab
  until it goes to another site — nothing in the manifest.
- **A space is yours once the person runs you in it.** `spaces:write` lets you send spaces away at all,
  `spaces:mark` mark them, `theme` give one a backdrop; *which* space is the one the person ran your Bar
  command, menu item or key in (or opened your panel or pressed your icon in) — the handler's
  `ctx.spaceId` — or the one whose menu they chose your `space` item from (`info.spaceId`). That grant
  is kept for good, so keep the id in `storage.local` and act on it later. A tool call or a message
  grants nothing.
- **`spaces:all` is the exception, and it is High.** With it every drawn space of the Profiles you are
  on in counts as given — for whatever your *other* capabilities let you do to a space (`spaces:write`
  to send away, `spaces:close` to close, `spaces:mark`, `theme`). Ask for it only when the wish is about
  spaces in general ("tidy up the spaces I am not using"); "hide *this* space on weekdays" never needs
  it. The sheet leads with *Acts on any of your spaces, not only the ones you ran it in.*
- **Prefer a `web` worker.** It is the only kind: there is no Node (`require`, `fs`, `process`,
  child processes) in v1, so don't write code that needs it.

## 5. Contexts

| Context | What | Lives |
| --- | --- | --- |
| worker | `worker.main` (`.js` or `.ts`), an ES module in a hidden page | started on first need (a command, a tool call, a menu item, a message, a trigger); stops after 30 min idle — at once after a trigger's handler, when the trigger is what started it |
| panel | `panel.file`, beside the sidebar | while open |
| page | each of `pages`, a desk window (`ui.openPage`) | while open; restored after a restart |

All three share one `pistachio`, one `storage.local` and one origin. Handlers that main calls —
`bar.onCommand`, `agent.onToolCall`, `contextMenus.onClicked`, `commands.onCommand`, `runtime.onAction`,
`triggers.on` — go in the **worker**. Pages and the panel talk to it with `runtime.sendMessage` or `runtime.connect`.

## 6. Rules

- **No remote code.** Every page has `script-src 'self'`: no CDN scripts, no inline `<script>` (use
  `<script type="module" src="panel.js">`), no `eval`. Vendor a library as an ES module file in the folder.
- **No direct network.** `connect-src 'self'`: `fetch("https://…")` fails. Use `pistachio.net.fetch` with
  the site in `hosts`. Images load only from the folder, `data:` and `blob:`. No frames, no form posts.
- **TypeScript** works without a build: `.ts` files are served with their types stripped. Erasable syntax
  only — no `enum`, `namespace`, parameter properties or `import =`; `import type` for types. Import files
  by their real name (`import { x } from "./util.ts"`). For types: `/// <reference path="../.pistachio/pistachio.d.ts" />`.
- Call the API, not the DOM of other pages: you never see another page's DOM; read pages with `pages.read`.
- Errors are `ExtError`s with a `code` (`PERMISSION_DENIED`, `NOT_FOUND`, `INVALID_ARGUMENT`,
  `UNAVAILABLE`, `TIMEOUT`, `RATE_LIMITED`, `CANCELLED`) and a message that says what to fix.
- Who you are (`runtime.id`, `runtime.manifest`, `runtime.context`, `files.data.url()`) is known once
  `pistachio.runtime.ready` resolves — `await pistachio.runtime.ready` at the top of a script. Every
  call waits for it by itself. A handler main calls before your script registered it waits for it.
- Handlers time out: a tool after 30 s, a Bar command or a trigger after 10 s, a menu item or key after 5 s.
- **Never wait for a time yourself.** No `setTimeout` or `setInterval` until tonight or until Sunday: the
  worker stops when idle and its timers go with it. A time is a trigger (§9), or `sendAway`'s `until`.

## 7. The API (`.pistachio/pistachio.d.ts` has every type)

Every call returns a Promise; every `onX(fn)` returns a function that unsubscribes. *(capability)*

- **runtime** — `id`, `manifest`, `context`, `ready`, `now()` (ms, the clock of capture and input), `log(level, msg, data?)`.
  `sendMessage`/`onMessage`, `connect(name?)`→`Port`/`onConnect` (what a port receives before its first
  `onMessage` waits for it, in order), `keepAlive(reason)`→release, `onInstalled`, `onAction`. *(none)*
- **storage.local** — `get(keys?)`, `set(items)`, `remove(keys)`, `onChanged(fn)`.
  JSON, 5 MB, kept by Pistachio, the same from every context. *(none)*
- **settings** — `get(key)`, `getAll()`, `onChanged(fn)` for the declared `settings`.
  A `secret` reads only in the worker. *(none)*
- **ui** — `openPanel()`, `closePanel()`, `openPage(name, { query?, space? })`→tabId, `toast({ title, body?, action? })`.
  `setBadge(text|null)`, `setStatus({ text, actions? }|null)`, `onStatusAction(fn)`, `onToastAction(fn)`. *(none)*
  `band` and `sidebar` — each `set({ title?, rows, spaceId? })`, `clear({ spaceId? })`, `get({ spaceId? })`,
  `onPress(({ row, button, spaceId }) => …)`: rows Pistachio keeps and draws for you. §11. *(declared)*
- **bar** — `onCommand(name, ({ arg, spaceId, tabId, selection }) => …)` in the worker.
  Return nothing, `{ prompt }` (handed to the agent) or `{ openPage, query? }`. *(declared)*
- **contextMenus** / **commands** — `onClicked(id, info)` / `onCommand(id, { tabId, spaceId })` in the worker.
  `info` has `tabId`, `pageUrl`, `linkUrl?`, `selectionText?`, `srcUrl?`, `windowTabId?`; for a `tab`
  item `fromTab: true` (`tabId` is the tab whose row it was chosen on); and for a `space` item `spaceId`
  (with `tabId` and `pageUrl` null). *(declared)*
- **tabs** — `query({ spaceId?, active?, url? })`, `get(id)`, `onCreated`, `onUpdated`, `onRemoved`, `onActivated` *(tabs:read)*.
  A tab is `{ id, spaceId, profileId, title, url, favIconUrl, active, loading, kind, lastActiveAt }` —
  `lastActiveAt` is when it was last in use (ms). A tab opened behind others counts from when it was
  opened, so it is **not** how to tell a tab nobody has looked at: for that, mark it on
  `{ "tab": "opened" }` and unmark it on `{ "tab": "shown" }` (§10).
  `create({ url, space?, show? })`, `navigate(id, url)`, `show(id)`, `close(id)` *(tabs:write)*.
  `setMark(id, { glyph?, tone?, label } | null)` *(tabs:mark)* — a small mark on that tab's row in the
  sidebar, or `null` to take yours off. Any tab you can see: nobody has to run you in it. It goes with
  the tab when the tab closes. §10.
- **spaces** — `list()`, `current()` (null in Home), `onCurrentChanged(fn)`.
  A space is `{ id, name, color, tabIds, lastActiveAt, byPerson }`: `lastActiveAt` is when any tab of it
  was last in use; `byPerson` is true when the person made it or made it theirs (named it, moved a tab
  into it, keeps a Stack or a conversation in it) and false only for one Pistachio gathered by itself
  that nobody has touched since. `away()`, `onAwayChanged(({ event, space }) => …)` for the
  spaces that are away: `{ id, name, color, tabCount, since, until?, mine }`. *(tabs:read)*
  `sendAway(spaceId, { until? })`, `bringBack(spaceId)` *(spaces:write)*. Away is off the rail with its
  tabs asleep, kept exactly as it was — not closed, not archived — and it comes back the same space.
  - **To hide a space for a while, send it away with `until`** (ms, a `Date`, or an ISO string with its
    offset; in the future): Pistachio brings it back by itself at that time — or the moment the Mac next
    wakes after it — **whether or not your extension is running**. Do not keep a timer to bring it back:
    your worker stops when idle and its timers go with it.
  - Without `until` it stays away until you `bringBack`, or the person does from the rail.
  - Only a space the person ran you in (§4): pass `ctx.spaceId`. Anything else is `PERMISSION_DENIED`.
    `bringBack` also works for any space you sent away yourself (`mine`).
  - `UNAVAILABLE` means the space is busy (shared live, recorded, the agent at work in it) or there is
    no room for it to come back: nothing changed, say so with a toast, try later.
  - Neither brings anything in front, except that the space in front, sent away, passes the desk on.
  - Both are safe to repeat on a space the person gave you: `sendAway` of one already away resolves with
    it as it is, `bringBack` of one already here resolves — nothing changes, nothing throws.
  - If you are turned off or removed, every space you sent away comes back.
  - `close(spaceId)` *(spaces:close)* — the person's own *Close space*: its tabs close and the space is
    filed in the **archive** as one entry, restored from there as itself for as long as the archive keeps
    it (30 days unless they changed it). **Away is for "later"; close is for "done".** The same grant
    (a space they gave you, or `spaces:all`), the same `UNAVAILABLE` while it is busy. From a trigger's
    handler it is written in the journal — Undo restores the space — and, like `sendAway`, refused the
    space in front, one playing and one with a terminal. (Like `sendAway` too, the space in front *does*
    go when the screen is locked or the handler is an `idle` or `screen` signal's: if "tidy up" must
    never take the space the person left in front, skip `spaces.current()` yourself.)
  - `setMark(spaceId, { glyph?, tone?, label } | null)` — a small mark on that space's tile, or `null`
    to take yours off *(spaces:mark)*. §10.
- **triggers** — `on(id, (state) => …)` in the worker, `get(id)`, `list()`. A state is
  `{ id, kind: "during", holds, changesAt }`, `{ id, kind: "at", at, next }`, `{ id, kind: "every", at, next }`
  or `{ id, kind: "when", holds, known }` (times in ms). §9. *(declared)*
- **theme** — `set({ backdrop?, colors?: { accent? }, spaceId? })`, `clear({ spaceId? })`, `get({ spaceId? })`.
  A backdrop behind a space's windows and an accent colour, for every space or one. §10. *(theme)*
- **desk** — `state(spaceId?)` → `{ stage, windows: [{ tabId, box, z, inUse, minimized, pageKind, title }] }`.
  `onChanged(fn)`, at most 4 times a second. *(desk)*
- **pages** — `read(tabId, { format: "text"|"markdown"|"elements" })`, `screenshot(tabId)`→PNG Blob.
  *(pages:read with the site in hosts, or a gesture grant)*
- **capture** — `sources()`, `tab(tabId, { audio?, scale?: 1|2, frameRate?: 30|60 })`→`MediaStream` (worker), `hold(tabId)`→release.
  The stream is real: record it with `MediaRecorder` or WebCodecs. *(capture:tab)*
- **input** — `subscribe(tabId, kinds?)`→`{ onEvent(fn), stop() }` in the worker: moves, clicks with the element's rect,
  key *kinds* (never characters), scrolls, the caret, navigations. *(input:events)*
- **files** — `pick()`, `save(data | { dataPath }, { suggestedName })`, `reveal(path)`, `startDrag(dataPath)` *(none: the dialog is the grant)*.
  `data.open(path)`→writable, `data.write/read/list/remove`, `data.url(path)` for `<video>`/`<img>`, `data.freeSpace()` *(files:data)*.
- **clipboard** — `write({ text?, html?, image?: Blob, filePath? })` *(clipboard:write)*.
  `readText()` within 5 s of the person using your extension *(clipboard:read)*.
- **notifications** — `show({ title, body?, action? })`, `onAction(fn)`.
  The Mac's notification, under your extension's name. *(notifications)*
- **net** — `fetch(url, { method?, headers?, body? })`→`{ status, ok, headers, text(), json(), arrayBuffer() }`.
  Runs in Pistachio, no CORS, no cookies of the person's, every request logged. *(hosts)*
- **notes** — `list()`, `search(q)`, `read(id)`→markdown *(notes:read)*.
  `create({ title, markdown })`, `update(id, { mode: "replace"|"append"|"section", markdown, section? })` *(notes:write)*.
- **agent** — `onToolCall(name, (input, { runId, spaceId, signal, progress }) => json)` in the worker; throw to fail the step *(agent:tools)*.
  `ask(prompt, { spaceId? })` starts a visible turn credited to your extension *(agent:ask)*.
- **ai** — `complete({ prompt, system?, maxTokens? })`→the answer's text *(ai)*.
  One question to Pistachio's fast model: no tools, no memory, nothing shown in any conversation. For a
  name, a sort, a one-line summary. `prompt` up to 24,000 characters, `system` (how to answer) up to
  4,000, `maxTokens` 16–2000 (600 when left out). Ask for JSON in words and `JSON.parse` in a `try`: the
  answer is a model's. It spends the person's AI usage and sends what you put in the prompt — send
  titles, not pages. **Rejects `UNAVAILABLE` when no model can be asked** (signed out, offline, switched
  off) or none answered in time: catch it and do the plain thing. Ten a minute; from a trigger's handler,
  twelve an hour — and there the answer is waited for only as long as the handler has left (ten seconds in
  all), so ask first thing in the handler.
- **power** — `preventSleep()`→release.
  Keeps the Mac awake while you work. *(power)*

## 8. Worked examples

### A `/` command that opens a page

`pistachio.json`: the Bar-command manifest of §3. `worker.js`:

```js
await pistachio.runtime.ready;

pistachio.bar.onCommand("hello", async ({ arg }) => {
  const name = arg.trim();
  await pistachio.ui.toast({ title: name ? `Hello, ${name}!` : "Hello!" });
  if (name) await pistachio.ui.openPage("hello", { query: `name=${encodeURIComponent(name)}` });
});
```

`hello.html` loads `<script type="module" src="hello.js"></script>`; `hello.js`:

```js
const name = new URLSearchParams(location.search).get("name");
document.getElementById("greeting").textContent = name ? `Hello, ${name}!` : "Hello!";
```

### An agent tool that fetches JSON from a host

```json
{
  "api": 1, "id": "dev.example.repo-facts", "name": "Repo facts", "version": "1.0.0",
  "description": "Gives the agent a public GitHub repository's stars, issues and default branch.",
  "permissions": ["agent:tools"],
  "hosts": ["https://api.github.com/*"],
  "worker": { "type": "web", "main": "worker.js" },
  "tools": [{
    "name": "repo_facts", "effect": "read",
    "description": "Stars, open issues and default branch of a public GitHub repository.",
    "input": { "type": "object", "properties": { "repo": { "type": "string", "description": "owner/name" } }, "required": ["repo"] }
  }]
}
```

```js
await pistachio.runtime.ready;

pistachio.agent.onToolCall("repo_facts", async ({ repo }, { progress }) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo is "owner/name", like "electron/electron"');
  progress(`Asking GitHub about ${repo}`);
  const response = await pistachio.net.fetch(`https://api.github.com/repos/${repo}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${repo}`);
  const data = await response.json();
  return { stars: data.stargazers_count, openIssues: data.open_issues_count, defaultBranch: data.default_branch };
});
```

### A panel that lists tabs

`pistachio.json`: the panel manifest of §3. `panel.html`:

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><style>body { margin: 0; padding: 12px; font: 13px system-ui; }</style></head>
  <body>
    <ul id="tabs"></ul>
    <script type="module" src="panel.js"></script>
  </body>
</html>
```

`panel.js`:

```js
const list = document.getElementById("tabs");

async function render() {
  const space = await pistachio.spaces.current();
  const tabs = (await pistachio.tabs.query()).filter((tab) => tab.spaceId === (space ? space.id : null));
  list.replaceChildren(...tabs.map((tab) => {
    const row = document.createElement("li");
    const show = document.createElement("button");
    show.textContent = "Show";
    show.addEventListener("click", () => pistachio.tabs.show(tab.id));
    row.append(tab.title || tab.url, " ", show);
    return row;
  }));
}

let timer;
const soon = () => { clearTimeout(timer); timer = setTimeout(render, 50); };
for (const on of [pistachio.tabs.onCreated, pistachio.tabs.onUpdated, pistachio.tabs.onRemoved, pistachio.tabs.onActivated, pistachio.spaces.onCurrentChanged]) on(soon);
soon();
```

The panel sizes itself to its content. Then read `.pistachio/status.json`: `pendingGrants` will list
`tabs:read` and `tabs:write` until the person turns it on.

## 9. Running by itself: triggers

Everything above runs because the person did something. A **trigger** is how an extension runs with
nobody there: "this space is here on Sundays", "every weekday at nine". You declare *when* as data in
`pistachio.json`; Pistachio keeps the clock, wakes the worker and calls your handler. You write only
*what*.

### Declaring when

```json
"triggers": [
  { "id": "sunday",  "during": { "days": ["sun"], "from": "08:00", "to": "23:00" } },
  { "id": "night",   "during": { "days": ["fri", "sat"], "from": "22:00", "to": "06:00" } },
  { "id": "weekday", "during": { "days": ["mon", "tue", "wed", "thu", "fri"], "from": "00:00", "to": "24:00" } },
  { "id": "nine",    "at": { "days": ["mon", "tue", "wed", "thu", "fri"], "time": "09:00" } },
  { "id": "scores",  "every": { "minutes": 5, "while": "sunday" } },
  { "id": "standup", "when": { "calendar": { "title": "stand-up", "early": 2 } } },
  { "id": "call",    "when": { "page": { "host": "meet.google.com" } } },
  { "id": "pr",      "on": { "page": { "host": "github.com", "path": "/pulls" } } }
]
```

- `id`: lowercase letters, digits, dashes; unique. At most 8 triggers.
- `during` is a **window** of the week. `days` (`"sun"` … `"sat"`) are the days it *starts* on; leave
  `days` out for every day. `from` and `to` are `HH:MM`, 24 hours, two digits each. `to` at or before
  `from` ends the **next day** (`22:00`–`06:00` on `fri` runs into Saturday morning). `"24:00"` is the
  end of the day, allowed only as `to`. `from` and `to` may not be the same time.
- `at` is an **instant** that recurs: `time` on each of `days` (every day when left out).
- Times are on the Mac's own clock, wherever the person is. Add `"zone": "America/Chicago"` (an IANA
  name) only when the wish names a place ("when the New York market opens").
- `every` is an **interval**: `minutes` from 1 to 1440, on the clock's own marks (every 5 minutes is
  :00, :05, …; every hour is on the hour; every day is midnight — counted from midnight on the Mac's
  clock, so a rhythm that does not divide the day, like 90, starts over each midnight). Add `"while": "<id>"` — the id of a `during` or a `when` declared beside it — and it
  runs only while that one holds. **This is how anything is looked at again**: scores, a build, a
  price. Almost every interval wants a `while`: "every 5 minutes" with none runs all day, every day,
  and the sheet says so.
- `when` is a **signal**: something Pistachio can see and you cannot. Exactly one of:

  | `when` | holds while | the sheet says |
  | --- | --- | --- |
  | `{ "power": "battery" }` / `"plugged"` | the Mac runs on its battery / is plugged in | While this Mac is on battery |
  | `{ "network": "offline" }` / `"online"` | the Mac has no network / has one | While this Mac is offline |
  | `{ "display": "external" }` | a second display is connected | While a second display is connected |
  | `{ "idle": { "minutes": 10 } }` | nobody has touched the Mac for that long (1–240) | While nobody has used this Mac for 10 minutes |
  | `{ "calendar": { "title": "stand-up", "early": 2 } }` | an event with that phrase in its name (any case, 3–40 characters) is on — from `early` minutes (0–30) before it starts | While a calendar event with “stand-up” in its name is on, and for 2 minutes before it |
  | `{ "screen": "locked" }` | the Mac's screen is locked | While this Mac's screen is locked |
  | `{ "page": { "host": "meet.google.com", "path"?: "/abc" } }` | a tab is on a page of that site — `host` is a site's name, or `"*.google.com"` for it and every site under it (never a scheme, a port, or a whole ending like `*.com`); with `path`, a page whose path starts with it | While a page on meet.google.com is open |
  | `{ "space": "front" }` | a space the person gave you (§4) is the one in front | While a space you gave it is in front |
  | `{ "tabs": { "over": 30 } }` | more than that many tabs are open (1–500) | While more than 30 tabs are open |

  The last three are read from the browser itself, the moment the tabs change: "send Football away
  while a Meet call is open" is `{ "page": { "host": "meet.google.com" } }` and two lines of worker.
  Only the person's own tabs in the Profiles you are on in count — never the agent's hidden tabs.

  **You are told one thing: whether it holds** (and so, by when you are told, when such an event
  starts and ends). Never the event's name, its guests or its place, never another event, never how
  long the Mac has been idle. There is no API that reads the calendar. If the wish needs more than
  that one answer, a signal is not the tool. Pick the phrase from the person's own words ("my
  stand-up" → `"stand-up"`), and say in your reply which phrase you chose: an event named "Daily
  sync" will not match it. The calendar read is the Google Calendar connected in the Profiles the
  extension is on in.
- `on` is an **event**: something that *happens*, as against something that holds. Exactly one of:

  | `on` | happens when | the sheet says |
  | --- | --- | --- |
  | `{ "tab": "opened" }` / `"closed"` / `"shown"` | a tab opens / closes / comes in front | When a tab opens |
  | `{ "page": { "host", "path"? } }` | a tab arrives at such a page (a new tab on it, or a tab that navigates to it) | When a page under github.com/pulls opens |
  | `{ "download": "finished" }` | a download completes | When a download finishes |

  **Prefer a signal when the wish can be said as one.** What holds is asked again after a closed lid,
  a restart, a pause; what happened is not. An event is **told once, soon, or never**: only while
  Pistachio is up and the extension is on and not paused — whatever happened otherwise is missed for
  good, and a handler that fails is not run again. Events arrive **together**: `state.events` is what
  happened since the handler last ran, oldest first, at most twenty, and one trigger's handler runs a
  few seconds apart at most. Each event is `{ at, tabId? }` — *that* it happened and to which tab,
  never an address: `tabs.get(tabId)` reads it, with `tabs:read`. A space sent away or brought back
  is not its tabs closing or opening. An interval's `while` cannot name an event.
- No expressions, no dates. A rule that needs an `if` is your handler's code.

### Handling it

```js
pistachio.triggers.on("sunday", async ({ holds }) => { … });   // a window: holds is true or false
pistachio.triggers.on("nine", async ({ at }) => { … });        // an instant: at is the one that came due
pistachio.triggers.on("scores", async ({ at }) => { … });      // an interval: at is the latest mark
pistachio.triggers.on("standup", async ({ holds }) => { … });  // a signal: holds is true or false
pistachio.triggers.on("pr", async ({ events }) => { … });      // an event: what happened, [{ at, tabId }]
const now = await pistachio.triggers.get("sunday");            // the same state, asked for
```

- **Pistachio owns the clock.** It asks what holds at launch, on wake, on unlock and as the time comes,
  and calls the handler when the answer is **not the one the handler last heard**. Nothing fires *at*
  8:00: a Mac asleep from Saturday to Monday hears nothing about Sunday, and one opened Sunday at noon
  hears `holds: true` then. Several instants missed while asleep are one call, with the latest.
- **Reconcile, do not remember.** The handler is told the state; make the world match it. Do not count
  calls, do not assume the last one you heard was the opposite, do not keep "what I did last time" to
  decide what to do now. The verbs you need are safe to repeat (§7 spaces).
- **Return the promise.** `return` or `await` what the handler does. A handler that throws or rejects
  was **not delivered**: Pistachio runs it again later, a little longer apart each time, until it
  succeeds or the answer changes. That is how "put the space away after the games" waits for the person
  to leave it: `sendAway` rejects `UNAVAILABLE` while the space is in front, the error leaves the
  handler, and the trigger runs again. A `.catch(() => {})` there throws that away.
- **The worker does not stay.** Started by a trigger, it is stopped as soon as the handler answers.
  Finish inside the handler; `runtime.keepAlive` is refused there. A timer you set in a handler does
  not run later: there is no later.
- **Do not make a signal chase its own tail.** If your handler sends away the space that holds the
  tab your `page` signal counts, the signal goes off, you bring the space back, it goes on… Pistachio
  pauses an extension whose signal's handler has changed spaces or tabs eight times in two minutes,
  and tells the person. Act on a space the signal does not read.
- **Top-level code in the worker runs with nobody there too** when a trigger is what started it: the
  same list applies from its first line. Register handlers at the top level; do the work in them.
- A trigger with no `triggers.on` for its id is an error in `runtimeErrors`.
- First approval: a window's and a signal's handler is called once with what holds now; an instant
  waits for its next time, an interval for its next mark.
- **An interval is one call for however many marks passed** (a lid closed for an hour is one call, the
  latest), and it **starts quiet**: when its `while` comes to hold, that trigger's own handler has
  just run — the interval's first call is the mark after. So set things up in the window's or the
  signal's handler, and only *refresh* in the interval's.
- **A signal can be not known**: no calendar connected, or it could not be read. Then no handler runs —
  not with `holds: false`; nothing is heard at all, and what you last heard stands. `triggers.get`
  answers `{ holds: false, known: false }`: in a command's handler check `known` before acting on
  `holds`, or "no calendar" becomes "no meeting". The extensions page tells the person what to
  connect; you can say it too.

### What a trigger's handler may do

Nobody is there, so only what can be undone, and what tells the person:

| Works | |
| --- | --- |
| Reading | `tabs.query`/`get`, `spaces.list`/`current`/`away`, `desk.state`, `triggers.get`/`list`, `settings.get` |
| Your own state | `storage.local`, `files.data.*`, `runtime.sendMessage`, `runtime.log` |
| Telling the person | `ui.toast`, `ui.setBadge`, `ui.setStatus`, `notifications.show` |
| The network | `net.fetch` to your `hosts` |
| Spaces | `spaces.sendAway` / `bringBack` / `close` of a space the person gave you (§4) |
| A model | `ai.complete`, twelve an hour |
| A tab, behind | `tabs.create` — a page of the web (never one of your own pages), in the space in front or a space on the rail you name (never `"new"`, never a Home tab's space); it opens **behind** what is in front whatever `show` says, twelve an hour at most |
| What Pistachio draws for you | `theme.set` / `clear` / `get`, `spaces.setMark`, `tabs.setMark` (§10); `ui.band` and `ui.sidebar` `set` / `clear` / `get` (§11) |

**Everything else rejects `PERMISSION_DENIED`** inside a trigger's handler: `tabs.navigate`,
`show` and `close`, `ui.openPanel`/`openPage`, `pages.read`, `notes.*`, `capture`, `input`, the
clipboard, `agent.ask`, `runtime.keepAlive`, `power`. To do one of those, ask: `ui.toast({ title,
action })` and do it in `ui.onToastAction` — the person's press is theirs, and everything works there.

With nobody there `spaces.sendAway` is also refused (`UNAVAILABLE`) for the space **in front**, one
that is **playing** something, and one with a **terminal** open. Let the error out; it is tried again.
The space in front *does* go when Pistachio can see that nobody is at the Mac: its screen is locked,
or the handler in hand is an `idle` or `screen` signal's (or an interval's that runs `while` one) and
that signal holds. "Send Work away when I have been gone ten minutes" is `{ "idle": { "minutes": 10 } }`
and `sendAway` in its handler — no other trigger gets that leave.

Every send, return and close a trigger makes, every theme it sets and every tab it opens is written in
a journal the person sees on the extensions page, with **Undo** (the space is back, restored from the
archive; the tab is closed), **Pause** for your triggers and **Pause all**. A mark, rows
and a `clear` are not written there: each says whose it is where it is drawn, and the person takes it
off in one press. Paused, you still run when they run you.

### What the person sees, and what you check

- The approval sheet says **Runs by itself:** with one line per trigger in Pistachio's words —
  "Sundays 8:00 AM–11:00 PM" — from the manifest alone. Adding a trigger, or changing one's days, times
  or zone, pauses the extension until the person approves again. Removing one applies at once.
- `.pistachio/status.json` → `triggers`: each with `id`, `says` (that same line), `zone`, `holds` (a
  window, now) and `next` — the changes of the next seven days, in order; an interval lists its next
  three marks. **Read it after saving.** If the person said "Sunday mornings through the games" and
  `says` reads "Every day 8:00 AM–11:00 PM", the manifest is wrong, and it is the kind of wrong nobody
  notices until Thursday. An interval's `says` names what it runs while ("Every 5 minutes, Sundays
  8:00 AM–11:00 PM"): if it reads only "Every 5 minutes", you left out the `while`.
- A signal's `holds` is in the status only once the person has approved the extension — nothing of
  the Mac or the calendar is read for a draft — and `needs` says what is missing when it cannot be
  read ("Connect Google Calendar in Settings"). A signal has no `next`: when it changes is not the
  clock's to say.

### Game day: a space that is here on Sundays

```json
{
  "api": 1, "id": "dev.example.game-day", "name": "Game day", "version": "1.0.0",
  "description": "Keeps a space away except Sundays, 8 AM to 11 PM.",
  "permissions": ["spaces:write"],
  "worker": { "type": "web", "main": "worker.js" },
  "triggers": [{ "id": "sunday", "during": { "days": ["sun"], "from": "08:00", "to": "23:00" } }],
  "bar": { "commands": [{ "name": "gameday", "description": "Show this space only on Sundays", "run": { "event": true } }] }
}
```

```js
// Run in a space, /gameday gives the extension that space (§4) — and applies today's answer at once.
pistachio.bar.onCommand("gameday", async ({ spaceId }) => {
  if (!spaceId) throw new Error("Run /gameday in the space to keep for Sundays.");
  await pistachio.storage.local.set({ space: spaceId });
  await apply(await pistachio.triggers.get("sunday"));
});

// Pistachio calls this when Sunday's window opens or closes — or the first time it looks after either.
pistachio.triggers.on("sunday", apply);

async function apply({ holds }) {
  const { space } = await pistachio.storage.local.get("space");
  if (!space) return;
  return holds ? pistachio.spaces.bringBack(space) : pistachio.spaces.sendAway(space);
}
```

No timer, no catch-up after sleep, no time zone, no "was it already away": those are Pistachio's.

### Stand-up: a space that comes back when the meeting starts

"When my stand-up starts, bring the Team space back." The calendar is the person's; the extension
declares a phrase and is told when an event with it is on.

```json
{ "api": 1, "id": "dev.me.stand-up", "name": "Stand-up", "version": "1.0.0",
  "permissions": ["spaces:write"],
  "worker": { "type": "web", "main": "worker.js" },
  "triggers": [{ "id": "standup", "when": { "calendar": { "title": "stand-up", "early": 2 } } }],
  "bar": { "commands": [{ "name": "standup", "description": "Bring this space back when my stand-up starts", "run": { "event": true } }] } }
```

```js
pistachio.bar.onCommand("standup", async ({ spaceId }) => {
  await pistachio.storage.local.set({ space: spaceId });   // running it here gives the extension this space
  const state = await pistachio.triggers.get("standup");
  if (state.known) await apply(state);                     // not known is not "no meeting"
});
pistachio.triggers.on("standup", apply);
async function apply({ holds }) {
  const { space } = await pistachio.storage.local.get("space");
  if (!space) return;
  return holds ? pistachio.spaces.bringBack(space) : pistachio.spaces.sendAway(space);
}
```

### Idle spaces: one of Pistachio's own features, as an extension

"Tidy up the spaces I have not used in a while." This is what Pistachio's own Tidy does to the spaces
it gathered (it files them in the archive once every tab of one is idle), written on the API you have:

```json
{ "permissions": ["tabs:read", "spaces:close", "spaces:all"],
  "worker": { "type": "web", "main": "worker.js" },
  "triggers": [{ "id": "sweep", "every": { "minutes": 30 } }],
  "settings": [{ "key": "hours", "title": "File a space nobody has used for this many hours", "type": "number", "default": 12, "min": 1 }] }
```

```js
pistachio.triggers.on("sweep", async () => {
  const idleMs = Number((await pistachio.settings.get("hours")) ?? 12) * 3600_000;
  const current = await pistachio.spaces.current();
  let failed = null;
  for (const space of await pistachio.spaces.list()) {
    if (space.byPerson || space.id === current?.id || space.tabIds.length === 0) continue;   // never theirs, never the one in front
    const tabs = await pistachio.tabs.query({ spaceId: space.id });
    if (!tabs.every((tab) => tab.lastActiveAt > 0 && Date.now() - tab.lastActiveAt >= idleMs && !tab.loading)) continue;
    try { await pistachio.spaces.close(space.id); } catch (error) { failed = error; }        // busy: left for the next sweep
  }
  if (failed !== null) throw failed;                                                          // thrown: Pistachio tries again
});
```

- `spaces:all` because the wish is about spaces nobody ran the extension in; the sheet says so first.
- **`byPerson` is the line a person would draw**: leave their own spaces alone unless they said "all of
  them". If they did, say in your reply that their own spaces will be filed too.
- Nothing is lost: each is one entry in the archive, the journal lists it with Undo, and a notice says
  *Closed “Trip” · 2 tabs · <your extension>* with Undo.
- An interval with no `while` runs all day; this one should, and the sheet says *Every 30 minutes*.

## 10. What the shell draws for you: the theme and marks

You never put your own pixels in Pistachio's chrome: no injected styles, no overlay view, no DOM of the
shell's. You name a place Pistachio offers and hand it a **value**; Pistachio checks it, keeps it and
draws it, labelled as yours — whether or not your worker is running — and the person removes it in one
press. Two places so far: what lies **behind a space's windows** (with an accent colour), and a small
**mark on a space's tile**.

### The theme

```js
await pistachio.theme.set({
  spaceId,                                                  // one space the person gave you; leave out for every space
  backdrop: { image: "field.svg", dim: 0.2 },               // or { color }, or { gradient: { colors, angle? } }
  colors: { accent: "#1f8a4c" },
});
await pistachio.theme.clear({ spaceId });
const mine = await pistachio.theme.get({ spaceId });        // what you set there, or null
```

- Needs `"theme"`. **`set` replaces your theme for that place, whole**: saying it twice is saying it
  once, so a trigger's handler says what should be so — `holds ? set(…) : clear(…)`.
- **Where.** With `spaceId`, that one space — one the person gave you (§4), else `PERMISSION_DENIED`.
  Without it, every space. A space's own theme is the one drawn there, over one for every space.
- **One holder a place.** Another extension's `set` for the same place takes yours, and `get` answers
  null from then on. `get` is also null once the person removed it or you cleared it.
- **A backdrop** is one of:
  - `{ color: "#0b3d2e" }` — `#rrggbb`.
  - `{ gradient: { colors: ["#0b3d2e", "#145c43"], angle: 160 } }` — two to four colours; `angle` in CSS
    degrees (0 bottom to top, 90 left to right; 180 when left out).
  - `{ image: "art/field.svg", fit?: "cover"|"contain"|"tile", dim?: 0–0.8 }` — a file **in your own
    folder**: `.png`, `.jpg`, `.jpeg`, `.webp` or `.svg`, at most 8 MB (an SVG 512 KB). Pistachio
    **copies it when you call `set`** and keeps the copy: editing the file later changes nothing until
    you `set` again. `dim` lays Pistachio's own ground over the picture that far, so windows and the
    desk's own words stay readable in light and dark alike — use 0.15–0.4 for anything busy.
  - `backdrop: null`, or leaving it out, is no backdrop. A theme with neither a backdrop nor an accent
    is `clear`.
- **The accent** (`colors.accent`, `#rrggbb`) tints Pistachio's own surfaces and is its focus ring while
  your theme is in front. It must stand out at least **2:1 from both Pistachio's light ground and its
  dark one** — the person may be in either — or `set` rejects `INVALID_ARGUMENT` with the ratio and
  which way to go ("too light … choose a deeper colour"). Mid-tones pass; near-white and near-black don't.
- `INVALID_ARGUMENT` also for a picture that is missing, too large, or not a picture of its type.
- **Making the picture.** You write text files, so a picture you make yourself is an **SVG** written
  into the folder (or use a gradient). Give it a `viewBox` and no `width`/`height`, draw with shapes
  and gradients, and keep it self-contained: **no `<script>`, no external `href` or `url(http…)`, no
  web fonts, no `<foreignObject>`** — it is drawn as a picture, so scripts never run and nothing it
  links to is loaded. Keep it under 512 KB (a few dozen shapes is plenty for a backdrop):

  ```svg
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <defs><linearGradient id="turf" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1f8a4c"/><stop offset="1" stop-color="#0f5c30"/>
    </linearGradient></defs>
    <rect width="1600" height="1000" fill="url(#turf)"/>
    <g stroke="#ffffff" stroke-opacity="0.35" stroke-width="6" fill="none">
      <rect x="100" y="120" width="1400" height="760"/><line x1="800" y1="120" x2="800" y2="880"/>
      <circle cx="800" cy="500" r="110"/>
    </g>
  </svg>
  ```

### A mark on a space's tile

```js
await pistachio.spaces.setMark(spaceId, { glyph: "🏈", tone: "green", label: "Games on" });
await pistachio.spaces.setMark(spaceId, null);              // take yours off
```

- Needs `"spaces:mark"`, and a space the person gave you (§4).
- `glyph` is one or two characters as a person counts them — a letter, a digit, an emoji — or leave it
  out for a dot. `tone` is `"neutral"` (the default), `"green"`, `"amber"`, `"red"` or `"blue"`.
  `label` (1–60 characters) says what it means: the tile's tooltip reads "<your extension's name>:
  <label>", and a screen reader says it.
- One mark an extension a space; setting it again replaces it.

### A mark on a tab's row

```js
await pistachio.tabs.setMark(tabId, { tone: "blue", label: "Not read yet" });   // a dot; add glyph for a character
await pistachio.tabs.setMark(tabId, null);                                        // take yours off (quiet if it has none)
```

- Needs `"tabs:mark"`. The same value as a space's mark, on the tab's row in the sidebar, said as
  "<your extension's name>: <label>".
- **Any tab you can see** — unlike a space, a tab is not "given": the capability is the grant.
- Pistachio drops the mark when the tab closes. You do not have to.
- "Mark the tabs I have not read" is three events and this call: `{ "tab": "opened" }` → mark it unless
  `tab.active`; `{ "tab": "shown" }` → `setMark(tabId, null)`. No `tabs:read` is needed for the mark
  itself; reading `tab.active` is what needs it.

### What the person sees and can do

- The sheet says "Changes the backdrop and accent colour of your spaces." (`theme`) and "Puts a small
  mark on the spaces you ran it in." (`spaces:mark`).
- A space's menu has **Remove backdrop**; the extensions page lists **What it shows** — each mark and
  theme — with **Remove**. After that `theme.get` is null: do not put it straight back.
- Turned off or removed, your marks and theme go with you.
- All four calls work in a trigger's handler (§9). A theme set there is in the journal with **Undo**.

### Game day, with a stadium

"Give my football space a stadium while the games are on." The wish is about *this space*, so it is a
`space` menu item; the window is a trigger; the rest is two values.

```json
{
  "api": 1, "id": "dev.example.game-day-stadium", "name": "Game day", "version": "1.0.0",
  "description": "A stadium behind a space, and a mark on it, on Sundays from 8 AM to 11 PM.",
  "permissions": ["spaces:mark", "theme"],
  "worker": { "type": "web", "main": "worker.js" },
  "triggers": [{ "id": "sunday", "during": { "days": ["sun"], "from": "08:00", "to": "23:00" } }],
  "contextMenus": [{ "id": "here", "title": "Game day here", "contexts": ["space"] }]
}
```

```js
// Chosen from a space's menu, "Game day here" gives the extension that space (§4) — and applies today's answer at once.
pistachio.contextMenus.onClicked("here", async ({ spaceId }) => {
  await pistachio.storage.local.set({ space: spaceId });
  await apply(await pistachio.triggers.get("sunday"));
});

// Pistachio calls this when Sunday's window opens or closes — or the first time it looks after either.
pistachio.triggers.on("sunday", apply);

async function apply({ holds }) {
  const { space } = await pistachio.storage.local.get("space");
  if (!space) return;
  if (holds) {
    return Promise.all([
      pistachio.theme.set({ spaceId: space, backdrop: { image: "field.svg", dim: 0.2 }, colors: { accent: "#1f8a4c" } }),
      pistachio.spaces.setMark(space, { glyph: "🏈", tone: "green", label: "Games on" }),
    ]);
  }
  return Promise.all([pistachio.theme.clear({ spaceId: space }), pistachio.spaces.setMark(space, null)]);
}
```

`field.svg` is the picture above, written into the folder beside `worker.js`. Nothing here draws,
keeps time or cleans up after itself: the backdrop and the mark are Pistachio's to hold and to show.

## 11. Rows: a strip beside the Bar, a section of the sidebar

Two more places Pistachio draws for you, and both take the same thing: **rows**. A row is Pistachio's
own — you fill it in, you never lay it out, and nothing you hand over is markup.

- **`pistachio.ui.band`** — a strip along the foot of the desk, beside the Bar: at most **6** rows, each
  a chip. For the few things worth a glance while working: today's games, a build, a count.
- **`pistachio.ui.sidebar`** — a section at the foot of the sidebar: a heading (`title`, or your
  extension's name) and at most **12** rows. For a short list the person returns to.

Declare the place in `pistachio.json` — `"band": true`, `"sidebar": true` — or the call is refused. No
permission is needed: the sheet says "a strip beside the Bar" / "a section in the sidebar".

```js
await pistachio.ui.sidebar.set({
  title: "Today’s games",          // sidebar only
  spaceId,                          // optional: one space the person gave you (§4); left out, every space
  rows: [
    { id: "game:401", mark: { tone: "red" }, text: "KC 21 – BUF 17", detail: "3rd quarter", value: "4:12",
      buttons: [{ id: "open", title: "Open" }] },
    { text: "SF at SEA", detail: "4:25 PM" },
  ],
});
```

A row:

| Field | |
| --- | --- |
| `text` | What it says. Required, one line, 80 characters at most. |
| `detail` | Said after it, quieter — the first thing to give way when there is no room. 80 at most. |
| `value` | At the trailing end, in figures that line up: a score, a count, a time. 24 at most. |
| `mark` | `{ glyph?, tone? }` in front: one or two characters (a dot when left out); `tone` is `"neutral"`, `"green"`, `"amber"`, `"red"` or `"blue"`. |
| `id` | With one, the row can be **pressed**. Letters, digits and `. _ : -` (`"game:401"`), each id once. |
| `buttons` | Up to two `{ id, title }` (title 24 at most), pressed on their own. Give the row an `id` too when more than one row has buttons: rows with no id are all `row: null` to a press, so the same button id in two of them is refused. |

Rules that matter:

- **`set` replaces your rows there, whole.** Say what should be shown; saying the same twice does
  nothing. No rows (`rows: []`) is `clear`.
- **Pistachio keeps them.** They are drawn after your worker has stopped and after a restart. Do not
  keep a timer or a worker alive to hold them up, and do not set them again on every start.
- **For every space, or for one.** With `spaceId` they show only in that space, and it must be a space
  the person gave you. A space's own rows are drawn there *instead of* your every-space ones.
- **A press wakes the worker**: `pistachio.ui.band.onPress(({ row, button, spaceId }) => …)` (and
  `ui.sidebar.onPress`). `row` is the row's `id`, `button` the button's or null for the row itself,
  `spaceId` the space in front. The press is the person's own act, so everything works in the handler —
  `tabs.create`, `ui.openPage` — unlike a trigger's. Rows with an `id` or buttons need a `worker`.
- **The person removes them** with the × on the section's head, or on the strip (your icon turns into
  it under the pointer), or from the extensions page. After that `get` is null: do not put them
  straight back.
- `ui.setStatus` is still the right call for something **live that ends with the work** — a recording, a
  timer running. It is not kept across a restart. Rows are for what should still be there tomorrow.
- Refusals are `INVALID_ARGUMENT` with a sentence saying what to change: too many rows, an id used
  twice, a line break in a text, a field the row does not have.

### Game day, with the scores

"Show today's games in a strip beside the Bar on Sundays, and list them in my football space."

```json
{
  "api": 1, "id": "dev.example.scoreboard", "name": "Scoreboard", "version": "1.0.0",
  "description": "Today's games beside the Bar and in a space's sidebar, on Sundays from 8 AM to 11 PM.",
  "hosts": ["https://scores.example.com/*"],
  "band": true,
  "sidebar": true,
  "worker": { "type": "web", "main": "worker.js" },
  "triggers": [{ "id": "sunday", "during": { "days": ["sun"], "from": "08:00", "to": "23:00" } }],
  "contextMenus": [{ "id": "here", "title": "Games here", "contexts": ["space"] }]
}
```

```js
pistachio.contextMenus.onClicked("here", async ({ spaceId }) => {
  await pistachio.storage.local.set({ space: spaceId });
  await apply(await pistachio.triggers.get("sunday"));
});
pistachio.triggers.on("sunday", apply);

async function apply({ holds }) {
  const { space } = await pistachio.storage.local.get("space");
  if (!holds) {
    await pistachio.ui.band.clear();
    if (space) await pistachio.ui.sidebar.clear({ spaceId: space });
    return;
  }
  const games = await (await pistachio.net.fetch("https://scores.example.com/today.json")).json();
  const rows = games.map((game) => ({ id: `game:${game.id}`, mark: { tone: game.live ? "red" : "neutral" }, text: game.score, detail: game.clock }));
  await pistachio.ui.band.set({ rows: rows.slice(0, 6) });
  if (space) await pistachio.ui.sidebar.set({ spaceId: space, title: "Today’s games", rows: rows.slice(0, 12) });
}

// A press is the person's: opening a tab works here.
const open = ({ row }) => pistachio.tabs.create({ url: `https://scores.example.com/${row.slice(5)}`, show: true });
pistachio.ui.band.onPress(open);
pistachio.ui.sidebar.onPress(open);
```

(`tabs.create` needs `"tabs:write"` in `permissions`; left out above to keep the manifest short.)
The window's trigger runs when Sunday opens and closes. For scores that move, add an interval that
runs while it holds, and refresh there — a worker does not stay up to poll:

```json
"triggers": [
  { "id": "sunday", "during": { "days": ["sun"], "from": "08:00", "to": "23:00" } },
  { "id": "scores", "every": { "minutes": 5, "while": "sunday" } }
]
```

```js
pistachio.triggers.on("scores", () => show());   // every five minutes on Sundays; one call after a sleep
```
