# Architecture

## Organizing invariant

Every component must improve the collaborative browser loop: the person is already working, asks in one gesture, the agent acts in the same authenticated tabs, and every tool call remains visible, interruptible, steerable, and provable.

The desktop owns the live browser views and exposes a main-process tool boundary over them. The conversation owns intent and control state, while the browser remains the source of truth for sessions, navigation, and page state. A future policy layer can constrain this tool boundary without reintroducing a separate handoff surface.

## Planes

### Native client

The Electron client carries the Suma browser foundation: `WebContentsView` tabs, a trusted unsandboxed ESM chrome preload with context isolation, sandboxed site views, space partitions, split layout, and side-panel interaction patterns. A task browser appears as another tab and can share a split with the human tab. The chrome arranges as a top tab row or a vertical sidebar from one feature manifest, so no control can exist in one layout only ([chrome layouts](chrome-layouts.md)).

The native shell keeps the current tab as the task context. The agent tool boundary targets its existing `WebContentsView`, so cookie material never crosses renderer IPC and the person and agent see the same navigation, authentication, and form state. Conversation snapshots contain only trusted tab metadata and structured activity.

#### How state reaches the shell

Main is the source of truth for the shell's `ShellSnapshot` (`@pistachio/shell-contracts/ipc`); the renderer never derives tab or run state on its own. Publishing is coalesced and split (`publish()` / `publishRun()` in `main/index.ts`): every change in a tick produces one flush, the tab side (`ShellTabsSnapshot` — spaces, tabs, split groups, the shelf) travels on `pistachio:snapshot-changed`, and the run side (`ShellRunSnapshot` — the conversation and the thread list, already scoped to the active Space) travels on `pistachio:run-changed`. A title tick therefore never re-serializes a long conversation, and a tool step never re-sends every tab. `getSnapshot` still answers with the whole thing for startup and for tests.

The renderer's store folds both back into one `snapshot` with structural sharing (`@pistachio/shell-ui`'s `lib/share.ts`): every subtree that is deep-equal to what it held keeps its previous reference, so a publish that changed one tab's title leaves every other tab, every message, and the shelf identical by identity. Components rely on that — they select narrow slices (`useShallow` where a slice is an object), rows are memoized on their tab, and the conversation is memoized on its run — so nothing between the store and a changed row re-renders. Anything that arrives on a per-frame path (a resize drag, pointer geometry) stays out of the snapshot entirely.

Those rules are the shell's, not Electron's. The web client's `ShellHost` on the worker publishes under the same discipline — one coalesced flush per tick, the tab side and the run side on their own channels, `getSnapshot` answering whole — and the same store folds the result, so the two hosts differ in transport and in what they own, never in how state arrives.

### Web client

The same chrome runs in an ordinary browser tab. It is not a second implementation: the desktop renderer and its contracts are workspace packages — `@pistachio/shell-ui` (the React tree, the store, the theme) and `@pistachio/shell-contracts` (the IPC surface, the snapshot shapes, the socket protocol) — and the desktop consumes them from there. See [the web browser](web-browser-design.md).

**Two sites, one account.** The web client is two Next applications, because they are two different things behind the same sign-in (web-browser-design.md §15). `apps/www` (package `www`, port 3000 in development) is the public site — the landing pages, download, docs, early access, privacy, artifact shares, the feedback API, iMessage onboarding, credential capture — and the account dashboard under `/app`: the agent and its runs with a live pane, devices, Spaces, memory, bookmarks, reminders, artifacts, channels and settings. `apps/web` (package `web`, port 3001) is the browser and nothing else: the shell on a stream surface, at `/`. The dashboard's rail links across (`NEXT_PUBLIC_PISTACHIO_BROWSER_URL`), the browser links back for anything the dashboard owns (`NEXT_PUBLIC_PISTACHIO_WWW_URL`), and `/app/browse` — where the shell used to live — redirects.

They are separate origins, so they are separate devices: device keys live in the origin's IndexedDB and neither site can read the other's. The dashboard enrols as "Web" and the browser as "Browser", and the Devices page lists both. What they share is `@pistachio/web-account`, the account layer itself — the device and its keys, the token session, the vault, the control client, the sealed workspace records, the live view, the gate (with its own stylesheet, so the front door looks the same on both) and the small UI kit the dashboard is built from. It reads `NEXT_PUBLIC_PISTACHIO_CONTROL_URL` itself; the device name is the one thing each app passes in.

Control and the worker tell the two apart: `PISTACHIO_WEB_URL` keeps meaning `www` (capture and iMessage links, artifact tool views, the live view's origin for the dashboard's run page), `PISTACHIO_BROWSER_URL` is the browser app (the shell socket's pinned origin, the download route's CORS origin), and `CONTROL_ALLOWED_ORIGINS` lists both.

