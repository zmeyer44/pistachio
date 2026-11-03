# bar-tool (e2e fixture, `@extensions`)

Proves main's invocations reach a worker and come back through `runtime.done`, each leaving a marker in `pistachio.storage.local`:

- **worker** — started on first need, not at install (`worker.started`, once a command or the tool runs).
- **Bar command, kind `event`** — `/shout hi` runs the handler with the Bar's context (`bar.shout`) and shows a toast "HI"; `/shout` with no text answers `{ prompt }`, which the Bar hands to the agent.
- **tool** — `shout_text` is offered to the agent only with `agent:tools` granted and *Agent can use it* on; a call answers `{ text, letters }` (`tool.shout_text`, with the run's id and an unaborted signal); the text `"fail"` throws, which fails the step with the message (`tool.failed`).
- No icon: the Ledge draws a monogram.
