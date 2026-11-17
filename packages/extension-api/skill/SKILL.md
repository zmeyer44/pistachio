---
name: pistachio-extension
description: Use when making or changing a Pistachio browser extension — a folder with a pistachio.json in ~/Pistachio/Extensions/ (a / command, an agent tool, a panel, a page, something that runs by itself on a schedule, a backdrop or a mark on a space).
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
   - `triggers` (if you declared any) → the schedule as Pistachio read it: check `says` is what was asked.
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
  "settings": [{ "key": "token", "title": "API token", "type": "secret" }],
  "band": true,
  "sidebar": true,
  "triggers": [{ "id": "sunday", "during": { "days": ["sun"], "from": "08:00", "to": "23:00" } }]
}
```

Include only the keys you use: an absent surface does not exist. An event Bar command, a tool, a menu
item, a key command, a trigger or `"action": true` needs a `worker`; `tools` need `"agent:tools"`; `panel` and
`action` exclude each other. A Bar command with `"run": { "prompt": "… {arg} {page.url} {selection}" }`
asks the agent and needs no code. `contextMenus` contexts are `"page"`, `"selection"`, `"link"`, `"image"`,
`"window"` (a desk window's ⋯), `"tab"` (a tab's own menu, a right-click on its row: `info.tabId` is that
tab, `info.fromTab` true) and `"space"` (a space's own menu, a right-click on its tile): for a wish
about "this space" prefer a `space` item — `onClicked(id, ({ spaceId }) => …)`, and the choice gives you that space.
`"band": true` / `"sidebar": true` declare that you fill a strip beside the Bar / a section of the sidebar with rows (below).

## Capabilities (ask for the fewest)

- None: declared surfaces, `storage`, `settings`, `ui`, file dialogs.
- Low: `notifications`, `clipboard:write`, `power`, `spaces:mark`.
- Medium: `tabs:read`, `tabs:write`, `spaces:write`, `theme`, `desk`, `files:data`, `notes:read`, `hosts` (named sites).
- High: `pages:read`, `capture:tab`, `input:events`, `notes:write`, `agent:tools`, `agent:ask`, `clipboard:read`.
- Critical: `"hosts": ["<all_urls>"]` — don't.

Prefer a **gesture grant** over `pages:read`/`hosts`: run from the person's Bar command, menu item, key or
panel on a tab, `pistachio.pages.read(tabId)` works on that tab with nothing declared. Prefer a **`web`
worker** — it is the only kind; there is no Node (`require`, `fs`, `process`) yet.

**Hiding a space** (`spaces:write`): `pistachio.spaces.sendAway(spaceId, { until })` takes a space off the
rail, tabs asleep, kept as it is; Pistachio brings it back at `until` (ms, a `Date` or an ISO string) by
its own clock, even if the extension is not running — never keep a timer for that. Without `until` it
stays away until `spaces.bringBack(spaceId)`. The space must be one the person ran your command in: use
the handler's `ctx.spaceId` (and keep it in `storage.local`); any other space is `PERMISSION_DENIED`.
Both are safe to repeat: one already away, or already here, resolves and changes nothing.

`pistachio.spaces.close(spaceId)` (`spaces:close`) is the person's own *Close space*: filed in the archive
as one entry, restored from there as itself. **Away is for "later", close is for "done".** A space is
`{ id, name, color, tabIds, lastActiveAt, byPerson }` — leave `byPerson` spaces alone unless the person said
otherwise. For a wish about spaces in general ("the ones I am not using") add `spaces:all` (High: every
space counts as given); a wish about *this* space never needs it.

`pistachio.ai.complete({ prompt, system?, maxTokens? })` (`ai`, High) asks Pistachio's fast model one
question and resolves with the text — for a name, a sort, a one-line summary. It rejects `UNAVAILABLE` when
no model can be asked: catch it and do the plain thing.

## Running by itself (triggers)

For "on Sundays", "every weekday at nine", "overnight", "every five minutes during the games", "when my
stand-up starts", "when I unplug", "while a Meet call is open", "when I open a pull request": declare **when** in `pistachio.json`, handle **what** in the worker.
Pistachio keeps the clock, reads the signal and wakes the worker. Never `setTimeout`/`setInterval` to wait
for a time or to poll: the worker stops and its timers go with it.

- `{ "id", "during": { "days"?, "from", "to", "zone"? } }` — a window of the week. `days` are `"sun"`…`"sat"`,
  the days it starts on (every day when left out); `HH:MM`, 24 h; `to` at or before `from` ends the next day;
  `"24:00"` is the end of the day (only as `to`). Handler: `pistachio.triggers.on(id, ({ holds }) => …)`.
- `{ "id", "at": { "days"?, "time", "zone"? } }` — an instant that recurs. Handler: `({ at }) => …`.
- `{ "id", "every": { "minutes", "while"? } }` — an interval (1–1440 minutes). `while` is the id of a
  `during` or `when` beside it: it runs only while that holds — nearly always wanted. Handler:
  `({ at }) => …`, one call however many marks passed; it starts quiet, the mark after its `while` begins.
- `{ "id", "when": … }` — a signal Pistachio reads and you cannot: `{ "power": "battery" | "plugged" }`,
  `{ "network": "offline" | "online" }`, `{ "display": "external" }`, `{ "idle": { "minutes" } }`,
  `{ "calendar": { "title": "stand-up", "early"?: 0–30 } }` (an event with that phrase in its name is on),
  `{ "screen": "locked" }` — and the browser's own: `{ "page": { "host": "meet.google.com", "path"? } }` (a
  tab is on a page of that site; `"*.google.com"` for the sites under it), `{ "space": "front" }` (a space
  the person gave you is in front), `{ "tabs": { "over": 30 } }`.
  Handler: `({ holds }) => …`. You learn only whether it holds — never the event. Not known (no calendar
  connected) runs no handler; `triggers.get` then answers `known: false`, so check `known` in a command.
- `{ "id", "on": … }` — an event, something that happens: `{ "tab": "opened" | "closed" | "shown" }`,
  `{ "page": { "host", "path"? } }` (a tab arrives at such a page), `{ "download": "finished" }`. Handler:
  `({ events }) => …` — `[{ at, tabId? }]`, what happened since it last ran (at most twenty); never an
  address (`tabs.get(tabId)` reads it, with `tabs:read`). Told once, only while Pistachio is up and you are
  on: what happened otherwise is missed, and a failed handler is not run again. **Prefer a signal** when
  the wish can be said as something that holds.
- The handler is called when the answer is not the one it last heard — at the time, or the first time the
  Mac is awake after it. **Reconcile** to the state it is given; do not remember the last call.
- **Return/await the promise.** A handler that throws was not delivered and is run again later. `sendAway`
  from a trigger rejects `UNAVAILABLE` for the space in front, one playing, one with a terminal: let it out.
  (From an `idle` or `screen` signal's handler the space in front does go: nobody is in front of it.)
- Inside a trigger's handler only these work: reading (`tabs`, `spaces`, `desk`, `triggers`, `settings`),
  `storage.local`, `files.data`, `ui.toast`/`setBadge`/`setStatus`, `notifications.show`, `net.fetch`,
  `spaces.sendAway`/`bringBack`/`close`, `tabs.create` (it opens behind what is in front, twelve an hour at
  most), `ai.complete` (twelve an hour),
  `theme.set`/`clear`/`get`, `spaces.setMark`, and the rows of `ui.band` / `ui.sidebar`
  (`set`/`clear`/`get`). Anything else is
  `PERMISSION_DENIED`: show a toast with an action and do it in `ui.onToastAction`.
- The sheet shows "Runs by itself: Sundays 8:00 AM–11:00 PM"; a changed time pauses the extension for
  approval. The person can undo what a trigger did, and pause triggers.
- After saving, read `triggers` in `.pistachio/status.json` (`says`, `holds`, `next`): the next seven days.
  An interval's `says` names what it runs while; a signal has no `next`, and `needs` says what to connect.

```js
pistachio.bar.onCommand("gameday", async ({ spaceId }) => {
  await pistachio.storage.local.set({ space: spaceId });
  await apply(await pistachio.triggers.get("sunday"));
});
pistachio.triggers.on("sunday", apply);
async function apply({ holds }) {
  const { space } = await pistachio.storage.local.get("space");
  if (!space) return;
  return holds ? pistachio.spaces.bringBack(space) : pistachio.spaces.sendAway(space);
}
```

## What the shell draws for you (the theme, marks)

Never your own pixels in Pistachio's chrome. You hand Pistachio a **value**; it checks it, keeps it and
draws it as yours, whether or not the worker runs, and the person removes it in one press (the space's
menu: Remove backdrop; the extensions page: What it shows — after which `theme.get` is null).

- `pistachio.theme.set({ backdrop?, colors?: { accent? }, spaceId? })` *(theme)* **replaces** your theme
  for that place whole — safe to repeat. `spaceId`: a space the person gave you (else `PERMISSION_DENIED`);
  left out: every space. A space's own theme is drawn over the every-space one; another extension's `set`
  for the same place takes yours. `theme.clear({ spaceId? })`, `theme.get({ spaceId? })` → yours or null.
- A backdrop: `{ color: "#rrggbb" }`, `{ gradient: { colors: [2–4], angle? } }` (CSS degrees, 180 when left
  out), or `{ image: "art/field.svg", fit?: "cover"|"contain"|"tile", dim?: 0–0.8 }` — a file of your own
  folder (.png .jpg .jpeg .webp .svg; 8 MB, an SVG 512 KB), **copied when you call `set`**. `dim` 0.15–0.4
  keeps windows readable. No backdrop and no accent is `clear`.
- You write text, so a picture you make is an **SVG**: a `viewBox`, shapes and gradients, no `<script>`, no
  external references (never loaded), under 512 KB. Or use a gradient.
- `colors.accent` must stand out 2:1 from both Pistachio's light and dark grounds, or `set` rejects
  `INVALID_ARGUMENT` with the ratio: choose a mid-tone.
- `pistachio.spaces.setMark(spaceId, { glyph?, tone?, label } | null)` *(spaces:mark)*: one mark an
  extension a space, on its tile, said as "<your name>: <label>". `glyph` is one or two characters;
  `tone` is neutral, green, amber, red or blue.
- In a trigger, reconcile: `holds ? set(…) : clear(…)`, and return the promises. A theme set by a trigger
  is in the journal with Undo. Turned off or removed, your marks and theme go with you.

```js
pistachio.contextMenus.onClicked("here", async ({ spaceId }) => {      // "contexts": ["space"]
  await pistachio.storage.local.set({ space: spaceId });
  await apply(await pistachio.triggers.get("sunday"));
});
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

