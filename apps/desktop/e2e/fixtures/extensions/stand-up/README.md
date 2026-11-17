# Stand-up (an e2e fixture)

Stage 5's gate (`docs/primitives.md` §5): "when my stand-up starts, bring the Team space back", on the public API
alone.

- `pistachio.json` declares a **signal** — `when: { calendar: { title: "stand-up", early: 2 } }` — an **interval**
  that runs while it holds, and a second signal (`power: "battery"`).
- `worker.js` never reads the calendar. Pistachio tells it whether the signal holds; it brings the space back or
  sends it away, and keeps one row beside the Bar current from the interval.

Run by `e2e/tests/extensions-signals.spec.ts`, against a clock (`PISTACHIO_E2E_TRIGGER_CLOCK`) and readings
(`PISTACHIO_E2E_SIGNALS`) the spec writes.
