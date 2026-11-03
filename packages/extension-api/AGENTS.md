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
   `{ id, state, loadedAt, api, manifestErrors, pendingGrants, runtimeErrors, surfaces }`.
3. `manifestErrors` (`[{ path, message }]`): fix `pistachio.json`; each message says what to change.
4. `runtimeErrors` (`[{ context, message, file, line, at }]`): fix that file and line.
5. `pendingGrants` not empty: the extension is paused until the person approves it in Pistachio
   (the amber dot on the Ledge, or the sheet on `pistachio://extensions`). **You cannot approve, and
   must not try to work around it.** Tell the person what it asks for and why.
6. `.pistachio/log.ndjson` has every context's console and `pistachio.runtime.log` lines.

Asking for less means fewer, quieter approvals: a manifest that widens its permissions pauses the
extension again; one that narrows them applies at once.

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
- `contextMenus`: `[{ "id", "title", "contexts": ["page"|"selection"|"link"|"image"|"window"] }]`.
- `commands`: `[{ "id", "title", "key": "Cmd+Shift+Y" }]` — never overrides one of Pistachio's keys.
- `settings`: `[{ "key", "title", "type": "boolean"|"string"|"number"|"enum"|"secret", "default"? }]`,
  shown in Settings → Extensions; read with `pistachio.settings.get(key)`.
- Rules the schema enforces: an event command, a tool, a menu item, a key command or `action` needs a
  `worker`; `tools` need `"agent:tools"`; a `panel` and `action` exclude each other; names are unique.

## 4. Capabilities

Ask for the fewest. Each has a fixed sentence on the person's approval sheet, broadest first.

| Tier | Capabilities |
| --- | --- |
| None needed | declared surfaces (commands, menus, keys, pages, panel), `storage`, `settings`, `ui`, file dialogs |
| Low | `notifications`, `clipboard:write`, `power` |
| Medium | `tabs:read`, `tabs:write`, `desk`, `files:data`, `notes:read`, `hosts` (each site named) |
| High | `pages:read`, `capture:tab`, `input:events`, `notes:write`, `agent:tools`, `agent:ask`, `clipboard:read` |
| Critical | `"hosts": ["<all_urls>"]`, or any pattern naming every site (`*://*/*`, `https://*/*`) — don't |

- **Prefer a gesture grant over `pages:read` and `hosts`.** When the person runs your Bar command,
  menu item or key on a tab, or opens your panel from its window, you may `pages.read` that tab
  until it goes to another site — nothing in the manifest.
- **Prefer a `web` worker.** It is the only kind: there is no Node (`require`, `fs`, `process`,
  child processes) in v1, so don't write code that needs it.

## 5. Contexts

| Context | What | Lives |
| --- | --- | --- |
| worker | `worker.main` (`.js` or `.ts`), an ES module in a hidden page | started on first need (a command, a tool call, a menu item, a message); stops after 30 min idle |
| panel | `panel.file`, beside the sidebar | while open |
| page | each of `pages`, a desk window (`ui.openPage`) | while open; restored after a restart |

All three share one `pistachio`, one `storage.local` and one origin. Handlers that main calls —
`bar.onCommand`, `agent.onToolCall`, `contextMenus.onClicked`, `commands.onCommand`, `runtime.onAction` —
go in the **worker**. Pages and the panel talk to it with `runtime.sendMessage` or `runtime.connect`.

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
- Handlers time out: a tool after 30 s, a Bar command after 10 s, a menu item or key after 5 s.

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
- **bar** — `onCommand(name, ({ arg, spaceId, tabId, selection }) => …)` in the worker.
  Return nothing, `{ prompt }` (handed to the agent) or `{ openPage, query? }`. *(declared)*
- **contextMenus** / **commands** — `onClicked(id, info)` / `onCommand(id, { tabId, spaceId })` in the worker.
  `info` has `tabId`, `pageUrl`, `linkUrl?`, `selectionText?`, `srcUrl?`, `windowTabId?`. *(declared)*
- **tabs** — `query({ spaceId?, active?, url? })`, `get(id)`, `onCreated`, `onUpdated`, `onRemoved`, `onActivated` *(tabs:read)*.
  `create({ url, space?, show? })`, `navigate(id, url)`, `show(id)`, `close(id)` *(tabs:write)*.
- **spaces** — `list()`, `current()` (null in Home), `onCurrentChanged(fn)`.
  A space is `{ id, name, color, tabIds }`. *(tabs:read)*
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
- **power** — `preventSleep()`→release.
  Keeps the Mac awake while you work. *(power)*

## 8. Three worked examples

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
