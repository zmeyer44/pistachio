# Native desktop browsing and cloud continuity

Desktop always opens sites in local Electron WebContentsViews. Page JavaScript,
input, rendering, audio, and navigation run on the Mac, whether the account is
signed in or not. Signing in never replaces the native shell with a DOM mirror
or pixel stream, suspends its pages for a cloud connection, or makes local
browsing depend on the cloud worker. Existing Fly egress policies still route
network traffic through the account's gateway when configured.

The web app uses its cloud Chromium session and the shared shell UI. Its DOM
mirror and pixel renderer remain web capabilities. Linked cursor/view/control
mode links web viewers of that same cloud process; desktop is not a viewer of
that process.

## Moving from desktop to web

The desktop publishes tabs, active selection, split groups, and eligible cookies
through the existing signed, encrypted sync lanes. Portable page checkpoints
add document scroll and up to eight identifiable textarea drafts (8,192 characters
in total). Password/credential-like field names, anonymous textareas, disabled
or read-only fields, and fields opting out with autocomplete=off are excluded.
Input and scroll reports are coalesced; they do not copy the DOM or stream frames.

Checkpoints are scoped to the exact page URL. Restoration fills empty matching
textareas, emits input events, and restores document scroll; it never submits
forms or replaces a field that the site has already populated. The encrypted
workspace record is bounded; page details are dropped before tab identities if
the record exceeds its budget.

After workspace and cookie hydration, the web browser can adopt a newer desktop
checkpoint. A returning first viewer can also update an existing idle cloud
session. An attached web viewer or active agent run is never interrupted by a
desktop handoff. Newer cloud state wins over older desktop state. Each desktop
Space keeps the timestamp of its actual last change, so republishing unchanged
metadata does not make it newer.

Desktop pages continue independently while the web app is used; incoming session
checkpoints do not automatically close or replace active native pages. Eligible
cookie sync remains bidirectional, and the existing explicit workspace Pull/Merge
flow remains available for other devices' restore points.

## Limits

Two independent JavaScript processes cannot share the same in-memory execution
state. This is a best-effort handoff, not a page-process checkpoint. Arbitrary
JavaScript heaps, IndexedDB, local/session storage, file inputs, nested-frame
state, text selection, and arbitrary application editors are not transferred.
A site may require another login if it relies on device-bound credentials or
storage outside the eligible cookie lane. Restoring a page makes a new request;
sites with asynchronous layouts may not restore the exact scroll or draft.

Web-to-web viewers can still reattach to the same running cloud page and use
linked controls. Cloud restart or idle suspension rebuilds from the durable
record, including available portable checkpoints.

The real Electron-to-web regression is
`apps/desktop/e2e/tests/desktop-web-sync.spec.ts`. It checks a native local page,
signed-in cloud restoration, portable draft and scroll, independent local
JavaScript, and re-entry into a previously opened cloud session.