The tree meets its host through two seams. The **API seam** (`setShellApi`, `shellApi()`, `nativeApi()`) splits the surface in two: `ShellApi` is everything a host can answer, and `NativeSurfaceApi` is the geometry that only an Electron window can — placing views over holes in the DOM, polling the OS cursor, native dialogs, the update installer, importing local browser profiles. Each native member is recorded with its reason, the way a chrome feature is recorded with its placement in both layouts. The web bridge implements `ShellApi` only, and `nativeApi()` answers null, which every caller must survive. The **surface seam** decides what a pane is: on the desktop, a hole the main process places a `WebContentsView` over; on the web, a DOM element painted from a screencast, with no bounds reported to anyone.

The host is on the worker. `services/cloud-browser/src/sessions/` holds a `ShellHost` that plays the part Electron main plays for one session: the source of truth for the snapshot and the executor of every call. It answers tabs, spaces, splits, the shelf, settings (as a sealed account-global workspace register of their own, so a theme or a shortcut changed in a browser tab is changed on the Mac too and survives a suspend), find in page, the console (starting a run, messages, answers, approvals, takeover, release, threads, evidence), and — since S6 — downloads, uploads, the clipboard, print, the context menu, reader view, site permissions, browsing data, the media stack, the tab switcher, zoom and the personal records (memory, reminders, bookmarks, artifacts). What is left is refused rather than approximated, in one list (`UNSUPPORTED` in `sessions/shell-host.ts`) with a reason a person can read, which the shell shows in place of the affordance: the handful W12 declares (the live view — the pane already is one — forking a Space, feedback, read-aloud synthesis, speech, the onboarding intake, opening the native bookmarks page, and acknowledging or snoozing a reminder's fired occurrence), and the settings whose subject belongs to the dashboard's own pages, signed in as the person (the shell renders the way there beside the reason) — the account and its AI usage, devices, sync, egress, cloud, channels, iMessage, the vault and integrations. Passkeys and camera/microphone are refused where a site asks for them rather than as members, and auto-update reports itself unsupported. The web page is only chrome: cookie material and page HTML never reach it, and control keeps storing only sealed records.

The transport is one WebSocket, `/v1/shell/:sessionId` on the fleet's single public address, relayed in-fleet exactly as the live view is. Its authentication is the live view's stack unchanged: the upgrade's `Origin` is pinned to the browser app, a one-minute one-redemption ticket is spent at control (no WebSocket client can set a header, so the credential rides in the URL and authorises nothing else), the viewer's device is re-checked every minute, and the host sends a challenge and nothing else until the viewer proves it holds the Space key. The socket then carries an RPC envelope over the `ShellApi` method names, the two snapshot channels the preload carries on the desktop, per-pane JPEG screencast frames sized to the pane and its device pixel ratio, and input. Method names and event channels are derived from the interface itself, so a member added to the contract cannot silently go missing on one end.

Browser sessions are the durable object underneath. A session belongs to a user and a Space and exists before, during, and after any conversation; a run attaches to its tabs and holds authority only while it runs; a viewer is one web tab, and the session outlives every viewer. Control owns the record, the lease, and the fence: taking control, a run starting, and a run ending each bump a **control generation**, and every forwarded input and agent tool call carries the generation it was issued under (the tool call's is re-checked at the Playwright call, not only when the turn began), so the host drops a stale actor instead of racing it. Placement is on demand — a socket lands on whichever worker the public address routed it to, and that worker either claims the session from control or relays to the holder. The tabs, splits, shelf, active tab, per-origin zoom and the answers given to each site's permission prompts persist as a sealed workspace record (`browser-session:<spaceId>`, versioned: a worker that does not know a record's version refuses it and then never publishes one, because the register is last-writer-wins and a confident empty write would take every tab on every device), so a session suspended after `CLOUD_BROWSER_SESSION_IDLE_MS` with no viewer and no run rebuilds on whatever machine claims it next; live page state (a half-typed form, the JS heap) lives only as long as the Chromium context, and so does anything whose address is its content — a reader tab is rebuilt, never stored.

The agent in a session cannot act as the person by holding a device token — a `cloud` device is refused every device-bearer route. What stands in for the person is the pair the worker already holds: the service bearer and the session's lease token, with the audit actor named as the viewer's own device, which control checks belongs to the session's user and is not revoked.

### Managed control

The control plane is the durable source of truth for run status, pause state, current policy version, device reattachment, delivery occurrences, and evidence metadata. `@pistachio/runtime` defines its optimistic-revision and worker-lease contract. Production storage will be our Postgres service; the in-memory adapter exists only for tests and the local demonstration.

The control plane (`services/control`) also owns accounts (BetterAuth, email + password, server-side only), device enrollment with client-generated device ids and Ed25519/X25519 keys, sealed key wrappers, the in-process session hub (`packages/sync-hub`), egress credentials, hosted cloud runs, and channel links. It never holds a Space root secret or a cookie value: sync records, workspace docs, and cloud-run content events are sealed by the devices. See [cloud sync design](cloud-sync-design.md).

There is intentionally no local control-plane distribution, Docker Compose bundle, or self-host administration surface.

### Session sync and the cloud browser

Every device, including the cloud browser, runs the same `@pistachio/sync-engine` over a WebSocket to the hub: cookies are captured from Chromium's change stream (desktop) or a CDP diff (cloud), sealed under the Space key, ordered by hybrid logical clocks, and reconciled with durable tombstones, causal ancestry, and a resurrection guard. Origin leases decide who may write a session: the cloud browser holds exclusive leases while a run is active and desktops defer instead of fighting. The identity egress gateway (`services/egress`) gives the desktop and the cloud browser one static IP per user so sites do not see a device change.

### Task runtime

Production runs use one ephemeral browser sandbox per task. A worker claims a run with a fencing token, hydrates the task capsule below the automation boundary, and publishes browser frames plus structured events. Losing the lease invalidates subsequent writes. Completion is committed only after capsule-key destruction and egress cutoff succeed.

The current Electron demo hosts both browser partitions locally to validate UX and contracts. It does not claim laptop-close continuity or microVM isolation.

### Policy and adapters

The deterministic layer derives origin, HTTP method, transfer controls, sensitive-page blocks, interaction count, and semantic action at the interception boundary rather than trusting agent classifications. Known consequential writes return `require_approval`; unknown writes fail closed. An approval is scoped to origin + method + adapter identity/version + semantic action + matched path pattern, expires, and is consumed once.

The semantic layer is a registry of versioned manifests. A manifest maps a known method and path shape to a business action, resource label, reversibility, and data-leaving fields. Unknown routes remain unknown; the system does not invent a universal ontology.

The native vertical slice binds that enforcer to the delegated Electron partition with `session.webRequest.onBeforeRequest`; the demo's consequential POST is genuinely cancelled until its exact approval is consumed. Delegated popups are denied, navigations remain inside the origin grant, downloads are gated, and terminal revocation leaves the partition offline. Production still requires the same decision contract in the hosted browser's CDP request-paused loop and outbound gateway.

### Pause and delivery plane

Approval, judgment, and step-up authentication are durable run states. Expired pauses are leased by a sweeper, have their capsule key and egress revoked, and transition to a terminal state. Notifications are scheduled occurrences, not transient UI events. Workers claim occurrences with leases; adapters deliver idempotently; retries have a terminal attempt ceiling; and the capability ceiling attached to a notification is intersected with current policy at fire time. Desktop notifications are the first adapter. Phone push and email adapters use the same seam.

### Evidence

Every evidence entry includes sequence, timestamp, run, event type, actor/sponsor/task chain, payload, previous hash, signer identity, content hash, and Ed25519 signature. Verification enforces monotonic sequence, one run, one signer, canonical hashes, and signatures; callers can supply an expected length and externally anchored root. The local demo creates a run key; production keys must be hosted KMS-backed and their public-key identity anchored outside the evidence bundle.

Screenshot keyframes, network logs, SIEM export, retention policy, and KMS anchoring are production milestones, not implemented claims.

## Production sequence

1. Bind `HostedRunStore` and notification occurrence stores to Postgres transactions.
2. Run the Suma-derived Playwright backend inside ephemeral task sandboxes rather than per-user workspaces.
3. Add the request-paused deterministic enforcer, managed credential injection, redirect stripping, and egress revocation input.
4. Stream screencast frames and input over a leased live-view channel; prove sub-second takeover.
5. ~~Connect the desktop client to hosted discovery, device enrollment, and reattachment.~~ Done with the cloud sync port; remaining: production hosting of control, hub, gateway fleet, and runner.
6. Add phone approval and WebAuthn step-up flows.
7. Store screenshot/network evidence, anchor signing keys in KMS, and export to SIEM.
8. Isolate web sessions per user in the fleet. Today sessions share a Chromium per worker with one `BrowserContext` per user and Space, as runs do; per-user containers or microVMs are a deployment change, not a design one.
9. Carry the pane over WebRTC with audio. Fidelity today is a JPEG screencast per visible pane, which means no sound and a frame budget; video and audio transport is a milestone with its own spec.
10. Bridge accessibility across the stream. A streamed pane is a picture, so a page's semantics do not reach the viewer's assistive technology; exposing the cloud page's accessibility tree through the shell is unbuilt.
