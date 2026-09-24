# The web browser: Pistachio in a browser tab

Revision 9 (2026-09-10). Normative for the `web-browser` branch.
Revision 7 is §14 (the first run on the web); revision 8 is §15 (two web
apps), and §13's last subsection records what building it changed. Revision 9
is §16 (the live DOM mirror), an additive second renderer behind a flag; the
pixel path is unchanged.
Revision 2 settled §8's open question; its notes are §8.1. Revision 3 recorded
S6 as implemented: §11 is a table of what the host answers and the test
that holds it, plus the `StreamShellApi` half of the socket surface. Revisions
4 and 5 are the adversarial review's pass over that — 4 the shell and the web,
5 the host, the record and the socket contract. Revision 6 is the second
review's five reproduced defects, all of them about authority: who holds the
wheel, who holds the lease, and which viewer is driving. Every change either made to a
normative claim is folded into the section it belongs to, and §13 lists them.
Companion to
[cloud-sync-design.md](cloud-sync-design.md), whose §8 (cloud browser), §8.5
(live view) and §17 (the web app as a device) this document extends rather
than repeats.

The product: open `<PISTACHIO_WEB_URL>/app/browse` in any browser and get the
desktop app. The same chrome (tabs, spaces, splits, shelf, console, settings),
the same agent acting in the same signed-in tabs, the same egress identity.
The pages themselves are Chromium tabs running on the cloud browser fleet,
streamed into the page and driven from it.

## 0. Decisions

| # | Decision | Rule |
|---|---|---|
| W1 | Real Chromium, streamed | A site is never embedded in an iframe. Every page is a tab in the cloud browser's `BrowserContext` for that user and Space, painted into the web app from a CDP screencast and driven by forwarded input. |
| W2 | The shell is shared, not forked | The desktop renderer and its `shared/` contracts move into workspace packages and the desktop consumes them from there. The web app mounts the same React tree. A feature that exists in the desktop chrome exists in the web chrome by construction, the same way the chrome manifest guarantees both layouts. |
| W3 | The host runs on the worker | The role Electron main plays today (source of truth for `ShellSnapshot`, owner of stores, executor of every `PistachioApi` call) is played by a `ShellHost` in `services/cloud-browser`. The web page is only chrome: it subscribes to snapshots and sends commands. Cookie material, page HTML and Space keys never reach the web page except the keys it already holds to unseal its own data. Control keeps storing only sealed docs. |
| W4 | Persistent session, temporary authority | A **browser session** is a durable object per user and Space that exists before, during and after any conversation. An **agent run** attaches to the session's tabs and holds authority only while it runs. A **viewer** is one web tab attached to the session. The session outlives every viewer. |
| W5 | One generic socket | The web app talks to the host over one WebSocket carrying an RPC envelope over the `ShellApi` method names, the snapshot channels the preload carries today, per-pane screencast frames, and input. Authentication is the live-view stack unchanged: origin pin, one-minute one-redemption ticket, Space-key proof before the first byte of state. |
| W6 | Geometry leaves the contract | The `PistachioApi` members that exist only to place native views over holes in the DOM (`setLayout`, glance bounds, drag capture, pointer-zone watches, pane stills, media preview) are split into `NativeSurfaceApi`. `ShellApi` is the rest. The web implements `ShellApi` only; components that need the native surface are mounted only when the surface is native. |
| W7 | Human input under a generation | The session carries `control: {holder: 'human' \| 'agent', generation}`. Every agent tool call and every forwarded input carries the generation it was issued under; the host drops anything from an older generation. Taking control bumps the generation before the first human input is accepted. |
| W8 | Leases like a desktop | A human session's sync engine uses `leaseKind: 'cloud'` for identity but acquires **non-exclusive** origin leases while no run is active, so a Mac and a web tab on the same account defer to each other under the existing rules. A run attached to the session takes exclusive leases exactly as today and releases them on completion. |
| W9 | Session state is a sealed doc | Tabs, split groups, the shelf and the active Space of a session persist as a sealed workspace record `browser-session:<spaceId>` so a session can be rebuilt on any worker. Live page state (form contents, JS heap) is preserved only while the Chromium context lives. |
| W10 | Fidelity v1 is the screencast | JPEG frames from `Page.startScreencast` per **visible** pane, sized to the pane and its device pixel ratio, resized with `Emulation.setDeviceMetricsOverride`. WebRTC video and audio are a later milestone with their own spec. |
| W11 | Isolation v1 is the context | Sessions share a Chromium per worker, one `BrowserContext` per user and Space, as runs do today. Per-user containers are a deployment milestone recorded in [architecture.md](architecture.md); nothing in this design assumes shared Chromium beyond the `SessionManager`. |
| W12 | Declared unsupported | Passkeys and WebAuthn (assertions bind to the site origin), camera and microphone inside sites, importing from local browsers (the desktop does it; sync carries the result), auto-update, and OS-reserved shortcuts in a non-installed tab. The shell shows these as unavailable rather than failing silently. |
| W13 | No new client | The desktop app is the local companion. The web app never asks for an extension or helper process. |

## 1. Repository layout

New:

- `packages/shell-contracts` (`@pistachio/shell-contracts`): everything that was `apps/desktop/src/shared/` plus the socket protocol (§5). Pure TypeScript, no React, no Electron, no Node built-ins. Consumed by desktop main, desktop renderer, the shell UI package, the worker and the web app.
- `packages/shell-ui` (`@pistachio/shell-ui`): everything that was `apps/desktop/src/renderer/src/`. React 19, zustand, Tailwind 4. Exports the shell root, the store, the theme and the stylesheet. Consumed by the desktop renderer entry and the web app.
- `services/cloud-browser/src/sessions/`: the browser session, its `ShellHost`, the shell socket server and the session claimer.
- `apps/web/app/app/browse/`: the route, the socket client implementing `ShellApi`, the streamed pane. (Revision 8: the browser is its own app, `apps/web`, and the route is its `/` — see §15.)

Changed: `apps/desktop` (imports move to the packages; `src/renderer/src/main.tsx` becomes a thin entry), `services/control` (sessions, tickets, run attachment), `packages/sync-protocol` (the session record), `packages/live-view` (per-pane frame fields), `packages/runtime` (control generation).

## 2. Stages and gates

Each stage is one or more subagent work packages. A stage is done when its gate passes on the branch, verified by the orchestrator, not reported by the implementer.

| Stage | Work | Gate |
|---|---|---|
| S1 | Extract `shell-contracts` and `shell-ui`; desktop consumes them; `ShellApi`/`NativeSurfaceApi` split; surface abstraction in the content area | `pnpm check-types` green; `apps/desktop` vitest green (same skip set); `pnpm --filter @pistachio/desktop build` succeeds; desktop e2e run compared against the recorded baseline failure list with no new failures |
| S2 | Control: `browser_sessions`, session tickets, run attachment, control generation, egress credential by session | `services/control` vitest green including new tests for every route and every refusal code in §4 |
| S3 | Worker: `BrowserSession`, `ShellHost`, shell socket server, session claimer, per-pane screencast, resize, human input under generation | `services/cloud-browser` vitest green including real-Chromium tests that drive a session over the socket: attach, open, navigate, resize, type, reconnect |
| S4 | Web: `/app/browse`, `WsShellApi`, `StreamedPane`, session attach and reconnect | `apps/web` check-types and lint green; a Playwright spec against the dev stack that opens the route, creates a tab, navigates, types into the page, reloads the outer page and finds the same tab live |
| S5 | Agent in the session: runs attach to session tabs, takeover and release under generation, threads and console in the shell | cloud-browser end-to-end test extended: a run started from the shell acts in a session tab, the person takes control, input flows, release resumes the agent |
| S6 | Completeness: find, context menu, downloads, uploads, permissions, clipboard, print, reader, session persistence and rebuild, idle suspend, docs, adversarial review | Full workspace `check-types`, `lint`, `test` green; every capability row in §11 has a test; README and architecture docs updated |

S1 and S2 are independent and run in parallel. S3 needs S1 (the contracts) and S2 (the routes). S4 needs S1 and S3. S5 needs S2 through S4. S6 follows S5.

## 3. S1: the shell packages

### 3.1 `@pistachio/shell-contracts`

