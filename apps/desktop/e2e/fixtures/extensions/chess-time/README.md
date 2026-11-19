# Chess time (e2e fixture)

The extension `docs/primitives.md` §2.7 gives as its gate, as an agent would write it for "every weekday at 5:30 PM make a space called Chess time with one tab on chess.com, and close it at 6:00 PM": a `during` trigger in `pistachio.json`, `spaces.create` when the window comes on and `spaces.close` when it is over. `extensions-chess-time.spec.ts` runs it against a clock the spec moves (`PISTACHIO_E2E_TRIGGER_CLOCK`), with the page's address swapped for a local one.
