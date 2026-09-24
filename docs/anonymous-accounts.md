# Anonymous accounts

Pistachio works without signing in, and until now "without signing in" also
meant "without models": every model call goes through control's `/v1/ai/*`
under a device token (docs/cloud-sync-design.md §7.2), and a Mac nobody signed
in on had none. So the agent, memory, the address bar's intent model, Tidy, the
brief, read-aloud and the spoken introduction in onboarding were all off until
an account existed.

Now a Mac nobody has signed in on is given an **anonymous account**: a real
`users` row with this Mac enrolled as its one device. The models work from the
first launch, every call has an owner to meter and to bound, and when the
person does make an account it is _this same account, upgraded_ — so nothing
is lost, because nothing moves.

## The shape

|                 | Anonymous                                       | Real                                   |
| --------------- | ----------------------------------------------- | -------------------------------------- |
| `users` row     | `email` NULL, `is_anonymous` true               | email + BetterAuth credential row      |
| Credential      | the device key alone (`/auth/device-login`)     | password, recovery code, device keys   |
| Devices         | exactly one, a Mac                              | any number                             |
| Reaches         | the allow-list below                            | every device-tier route                |
| Model spend     | a monthly allowance it cannot raise, and a pace | its own optional cap (`ai_budgets`)    |
| Keys, sync, hub | none — it holds no Space secret                 | §7, §10 of the sync design             |
| Lifetime        | swept after 90 days unseen                      | until deleted                          |

`users.email` is nullable for this (UNIQUE ignores NULLs) and BetterAuth never
reads such a row: every BetterAuth lookup is by email, and there is no
credential row to find.

There is no anonymous account on the web — the web app has no signed-out
state — and none under `PISTACHIO_E2E`, where the account layer is never
built (D22). `PISTACHIO_ANONYMOUS=0` turns it off on a desktop.

## What it can do

`anonymousAllowed` (`services/control/src/anonymous.ts`) is an **allow-list**,
checked in the `v1` middleware before the bootstrap and cloud tiers, so a route
added later is closed to anonymous accounts until someone decides otherwise:

- `ALL /v1/ai/*` — the models
- `GET /v1/ai-usage` — its meter; the allowance is reported as the `cap`
- `GET /v1/me` (now carries `anonymous: boolean`, and `email` may be null)
- `POST /v1/me/onboarding/complete`
- `POST /v1/account/upgrade` — the way out

Everything else answers `403 {error: "account_required"}`. The hub refuses its
token at the upgrade, and `/internal/auth/introspect` (the cloud browser's
check) answers 403. The line is deliberate: anything that keeps a person's data
on this plane — sync, the vault, integrations, the cloud browser, channels —
needs a credential that can get the data back, and an anonymous account's only
credential is a key in one Mac's keychain.

## Bounds

A real account has a spend cap the person sets. An anonymous account has three
bounds it cannot change, all in `anonymous.ts` and all read from the
environment per request (no restart to retune):

| Bound   | Default                   | Variable                                             | Refusal                                      |
| ------- | ------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| Minting | 10 accounts / hour / IP   | —                                                    | 429 `rate_limited`                           |
| Spend   | $5 / calendar month (UTC) | `AI_ANONYMOUS_MONTHLY_USD`                           | 403, `reason: "anonymous_budget_exceeded"`   |
| Pace    | 60 requests / minute      | `AI_ANONYMOUS_RPM`                                   | 429 + `Retry-After`, `anonymous_rate_limited` |
| Pace, named models | 6 / minute / model | `AI_ANONYMOUS_SLOW_MODELS` (comma-separated ids), `AI_ANONYMOUS_SLOW_RPM` | same |

Minting is the bound that makes the others mean anything: a fresh account is a
fresh allowance. The sign-up also requires a device proof (a signed challenge
for a key control has never seen), the same proof enrollment makes.

The model refusals are shaped as the gateway shapes one, like
`AI_BUDGET_EXCEEDED`, so the desktop's SDK surfaces the message — which says to
create an account. `AI_ANONYMOUS_SLOW_MODELS` is empty by default; naming
`anthropic/claude-opus-5` there, say, keeps artifact builds available but slow.
Real accounts are not paced or given an allowance by any of this.

The limiters are in memory, per control process, like every other limiter in
`abuse.ts`.

## Routes

- `POST /v1/accounts/anonymous` (public) — body is the enroll body
  (`deviceId, name, platform: "macos", devicePublicKey, agreementPublicKey,
  challenge, signature`). One transaction makes the user, its `work` and
  `__workspace__` Spaces (so an upgraded account is identical to a signed-up
  one), and the device. → 201 `{userId, device, token, exp}` — a **device**
  token; there is no bootstrap step because there is no credential to exchange.
- `POST /v1/account/upgrade {email, password}` (anonymous device bearer) — in
  one transaction: sets `email`, `name`, clears `is_anonymous`, and inserts the
  `auth_accounts` credential row exactly as `signUpEmail` writes it
  (`CREDENTIAL_ISSUER`; a test holds the two equal). → `{userId, email}`. The
  token the device holds stays good and now reaches the whole device tier.
  409 `email_taken`, 409 `not_anonymous`.
