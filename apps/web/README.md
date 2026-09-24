# web — Pistachio in a browser tab

The browser app (docs/web-browser-design.md §15). One route, at `/`: the same
shell the Mac app runs, mounted over a cloud browser session through the shell
socket. Everything else about the product — the landing pages, the download,
the account dashboard — is `apps/www`.

```bash
pnpm --filter web dev     # http://localhost:3001
```

It needs a control plane and a cloud-browser worker to talk to; `pnpm dev:ready`
from the repository root starts the lot. The addresses it reads:

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_PISTACHIO_CONTROL_URL` | the control plane (default `http://localhost:8787`) |
| `NEXT_PUBLIC_PISTACHIO_WWW_URL` | the other app’s origin: the gate’s site links, and `${origin}/app` for the settings pages this app does not own |
| `NEXT_PUBLIC_PISTACHIO_DOWNLOAD_URL` | the Mac app, for the walkthrough's import step |

The account layer (sign in, unlock, device keys, the control client) is
`@pistachio/web-account`, shared with `apps/www`. The chrome is
`@pistachio/shell-ui`, shared with the desktop.
