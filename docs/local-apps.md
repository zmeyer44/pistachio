# Local apps

The address bar offers the web apps running on this Mac — a dev server, a Storybook, a local tool's web UI — as compact chips, so one started a minute ago in a terminal is a click away rather than a port number to remember.

Desktop only: a web surface (docs/web-browser-design.md) has no local ports of the person's to offer.

## 1. What a person sees

A slim tray fastened under the address field (packages/shell-ui components/LocalTray.tsx), on both of the bar's faces: one pill per project — a green running dot, the project's name once, then each of its ports in tabular figures (`● marius 5173 5231 5242 5243`). An app with no project is named by its title, else its server. A port already open in a tab of the space in use wears a small window mark, and choosing it switches to that tab ("Switch to tab" in the field's line); any other opens in the page in use, ⌥↵ / ⌘⇧↵ in a new tab / space, as every row of the bar.

- **Keyboard.** The tray is the first stop under the field: browsing, ↓ reaches it; ←/→ walk its ports; ⇥ jumps into it from anywhere in the field and on along it, ⇧⇥ back, and past either end comes round to the typed text. Steered to a port, the field shows its address and, at its right, what the pill has no room for: server, title, uptime.
- **Typing.** The tray keeps the apps the text reaches — a port's first digits (`51`), an address of this Mac (`localhost`, `:3000`, `127.0.0.1:30`), or words beginning the name, title or server (`story`, `marius 52`) — and folds away when none. It never takes ↵: the typed face's first row keeps it, and "⇥ to pick" sits beside the pills; ↑ from the first row reaches them too.
- **Overflow.** One line, never two: the strip scrolls sideways, fading at a side with more beyond it, and a count (`+3`) says how many ports are past the right edge (a click scrolls on). Every port stays a ← or → away.
- **Arrival.** None running: nothing at all. Apps found after the bar opened unfold the tray (grid 0fr → 1fr, 200 ms) and each dot breathes once, left to right; a reopen with the same servers up is still. The selection stays on the pill or row it was on as the tray changes under it.

## 2. What counts as an app

A port on this Mac is a local app when all of these hold:

- Something is **listening** on it that loopback reaches: bound to every address, or to 127.0.0.1 / ::1 itself (`lsof -iTCP -sTCP:LISTEN`; a socket bound to one LAN address only is not reachable as `localhost`). It is asked at 127.0.0.1; an IPv6 socket bound to every address may take IPv6 alone, which lsof does not say, so when 127.0.0.1 refuses it is asked at ::1.
- It is **not Pistachio's own**: no process in Pistachio's tree, and not the dev server the shell itself is served from under `pnpm dev`.
- Asked for `/` over loopback, it **answers with a page**: a 2xx whose type is HTML, after following up to three redirects on the same port (a Next.js app's `/` → `/signin`). Every connection stays on the loopback address the socket was found at: a redirect takes only its scheme (plain HTTP sent on to HTTPS), path and query, and a loopback name it gives (127.0.0.1 → `localhost`, a server's own name for itself) is sent as the Host, never looked up. An AirPlay receiver's 403, an editor helper's `text/plain`, an event stream, a database — none is a page.

A port that answers with something else is not asked again for a minute; one that takes the connection and says nothing in time (most are not web servers; a dev server compiling its first page is the exception) for twenty seconds. A server only TLS speaks is asked over https, its certificate taken as it is: nothing sent is a secret. So is one that answers plain HTTP with a 400 of its own, as nginx, Go and Caddy do on an HTTPS port.

## 3. What an app is called

| Field | From |
| --- | --- |
| `title` | The page's `<title>` (the page a redirect led to). |
| `iconUrl` | The page's declared icon (an SVG, else the smallest of 32px or more), else `/favicon.ico` — read by main and handed over as a `data:` URL, so no shell page ever fetches from a local port. |
| `project` | The app bundle the process runs from (`BlueBubbles.app` → BlueBubbles), else the repository its working folder is in (the nearest folder with `.git`, short of home), else that folder. Nothing for a process working in `/` or home (a daemon, Docker). |
| `folder` | That working folder, `~`-abbreviated. |
| `server` | What its command line names — Next.js, Vite, Storybook, Astro, Django, Uvicorn, Rails, … — else the process's name. |
| `startedAt` | Its process's start. The list is newest first: the server started a minute ago leads. |

## 4. How

Main's `LocalApps` (apps/desktop/src/main/local-apps.ts) scans: `lsof` for the listeners, `ps` for the processes, `lsof -d cwd` for their folders, then a GET to each candidate, all in parallel, each bounded by a deadline. Without `lsof` it falls back to the usual dev-server ports (3000, 5173, 8080, …) and knows nothing of their processes. A scan is reused for 1.5 s; an app's icon is kept while its process is the same.

The shell asks through `localApps()` (a native surface member, @pistachio/shell-contracts/ipc) via `useLocalApps(open)` (packages/shell-ui/src/lib/use-local-apps.ts): as the bar opens, and every four seconds while it stays up, so a server started meanwhile turns up. Between openings the last answer is kept, so the bar opens with what was there a moment ago and settles on what is there now.

## 5. Tests

- Unit: apps/desktop/test/local-apps.test.ts — parsing `lsof`/`ps`, naming, what counts as a page, and a scan of real servers. packages/shell-ui/test/local-tray.test.ts — what a pill is called, which apps a query reaches, how a project's ports group, the chosen app's line.
- E2E: e2e/tests/local-apps.spec.ts (`@address`) — what main finds, then the tray: absent with no app, unfolding when one turns up, the keyboard ring (↓, ←/→, ⇥), switching to an open tab, typing's filter, a dozen apps on one scrolling line. Stand-in apps are node processes in their own temp repositories (e2e/tests/local-apps-harness.ts); under `PISTACHIO_E2E` main looks only at the ports in `PISTACHIO_LOCAL_APP_PORTS`, never the machine's own servers.
