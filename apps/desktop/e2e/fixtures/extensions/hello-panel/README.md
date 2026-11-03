# hello-panel (e2e fixture, `@extensions`)

Proves the three contexts of one extension over the wire, each leaving a marker in `pistachio.storage.local`:

- **worker** — loads with `pistachio` (`worker.started`: its id and `context: "worker"`); `onInstalled` (`worker.installed`).
- **panel** — the Ledge icon opens `panel.html` in the side card: `context: "panel"`, `tabs.query` under `tabs:read`, `runtime.sendMessage` answered by the worker (`panel.opened`, `worker.message`), and a `runtime.connect` port echoed by the worker (`panel.port`, `worker.port`); `<body data-done="true">` when all ran.
- **Bar command** — `/hello Ada` wakes the worker (`bar.hello`), shows a toast, and opens `hello.html?name=Ada` as a desk window (`page.hello`).
