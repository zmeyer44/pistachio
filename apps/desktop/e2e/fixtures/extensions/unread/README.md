# Unread (e2e fixture)

Stage 4b's gate (docs/primitives.md §5): "mark the tabs I have not read", written on the public API alone. Used by
`e2e/tests/extensions-tab-marks.spec.ts`.

- `tabs:mark` — `pistachio.tabs.setMark(tabId, { tone, label })`: a small mark on a tab's row in the sidebar, drawn
  by Pistachio and said as "Unread: Not read yet". On any tab the extension could see — nobody runs it in each tab.
- `/later <address>` — opens the address behind what is in front (`tabs.create` with `show: false`).
- `opened`, `shown`, `closed` — events: a tab that opens behind is marked; one that comes in front is read.
