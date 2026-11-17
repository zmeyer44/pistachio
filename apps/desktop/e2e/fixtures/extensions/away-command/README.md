# away-command

An e2e fixture (`e2e/tests/extensions-away.spec.ts`; docs/primitives.md §2.5): an extension named **Game day** holding
`spaces:write`. `/gameday` sends the space it is run in away for two seconds, `/benched` until asked, `/sendother <id>`
tries a space it was never run in. Each leaves its answer or its error in `pistachio.storage.local`.