## Rows: a strip beside the Bar, a section of the sidebar

Two more places Pistachio draws for you, both taking **rows** — Pistachio's own row, filled in by you,
never markup. Declare the place (`"band": true`, `"sidebar": true`); no permission is needed.

- `pistachio.ui.band.set({ rows, spaceId? })`: a strip beside the Bar, **6 rows** at most, each a chip.
  `pistachio.ui.sidebar.set({ title?, rows, spaceId? })`: a section at the sidebar's foot, **12 rows** at most.
  Each also has `clear({ spaceId? })`, `get({ spaceId? })` and `onPress(fn)`.
- A row: `{ text, detail?, value?, mark?: { glyph?, tone? }, id?, buttons?: [{ id, title }] }`. `text` and
  `detail` ≤ 80 characters, `value` ≤ 24 (a score, a count, a time), one line each; `tone` is neutral,
  green, amber, red or blue; two buttons at most. Ids are letters, digits and `. _ : -`, each once.
- `set` **replaces** your rows there whole; no rows is `clear`. Pistachio **keeps** them: they are drawn
  with no worker running and after a restart — never keep a timer or `keepAlive` to hold them up.
- With `spaceId` they show in that one space (one the person gave you); without, in every space.
- A row with an `id`, and each button, can be pressed: `onPress(({ row, button, spaceId }) => …)` in the
  worker. The press is the person's own, so `tabs.create`, `ui.openPage` and the rest work there.
- The person removes them with a × on the place itself or from the extensions page; then `get` is null.
- `ui.setStatus` stays for something live that ends with the work (a recording): it is not kept.

```js
pistachio.triggers.on("sunday", async ({ holds }) => {
  if (!holds) return pistachio.ui.band.clear();
  return pistachio.ui.band.set({ rows: [{ id: "game:401", mark: { tone: "red" }, text: "KC 21 – BUF 17", value: "4:12" }] });
});
pistachio.ui.band.onPress(({ row }) => pistachio.ui.openPage("game", { query: `id=${row}` }));
```

## Contexts

- **worker** (`worker.main`, an ES module in a hidden page): every handler main calls —
  `bar.onCommand`, `agent.onToolCall`, `contextMenus.onClicked`, `commands.onCommand`, `runtime.onAction`,
  `triggers.on`.
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
- Handlers answer in time: a tool 30 s, a Bar command or a trigger 10 s, a menu item or key 5 s.

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
