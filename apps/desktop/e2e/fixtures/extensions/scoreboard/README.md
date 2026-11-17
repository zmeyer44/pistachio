# Scoreboard (e2e fixture)

Stage 4's gate (docs/primitives.md §5): "show today's games in a strip beside the Bar on Sundays", built on the public
API alone — `"band": true` and `"sidebar": true` in `pistachio.json`, a window trigger, and a handler that says which
rows should be shown (`pistachio.ui.band.set`, `pistachio.ui.sidebar.set`). Pistachio keeps the rows and draws them.

`e2e/tests/extensions-sites.spec.ts` loads it from a copy of this folder and moves main's trigger clock under it.
