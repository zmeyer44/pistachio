# capture-probe (e2e fixture, `@extensions`)

Proves the S3 surfaces end to end through the public API alone (docs/extensions.md §5 `capture`, `input`, `desk`, `agent.ask`, `commands`), each step a line in `.pistachio/log.ndjson` (`probe: <step>`) and a marker in `pistachio.storage.local`:

- **`/probe`** on the window in use (the invocation grants that tab): `desk.state()` (its window's box), `capture.hold`, `input.subscribe` (every kind), `capture.tab` at 1× / 30 fps, two seconds counted with a `MediaStreamTrackProcessor` and recorded with a `MediaRecorder` into `files.data` (`probe/recording.webm`), then the tracks stopped, the subscription stopped and the hold released — `probe: result` says the frames, the bytes, the event kinds that came, the keys (kinds only) and the focus changes.
- **`/ask`** — `agent.ask` fills the Bar with a question for the person to send.
- **⌘⇧9** (`probe-key`) — a declared key, run on the window in use; **⌘T** (`steal`) is New tab's, left unbound (the status file says so).
