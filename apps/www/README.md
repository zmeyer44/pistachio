# www — the site and the account dashboard

Everything the web app was before the browser moved out (docs/web-browser-design.md
§15): the landing page, download, docs, early access, privacy, the artifact
share route, the feedback API, iMessage onboarding, credential capture, and the
account dashboard under `/app` — agent and runs with a live pane, devices,
Spaces, memory, bookmarks, reminders, artifacts, channels and settings.

```bash
pnpm --filter www dev     # http://localhost:3000
```

The browser itself is `apps/web` (package `web`, port 3001). This app links to
it from the rail's "Open the browser", and `/app/browse` redirects there.

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_PISTACHIO_CONTROL_URL` | the control plane (default `http://localhost:8787`) |
| `NEXT_PUBLIC_PISTACHIO_BROWSER_URL` | the browser app, for the nav link and the redirect |
| `NEXT_PUBLIC_PISTACHIO_DOWNLOAD_URL` | overrides where `/download` points |

The account layer (sign in, unlock, device keys, the control client, the
sealed workspace records) is `@pistachio/web-account`, shared with `apps/web`.
This app enrols as the "Web" device; the browser app enrols as its own.

Next.js App Router, Tailwind 4, `next dev --webpack` (workspace packages ship
TypeScript whose relative imports carry `.js`, which webpack's `extensionAlias`
resolves and Turbopack does not).