`git mv apps/desktop/src/shared packages/shell-contracts/src`. Every file keeps its name. Internal relative imports gain the `.js` suffix (the package extends `@repo/typescript-config/base.json`, NodeNext, like every other source-only package; consumers under Bundler resolution, Vite, and the web's webpack `extensionAlias` all resolve `.js` to `.ts`). `package.json` exports `"./*": "./src/*.ts"` so a consumer writes `@pistachio/shell-contracts/ipc`, `@pistachio/shell-contracts/chrome`, and so on. No default export, no barrel. Scripts `check-types` and `lint` (`@repo/eslint-config/base`); `test` with vitest for the tests that move in (§3.4). Dependencies: only what the moved files already import (`zod`, `@pistachio/protocol`, `@pistachio/agent-runtime` for the re-exported views, `@pistachio/live-view`, `@pistachio/sync-protocol`). `request-upload.ts` moves too; it models an Electron shape but is pure.

`ipc.ts` splits its interface:

```ts
export interface NativeSurfaceApi { /* the members below */ }
export type ShellApi = Omit<PistachioApi, keyof NativeSurfaceApi>;
export interface PistachioApi extends ShellApi, NativeSurfaceApi {}   // unchanged for the preload
export const NATIVE_SURFACE_MEMBERS: Record<keyof NativeSurfaceApi, string>; // member → reason, ≥ 10 chars
```

A member is native-only when its implementation needs an Electron window, a `WebContentsView`, the OS pointer, or a native dialog, or when it exists only to place native views over holes in the DOM. Starting list, to be confirmed against the preload and recorded with a reason each: `setLayout`, `setGlanceBounds`, `recedeGlanceOwner`, `stageGlancePromotion`, `setDragCapture`, `setTabDragVisual`, `sendDragSample`, `onDragSample`, `setSidebarWatch`, `setPaneToolbarTrigger`, `setPaneToolbarWatch`, the pointer entered/left subscriptions, `getCursorPoint`, `prepareOverlay`, `setOverlay`, `setMediaPreview`, `setShellState`, `resizeBookmarkToast`, `dismissBookmarkToast`, `installUpdate` and the update subscription, `microphoneRequest`, `browsersDetect`, `browserImport`, `openBookmarksPage` if it only targets a native view. `getAppInfo`, `getTabSwitcherPreviews` and the find members stay in `ShellApi`: a host can answer them. A test asserts `NATIVE_SURFACE_MEMBERS` keys equal the keys of `NativeSurfaceApi` (type-level, `satisfies`) and every reason is at least ten characters, mirroring the chrome manifest's hidden-placement rule.

`ipc.ts` also exports `SHELL_EVENT_CHANNELS`: the list of `on*` members of `ShellApi` as `{member, channel}` pairs, derived from the existing `IPC` map, so a transport can map them generically (§5 uses it).

### 3.2 `@pistachio/shell-ui`

`git mv apps/desktop/src/renderer/src packages/shell-ui/src`, except `main.tsx`, which stays in the desktop as the entry. Extends `@repo/typescript-config/react-library.json`; lints with `@repo/eslint-config/react-internal`; depends on `react`, `react-dom`, `zustand`, `@radix-ui/*`, `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `@shadcn/react`, `@pistachio/shell-contracts`, `@pistachio/live-view`, `@pistachio/run-view`, `@pistachio/protocol`, `@pistachio/agent-runtime` (whatever the moved files import; nothing new). Exports:

- `"."` → `src/index.ts`: `App` (the shell root, today's `App.tsx` default), `BookmarkToastApp`, `DragApp`, `FindApp`, `ThemeRuntime`, `setShellApi`, `shellApi`, `nativeApi`, `SurfaceProvider`, `useSurface`, `useStore` and the store types.
- `"./theme.css"`, `"./shell.css"` (§3.3).
- `"./*"` → `src/*` for deep imports from tests (`@pistachio/shell-ui/lib/fuzzy.js`).

**The API seam.** `src/api.ts`:

```ts
export function setShellApi(api: ShellApi & Partial<NativeSurfaceApi>): void; // once, before first render
export function shellApi(): ShellApi;                  // throws "shell api not set" otherwise
export function nativeApi(): NativeSurfaceApi | null;  // null on a stream surface
```

Every `window.pistachio.` reference in the moved files becomes `shellApi().` or, for the native members, `nativeApi()?.`; `global.d.ts` and its `Window` augmentation leave the package (they stay in the desktop renderer folder, where `main.tsx` calls `setShellApi(window.pistachio)`). A grep for `window.pistachio` in `packages/shell-ui/src` returns nothing.

**The surface seam.** `src/surface.tsx`:

```ts
export type Surface =
  | { kind: "native" }
  | { kind: "stream"; renderPane: (tab: BrowserTabInfo, pane: { active: boolean }) => ReactNode };
export function SurfaceProvider(props: { value: Surface; children: ReactNode }): ReactNode;
export function useSurface(): Surface;
```

The desktop entry provides `{kind: "native"}`. `ContentArea` reads the surface: native → the existing bounds reporter to `nativeApi().setLayout`; stream → every pane card renders `renderPane(tab, …)` where the hole used to be and no bounds are reported. Components that only make sense over native views (`GlanceOverlay`, the media preview in `MediaStack`, the pointer-zone watches in `PaneToolbar` and `SidebarLayout`, the three drag modules' capture calls, `prepareOverlay`/`setOverlay` in the store) call `nativeApi()` and do nothing when it returns null; a stream surface must never throw or leave a pane veiled. In stream mode a glance request opens the target as a normal tab and `prepareOverlay` resolves immediately. This is the minimum; §10 refines the stream behaviours.

### 3.3 Styles

`src/styles.css` splits into `src/theme.css` (the `@theme static` block **without** the `--color-*: initial` line) and `src/shell.css` (`@source ".";` then every layer the renderer defines today). The desktop's `src/renderer/src/styles.css` becomes:

```css
@import "tailwindcss";
@theme static { --color-*: initial; }
@import "@pistachio/shell-ui/theme.css";
@import "@pistachio/shell-ui/shell.css";
```

The web app (S4) imports the same two files after its own tokens, never the reset. Tailwind's `@source` is relative to the stylesheet that declares it, so any consumer that imports `shell.css` scans the package sources.

### 3.4 The desktop after the move

- `apps/desktop/src/main/**` and `src/preload/**` import contracts from `@pistachio/shell-contracts/<name>`; no relative path into a `shared` folder survives (grep gate).
- `src/renderer/src/main.tsx` imports from `@pistachio/shell-ui`, calls `setShellApi(window.pistachio)`, wraps in `SurfaceProvider value={{kind:"native"}}`, keeps the hash routing. `global.d.ts` stays beside it. `tsconfig.web.json` includes `src/renderer` only.
- `electron.vite.config.ts`: both packages join `workspacePackages`. The renderer needs no alias.
- Tests: a test file under `apps/desktop/test` that imports nothing from `src/main` or `src/preload` moves to the package whose code it tests (`packages/shell-ui/test`, `packages/shell-contracts/test`), with its imports rewritten to package paths. Tests that exercise main-process code stay and import contracts by package name. Every moved test keeps its name and every assertion.
- `pnpm install --offline` links the new packages; no new third-party dependency is introduced in S1.

### 3.5 S1 gate

1. `pnpm check-types`, `pnpm lint` (apps/web excepted only if it already fails on `main`), `pnpm test` all green, with the desktop's pre-existing timing flakes (`egress-service` credential refresh, cloud-browser `backend-contract` guard timeout) rerun alone before being called failures.
2. `pnpm --filter @pistachio/desktop build` succeeds.
3. `grep -rn "window.pistachio" packages/` is empty except `packages/shell-ui/src/api.ts` comments; `grep -rn "shared/" apps/desktop/src` finds no relative contract import.
4. Desktop e2e (`--workers=1`) produces no failure outside the recorded baseline list (memory: `desktop-e2e-baseline-failures`).

## 4. S2: control

### 4.1 Tables (`src/db/schema.ts` + a `CREATE TABLE IF NOT EXISTS` string in `src/db/migrate.ts` + the name in `test/schema-parity.test.ts`)

`browser_sessions`: `id uuid pk`, `user_id uuid fk users cascade`, `space_id text`, composite fk `(user_id, space_id) → spaces` cascade, `state text` ∈ `ready | live | suspended | ended`, `revision integer`, `lease_worker_id text`, `lease_worker_url text`, `lease_token text`, `lease_until timestamptz`, `control_holder text` ∈ `human | agent` default `human`, `control_generation integer` default 0, `active_run_id uuid`, `last_attached_at timestamptz`, `created_at`, `updated_at`, `ended_at timestamptz`. Partial unique index on `(user_id, space_id) WHERE state <> 'ended'`: one live session per Space per account.

`session_tickets`: `secret_hash text pk`, `session_id uuid fk browser_sessions cascade`, `user_id uuid fk users cascade`, `device_id uuid`, `created_at`, `expires_at`; expiry index. Ticket prefix `pst_`, TTL `LIVE_TICKET_TTL_SECONDS` (60), swept by `runMaintenance` with the run tickets.

`hosted_runs` gains `session_id uuid null references browser_sessions(id) on delete set null`. `egress_credentials` gains `session_id uuid null` beside `run_id`.

`packages/runtime`: `HostedRunRecord.sessionId: string | null`; `create` accepts it; `claimNext(workerId, now, leaseMs, workerUrl, options?: { eligible?: (run: HostedRunRecord) => boolean })` so control can filter by placement (§4.3). `PostgresHostedRunStore` maps the column. The in-memory store and the coordinator tests cover it.

### 4.2 Wire shape

```ts
BrowserSession = { id, spaceId, state, control: { holder: 'human' | 'agent', generation: number },
                   activeRunId: string | null, worker: { id: string, until: string } | null,
                   lastAttachedAt: string | null, createdAt, updatedAt, endedAt: string | null }
```
The lease token never leaves control except to the claiming worker.

### 4.3 Routes (all under `/v1`, device bearer; the existing gate already turns a `cloud` device away and a bootstrap token into `device_required`)

- `POST /browser-sessions {spaceId}` → `201 {session}` when created, `200 {session}` when a non-ended session already exists for the Space (create-or-resume). `400 space_not_cloud_enabled` under the same test `POST /runs` uses; `503 no_cloud_browser` when `CLOUD_BROWSER_PUBLIC_URL` is unset. Audit `session.created`.
- `GET /browser-sessions?spaceId=` → `{sessions}` (non-ended, the caller's); `GET /browser-sessions/:id` → `{session}`, `404 not_found` when unowned.
- `POST /browser-sessions/:id/ticket` → `{url, ticket, expiresAt}`; `409 session_ended`; `503 no_cloud_browser`. A ticket is minted whether or not the session is leased: the worker that redeems it claims the session on demand (§6.4). Audit `session.ticket`.
- `POST /browser-sessions/:id/end` → `204`: `state = ended`, `ended_at`, lease cleared; an attached non-terminal run is revoked through `coordinator.revoke` in the same unit; the worker is steered `{kind: 'session.ended', sessionId}` (best effort, outbox on failure); egress credentials with that `session_id` are revoked like `cutRuntimeEgress`. Audit `session.ended`.
- `POST /runs` accepts `sessionId?`: `404 session_not_found` when unowned or ended, `409 session_space_mismatch` when its Space differs. A run with a session is created with `executor.kind = 'cloud'` and no start tab unless `startUrl` is given. `GET /runs/:id` and the claim response carry `sessionId`.
- Control generation lives on the session. In the same transaction: run start (claim of a run with a session) sets `holder = agent`, `generation += 1`, `active_run_id`; `interrupt` (`takeControl`) sets `holder = human`, `generation += 1`; `release` sets `holder = agent`, `generation += 1`; run terminal or `interrupt` with lease loss sets `holder = human`, `generation += 1`, `active_run_id = null`. The `{t: 'control'}` run event gains `generation`. A session with no run is always `human`.

Service bearer:

- `POST /internal/browser-sessions/:id/claim {workerId, workerUrl}` → `{session, leaseToken}`; `409 held_elsewhere` when another worker's lease is live; idempotent for the same worker (renews); `410 session_ended`. Sets `state = live`, `last_attached_at`.
- `POST /internal/browser-sessions/:id/heartbeat {leaseToken}` → `{session}`; `409 stale_lease`.
- `POST /internal/browser-sessions/:id/release {leaseToken, state: 'suspended'}` → `204`; clears the lease.
- `POST /internal/session-tickets/redeem {ticket, sessionId}` → `{userId, deviceId, platform, spaceId, workerUrl: string | null}` with the live-ticket semantics (`DELETE … RETURNING` is the authentication; expired, revoked device, wrong user → `401`).
- `POST /internal/runs/claim` gains placement: a run whose `session_id` is held by another worker under a live lease is not claimable by this worker; a run whose session is unleased is claimed **atomically with the session** (same transaction), and the response then carries `session: {id, leaseToken}`; a run whose session this worker holds is claimable as usual. `SESSION_LEASE_MS = 60_000`.
- `GET /internal/users/:id/egress-credential?deviceId=&sessionId=` is accepted as the alternative to `runId=`: the session must be the user's and non-ended. The credential row records `session_id`.

Maintenance: a `live` session whose lease expired becomes `suspended` (its `active_run_id`'s run, if still leased, is left to the run sweeper); a `suspended` session older than `SESSION_RETENTION_MS` (7 days since `updated_at`) becomes `ended`; expired session tickets are deleted.

Tests (`services/control/test/browser-sessions.test.ts`): every route above, every refusal code, create-or-resume idempotency, the partial unique index, atomic run+session claim including the `held_elsewhere` race (two workers, one wins the run and the session), generation arithmetic across start, interrupt, release, and completion, ticket redemption single use, and the maintenance transitions. `runs.test.ts` gains the `sessionId` cases.

## 5. The shell socket (`@pistachio/shell-contracts/socket`)

Path `/v1/shell/:sessionId` on the cloud browser's public address, relayed in-fleet at `/v1/internal/shell/:sessionId` exactly like the live view. Upgrade authentication is the live-view stack: `Origin` must equal `PISTACHIO_WEB_URL` when present; `?access_token=pst_…` is redeemed at control and scrubbed from logs; the viewer's device is rechecked every 60 s; pings every 25 s. After accept the host sends only `challenge` until the viewer proves the Space key; AAD is `shellProofSealAad(sessionId, nonce)` = domain `pistachio.shell.proof.v1` in `@pistachio/sync-protocol` beside `liveProofSealAad`. Two bounds hold before a frame is understood, because sessions of different people share the process: the socket sets `maxPayload` (`MAX_SOCKET_FRAME_BYTES`, 48 MiB — an upload is the largest legitimate frame), and a viewer that has not yet proved the Space key is closed `4004` if it sends more than `MAX_UNPROVEN_FRAME_BYTES` (8 KiB), before the frame is parsed rather than after.

Zod schemas, exported as `shellServerFrameSchema`, `shellClientFrameSchema`, with `encode`/`decode` helpers that never throw:

Server → client:
- `{t:'challenge', spaceId, nonce}`
- `{t:'ready', sessionId, control: {holder, generation}, downloadKey}` — after proof; the client then runs its normal `initialize()` through RPC. `downloadKey` is a secret issued to this one proven socket: a minted download URL is bound to it and the download route wants it back in `DOWNLOAD_KEY_HEADER` (§11), so the URL alone is not a credential.
- `{t:'reply', id, ok: true, result}` | `{t:'reply', id, ok: false, error: {code, message}}`; `code` ∈ `unsupported | invalid_args | failed | not_found | ended`.
- `{t:'event', channel, payload}` — `channel` from `SHELL_EVENT_CHANNELS` (§3.1); the two snapshot channels carry `ShellTabsSnapshot` and `ShellRunSnapshot` unchanged.
- `{t:'frame', tabId, data, width, height, metadata}` — `LiveFrame` plus the tab.
- `{t:'control', holder, generation}`
- `{t:'error', code, message}`; `code` ∈ `unauthorized | not_found | ended | space_key_required | lease_lost`.

Client → server:
- `{t:'auth', proof}`
- `{t:'call', id, method, args}` — `method` ∈ `SHELL_METHOD_NAMES` (the non-`on*` members of `ShellApi`, exported from `ipc.ts` as a runtime array with a type-level exhaustiveness check); `args` is a JSON array **capped at `MAX_CALL_ARGS` (8) by the frame schema itself** — no `ShellApi` member takes more, and a frame that claims to is not a call this host will make sense of. There is no per-method arity check in the envelope: what validates the arguments is each member, the way it does over Electron IPC (`isSidebarCommand`, `sanitizeSettings`, `sanitizeOnboardingCompletion`, …). An unknown method is answered `unsupported` rather than by closing the socket.
- `{t:'pane', tabId, width, height, dpr, visible}` — the pane's CSS size; `visible: false` stops the tab's screencast.
- `{t:'input', tabId, generation, event}` — `event` is `liveMouseEventSchema | liveKeyEventSchema` from `@pistachio/live-view`.

Close codes: `4003 revoked`, `4004 space_key_required`, `4005 lease_lost`, `1000 ended`.

## 6. S3: the worker

### 6.1 Layout (`services/cloud-browser/src/sessions/`)

- `browser-session.ts` — `class BrowserSession`: `{ id, userId, spaceId, control: {holder, generation}, viewers: Set<WebSocket>, space: SpaceSession, host: ShellHost, activeRunId }`, `verifySpaceProof(nonce, proof)` sealed with the session's seal key, `subscribe(listener)`, `attachViewer`, `detachViewer`, `close(reason)`.
- `shell-host.ts` — `class ShellHost implements ShellApi` in Node (no React, no Electron), the counterpart of Electron main for one session.
- `shell-server.ts` — the WebSocket server for §5, built from the same pieces as the live view.
- `session-registry.ts` — `SessionRegistry { get(sessionId), claim(sessionId, redemption), release(sessionId, state) }` with the heartbeat loop (`SESSION_LEASE_MS / 3`) and idle handling.
- `session-state.ts` — the sealed `browser-session:<spaceId>` record (§9): publish on change (debounced 1 s), restore on claim.

`live/server.ts` is refactored, not duplicated: `Screencast`, the ticket/origin/relay/keepalive/recheck machinery and the input dispatch move to `live/common.ts` and both servers use them. Every existing live-view test passes unchanged.

### 6.2 Sessions in the `SessionManager`

`acquire` gains a holder kind: `acquire(userId, spaceId, holder: {kind: 'run', runId} | {kind: 'session', sessionId})`. A session holder mints its egress credential with `sessionId=`; a run holder attached to a session reuses the session's credential (`credentialForSpace`). `SpaceSession` counts holders of both kinds; the idle timer only starts when the last holder of either kind is gone. While a session holder is present and no run is active the engine acquires **non-exclusive** leases (W8): `SpaceSyncEngine` gains `exclusiveLeases: boolean` toggled by the session (`runStarted` → exclusive, `runEnded` → non-exclusive), defaulting to today's behaviour when unset.

`PlaywrightBrowserBackend`: `openTab(url?, options?: {kind: 'human' | 'agent'})` records the kind and `listTabs()` reports it; a session's tabs are `human`, a run's `agent`. `closeTab`, `reorder` (an ordered id list the backend keeps), `setViewport(tabId, {width, height})` (`page.setViewportSize`), `favicon(tabId)` (the `<link rel="icon">` href resolved, fetched through `context.request` so it goes through the Space's cookies and egress, returned as a data URL, cached per origin), `title`/`url`/`loading`/`canGoBack`/`canGoForward` already exist.

### 6.3 `ShellHost`

Implements `ShellApi`. The snapshot rules of [architecture.md](architecture.md) hold: main (here the host) is the only source of `ShellSnapshot`; publishing is coalesced per tick and split into `pistachio:snapshot-changed` (`ShellTabsSnapshot`) and `pistachio:run-changed` (`ShellRunSnapshot`); `getSnapshot` answers whole.

S3 scope of `ShellApi` (S5 and S6 add the rest):
- Tabs: create, close, select, navigate, back, forward, reload, reorder, duplicate, restore closed, suspend/wake (lifecycle `suspended` = the page is closed and the durable tab kept; selecting it reopens and navigates). The selection publishes BEFORE the wake, with the tab in `wakingTabIds`, so the strip moves at once and shows the tab waking instead of leaving the person on the old selection watching the previous tab's frames for the length of a page load. Move to space. `BrowserTabInfo` filled from the backend, favicon as above.
- Spaces: list from the Space records the session's sync engine already holds; create/rename/delete through control (`PUT/DELETE /spaces/:id`). Switching Space switches `spaceId` on the session (one `BrowserSession` per Space; the web client opens or resumes the other Space's session and swaps sockets — the shell already treats Spaces as partitions).
- Split groups and the shelf: the pure `sidebar-controller.ts`, `tab-session.ts` and split logic move from `apps/desktop/src/main` into `@pistachio/shell-contracts` if and only if they import nothing from Electron or Node (the survey says they do not); the desktop imports them back from the package. The host and desktop main share the code path.
- Settings: `getSettings`/`setSettings` over the sealed account-global `shell-settings:default` workspace register (`SHELL_SETTINGS_KEY`, doc kind `shellSettings`), mirrored by `DesktopSettings` and held to it by the record-docs parity test. Layout and appearance apply immediately, and a change made on the Mac reaches a browser tab through the same LWW register. The key is deliberately NOT under `settings:`, which is the per-FIELD workspace registers (`settings:keyMode`) a reader folds one field at a time with `applySettingsDoc` — routing this document there would turn it into a `keyMode` doc. `resetSettings` keeps `onboarding.completed: true` on this host: `DEFAULT_SETTINGS` has it false and the shell turns that into the first-run wizard, and this browser's first run happened on the way in.
- Bookmarks, memory, reminders, artifacts: read **and write** through the `WorkspaceToolStore` the runner already has; the web app's read-only pages become writable as a side effect.
- Find in page: `findInPage`/`stopFind` via `page.evaluate` using `window.find` with match counting; the result shape is today's `FindState`.
- Zoom: `Emulation.setPageScaleFactor` is not used; zoom is `document.documentElement.style.zoom` per tab via `page.evaluate`, persisted per origin in the session state (S6 may replace it).
- `getAppInfo` → `{platform: 'web', version, chrome: browser.version()}`.
- Everything else in `ShellApi` answers `unsupported` and is listed in `shell-host.ts` under `UNSUPPORTED` with the reason a person reads in place of the affordance. In S3 the list carried the stage that would implement each member, so it shrank visibly; what is left after S6 is the declared set (§11) and nothing else.

Input: `{t:'input'}` is dispatched to the tab's guard session only when `control.holder === 'human'` and `generation === control.generation`; anything else is dropped and counted in a stat the tests read. An **accepted** input also makes its viewer the session's **driving viewer** — the addressee of a page's file picker, its clipboard mirror and its context menu (§11). A refused input does not, and neither does a read-only call: `getSnapshot` from a second browser tab must not take the picker away from the person who just clicked.

Navigation is a takeover. `navigate`, `goBack`, `goForward`, `reload` and closing a tab change the page under whoever is driving it, so on a session whose fence says `agent` the host performs an implicit takeover first: control's `interrupt`, the same path `takeControl` uses, which aborts the executor's turn and moves the generation — and only then the page changes. The generation is re-read after every await (the takeover itself, a sleeping tab's wake) and the command is refused if the fence moved again, so a person's page change is never performed under the agent's authority and never silently overwrites a turn the agent is still driving. The desktop needs none of this: there is no fence there, and the person's own window is their own.

Panes: one `Screencast` per visible tab's guard session at `maxWidth = width`, `maxHeight = height`, `quality 60`, `everyNthFrame 1` for one visible pane and `2` for more; `pane` with `visible: false` or a tab leaving `visibleTabIds` stops it; a viewer's disconnect stops all of its screencasts. `page.setViewportSize` follows the pane size (debounced 100 ms).

### 6.4 Claim on demand

An upgrade for `/v1/shell/:sessionId` redeems the ticket. When `workerUrl` names this worker or is null: claim (`POST /internal/browser-sessions/:id/claim`); on `held_elsewhere` re-read the session and relay to its `workerUrl`; on success build the `BrowserSession` (acquire the `SpaceSession`, hydrate, restore the state doc, open the restored active tab), then accept and challenge. When `workerUrl` names another live worker: relay. Heartbeats renew; a heartbeat `stale_lease` or `410` closes every viewer `4005` and tears the session down. The worker also keeps the deadline (`worker.until`) of the lease control **last confirmed** and enforces it locally: when that time passes with no successful renewal — a heartbeat that fails as a transport error tells the worker nothing — the session is treated as lease lost and goes down the same path, because control is meanwhile free to hand it to a sibling worker and two workers driving one person's tabs is what the lease exists to prevent. `session.ended` steer does the same with `1000`. Idle: `CLOUD_BROWSER_SESSION_IDLE_MS` (default 30 min) after the last viewer detaches with no active run → publish the state doc, release with `state: 'suspended'`, close the `SpaceSession` holder.

### 6.5 Tests (`services/cloud-browser/test/sessions/*.test.ts`, `describeChromium` where a page is needed)

Socket auth (ticket, origin, proof, recheck) against the fake control; claim on demand and `held_elsewhere` relay; `call tabCreate` → `event pistachio:snapshot-changed` carries the tab; `pane` → frames arrive and their size follows the pane; `input` key events land in a fixture `<input>` and a stale generation is dropped; two viewers see the same tabs; heartbeat loss closes `4005`; idle suspend publishes the record and a fresh claim restores the tabs; every existing live-view test unchanged.

## 7. S4: the web app

- `next.config.js`: `transpilePackages` gains `@pistachio/shell-ui` and `@pistachio/shell-contracts`.
- `app/app/app.css` imports `@pistachio/shell-ui/theme.css` and `@pistachio/shell-ui/shell.css` after the web's own tokens (the desktop-only tokens are additive; the reset is never imported) and adds `@source "../../../../packages/shell-ui/src";`. Verify the marketing pages are pixel-unchanged by eye and the `.pa` dark ramp still applies.
- `components/app/shell.tsx`: when the pathname starts with `/app/browse` the gate still runs, but a ready session renders the children full-bleed (`.pa-browse`: `100dvh`, no rail, no padding) instead of the rail layout. `nav-config.tsx` adds "Browse" to the Agent group.
- `lib/app/shell-socket.ts`: `class WsShellApi implements ShellApi` built generically from `SHELL_METHOD_NAMES` (each becomes `call`) and `SHELL_EVENT_CHANNELS` (each `on*` registers a listener and returns the unsubscribe). `connect({sessionId, getToken, keys, controlUrl})` mints a ticket (`POST /browser-sessions/:id/ticket`), dials, proves, resolves on `ready`. Reconnect with 1 s backoff up to five attempts, a fresh ticket per dial; on reconnect it tells the shell (`onReconnect`), which re-reads everything a first load reads — the snapshot AND the devices, sync, egress, cloud, channels, account and refusal maps that arrived once as answers (`useAppStore.resync()`); with no shell attached it falls back to `getSnapshot` and re-emits both snapshot channels; `4003` → revoked, `4005` → lease lost (retry once after 2 s: the session may be re-claimed), `1000` → ended. `pane()` and `input()` send the §5 messages; `control` frames update `WsShellApi.control` which the pane reads.
- `app/app/browse/page.tsx`: requires `state === 'ready'` and `keysFor(spaceId)`; the Space is the last used (`localStorage`) or the account's first cloud-enabled Space; a Space without cloud shows the existing enable flow. Creates or resumes the session, connects, calls `setShellApi(api)` once, then renders `<SurfaceProvider value={{kind:'stream', renderPane}}><App/></SurfaceProvider>` with `ThemeRuntime`. Errors and the locked state render the existing gate styles.
- `components/app/streamed-pane.tsx`: from `live-pane.tsx`: one `<img>` per pane at the frame's aspect ratio; `ResizeObserver` → `pane` (debounced, with `devicePixelRatio`); paints only frames for its `tabId`, one repaint per animation frame; forwards mouse, wheel (native non-passive listener) and keyboard with the current generation while `holder === 'human'`; keyboard focus follows the active pane; shows a "the agent has control" veil otherwise.
- `live-pane.tsx` remains for the run page; both import the same arithmetic.

Gate test: `apps/desktop/e2e/tests/web-browse.spec.ts`, patterned on `web-credential-capture.spec.ts`: boots control on PGlite, the cloud-browser runner with real Chromium and `egressMode: 'direct'`, a fixture site, and `next dev --webpack`; signs up, unlocks, enables the cloud, opens `/app/browse`, creates a tab to the fixture, types into its input, reloads the outer page, and asserts the same tab is listed and the fixture reports the typed value.

## 8. S5: the agent in the session

- The console's `runStart` on the host creates the run through control with `sessionId`; the claimer on this worker claims it (atomically holding the session); `RunExecutor.execute` acquires the `SpaceSession` through the session holder path and reuses the session's backend, opening an `agent` tab only when `startUrl` is given, otherwise acting in the session's active tab. The run's `ShellRunSnapshot` is the fold of run events into `RunSummary` that `apps/desktop/src/main/cloud/cloud-run-service.ts` performs today; the pure fold moves to `@pistachio/shell-contracts/run-fold` (or `@pistachio/run-view` if it already fits there) and both hosts use it.
- Control transitions (§4.3) drive `control` frames; the host bumps its local generation from the control event and drops stale input. `runTakeControl`/`runReleaseControl` in `ShellApi` map to `interrupt`/`release`.
- Approvals, questions, evidence and thread persistence are the runner's existing paths; the shell's console renders them from the snapshot as it does on the desktop.
- Test: `test/integration/end-to-end.test.ts` gains a session case: a shell socket creates a tab, starts a run with a scripted model that types into the fixture, the viewer takes control (input flows, generation bumped), releases (the model's next step runs), and the run completes with the tab still in the session.

### 8.1 Revision 2 notes (normative)

S5's open question was how the host acts for the person. It cannot be the
person: control forbids a `cloud` device from every device-bearer route, so
`POST /runs` and the sponsor routes are closed to it. What stands in for the
person is the pair the worker already holds — the service bearer, and the
**session's `leaseToken`**. The lease proves this worker holds this person's
session, which a viewer only reached by proving that Space's key (§5). The
`viewerDeviceId` is the audit actor and must be an unrevoked device of the
session's own user, so a worker cannot invent who acted.

The route family (`services/control/src/app.ts`, service bearer, all under
`/v1/internal/browser-sessions/:id`):

| Route | Body / query | Answers |
|---|---|---|
| `POST …/runs` | `{leaseToken, viewerDeviceId, intent, attachments?, startUrl?}` | `201 {runId, at, events: [{t:'run.created', run}]}` — exactly what `POST /runs {sessionId}` creates: sponsor is the session's user, `session_id` is the session, `startUrl` only when given. Audit `run.created` by `viewerDeviceId`. |
| `POST …/runs/:runId/:command` | `{leaseToken, viewerDeviceId, …}` for `message \| answer \| interrupt \| release \| revoke \| approve \| reject` | `202 {ok, status, seqs, at, events}` — the same `sponsorTransition`, the same applies, the same events and the same steer as the sponsor routes. The run must belong to the session. |
| `GET …/runs` | lease in `x-pistachio-session-lease` | `{runs: ThreadListItem[], threads: Array<{runId, spaceId, sealed}>}` for the session's Space: what `GET /runs?spaceId=` and `GET /runs/:id` give a device. |
| `GET …/runs/:runId/events?since=` | lease in `x-pistachio-session-lease` | `{events: StoredRunEvent[]}`. |

The two GETs take the lease in a **header** (`SESSION_LEASE_HEADER`), not in
the query string, and the request logger scrubs `leaseToken` and `ticket`
beside `access_token` and `secret`. A lease authorises starting, steering,
revoking and reading every run in that person's Space; control logs
`url.search` on every request, so `?leaseToken=` wrote it in the clear on
every thread-list refresh and every replay. Lease tokens are compared with
`secretEquals`, as every other bearer in control already was.

Refusals across the family: `409 stale_lease`, `404 not_found` (unknown
session, or a run outside this session), `403 viewer_device` (not this
account's device, or revoked), `410 session_ended`, `400
space_not_cloud_enabled` and `400 invalid_body`. Every one has a case in
`services/control/test/browser-sessions.test.ts`.

Two deviations from the sketch, both deliberate:

- **`GET …/runs/:runId/events` is new.** A cloud run's sealed `thread` is the
  runner's execution checkpoint, not a `RunSummary`: only a run a *desktop*
  executor mirrored carries `{version: 2, run}`. So `openThread` opens the
  snapshot when there is one and otherwise rebuilds the conversation by
  replaying and folding the stream — the desktop's own path (§7.8), without
  the SSE a `cloud` device may not subscribe to. The list route's `threads`
  is what makes the mirrored case one round trip.
- **No `DELETE …/runs/:runId` in S5, and `deleteThread` was unsupported until
  S6.** The desktop's `deleteThread` only ever removed the row from its own
  local thread store and told the cloud observer to stop following the run;
  control had no route that deletes one. A session's thread list *is*
  control's list, so there was nothing local to forget, and a real delete
  needed a route control did not have. It was the one console member S5 could
  not answer. **S6 added the route** — `DELETE
  /v1/internal/browser-sessions/:id/runs/:runId` hides the run from every list
  (`hosted_runs.hidden_at`) and keeps its events — so `deleteThread` is
  answered and is no longer in `UNSUPPORTED` (§11, "Forgetting a
  conversation").

Also settled in S5:

- `POST /internal/runs/claim` answers `session: {id, leaseToken, generation}`.
  The generation is the fence control moved to `agent` in the claim's own
  transaction, so the worker raises its own the moment it adopts the session
  rather than waiting a heartbeat.
- `SessionRegistry.adopt` takes a session this worker got *with* a run rather
  than claiming a second lease; `refresh` re-reads the fence when a run ends.
  One lease, one heartbeat loop per session, whichever way the worker came by
  it.
- `RunEventWriter.mirror` hands the executor's callbacks to the session's
  `ShellHost` **in the clear, in the same process**, before they are sealed.
  That is why the open run's snapshot never waits on a stream.
- The `RunSummary` fold moved out of `apps/desktop/src/main/cloud/cloud-run-service.ts`
  into `@pistachio/shell-contracts/run-fold` (`parseStoredRunEvent`,
  `parseContentEvent`, `foldRunInto`, `desktopThreadRun`, `webStartUrl`), and
  both hosts use it.
- `newThread` clears the console, as it does on the desktop; the run itself is
  created by the `startDelegation` that follows, because a thread with no
  intent is not something control can be asked for.
- `openLiveView` is REFUSED with a reason (it is in `UNSUPPORTED`, §11): the
  pane *is* the live view (W1, W10). Revision 3 had it answer success and do
  nothing, which is worse than a refusal — the store raises the overlay on
  `liveState: "open"`, `onCloudFrame` never emits and `sendLiveInput` is
  empty, so every cloud run in a browser tab offered a blank rectangle that
  said "you have control" and discarded both. `closeLiveView` and
  `sendLiveInput` stay no-ops, which is honest: there is nothing to close, and
  forwarded input travels as `{t:'input'}` on the shell socket under the
  session's own generation.
- A run acting in a session opens `kind: 'agent'` tabs in the same context,
  and the host adopts any it did not open itself into the strip; a `human`
  page the host has no record of is not adopted (it is a leftover from a
  context this session no longer owns).
- `packages/live-view` `keyInput` now carries `text` for Enter (`"\r"`) and
  Tab (`"\t"`): CDP raises no `keypress` without it, so implicit form
  submission never fired. The desktop live view benefits too.

## 9. The session record

`packages/sync-protocol/src/records.ts` adds `browser-session:<spaceId>` as a sealed LWW register under the workspace key:

```ts
{ version: 2, spaceId,
  tabs: Array<{ id, url, title, favicon: string | null, kind: 'human',
                pinnedAnchor?: string, lastActiveAt?: number }>,
  activeTabId: string | null, splitGroups: SplitGroup[], shelf: SidebarState,
  zoom: Record<originHost, number>,
  permissions: Record<origin, Record<BrowserPermission, 'ask' | 'allow' | 'block'>>,
  updatedAt }
```

**Why the version moved.** `permissions` was added in S6 without moving it, so
a session that bounced to a pre-S6 worker came back with every grant dropped
— and rewritten. Reading now decides whether a session may ever WRITE, which
is the load-bearing half: `SessionStateStore.read` tells "nothing is stored"
(publishing is right, and it is the only case that is) from "a record written
by a build I do not know" and "a record I could only read by dropping part of
it — a permission name, a two-hundred-and-first tab". In the last two the
session browses and restores, and never publishes; refusing to read would
otherwise be worse than reading badly, because the next publish wins LWW with
an empty session and takes every tab on every device with it.

**`permissions` is keyed by origin.** Not by host: `.host` made
`http://bank.example` and `https://bank.example` one site, so a grant the
person gave the secure origin was spent by the plaintext one.

**`lastActiveAt` travels** so a rebuilt session's tab switcher is
most-recently-used, not insertion order, which is what the desktop persists.

**A reader tab is not in the record.** Its address IS the article (a
`data:text/html,…` document), so persisting it put page HTML into the
workspace — which security.md says never leaves the worker — and pushed the
document past the hub's 8 MiB frame cap after a few long pieces, at which
point the whole record silently stopped syncing. The reader view is a
rendering of a tab that IS in the record; it is rebuilt, not stored.

`@pistachio/shell-contracts/tab-session` gets the structural mirror and the existing record-docs parity test (`apps/desktop/test/record-docs.test.ts`, moved with its siblings in S1) asserts assignability both ways.

## 10. Stream-surface behaviours in the shared shell

| Native behaviour | On a stream surface |
|---|---|
| Bounds reporting (`setLayout`) | None; the pane is DOM |
| Glance (hover preview in its own view) | Opens the target as a tab beside the current one |
| Media preview in the sidebar (re-parented native view) | Hidden; the media stack still lists playing tabs and mute works |
| Pointer-zone watches (OS cursor polling) | CSS hover and DOM pointer events |
| Drag capture over native views | Ordinary pointer capture in the DOM |
| `prepareOverlay` still capture | Resolves immediately; the pane keeps painting |
| Tab switcher previews | Host screenshots through `getTabSwitcherPreviews` |
| Traffic-light padding, window drag regions | None |
| Live view of a cloud run (an overlay over the page area) | None: a run in this session acts in these very tabs, so the pane already IS the live view. `openLiveView` is refused, the store remembers the refusal, and the console header, the takeover card and Settings → Cloud drop the Monitor button rather than raising an empty overlay that says "you have control" |
| A page's file picker (Chromium opens it) | An affordance the person clicks, which opens this browser's own `<input type=file>` with their activation behind it (§11, Uploads) |
| The editing verbs of the context menu (Chromium performs `role`) | `streamEditRow`: a label and a call or a forwarded chord per role (§11, Context menu) |
| A favorite pulled into a split stops following its shelf tile | It keeps following: there is no native tile for a pane to stop following here. `SidebarController` takes an `anchorLeavesOnSplit` override for exactly this and the host passes `() => false`; before the override the controller assigned the desktop rule over whatever the host had set, so this row was documented and not implemented |

## 11. S6 capability table

Revision 5 (S6, implemented; the adversarial review's corrections folded in).
Every row below is answered by the host and covered by a named test; the last
row is what is declared unsupported and stays that way (W12).

Two things the shell needs are not `ShellApi` members, because they exist only
when the page is a picture in somebody else's browser: uploading a file the
person picked *there*, and pasting from *their* clipboard. Those live in
`StreamShellApi` (`@pistachio/shell-contracts/socket`), with its own
`STREAM_METHOD_NAMES` and `STREAM_EVENT_CHANNELS` held to the interface by the
same exhaustiveness trick `ipc.ts` uses; the socket's `call.method` and
`event.channel` are the union of both surfaces, and `WsShellApi` and
`ShellHost` implement both. The members:

| Member | Direction | What it is |
|---|---|---|
| `onFileRequest` | event `pistachio:file-request` | `page.on('filechooser')` → `{requestId, tabId, multiple, accept}`; the pane opens a real `<input type=file>` |
| `provideFiles(requestId, files)` | call | `{name, type, base64}[]`, ≤ 32 MiB (`MAX_UPLOAD_BYTES`) in all, into the waiting `setFiles` |
| `cancelFileRequest(requestId)` | call | the person dismissed the picker; the page is told rather than left waiting |
| `onClipboardCopy` | event `pistachio:clipboard-copy` | the tab's init script mirrors `copy`/`cut`; the pane writes `navigator.clipboard` |
| `pasteText(tabId, text)` | call | `Input.insertText` into the focused field, which is what a real paste does |
| `downloadUrl(downloadId)` | call | `{url}` = `GET /v1/shell/:sessionId/downloads/:id?access_token=…`, one use, 60 s, and only half a credential: the request must also carry this viewer's own download key (`ready.downloadKey`, in `DOWNLOAD_KEY_HEADER` = `x-pistachio-download-key`), so a URL that leaves the tab — into a log, a chat message, somebody's history — opens nothing. A header is not something `window.open` can set, so the pane **fetches** the URL and hands the blob to the person from an `<a download>`; the route therefore answers the CORS preflight, for `PISTACHIO_WEB_URL` and never `*`, and pins `Origin` on the GET. It relays in-fleet at `/v1/internal/shell/:sessionId/downloads/:id` (service bearer) exactly as the socket upgrade does, so the fleet's one public address does not make a download a coin flip on which worker answered |
| `printToPdf(tabId)` | call | `page.pdf()`, recorded as a download |
| `onContextMenu` | event `pistachio:context-menu` | the init script's hit report `{tabId, x, y, target}`, `target` being `PageContextMenuParams` |
| `setGeolocation(tabId, position)` | call | `context.setGeolocation` with the position the person's own browser gave |

| Capability | Implementation | Test |
|---|---|---|
| Find in page | §6.3, `window.find` plus a text scan | `ShellHost > counts matches for find in page, and clears on close` |
| Context menu | The tab init script (`sessions/tab-bridge.ts`) reports the hit target on `contextmenu` through one exposed binding — named per session and hidden from `Object.keys(globalThis)`, so there is no fixed global for a site to fingerprint the cloud browser by or to probe — `page-context-menu.ts` moved to `@pistachio/shell-contracts` (pure: Electron's `PageContextMenuParams`/`ContextMenuTemplateItem` became structural subsets, and the desktop imports it back), and `PaneContextMenu` renders its template as DOM. Actions map to `ShellApi`/`StreamShellApi` calls. What the desktop gets from Electron and a DOM menu has to supply itself is in `@pistachio/shell-ui`'s `lib/stream-menu.ts`, pure and tested: `streamMenuState` (history from the tab, reader state from the `data:` address a cloud reader tab has, and copy/paste/download/print from `getBrowserControls`' own verdicts — never a hard-coded `true`), `streamEditRow` (the `role` rows, which arrive with no label and no click: paste through `pasteText`, copy and cut from the report's own `selectionText`, cut and delete through a forwarded `Backspace`, undo/redo/select-all through forwarded `Ctrl` chords, which is what the WORKER's Chromium binds — the fleet is Linux, and `getAppInfo().platform` stays `"web"` rather than growing a field for a darwin worker that only happens on a developer's machine), `streamMediaFlags` (loop, controls and picture-in-picture are disabled rather than offered: `MediaControl` has no such command and a PiP window is not in the screencast) and `acceleratorLabel` (Electron's `CommandOrControl+R` shown as the viewer's own `⌘R`). | `S6 capabilities > reports what the pointer was over on a right-click, with the link the shell's menu needs`; `apps/desktop/test/page-context-menu.test.ts` unchanged |
| Downloads | The Space's context has `acceptDownloads: true` — it is W11's one context per user and Space, and it serves runs and sessions alike — but a download is only KEPT when a session host has CLAIMED the context (`claimDownloads()`, released when the host closes). Only a session host has somewhere to put the bytes, a policy verdict to apply and a sweep behind it, so a download that starts on the ordinary hosted-run path is cancelled where it starts rather than filling the worker's disk from a page an agent visited. A claimed one lands in `CLOUD_BROWSER_STATE_DIR/<userId>/downloads/<id>-<name>` with the existing `BrowserDownload` shape, `getDownloads`/`onDownloadsChanged`. Retention is a sweep of the DIRECTORY (`sweepDirectory`, at most one pass per five minutes and again on `close()`), not of the records a live session happens to hold, plus a per-user quota (`DOWNLOAD_QUOTA_BYTES`, 2 GiB, oldest settled file first): bytes from a suspended or ended session used to stay for ever. The shell fetches through the minted URL, which the shell server answers as its one plain HTTP route | `S6 capabilities > keeps a download's bytes and serves them once through a viewer-bound URL`; `S6 capabilities > sweeps a download's bytes and its record once the retention window is past`; e2e `the web app opens a cloud tab…` (a fixture download lists, the bytes on disk match, and "Open" opens the one-use URL) |
| Uploads | `page.on('filechooser')` → `provideFiles`/`cancelFileRequest`. The pane does **not** open the picker from the socket callback: a file dialog needs transient activation, so a request raises a "Choose file" affordance and the person's click opens the real `<input type=file>`. Dismissing it — the native `cancel`, the button, or Escape — cancels the request; a viewer with no pane for that tab ignores the request rather than cancelling somebody else's | `S6 capabilities > turns a page's file picker into a request the pane answers, and the bytes land in the input`; `…refuses an upload over the 32 MB one call may carry`; e2e (a picker opens in the outer browser and the fixture reports the file) |
| Site permissions | The init script wraps `Geolocation.prototype` (not the instance — the prototype's method is one line of page script away otherwise) and `Notification.requestPermission`, and awaits the shell's answer, so a site's prompt becomes `BrowserControlsSnapshot.pendingPermissions`. The origin of a prompt is the CALLING FRAME's, resolved by Playwright from the binding's source — never what the page put in the payload, which let any third-party frame name an origin the person had already allowed and be answered from the stored decision. `browserControl({type:'resolvePermission'})` applies it with `context.grantPermissions` and remembers it **per origin** (scheme included) in the sealed session record. A grant is revoked as well as given: "Allow this time" revokes the context grant once the page's parked call has spent it, and "Block" revokes a live one. Playwright has no per-origin revoke — `clearPermissions()` is whole-context — so resetting one site re-grants every other site's stored `allow` immediately afterwards. `getUserMedia` always refuses with the W12 message; `passkeys` reports unavailable. | `S6 capabilities > prompts for geolocation, remembers the answer, and gives the page the emulated position`; `…blocks a site the person blocked, without asking again` |
| Clipboard | Copy mirrored through the binding; paste through `Input.insertText` | `S6 capabilities > mirrors a page's copy to the pane, and pastes the person's clipboard into the page` |
| Print | `page.pdf()` served as a download | `S6 capabilities > prints a tab to a PDF that appears as a download` |
| Reader | `READER_EXTRACT_SCRIPT` lifted to `@pistachio/shell-contracts/reader-extract` (the desktop runs it through `executeJavaScript`, the host through `page.evaluate`); the article renders to a self-contained document opened as a `data:` URL in a tab beside the original. There is no `pistachio://` protocol in a cloud tab, and a `data:` document makes no request — so the tab is navigated directly rather than through the SSRF policy, which rightly refuses every scheme a page can ask for. The reader tab is deliberately NOT in the session record (§9): its address is the whole article, and it is a rendering of a tab that is in the record, so it is rebuilt rather than stored. | `S6 capabilities > shows an article as a reader page beside the tab it came from`; `…answers false rather than opening a reader tab for a page with no article` |
| Read aloud | Not synthesized: `getReadAloud` answers the truth (nothing is generating) and `cancelReadAloud` is unsupported | covered by the unsupported-list test |
| Media stack | The init script reports the page's most interesting player as a `TabMediaReport`; `getMedia`/`onMediaChanged` publish `BrowserMediaInfo`, `controlMedia` drives the element with `page.evaluate` | `S6 capabilities > lists the playing media in a tab and mutes it` |
| Tab switcher | `getTabSwitcherPreviews` from host screenshots, newest-active first | `S6 capabilities > captures a still for each recent tab in the switcher` |
| Glance | §10: `openGlance` opens the target as a tab beside the current one and there is never an overlay | `S6 capabilities > opens a glance target as a tab beside the current one (§10)` |
| Session persistence | §6.4 and §9 | `session-registry` suite, unchanged |
| Zoom | Per origin host, applied as `documentElement.style.zoom` (not the compositor's page scale, which would break the pane's pointer arithmetic), persisted in the session record and re-applied on wake | `S6 capabilities > zooms per origin, applies it to the page, and keeps it in the durable record` |
| Browsing data | `context.clearCookies` + `clearPermissions` + per-page storage clear | `S6 capabilities > clears the Space's cookies and page storage` |
| Bookmarks, memory, reminders, artifacts | `WorkspaceToolStore.person()` — the same registers, seals and LWW the agent's tool hosts use, sourced `{kind:'user', runId:null}`; `onRecordsChanged` republishes every snapshot, so a correction another device made lands here too | `S6 capabilities > writes bookmarks, memories and reminders as the person…`; `…publishes a fresh snapshot to the shell whenever a record changes` |
| Onboarding | The host reports `onboarding.completed` for the session — this browser's first run happened on the way in — so `ShellTree`'s local `closeOnboarding()` is gone; `completeOnboarding` writes the name, the about and the facts as memories and the favorites onto the shelf | `S6 capabilities > finishes the walkthrough by writing what it gathered, not by pretending it ran` |
| Forgetting a conversation | `DELETE /v1/internal/browser-sessions/:id/runs/:runId` hides the run from every list (`hosted_runs.hidden_at`) and keeps its events; §8.1's "no delete route" is answered | control `DELETE /internal/browser-sessions/:id/runs/:runId > hides a finished conversation from every list and keeps its events` (+ three refusal cases) |
| Moving a tab between Spaces | A hand-off: the tab is written into the destination Space's sealed session record and closed here, so that Space's session opens it on next attach (W9: the live page state does not travel) | `S6 capabilities > hands a tab to another Space…`; `…refuses a hand-off to a Space this account does not have` |
| `held_elsewhere` | `GET /v1/internal/browser-sessions/:id` tells the worker where the session went, and the shell socket relays instead of refusing `409` | control `GET /internal/browser-sessions/:id > tells a worker where the session is…` |
| Unsupported (W12) | `ShellApi` members answer `unsupported` with a READABLE REASON, which the shell shows in place of the affordance; the settings sections whose whole subject the host refuses render `Unavailable` with that reason | `the unsupported list > names only real ShellApi methods…`; `ShellHost > refuses a member it will never answer with the reason the shell shows` |

**W7's other half lives in `runs/control-fence.ts`.** The decision says
"every agent tool call and every forwarded input carries the generation it was
issued under; the host drops anything older", and until the review only
forwarded input did: taking control aborts the executor's TURN, but a
`page.click` the model had already dispatched is a promise in flight and lands
on whatever the person is now looking at — precisely the case the fence
exists to prevent. `fencedBrowser` wraps the backend a run drives, stamps each
tool dispatch with the generation the run holds the wheel under, and re-checks
it immediately before the Playwright/CDP call, after every await the dispatch
went through; an action issued under an older fence raises `ControlLostError`
and is not performed. Reads (`listTabs`, `inspect`, `screenshot`) are
deliberately not fenced, or the turn that resumes after a release would start
blind. On `cmd.release` the executor re-reads the fence from control before
resuming, so the agent never dispatches while the session still says the
person holds the wheel. The three `StreamShellApi` members that mutate the
page for the person — `pasteText`, `provideFiles`, `printToPdf` — are refused
while `control.holder === 'agent'`: they are forwarded input by another name,
and they apply the same guarded-action verdicts (`paste`, `upload`, `print`)
the site-controls surface shows.

**The unsupported list, in full.** Two groups, both with reasons a person can
read (`UNSUPPORTED` in `sessions/shell-host.ts`):

- *W12 and its neighbours*: `openLiveView` (the pane already is the live
  view, §10), `forkSpace` (a live browser profile is the desktop's to clone),
  `submitFeedback`, `cancelReadAloud`, `transcribeSpeech`,
  `extractOnboardingIntake`, `openBookmarksPage`, `acknowledgeReminders` and
  `snoozeReminder` (a reminder's fired occurrences are the firing host's own
  log and carry no synced record, §9). Passkeys and camera/microphone are
  refused inside `browserControl` and the page bridge rather than as members,
  because that is where a site asks for them; auto-update is reported as
  `UpdateState.status === 'unsupported'`, which the settings section already
  renders.
- *Managed from the web app's settings pages*: the account and its AI usage,
  devices, sync, egress, cloud, channels, iMessage, the vault and integrations
  — every one of which has a page in the web app, signed in as this person,
  talking to control directly. A worker acting as a `cloud` device could not
  drive them anyway.

**A refusal has to reach the person, not just the caller.** The store keeps
two maps: `unavailable` (the host answered `unsupported`; its reason replaces
the affordance, W12) and `failed` (the call broke). They are deliberately not
one map, because a getter that failed must not be rendered as a fact — a
`getCloudStatus` that 500s once used to read as "the cloud browser is off"
beside a button that would have worked. Members the initial load probes are
recorded there; the three that it cannot probe are recorded at first use
(`vaultList` and `integrationProviders`, which the vault and integrations
pages call themselves) or on the first attempt (`openLiveView`). Both maps are
rebuilt whenever the shell re-reads, which it does after every reconnect
(§7).

**Not done, and named as such.** The pane is pixels: a screen reader has no DOM
to walk, and mirroring the page's accessibility tree over the socket — the
semantic bridge — is a milestone of its own. What S6 adds is the floor a
browser can honestly offer about a picture: the pane is a named `region`
carrying the tab's title and address, `aria-busy` until the first frame, a
polite live region announcing the active tab, and the skip link restored on the
full-bleed route.

Docs: README, architecture.md (planes: the web client and the host; production
sequence), security.md (the web page's trust boundary: pixels and snapshots,
never cookies), this document's status. Adversarial review of the whole branch
with each finding fixed under a regression test.

## 12. Environment

New: `CLOUD_BROWSER_SESSION_IDLE_MS` (worker, default 1 800 000). Every new variable is added to `turbo.json` `globalEnv` or turbo drops it. No new third-party dependency in any stage without the orchestrator's sign-off. Agents never run `pnpm install` with the network; workspace links are refreshed with `pnpm install --offline`.

## 13. Revisions 4, 5, 6 and 8: what changed

The adversarial reviews of `ec4c9dc..1c086f5` are folded into the sections
above; this is the index, so a reader of revision 3 can see what moved. Each
entry names the claim that was wrong, not the code that was. The last
subsection is not a review: it is what building §15's split actually moved.

**In the shell and the web app** (revision 4).

- §11, Context menu: the `role` rows had no label and no click on the web —
  seven blank, enabled, inert buttons where undo, cut, copy and paste live.
  They are now labelled and performed (`streamEditRow`).
- §11, Context menu: the menu's state was a row of hard-coded `true`s. It now
  comes from the tab (history, reader) and from `getBrowserControls`
  (copy, paste, download, print). A `getBrowserControls` that fails no longer
  reads as permission: the shell's neutral snapshot holds every guarded action
  BLOCKED and the site-controls panel says the controls could not be loaded.
- §11, Context menu: the three media checkboxes were offered for any player
  and then answered "not available over a streamed pane". They are disabled.
- §11, Uploads: the pane opened the picker from the socket callback, which a
  browser refuses without transient activation — and after which neither
  `change` nor `cancel` fires, so the page waits forever. A request now raises
  an affordance, and a viewer with no pane for that tab neither opens a picker
  nor cancels one.
- §10: the live view was raised over every cloud run in a web tab and painted
  nothing while saying "you have control". `openLiveView` is refused, the
  refusal is remembered, and the button is gone.
- §11: three settings pages carried a W12 guard that could never fire
  (`vaultList`, `integrationProviders`) or none at all (the account, whose
  form could never submit). All three are guarded now, and the two members the
  initial load cannot probe are recorded at first use.
- §11: `unsupported` and "that failed" are now different states with different
  words, so an outage is never rendered as a fact about the account.
- §7: a reconnect re-read only the snapshot; everything else the shell holds
  kept whatever the first load got, for the life of the page.
- Menu accelerators were rendered in Electron's spelling
  (`CommandOrControl+R`) instead of the viewer's (`⌘R`, `Ctrl+R`).

**In the record, the host and the socket** (revision 5).

- §9: the record is version 2 (`permissions`, `lastActiveAt`), a version this
  build does not know is refused rather than half-read, and — the load-bearing
  half — a session that could not read the record never publishes one, so
  refusing to read cannot cost a person every tab on every device.
- §9: `permissions` is keyed by ORIGIN, not by host, so a grant given to
  `https://` is not spent by `http://`.
- §9: a reader tab is no longer persisted; its address is the whole article,
  which put page HTML in the workspace and pushed the record past the hub's
  frame cap, at which point the record silently stopped syncing.
- §6.3: the shell's settings are a sealed workspace document of their own
  (`shell-settings:default`, kind `shellSettings`) instead of memory the
  worker lost on every suspend; the `settings:` prefix was, and remains, the
  per-field registers. `resetSettings` no longer reopens the walkthrough over
  a live session.
- §6.3: `wakingTabIds` is populated and the selection publishes before the
  wake, so the strip moves when the person clicks rather than after the page
  opens.
- §5: `ready` carries `downloadKey`; `DOWNLOAD_KEY_HEADER` makes the download
  URL half a credential (and is why the pane FETCHES it, §11); `call.args` is
  capped at `MAX_CALL_ARGS` and the "per-method arity and shape validation"
  sentence is corrected to what the code does; the socket has a `maxPayload`
  and closes an unproven viewer that sends more than 8 KiB before parsing it.
- §8.1: the session lease travels in `x-pistachio-session-lease` on the two
  GETs instead of a query string control writes to its log, and is compared
  in constant time.
- §8.1: `openLiveView` is refused rather than answering a success it cannot
  keep.
- §11: W7's agent half exists (`runs/control-fence.ts`), and the three
  page-mutating `StreamShellApi` members are refused while the agent holds
  control.
- §11: the permission prompt's origin is the calling frame's, the geolocation
  shim is on the prototype, `notifications` is wrapped, "allow once" and
  "block" revoke at the context, and the page binding's name is per session
  and hidden.
- §11: downloads are cancelled unless a session host claimed the context,
  swept by directory with a per-user quota, and served over a route that
  relays in-fleet and answers a preflight for the web app's origin alone.
- §10: the shelf's `anchorLeavesOnSplit` override exists, so the documented
  stream behaviour is the implemented one.

**In the prose.** security.md now states the actual key-retention behaviour
(the web app's opt-in 30-day IndexedDB vault of derived keys), the actual
contents of the boundary in both directions after S6, and the download URL's
actual bindings — which, with the viewer key and the relay in place, its
"viewer-bound" claim is true of for the first time; architecture.md and README describe the `UNSUPPORTED` list
that exists rather than the S3 one; §6.3 names `UNSUPPORTED`, not
`UNSUPPORTED_IN_S3`; §8.1's "`deleteThread` stays unsupported" is answered by
the route S6 added.

**In authority** (revision 6). Five defects, each reproduced by the reviewer,
each now held by a named test in `services/cloud-browser/test/sessions/`.

- W7, the agent's side: the fence's checks ended before `work()` entered the
  backend, and a tool call is not one Playwright call —
  `PlaywrightBrowserBackend.type` prepares the focus, awaits that round trip
  and then types. A takeover landing in that await put the agent's text in the
  field the person had moved to. The fence now travels INTO the backend (an
  `AsyncLocalStorage` the wrapper installs for the duration of the call), and
  the backend re-checks it immediately before each mutation —
  `takeover.test.ts`, "does not let the agent's keystrokes reach the field the
  person moved to".
- §6.3, navigation is a takeover: `navigate`, `goBack`, `goForward`, `reload`
  and tab closing bypassed the control check the other page-mutating members
  make, so the address bar could replace the page under a running turn while
  the session still reported `agent`. They now perform the implicit takeover
  described in §6.3 and re-check the generation after every await —
  `takeover.test.ts`, "takes control through control's interrupt before the
  page changes".
- §6.4, the lease is enforced locally too: a heartbeat that failed as a
  transport error only logged and retried, so with control unreachable a
  session went on accepting input long past its lease while another worker was
  free to claim it. The worker now keeps the last confirmed `leaseUntil` and
  tears the session down at it, exactly as a `stale_lease` does —
  `session-registry.test.ts`, "stops serving the session once the confirmed
  lease has run out".
- §6.4, the registry owns the end of a run: the executor cleared the session's
  `activeRunId` before asking for a refresh, and the registry only started a
  viewerless session's idle clock when the refresh itself witnessed the
  transition — so an unattended Chromium outlived its idle deadline for ever.
  The executor now tells the registry the run ended (`runEnded`), and the
  registry starts the clock from what is true rather than from what it
  happened to see change — `session-registry.test.ts`, "releases the session
  even though the executor cleared activeRunId first".
- §11, the driving viewer: raw input did not set it and every RPC did, so with
  two viewers attached one viewer's `getSnapshot` took the file picker away
  from the other viewer's click, and the person who clicked could not answer
  it. Accepted input now sets the driving viewer, read-only calls leave it
  alone, and a page's file request, clipboard mirror and context menu go to
  the viewer whose accepted input caused them — `driving-viewer.test.ts`,
  "goes to the viewer whose input raised it, not the one that last read the
  snapshot".

**Revision 7, the host side of the first run** (§14, implemented). Four
things the host had wrong or did not have at all.

- §6.3, the walkthrough flag was not a flag. `ShellHost` forced
  `onboarding.completed` true on every read AND every write
  (`#withWalkthroughDone`), so `updateSettings({onboarding: {completed:
  false}})` from the web was accepted, rewritten, and published as `true` —
  a first run on the web could not be expressed at all, and the store's
  first-load rule had nothing to open on. The forcing is gone. What is left
  is one deliberate default: the host's OWN starting settings say completed,
  which is the answer for an account with no `shell-settings:default` record
  (a Mac onboarded them; the record has not synced yet). `resetSettings`
  still keeps the walkthrough done, for the reason it always did — a reset is
  not a request to be onboarded over a live session. Tests:
  `shell-host-fixes.test.ts`, "the walkthrough flag" (three cases) and
  "settings > a reset does not reopen the Mac's walkthrough over a live
  browser session".
- §14, naming the first Space. The host could read the account's Space
  records and never write one, so the walkthrough's second effect had nowhere
  to land. `WorkspaceToolStore.putSpace` publishes the sealed `space:<id>`
  doc the way `putShellSettings` publishes its own and the desktop's
  `SpaceStore` publishes this one; `completeOnboarding` renames through it,
  keeping every other field of a Space that already has a record, and the
  snapshot shows the new name at once. Tests: `shell-host-fixes.test.ts`,
  "naming the first Space" (two cases).
- §14, the welcome pages had one implementation and two hosts needing it. The
  pure builders moved to `@pistachio/shell-contracts/welcome-pages`
  (`welcomeLessons`, `welcomeOverviewHtml`, `welcomeLessonHtml`,
  `welcomePage`, `welcomePalette`, `WELCOME_VIDEOS`, the icons and the CSS),
  parameterised by `linkBase`, `assetBase` and `fontSrc`; the desktop keeps
  `setWelcomeContext`, the `pistachio://` routing, `assetResponse` and
  `geistFont`, and its output is pinned BYTE FOR BYTE against fixtures
  captured from the pre-lift file (`apps/desktop/test/welcome-pages.test.ts`,
  five documents). With `fontSrc: null` there is no `@font-face` and the
  pages take a system stack, which is the honest answer where no protocol can
  serve a woff2.
- §14, the welcome tabs on the host. `completeOnboarding` with
  `openWelcomeTabs` opens each `WELCOME_TABS` entry as a host-rendered
  document — the reader's mechanism (§11): a `data:` document the tab is
  navigated to directly, since it makes no request for the SSRF policy to
  vet. Two things are new on top of the reader. The tab's DISPLAYED address
  is the page's own `pistachio://` one, and that is also what the sealed
  record carries, so a welcome tab IS restorable (unlike a reader tab) —
  restorable by logical address: `#wake` re-renders it rather than navigating
  to a scheme this Chromium has no handler for. And a `pistachio://` link
  inside a `data:` document cannot navigate, so **the click is intercepted**:
  the page bridge reports an anchor click whose href carries the browser's own
  scheme (`{kind: "link"}`, `preventDefault`), and the host re-renders that
  tab with the page the link named. Rewriting the links to the next
  document's `data:` address is not an option — the pages link to each other
  in both directions, so each address would have to contain the others.
  What makes a tab a welcome tab is the document it is SHOWING, keyed by
  address in `#welcomeDocuments`, which is what keeps Back, Forward and
  Reload honest for free and stops it being one the moment the page changes.
  Tests: `shell-capabilities.test.ts`, "opens the welcome pages as documents
  of its own, at the addresses they are written at", "greets the person by
  their first name on the welcome overview", "follows a lesson link inside a
  welcome page without leaving the welcome set", "rebuilds the welcome tabs
  on restore instead of storing their documents".
- §6.4, a retire said it was done before it was. `SessionRegistry` dropped a
  session from `#held` — which is what `get()` answers from, and what a
  caller reads as "this worker is finished with it" — as the FIRST thing a
  retire did, then flushed the record and gave the lease back. For the length
  of a round trip to control the registry claimed to have let go of a session
  whose lease it still held, which a machine under load turns into a real
  failure (`session-registry.test.ts`, "idles when the run it was holding
  open ends" and "releases the session even though the executor cleared
  activeRunId first", both reading control's row the moment the registry says
  it is done). The drop moved to the end, in a `finally` so a failing close
  still releases the Space holder. Nothing sees a half-retired session in the
  window: `BrowserSession.close()` marks it closed on its first synchronous
  line, both readers of `get()` already refuse a closed session as they
  refuse a missing one, and `claim()` waits out `#settleRetire` before it
  looks at all.

**Revision 7, the first frame a pane is given** (§6.3, §11). The welcome
overview painted "Opening…" for ever under load, and the reason was not the
one everybody assumed.

- **`Page.captureScreenshot` does not fail when it cannot answer — it never
  settles.** Chromium serves a screenshot out of the page's compositor, and a
  page that is not the front one in its context produces no frames to serve.
  That is the ordinary state of every welcome tab but the last one the host
  opened, and of every tab behind the active one. `Screencast.snapshot()`
  awaited it with no deadline, and `#attachPane` awaited THAT before
  registering the viewer — so one backgrounded tab parked the whole attach:
  no live emitter, no `Page.startScreencast`, no retry, `pending` never
  decremented, and a pane that said "Opening…" for the life of the session.
  Passing alone and failing under load is exactly the shape of the race: it
  turns on whether the pane's `pane` message arrives before or after the host
  has opened the other three welcome tabs on top of it.
  `snapshot()` is now bounded (`SNAPSHOT_TIMEOUT_MS`, 2 s) and
  `#attachPane`/`#attachStream` register the viewer with the stream BEFORE
  they wait on a still, so the page's own frames paint the pane whatever the
  screenshot does.
- **A first frame is retried, not hoped for.** A screencast is silent
  whenever the page is, and a welcome document is silent for ever — so a
  viewer's whole picture was the one-off snapshot taken when its pane joined.
  `Screencast.ensurePainted` keeps taking the page's picture on a growing
  backoff (`FIRST_FRAME_RETRY_MS` 250 ms → `FIRST_FRAME_MAX_RETRY_MS` 2 s,
  `FIRST_FRAME_BUDGET_MS` 15 s) until that viewer has a frame, and at once on
  `Page.loadEventFired`/`Page.frameNavigated`, which is the moment a document
  that was still being swapped in stops being. A `pane` message that
  re-reports a still-blank tab asks again rather than returning early.
- **A pane whose tab has no page yet is not dropped.** A document tab the
  host renders itself (`#showWelcome`, the reader) is published to the shell
  as soon as it exists, and a suspended tab is selected before it is woken,
  so a pane can honestly report itself visible before `guardSessionFor`
  answers. That message used to be dropped on the floor, and the client only
  sends another when its own geometry changes. It is now retried on the same
  backoff.
- **A refused `Page.startScreencast` no longer marks the stream started.**
  The rejection was swallowed while `#started` stayed true: no live frames, no
  retry, and every later viewer of that page inheriting the silence. It is
  asked again, bounded.
- Tests: `services/cloud-browser/test/sessions/shell-pane-paint.test.ts`,
  eight cases against a fake CDP session — seven of them fail on the code
  before this change, led by "a backgrounded page whose screenshot never
  answers still joins the live stream" and "a static page still paints for a
  viewer whose first snapshot failed".

### Revision 8: what the split changed

§15 is the decision; this is what implementing it moved, so a reader of
revision 7 can see it. Nothing in §0–§12 changed meaning — the shell, the
socket, the host and the session are what they were. What changed is where
the chrome around them lives.

**The apps.**

- `apps/web` became `apps/www` (package `www`, port 3000) — every file, moved
  with `git mv`, so the site, the dashboard and their history are intact. The
  new `apps/web` (package `web`, port 3001) is the browser: `app/layout.tsx`,
  `app/page.tsx` (the old `/app/browse` page, at `/`), the three stream
  components, `lib/shell-socket.ts` and `lib/onboarding-ai.ts`.
- `/app/browse` on `www` is a route handler that 307s to
  `NEXT_PUBLIC_PISTACHIO_BROWSER_URL` — a handler rather than a page, so a
  bookmark gets the redirect from the server instead of a document that
  redirects itself once React has loaded — and the rail's "Browse" became
  "Open the browser", pointing at the same address. `shell.tsx`'s full-bleed
  branch is gone with the route.
- `www` no longer depends on `@pistachio/shell-ui`, `@pistachio/shell-contracts`,
  `@pistachio/agent-runtime` or `ai`, and `app/app/app.css` no longer imports
  the shell's theme or stylesheet: the dashboard's CSS is the dashboard's
  again. The browser app's stylesheet is the desktop renderer's — Tailwind's
  reset, theme and utilities, then `@pistachio/shell-ui/theme.css` and
  `shell.css` — plus the gate's skin, and none of the marketing tokens.

**The package.** `@pistachio/web-account` holds the account layer §15 lists,
moved file by file out of `apps/www`. Three things had to change to make one
copy serve two sites:

- `SessionProvider` takes `deviceName: "Web" | "Browser"`, and the device is
  enrolled as `<name> — <browser> on <platform>`, so the Devices page names
  the site as well as the browser. The kind stays `web` for both.
- The gate no longer imports `next`. It navigated after sign-up (`router
  .replace("/app/browse")`); it no longer needs to, because on both sites the
  gate IS the page until the session is ready — a new account on the browser
  app is already standing in its walkthrough, and one on `www` is standing on
  the dashboard. Its masthead links are ordinary anchors to
  `NEXT_PUBLIC_PISTACHIO_WWW_URL`, which is empty on `www` and therefore
  relative.
- The gate's dress moved from Tailwind utilities to `auth.css`, a
  self-contained stylesheet the package exports. It was written against the
  marketing theme (`bg-cream`, `text-24`, the `desk:` breakpoint), which the
  browser app must not load; the values are inlined under `.pa-auth`
  instead, unlayered so neither app's utilities can reach them.
- `NEXT_PUBLIC_PISTACHIO_CONTROL_URL` is read inside the package, and Next
  does inline it there: `transpilePackages` puts the package through the same
  loader as the app's own files, bracket access included. Verified by the
  e2e stack, which points both apps at a control plane on an ephemeral port.

**The seam the shell needed.** A cloud host refuses a family of members with
"managed from the web app", and the sentence is the host's. The address is
not: `Surface` gained `accountUrl`, the browser app supplies it, and
`Unavailable` renders "Open the web app" beside the reason. On the desktop
there is no such address and it renders nothing.

**Testability.** `www`'s Spaces table carries `data-space` (the id), because
the two sites label the same Space differently — control's row on the
dashboard, the sealed `space:` record in the shell, which falls back to the
Space id when no record exists yet. The id is what makes it one Space, and
what `web-two-apps.spec.ts` asserts.

**E2E.** `web-harness.ts` boots either app (or both) by package name, always
allocates both ports, tells each app where the other is, and hands control
both origins and the worker `browserUrl` as well as `artifactWebUrl`.
`web-browse` and `web-onboarding` boot `web` and sign up at `/`;
`web-credential-capture` boots `www`; `web-two-apps` boots both and walks the
seam: sign up on `www`, follow "Open the browser", sign in there, find the
same Space open in the shell, and see two web devices — "Web —…" and
"Browser —…" — on the dashboard's Devices page.

**Origins** (implemented in `services/control` and `services/cloud-browser`
by the other half of this work): `PISTACHIO_BROWSER_URL` is the new constant
for the browser app, the shell socket pins its `Origin` to it and nothing
else, the download route answers CORS for it, the live view accepts either
site's origin as a list rather than one constant, and
`CONTROL_ALLOWED_ORIGINS` lists both. `PISTACHIO_WEB_URL` keeps meaning
`www`.

## 14. First run on the web (revision 7)

A person who creates their account in the web app lands in the browser's walkthrough at once, and the walkthrough is the desktop's: the same four steps, the same stages, the same completion, on a stream surface.

**Routing.** After sign-up or sign-in, the browser app opens `/`. Keys and the first Space's cloud enablement happen inside the sign-up ceremony (§17 of the cloud-sync design); when enablement failed, the browse curtain's "Turn on cloud browser" runs first and the walkthrough follows. Before mounting the shell, every browser session reads `GET /v1/me` for the account's `onboardingCompletedAt`. Local storage and the choice of sign-up versus sign-in no longer decide whether onboarding is required.

**The database is authoritative.** `users.onboarding_completed_at` is nullable: null means incomplete; a timestamp means complete. The schema migration seeds every existing user as incomplete by adding the nullable column, and new accounts also start null. Subsequent migrations preserve completions. Before the shell mounts, the web entry copies this status into the host's `onboarding.completed` and `completedAt`, overriding either value in old sealed settings. The store's first-load rule (`onboardingOpen = !settings.onboarding.completed`) opens the walkthrough. A failed status read or settings write keeps the browser behind its retry curtain. A reload mid-walkthrough or a sign-in from a fresh browser still requires onboarding until the database records completion. The about step's "Or sign in" is not offered on the web (`canSignIn` is false: the person just signed in); the steps are about, import, favorites, appearance on every surface.

**The steps on a stream surface.**
- *About you*: the recorder is browser code and runs unchanged; the microphone prompt is the browser's own (`requestMicrophone` is native-only and answers true). Speech is transcribed and read on the web's side of the bridge: `WsShellApi` answers `getAiStatus`, `transcribeSpeech` and `extractOnboardingIntake` itself with the web device's token against control's `/v1/ai/*` proxy (a `platform: "web"` device is allowed there; a `cloud` device is not), through `@pistachio/agent-runtime/onboarding` — `transcribeIntroduction(model, audio, mediaType)` with the chat-model-with-audio fallback and `extractIntake(model, transcript)` with the flat intake schema and `heuristicIntake` fallback, the desktop's `main/onboarding.ts` logic moved into the package so both hosts share it. Without a reachable proxy the step says so and offers the typed fields, as on the desktop.
- *Bring a browser*: importing runs only on a Mac (W12). On a stream surface the step keeps its place and shows the web variant: the reason, that a Mac signed into this account brings its sessions and bookmarks here through sync, a download link for the Mac app, and "Continue" as the primary; `detectBrowsers`/`importBrowserProfiles` are never called.
- *Favorites* and *Appearance*: unchanged; appearance writes to the sealed settings record live.

**Completion on the host** does all four desktop effects: memories (`profile.name`, `profile.about`, facts) as the person; the first Space renamed — the host publishes the sealed `space:<id>` record through a new `WorkspaceToolStore.putSpace`, and the web's `completeOnboarding` wrapper then calls `PUT /v1/spaces/:id` so control's row agrees; favorites appended to the shelf; `onboarding.completed` with `completedAt`; and the welcome tabs. The welcome pages are host-rendered documents like the reader (§11): the pure builders in `apps/desktop/src/main/welcome-pages.ts` (`lessons`, `overviewHtml`, `lessonHtml`, `page`, `palette`) move to `@pistachio/shell-contracts/welcome-pages`, parameterised by the link base, the asset base and the font source, the desktop keeping only its `pistachio://` serving and file reads. The host opens each `WELCOME_TABS` entry as a document tab whose displayed URL is the tab's `pistachio://` address, personalised with the person's name, appearance and the web shortcut labels; welcome tabs are rebuilt, not stored, on restore. After the host succeeds, the web wrapper calls device-authenticated `POST /v1/me/onboarding/complete`; control sets the authenticated user's timestamp with its own clock, preserving the first timestamp on retries. A failed completion write keeps the wizard open. Only then does the wrapper make the best-effort Space label update. Bootstrap tokens and cloud-device tokens cannot mark onboarding complete.

**Gate.** `apps/desktop/e2e/tests/web-onboarding.spec.ts`: sign up on the web, land on `/` with the walkthrough at `about`; typed introduction; the import step's web variant; three favorites including a custom site; a preset; reveal with three favorite tiles, the Space named after the person, the welcome overview open and greeting them by name, memory holding the profile; a reload mid-walkthrough reopens it at the first step; a second visit after completion opens the browser directly. Fresh browser profiles verify both unfinished and completed accounts; an account created outside the browser must also onboard. A failed account write leaves the wizard open, and retrying does not duplicate welcome tabs.

## 15. Two web apps (revision 8)

The web app splits in two. `apps/www` (package `www`, dev port 3000) is everything the web app was before this branch: the landing page, download, docs, early access, privacy, the artifact share route, the feedback API, the iMessage onboarding page, credential capture, and the account dashboard under `/app` (agent, runs with the live pane, devices, spaces, memory, bookmarks, reminders, artifacts, channels, settings). `apps/web` (package `web`, dev port 3001) is only the browser: the shell on a stream surface, at `/`.

**Shared code moves to `packages/web-account` (`@pistachio/web-account`).** Both apps sign in to the same control plane with the same device model, so the account layer is one package, not two copies: `session.tsx`, `keys.ts`, `device.ts`, `idb.ts`, `token.ts`, `vault.ts`, `control.ts`, `records.ts`, `credential-vault.ts`, `usage.ts`, `artifacts.ts`, `runs.ts`, `live-view.ts`, the `session-boundary`, the gate (`SignIn`, `Unlock`, `NotSetUp`, `Loading`) with its stylesheet (`auth.css`, the `pa-auth` skin), and `ui.tsx`. One gate asks for the same things in the same words on both sites; what it wears is chosen by `skin` (`GateSkin`, `data-skin` on the root).

**The PIN (revision 9).** "Stay unlocked on this browser" no longer keeps usable keys at rest. Checking it does nothing at the form; once the password has actually opened the account the session lands in `set-pin`, where the reader picks six digits twice, and `packages/web-account/src/pin.ts` seals the Space ROOT SECRETS under a PBKDF2-derived key from them (`RECOVERY_CODE_PBKDF2_ITERATIONS`, one derivation per record, salt in the record). Boot then lands in `pin` rather than `locked`, and a right answer re-derives exactly the non-extractable keys a password unlock produces — plus the root secrets themselves, so a PIN-unlocked tab can wrap a Space for the cloud browser without a second password ceremony. Wrong answers are counted inside the record, so the count survives a reload; the fifth destroys it. `unlocking` is the beat between a right answer and the app: the keys are held in a ref until the screen that took the digits has played its wrap out (`pin-motion.ts` rolls the row of circles onto a circle whose circumference is the row's own length), then `finishPinUnlock` hands them over. The two sounds are files, in each app's own `public/audio` because a site can only fetch its own origin, played through Web Audio so they can be scheduled to a frame: `pin-unlock.wav` carries its own scrape-gap-click structure and the wrap's duration is DERIVED from where its click sits (`UNLOCK_CLICK_MS`), so the ring closes on the latch rather than near it; `pin-wrong.wav` has two lobes that the shake's keyframes are placed on. Both are preloaded when the keypad mounts and the context is resumed from the keystroke, since only playing needs a gesture. Both PIN screens are card-less by design — one question, one self-submitting answer, and a ring needs no box to sit in. `PinGate` picks between them, because `unlocking` belongs to whichever screen took the digits. What six digits is and is not worth is a non-claim in [security.md](security.md). `site` is the default and the marketing site's dress — cream, green, Inter, the card over the early-access photograph. `web` passes `skin="shell"`, which drops the photograph and redraws the same layout in the shell's own tokens: Geist on `background-200` under the theme's two accent blooms, one flat `background-100` card with a hairline, Geist Input and Button. That is the room the reader is about to be in — a new account lands in the walkthrough at `/` the moment the state flips (§14) — so the door hands off without a change of world. The `shell` root is a `<div>`, not a `<main>`: `apps/web`'s layout already owns the page's landmark. It is a React package like `@pistachio/shell-ui` (exports `"."`, `"./auth.css"`, `"./*"`; `react-library` tsconfig; vitest for its pure modules). Each app is enrolled as its own web device, because device keys live in the origin's IndexedDB: the dashboard enrolls as "Web" and the browser as "Browser", so the Devices page tells them apart. `NEXT_PUBLIC_PISTACHIO_CONTROL_URL` is read by the package.

**What each app keeps.**
- `www`: everything listed above plus `lib/site-data.ts`, `lib/release.ts`, `lib/og.tsx`, the marketing components, `globals.css`, `app/app/app.css`, `nav-config`, `sidebar-nav`, `shell.tsx` (the rail layout; the full-bleed browse branch is deleted), `run-thread.tsx`, `live-pane.tsx`, the settings sections. The dashboard's nav gains "Open the browser" → `NEXT_PUBLIC_PISTACHIO_BROWSER_URL`. `/app/browse` is gone; a request for it redirects to the browser app.
- `web`: `app/layout.tsx` (session boundary, `auth.css`, the shell stylesheets), `app/page.tsx` (today's browse page at `/`), `shell-tree.tsx`, `streamed-pane.tsx`, `stream-capabilities.tsx`, `lib/shell-socket.ts`, `lib/onboarding-ai.ts`, and a single stylesheet importing Tailwind's theme and utilities plus `@pistachio/shell-ui/theme.css` and `shell.css` (never the marketing tokens). The download link on the import step comes from `NEXT_PUBLIC_PISTACHIO_DOWNLOAD_URL`; the settings sections that say "managed from the web app" link to `NEXT_PUBLIC_PISTACHIO_WWW_URL`. Sign-up in the browser lands in the walkthrough at `/` (§14); sign-up on `www` stays on the dashboard, which offers the browser.

**Origins.** Control and the worker distinguish the two sites:
- `PISTACHIO_WEB_URL` keeps meaning `www`: credential-capture and iMessage links, artifact tool views, the live view's `Origin` for the dashboard's run page.
- `PISTACHIO_BROWSER_URL` (new; dev default `http://localhost:3001`) is the browser app: the shell socket's `Origin` pin and the download route's CORS origin. The live view accepts either origin (the run page on `www`, and nothing on the browser app today, but the pin is a list rather than a second constant).
- `CONTROL_ALLOWED_ORIGINS` lists both.
- Turbo `globalEnv`, `.env.example`, `scripts/dev-ready.mjs` (starts both apps), and the root `dev:cloud` filter include both apps and the three new `NEXT_PUBLIC_*` names (`NEXT_PUBLIC_PISTACHIO_BROWSER_URL`, `NEXT_PUBLIC_PISTACHIO_WWW_URL`, and the existing download URL).

**E2E.** `apps/desktop/e2e/tests/web-harness.ts` boots either app by package name; `web-browse` and `web-onboarding` boot `web` and sign up at `/`; `web-credential-capture` boots `www`. A small new spec proves the seam: sign up on `www`, follow "Open the browser", sign in on the browser app with the same account, and see the same Space.

**Gate.** `www` and `web` each type-check, lint and build-check (`next build` is not run; `next typegen && tsc`); `@pistachio/web-account` type-checks, lints and tests; the three web e2e specs pass; control and cloud-browser suites pass with tests for the origin rules; the desktop e2e stays at the baseline.

## 16. The live DOM mirror (revision 10)

Revision 9 adds a second way to paint a pane. The screencast (§6.3, §7)
sends pixels the cloud took; the **DOM mirror** sends the document itself, so
the person's browser renders a synchronized copy — the tree, the styles, the
form state, the assets. That gives crisp text, local zoom, native text
selection, and instant response for anything that does not need the site's
JavaScript: scrolling loaded content, typing in an ordinary field, a CSS
reflow on resize. The cloud is still authoritative — its JavaScript,
cookies, network and application state run in one place, the cloud Chromium —
and the mirror reproduces the *results* of that execution while running none
of the site's scripts. This is the rrweb approach (serialize a document, then
stream incremental mutations, suppressing the original scripts) with our own
input, asset and synchronization layers on top.

It is behind a per-tab flag and off by default; a page that cannot be mirrored
faithfully falls back to pixels on its own. It does not replace the
screencast, it stands beside it: `renderPane` picks per tab.

### 16.1 The package (`@pistachio/dom-mirror`)

One package, five parts, all pure or self-contained so the recorder and the
renderer can each be stringified into a page and a Node test can drive the
protocol:

- `protocol.ts` — the wire shapes, all zod. `MirrorNode` (the serialized
  tree: elements, text, shadow roots, adopted stylesheets, canvas data,
  form values, scroll), `MirrorOp` (the incremental operations: add, remove,
  attribute, text, value, checked, scroll, css, adopted, shadow, canvas,
  focus), the recorder's reports, the **server messages** (`snapshot`,
  `patch`, `frameGone`, `edited`, `scrolled`, `assetReady`, `unsuitable`, `assetMissing`, `stopped`)
  and **client messages** (`attach`, `detach`, `ack`, `resync`, `need`,
  `pointer`, `key`, `edit`, `scroll`), and the binary asset-chunk codec.
  Node ids are small integers stable for a node's life; `1` is the document.
  An **epoch** is one serialization of one frame; every patch names its epoch
  and a sequence number, so a gap is detectable and answered by a resync
  rather than by applying an op to the wrong tree.
- `recorder.ts` — one self-contained function installed in every document
  (init script + evaluate), plus a control object the host drives (`start`
  returns the first snapshot, then patches arrive through a binding). It is
  `MutationObserver` AND the things a mutation is not: input properties
  (wrapped setters on the value/checked/selectedIndex prototypes), the CSSOM
  (`insertRule`/`replace`/`setProperty`), `adoptedStyleSheets`, scroll,
  `attachShadow` (so closed roots are seen), and a canvas poll. It also
  judges *suitability* — visible WebGL, plugins, embedded frames and rich editors —
  and reports `unsuitable`.
- `renderer.ts` — one self-contained factory that rebuilds the document in a
  target document (the pane's sandboxed iframe) and applies patches. It is
  the second line of defence after the sandbox and the CSP: every `script`,
  `object`, `base`, `meta` becomes an inert `template`, every `on*` handler
  and `javascript:` URL is dropped, and every URL that is not an asset token,
  a `data:` or a fragment is discarded. Assets arrive on their own schedule;
  a token with no bytes yet leaves the attribute unset and registers a
  waiter, filled the moment the bytes land. A CSS asset is text with tokens
  of its own, so its object URL is rebuilt when a dependency arrives.
- `surface.ts` — the trusted controller inside an opaque-origin iframe. A
  nonce permits only this bootstrap, and the parent transfers one private
  MessagePort. The controller owns the renderer, native input and asset blob
  URLs, resets document state on snapshots, and disposes listeners with the
  frame. Site content cannot access shell DOM, storage or credentials.
- `rewrite.ts` / `assets.ts` — the pure URL/CSS rewriting the host runs, and
  the viewer-side reassembly of chunked assets.

### 16.2 What the recorder sends

A snapshot once — the tree with stable ids, stylesheets (serialized from the
CSSOM, so a `link`'s rules and a framework's `insertRule` sheets both come
across), form values, focus, scroll, shadow roots and their adopted sheets,
asset references — then small operations. Child frames are **not** mirrored
in this version: a visible populated frame triggers whole-tab pixel fallback,
so embedded content remains usable. Closed and open shadow roots are captured;
suitability checks inspect those roots too.

### 16.3 The asset broker (`services/cloud-browser/src/sessions/mirror/`)

Copying an image's URL is not enough: it may need the cloud browser's
cookies, a referer, a signed URL, or be an in-memory `blob:`. So before a
snapshot or patch leaves the worker, every asset URL is resolved against the
frame's base and replaced by an opaque `pa-asset:<id>` token (`AssetBroker`).
The broker observes the page before navigation and captures the original guarded
responses, preserving cookies, referer, signed URLs and authenticated egress
without a second request. IDs are random and scoped to the current document;
navigation discards its previous scope. Missing bytes fail closed into pixel
fallback. Page-owned `blob:` data is extracted by the recorder. Captured CSS
is rewritten recursively, including cross-origin sheets and imported fonts.

A viewer requests IDs with `need` and receives small `assetReady` control
messages. The web shell fetches bytes on an independent authenticated HTTP
route, with four concurrent transfers. Each request requires a live, proved
viewer's key and a resource in the current document, with the viewer origin
pinned by CORS. The fleet relay uses the same checks. Responses are `no-store`;
keys never enter the mirrored document. Assets are capped at 12 MB each, the
shared LRU at 64 MB, and metadata and pending queues are bounded. Binary chunks
remain available for older clients but are not the web client's default.

The mirrored document makes no origin requests. Its CSP permits asset data
only through `blob:`/`data:` and inline styles; the trusted bootstrap is the
only script allowed. CSS dependency arrivals rebuild blob URLs and refresh
referencing stylesheets. DOM patches and asset bytes do not share a socket
queue.

### 16.4 Input by node identity

Input names a NODE, not just a pixel (`TabMirror`). A pointer press or release
carries the id of the element it landed on and where inside its box (0..1),
so the cloud resolves that node's *current* layout and clicks the same
control even when local font metrics differ; moves also use node identity and
are coalesced to animation frames. Removed or stale targets are dropped. A key names the focused node; the cloud
focuses it and dispatches a real key event, so the site's own handlers run.
The shared page context menu uses the local pointer position, while actions
continue through the cloud host. An ordinary field edits optimistically — it is a real field in the iframe and
updates as fast as the key is pressed — and the whole value plus caret is sent
as an `edit` for the cloud to reconcile (`setValue`, which fires `input` so
the site reacts); a `val` the recorder then echoes is shielded from clobbering
a field the person is mid-edit on until the cloud acknowledges the revision.
Edit and scroll revisions belong to one viewer and document epoch. Replies go
only to the originating viewer; an old acknowledgement cannot clear a newer
pending edit. Scroll echoes are suppressed. Every input checks its document
epoch and control generation, and rechecks authority after asynchronous target
lookup immediately before CDP dispatch. A bounded serialized queue preserves
input order. A viewer may acknowledge and request resync while the agent holds
control; these read operations do not grant input authority.

### 16.5 The transport and the seam

The socket (§5) gains a `mirror` server frame (`{tabId, msg}`) and a `mirror`
client frame (`{tabId, generation, msg}`), and `pane` gains a `renderer`
(`pixels` | `dom`, absent meaning pixels — what a client that predates the
mirror asks for without knowing it). A `dom` pane stops any screencast and
attaches to the tab's `TabMirror`; its viewport is still sized, so the cloud
page reflows to where the person is looking. The first viewer owns the cloud viewport until another viewer acts; passive
viewers can reflow locally without repeatedly resizing the cloud page. On the web the pane is chosen by `components/pane.tsx`
from `lib/renderer-preference.ts` (env default + a remembered per-viewer
choice), and it falls back to `StreamedPane` when the host says `unsuitable`.
The mirrored document lives in an opaque-origin iframe with `allow-scripts`
and no `allow-same-origin`. CSP authorizes only the nonce-bearing controller.
Snapshots replace the renderer without duplicating document listeners; iframe
teardown closes its MessagePort and cancels pending asset work.

### 16.6 What is faithful and what is a compatibility boundary

Local rendering is immediate; behavior that depends on cloud JavaScript still
takes a round trip. Responsive layout is preserved by keeping the stylesheet
rules and their structure so the local browser lays the page out — but a site
that chooses its DOM in JavaScript (`ResizeObserver`, virtualized lists, text
measurement, mobile component swaps) only shows what the cloud produced at the
cloud viewport; the active viewer's size is the cloud viewport, reflow is
local and immediate, and cloud updates reconcile. Video and audio use local encoded-media playback (§16.8). WebGL, plugins, populated frames and rich editors use whole-tab pixel
fallback. Invisible content (including transparent ancestors) does not trigger
compatibility fallback. The sidebar rendering status explains the active trigger
and offers a DOM retry for the current document without reloading it.
Small 2D canvases are sampled; this is not a video-grade graphics
transport. Prefilled passwords also use pixels so a masked snapshot is never
submitted as the real secret; typing into an initially empty password remains
local. Missing/oversized assets, large documents and persistently lagging
viewers fall back as well. "Everything is instant"
is a measured compatibility goal, strongest for document-heavy pages, not an
assumption of switching from pixels to HTML.

### 16.7 Gate

`NEXT_PUBLIC_PISTACHIO_DOM_MIRROR=1` enables the build default. The variable is
part of Turbo's environment/cache key. With it unset, pixels remain the default;
the stored renderer preference can override it. Keep the pixel path available.
The web app's checked-in `vercel.json` supplies `1` to deployment builds so the
production rollout is reproducible. To roll back the renderer alone, set that
value to `0` and redeploy; local builds still require an explicit opt-in.

Validation covers the protocol and rewriting, real Chromium recorder/surface
round trips, cross-origin CSS/imports/fonts/images/blob assets, asset privacy
and cache limits, authenticated proxy capture, stale epochs and authority
changes, independent viewers, HTTP authorization, and unsupported-page fallback.
The web journeys exercise actual signup, the cloud worker, both apps, local
input under transport latency, responsive reflow, scroll, reconnect and form
submission. The same mirror journey can run against a production build with
`PISTACHIO_E2E_WEB_PRODUCTION=1`.

See [DOM mirror validation](dom-mirror-validation.md) for the checked commands,
results, screenshot review and the scope of the performance measurements.


### 16.8 Encoded media in a DOM page

A visible video no longer forces a new client into whole-page pixels. The
opaque mirror contains real `video` and `audio` elements. Its trusted media
controller plays the original encoded audio/video, so the local browser owns
decoding, synchronization, scaling and native controls. The sidebar reports
**DOM + media playback** after at least one player has decoded media.

For ordinary HTTP(S) media, a proved socket receives an unpredictable read
capability scoped to its viewer, tab, document epoch, media node and current
source URL. `/v1/shell/:session/media/:capability` streams range responses
through the worker's authenticated egress. Only request headers observed on
the source browser's exact media URL are reused; every redirect is checked
against network policy. Cookies, origin authorization and the original media
URL stay on the worker. A `preload=none` source may load metadata in the cloud
first so Chromium makes its own cookie and authentication decisions. Revoking
the viewer, hiding its pane, navigating or changing source invalidates the
capability and aborts active transfers. Fleet relays preserve ranges and abort
when the viewer disconnects.

This narrow media capability is an explicit exception to header-only asset
credentials: native media elements cannot set an authorization header. It does
not grant shell, asset or arbitrary-fetch access. The mirror CSP permits the
configured worker origin only for `media-src`; site scripts remain inert and
shell storage remains inaccessible. The relay accepts the opaque frame's
`Origin: null` with anonymous CORS so audio can be decoded locally.

For main-thread MediaSource players, init scripts capture SourceBuffer tracks,
encoded appends, timestamp/window settings, removals, aborts, codec changes and
end-of-stream before site code runs. Bounded batches travel over the existing
proved socket with per-viewer sequence cursors and transport backpressure.
The mirror rebuilds MediaSource without executing the site's player code or
fetching its manifests, licenses or segments independently. Separate audio
and video tracks retain their original timestamps. A document keeps at most
64 MiB of encoded replay history; active viewers can continue beyond that
limit. A new or stalled viewer whose cursor predates retained history cannot
reconstruct the stream and falls back. Reloading the source page starts a new
history; a simple DOM resnapshot cannot restore evicted initialization data.

Cloud state remains authoritative. Local native controls send fenced media
commands, while custom site controls continue through DOM input forwarding.
The mirror reconciles time, play/pause, volume, mute and rate every 250 ms,
correcting time drift above 750 ms. Browser autoplay policy can require an
**Enable audio & video** click. This is not zero-latency synchronization with
cloud JavaScript, although local audio and picture use one playback clock.

Pixel panes subscribe to a separate media-only receiver in an opaque iframe.
They retain JPEG page rendering while locally decoding relayed audio. A
media-only recorder snapshot establishes the document epoch without sending
page markup, and discovers media even when DOM suitability fails. Native
files use the same scoped range relay; MediaSource streams use the same
encoded batches (including video buffers when the source contains both
tracks). Site controls remain cloud-owned; this receiver cannot submit DOM
or media input. A local **Enable audio** button handles autoplay rejection.
The status card reports **Pixel fallback + audio** when a player is ready,
and provides explicit switches between pixel and DOM rendering.
Navigation clears the receiver immediately; hiding or closing the pane
releases its subscription and media capabilities. Audio startup updates the
existing pane subscription without restarting its screencast.

DRM, MediaStreams, worker-owned MediaSourceHandle players, unsupported codecs
and expired replay history remain compatibility boundaries. Pixel audio uses
the same encoded relay, so it does not solve these media-source failures;
it reports unavailable audio instead of claiming success. Supporting them
requires a separately validated cloud audio capture transport, and protected
media may prohibit capture. Background-tab audio is still outside this path.