- `POST /v1/account/link {anonymousToken}` (bootstrap or device bearer of a
  real account) — folds an anonymous account into the bearer's and deletes it.
  Both are proven: the bearer by a password login a moment ago, the anonymous
  account by its own device token. Moves `ai_usage` and `audit_events`,
  carries over a recorded onboarding (the real account's own wins),
  **re-parents the device** so the Mac keeps its one id (D24), deletes the
  anonymous user (its empty Spaces cascade). → `{linked, usageRows, device,
  token, exp}` with the device's token under the real account. Only an
  anonymous account can be the source: 409 `not_anonymous` otherwise.

A model answer the anonymous account started may still be streaming when the
link deletes its user row; the meter row lands afterwards and would fail its
foreign key. So the link also writes `account_links (from_user_id → to_user_id)`
in the same transaction, and `recordAiUsage` follows it when an insert is
refused: the spend lands on the real account, toward its meter and cap. (The
insert cannot slip between the link's move and its delete — the link holds the
user row `FOR UPDATE`, so a concurrent insert waits and then takes this path.)
Rows are pruned after a day (`ACCOUNT_LINK_RETENTION_MS`; the proxy cuts an
answer at ten minutes).

The hourly job deletes anonymous accounts older than `ANONYMOUS_RETENTION_MS`
(90 days) whose device has not been seen in that long
(`MaintenanceResult.prunedAnonymousAccounts`).

## Desktop

`EnrollmentState.state` and `AccountState.state` gain `"anonymous"`. The rule
that keeps this safe: **`enrolled()` still means a real account**. Sync, the
vault, integrations, egress and the cloud browser all ask `enrolled()` (or
`account.state === "enrolled"` in the shell) and so stay off; only the model
layer asks the new `modelsAvailable()` / `getModelToken()`.

- `AuthService.ensureAnonymous()` — when nobody is signed in and the keychain
  is available: challenge, sign, `POST /accounts/anonymous`. Called at
  `start()`, after `signOut()`, and lazily by `getModelToken()`. Single-flight;
  quiet on failure (the browser works without it), retried on its own timer
  with a 30 s → 1 h backoff. A 409 for a known device id or key mints a new
  identity once, as `enroll` does — which is what happens after a sign-out,
  since control still holds the signed-out account's device row.
- **Sign up** while anonymous → `POST /account/upgrade`. The store goes to
  `signed-up` _keeping the device token_; `enroll()` sees the token, skips
  device enrollment, and does what a first enrollment does: mint the Space
  secrets, upload password wrappers, show the recovery code once. Survives a
  restart between the two steps.
- **Sign in** to an existing account while anonymous → password login, unwrap
  that account's keys (unchanged), then `POST /account/link` with the anonymous
  token taken before the login. Same `signed-up`-with-token state, and
  `enroll()` finishes as a joined account (no new recovery code). If the link
  is refused or unreachable, the token is dropped and `enroll()` registers the
  device afresh; the anonymous account is left for the sweep.
- A 401 on an anonymous token that re-proving the key cannot fix (the account
  was swept) resets to `unenrolled` and starts another — no "revoked" banner,
  no `onSignedOut`, and in particular no clearing of the Spaces' cookie jars.
- An anonymous sign-up and a sign-in never overlap: each waits out the other,
  because both install a token on the one control client. A retry that comes
  due during a sign-in is turned away, and is owed again when the sign-in ends
  (`#exclusively`); one turned away by the backoff with no timer pending arms
  one. The invariant: while nobody is signed in, something is always going to
  ask again — otherwise the models stay off until the next launch.
- During a sign-in the client carries the new account's **bootstrap** token,
  which `/v1/ai/*` refuses. `getModelToken()` therefore answers the device
  token in the store whenever the client's differs from it: the anonymous
  account's until the link lands, this Mac's under the real account after.

In the shell, `accountStep` treats `anonymous` as `sign-in`, so every
account-gated settings page reads exactly as it did signed out. Settings →
Account adds a card with the month's spend against the allowance and says that
creating an account keeps what this Mac has done. The onboarding mic no longer
waits on an account; it re-reads the model status when the account state
changes, since the anonymous account can land a moment after the wizard opens.

## What "nothing is lost" covers

Everything local stays local either way — Spaces, tabs, memories, favorites,
the watchtower archive; none of it ever lived in the anonymous account. On the
server the anonymous account holds its meter, its audit trail, the onboarding
timestamp and the device, and:

- **sign up** keeps all four by construction (same row);
- **sign in** moves all four.

After either, local data starts syncing under the real account's keys exactly
as it does today for a Mac that signs in after being used signed out.

## Not done

- **Anonymous integrations / vault.** Excluded on purpose (see "What it can
  do"). Allowing them means a link has to re-seal rows from the anonymous
  account's Space keys to the real account's where Space ids collide (`work`,
  `__workspace__`) — the client holds both secrets at sign-in, so it is
  possible, but it is its own project.
- **A shared limiter.** The three bounds are per control process; more than one
  instance multiplies the pace and minting bounds (not the spend allowance,
  which is read from `ai_usage`).
- **Abuse beyond IP.** Minting is bounded per address only; no attestation.
- **Cloud-browser spend** is still unmetered (it holds its own gateway key),
  which is unchanged and unreachable to anonymous accounts.
- **E2E.** The account layer is off under `PISTACHIO_E2E`, so Playwright never
  sees the anonymous state. Covered instead by
  `services/control/test/anonymous-accounts.test.ts` and the "anonymous
  accounts" block of `apps/desktop/test/account-service.test.ts`.
