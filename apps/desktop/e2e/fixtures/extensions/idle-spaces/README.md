# Idle spaces (e2e fixture)

Stage 6's gate (docs/primitives.md §5): one of Pistachio's own features — Tidy's filing of idle spaces
(docs/tab-tidy.md §4) — written on the public API alone. Used by `e2e/tests/extensions-idle-spaces.spec.ts`, with
the built-in pass switched off (Settings → Tabs → *Archive idle tabs after: Never*) so what is filed is this
extension's doing.

- `sweep` — every half hour: `spaces.list()` says when each space was last used and whose it is (`byPerson`);
  one Pistachio gathered, every tab of it idle, is closed into the archive with `spaces.close` — written in the
  journal, restored by Undo.
- `spaces:all` — it acts on spaces nobody ran it in, which is a High line of its own on the sheet.
- `ai.complete` — a few words on what the space was for; with no model to ask it files the space all the same.
