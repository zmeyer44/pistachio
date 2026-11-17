# Call guard (e2e fixture)

Stage 5b's gate (docs/primitives.md §5): "send Football away while a Meet call is open", written on the public API
alone. Used by `e2e/tests/extensions-events.spec.ts`, which serves the "call" from a local server (`127.0.0.1/call/…`).

- `call` — a **signal** of the browser's own: a page under `127.0.0.1/call` is open. The worker is told whether it
  holds, and sends the space `/guard` was run in away, or brings it back.
- `locked` — the screen is locked: the same space goes away even from in front (nobody is in front of it).
- `opened`, `closed`, `arrived` — **events**: told what happened, once, with the tab.
- `nine` — an instant: opens a page with nobody there (behind what is in front; written in the journal, Undo closes it).
