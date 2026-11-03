---
name: pistachio-extension
description: Use when making or changing a Pistachio browser extension — a folder with a pistachio.json in ~/Pistachio/Extensions/ (a / command, an agent tool, a panel, a page).
---

# Pistachio extension

An extension is a folder in `~/Pistachio/Extensions/<folder>/` with a `pistachio.json` at its root.
Pistachio reloads it on every save and runs it in sandboxed views with a global `pistachio`.
The full guide is `~/Pistachio/Extensions/AGENTS.md`; the types are `~/Pistachio/Extensions/.pistachio/pistachio.d.ts`;
the manifest's schema is `~/Pistachio/Extensions/.pistachio/pistachio-extension.schema.json`. Read the guide before
anything not covered here.

## Procedure

1. Start from the closest template shape (below). `id` is reverse-DNS, lowercase, stable: `dev.<you>.<slug>`.
2. Write `pistachio.json` first (with `"$schema": "../.pistachio/pistachio-extension.schema.json"`), then the files it names.
3. After each save, wait a second and read `.pistachio/status.json`:
   - `manifestErrors` → fix `pistachio.json` (each has `path` and `message`);
   - `runtimeErrors` → fix that `file`/`line`;
   - `pendingGrants` → the person must approve in Pistachio. **You cannot approve; never work around it.**
     Tell them what it asks for and why.
4. `.pistachio/log.ndjson` has console output. Never write anything in `.pistachio/`.

## The manifest, in short

```json
{
  "$schema": "../.pistachio/pistachio-extension.schema.json",
  "api": 1, "id": "dev.you.example", "name": "Example", "version": "1.0.0",
  "description": "One line for the approval sheet.",
  "icon": "icon.svg",
  "permissions": [],
  "hosts": [],
  "worker": { "type": "web", "main": "worker.js" },
  "panel": { "file": "panel.html", "width": 320 },
  "pages": { "main": { "file": "main.html", "title": "Example" } },
  "bar": { "commands": [{ "name": "example", "description": "…", "arg": { "hint": "text" }, "run": { "event": true } }] },
  "tools": [{ "name": "example_tool", "description": "…", "input": { "type": "object", "properties": {} }, "effect": "read" }],
  "contextMenus": [{ "id": "example", "title": "…", "contexts": ["selection"] }],
  "commands": [{ "id": "example", "title": "…", "key": "Cmd+Shift+Y" }],
  "settings": [{ "key": "token", "title": "API token", "type": "secret" }]
}
```

Include only the keys you use: an absent surface does not exist. An event Bar command, a tool, a menu
item, a key command or `"action": true` needs a `worker`; `tools` need `"agent:tools"`; `panel` and
`action` exclude each other. A Bar command with `"run": { "prompt": "… {arg} {page.url} {selection}" }`
asks the agent and needs no code.

## Capabilities (ask for the fewest)

- None: declared surfaces, `storage`, `settings`, `ui`, file dialogs.
- Low: `notifications`, `clipboard:write`, `power`.
- Medium: `tabs:read`, `tabs:write`, `desk`, `files:data`, `notes:read`, `hosts` (named sites).
- High: `pages:read`, `capture:tab`, `input:events`, `notes:write`, `agent:tools`, `agent:ask`, `clipboard:read`.
- Critical: `"hosts": ["<all_urls>"]` — don't.

Prefer a **gesture grant** over `pages:read`/`hosts`: run from the person's Bar command, menu item, key or
panel on a tab, `pistachio.pages.read(tabId)` works on that tab with nothing declared. Prefer a **`web`
worker** — it is the only kind; there is no Node (`require`, `fs`, `process`) yet.

## Contexts

- **worker** (`worker.main`, an ES module in a hidden page): every handler main calls —
  `bar.onCommand`, `agent.onToolCall`, `contextMenus.onClicked`, `commands.onCommand`, `runtime.onAction`.
- **panel** (`panel.file`): the Ledge icon's side card; sizes itself to its content.
- **page** (`pages`): desk windows opened with `pistachio.ui.openPage(name, { query })`.

They share one `pistachio.storage.local` and talk with `runtime.sendMessage`/`onMessage` or `runtime.connect`/`onConnect`.

## Rules

- No remote code: `script-src 'self'` — no CDN, no inline `<script>`, no `eval`. Use `<script type="module" src="x.js">`.
- No direct network: page `fetch()` to the web fails. Use `pistachio.net.fetch(url)` with the site in `hosts`.
- Images only from the folder, `data:`, `blob:`. No frames.
- Paths relative, no `..`, no leading `/`.
- `.ts` is served stripped: erasable TypeScript only (no `enum`, `namespace`, parameter properties); import by real file name.
- `await pistachio.runtime.ready` before reading `runtime.id`, `runtime.context`, `runtime.manifest` or `files.data.url()`;
  every call waits for it by itself.
- Errors are `ExtError`s with a `code` and a message that says what to fix.
- Handlers answer in time: a tool 30 s, a Bar command 10 s, a menu item or key 5 s.

## Two handlers, for shape

```js
await pistachio.runtime.ready;

pistachio.bar.onCommand("example", async ({ arg, tabId }) => {
  await pistachio.ui.toast({ title: `Got ${arg}` });
  return { openPage: "main", query: `q=${encodeURIComponent(arg)}` };
});

pistachio.agent.onToolCall("example_tool", async (input, { progress, signal }) => {
  progress("Working");
  const response = await pistachio.net.fetch("https://api.example.com/v1/thing");
  if (!response.ok) throw new Error(`api.example.com answered ${response.status}`);
  return await response.json();
});
```

Templates to copy live in the package as `templates/panel`, `templates/bar-command`, `templates/agent-tool`;
the guide (`AGENTS.md`) has them as worked examples.
