# Game day (e2e fixture)

The extension `docs/primitives.md` §6 gives as stage 2's gate, as an agent would write it for "show this space only on Sundays": a `during` trigger in `pistachio.json` and a handler that reconciles. `extensions-triggers.spec.ts` runs it against a clock the spec moves (`PISTACHIO_E2E_TRIGGER_CLOCK`).
