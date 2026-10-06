# Shields: ad, tracker, and privacy protection

Status: implemented on branch `shields` (October 2026), desktop only. The
cloud browser and the site preview refuse it (§7).

## 1. What this is, and where it comes from

Pistachio blocks ads, trackers, and dangerous sites itself, and keeps sites
from following a person from one to the next. A protection level (Standard /
Strict / Custom) sets every protection at once; each one can then be changed
on its own in Settings → Privacy & security → Ads & trackers, and Shields can
be lowered for one site from its site popover.

**How Zen does it** (source: `zen-browser/desktop` at Firefox 157). Zen ships
no blocker of its own. It runs Firefox's Enhanced Tracking Protection at
**Standard** (Total Cookie Protection; social, cross-site-cookie, cryptominer,
and known-fingerprinter blocking), turns **Global Privacy Control** on for
every window (`privacy.globalprivacycontrol.enabled=true`), strips telemetry
at build time, offers **uBlock Origin** as a pre-checked onboarding step
installed from addons.mozilla.org, and puts a single per-site **"Tracking
Protection" switch** in its combined site panel next to permissions. The
privacy preferences page is stock Firefox: Standard / Strict / Custom.

Electron has no ETP and no extension store, so Pistachio builds the
equivalent of both: an engine that reads the community filter lists uBlock
Origin, Brave, and Ghostery use, and the protections ETP and Brave Shields
add around them. The shape follows Zen and Firefox (levels that own their
knobs, a per-site switch in the site panel, GPC on); the protections follow
Brave and uBlock Origin, which are stronger by default than ETP Standard.

## 2. The engine and the lists

**Engine: `@ghostery/adblocker` (MPL-2.0), with our own Electron adapter.**
It is pure TypeScript (no native build), reads EasyList/uBlock Origin syntax
including scriptlets (`##+js`), `$redirect`, `$csp`, `$removeparam`, and
`!#if` preprocessors, and serializes. Brave's `adblock-rs` was the other
candidate: an excellent engine, but its npm package has no prebuilt binaries
(a Rust toolchain on every install, separate arm64/x64 builds) and no Electron
integration. Ghostery's own `@ghostery/adblocker-electron` was rejected after
reading its source: it takes over the session's `webRequest` listeners (which
would silently remove the upload policy), registers global IPC handlers that
throw on a second session, judges first/third party from the `Referer`
header, ignores `$removeparam`, and injects scriptlets asynchronously — too
late for YouTube. The adapter here fixes all five.

**Lists** (`FILTER_LISTS` in `@pistachio/shell-contracts/shields`), fetched
from their maintainers at run time, never bundled:

| Category | On in Standard | Off (one switch away) |
| --- | --- | --- |
| Ads | uBlock filters, EasyList, uBO Quick fixes, uBO Unbreak | AdGuard Base |
| Privacy | EasyPrivacy, uBO Privacy, Peter Lowe's list | AdGuard Tracking, AdGuard URL Tracking |
| Security | uBO Badware risks, Malicious URL Blocklist (URLhaus) | — |
| Annoyances | — | EasyList Cookie, uBO Cookie notices, uBO Other annoyances, EasyList Social |

The Standard set is exactly uBlock Origin's default set. Strict adds the
annoyance and social lists; "Cookie banners: Hide" brings both cookie-notice
lists and strict tracking-parameter removal brings AdGuard URL Tracking,
whatever their own switches say.

- **Cache** (`main/shields/lists.ts`): `<userData>/shields/lists/<id>.txt`
  plus `lists.json`.
  - Fetched conditionally (`If-None-Match` / `If-Modified-Since`), from the
    maintainer first and the mirrors after; HTML error pages are refused.
  - Fresh for as long as the list's `! Expires:` says (clamped 4 h – 14 d;
    uBO Quick fixes says 8 h, URLhaus 12 h); an unchanged (304) answer starts
    the same period again.
  - `!#include` is resolved one level deep, same origin only. A list with
    includes is fetched in full each time: the parent's 304 says nothing
    about the files it includes.
  - Versioned by content hash, so a download that brings the same text never
    invalidates the compiled engine.
  - One 30 s timeout covers headers and body, so a server that stalls
    mid-download fails over to the mirror. A failed fetch keeps the cached
    copy and is retried in 30 min.
  - Checked 5 s after launch and hourly; a list is fetched the moment it is
    switched on; "Update now" forces a fetch.
- **Resources** (uBO's scriptlets and redirect bodies) come from Ghostery's
  copy (`packages/adblocker/assets/ublock-origin/resources.json`), because the
  engine reads its JSON form; jsDelivr is the mirror. They are loaded whenever
  any list is on or the person has filters of their own.
- **Trust.** uBlock Origin runs `trusted-*` scriptlets and `$replace` only
  from lists its own team maintains. Ghostery's engine does not keep that rule,
  so `compile.ts` keeps it for every other list and for the person's own
  filters: `$replace` lines are dropped before parsing, and a scriptlet is
  dropped once its name is resolved through the resources — aliases
  included (`rpnt` IS trusted-replace-node-text) — if it is marked
  `requiresTrust` or named `trusted-`.
- **Compile** in a utility process (`compile-worker.ts`), written to
  `engine.bin` / `danger.bin` and keyed in `engine.json` by engine version,
  compiler revision, each list's cached version, the custom filters, and the
  resources. A key that matches at launch deserializes in ~10 ms, before the
  first page; a fresh compile is not awaited past 400 ms, so the window never
  waits on the worker (pages load unprotected for the second it takes).
- **Two engines.** The blocking engine holds every effective list and the
  person's filters. The danger engine holds only the Security lists and
  decides whether a PAGE is stopped behind the warning: a hostname on
  EasyList is an ad server to keep out of pages, not a page to warn about.

Measured on 2026-10-03 with the live lists (Node, this Mac):

| | Standard | Strict |
| --- | --- | --- |
| Compile (worker) | 403 ms | 360 ms |
| Engine size / load | 8.5 MB / 10 ms | 11.5 MB / 8 ms |
| Network / cosmetic filters | 134,208 / 42,694 | 140,010 / 90,196 |
| Match, average | 10.6 µs | 18.9 µs |
| youtube.com scriptlets | 33 | 37 |

Adding AdGuard Tracking Protection (the largest list offered) to Standard:
459,854 network filters, 871 ms to compile, a 23.2 MB engine.

## 3. Requests

Electron keeps ONE `webRequest` listener per event per session; a second
registration silently replaces the first. `main/shields/request-hub.ts` owns
each event per session and runs named handlers in priority order: the upload
policy (`upload-policy`, priority 0) before Shields (10). A handler of the
same name replaces its predecessor — a second window's controller meets the
same persisted session. Agent partitions use the hub too (`agent-enforcement`).
Handlers are synchronous; nothing in them waits on disk or the network.
With Shields off, their handlers are taken off every session (and the engine
is let go), so the upload policy's narrow type filter is all that remains
and no other request makes the trip through the main process.

`onBeforeRequest`, for a page or frame load (GET): bounce page → its
destination; tracking parameters → stripped; then, for a page, the HTTPS
upgrade; then the danger engine (a page is redirected to the warning, a frame
is cancelled). For every other request: the blocking engine. A match blocks
(or answers with a redirect resource, e.g. a no-op script); a `$removeparam`
match rewrites. **Standard** lets a match through when the request is to the
site being visited (the top-level page's — a third-party frame's requests to
its own host stay third-party), unless the filter is `$important` or written
for first parties only — Brave's standard mode, which is where nearly all
breakage comes from. **Aggressive** applies every filter as written, as uBO does.
Pages themselves are never blocked by the ad and tracker lists, but their
addresses are cleaned by the lists' `$removeparam` filters (AdGuard URL
Tracking, the person's own).

`onBeforeSendHeaders`: `Sec-GPC: 1`; cross-site `Referer` trimmed to the
origin (or removed under `strip`); `<a ping>` audits (they carry `Ping-To`;
`sendBeacon` does not) cancelled; `Cookie` removed from cross-site requests
— all of them under `all`, or those a filter names as tracking (a match an
exception let through) under `trackers`. WebSocket handshakes carry cookies
too, and get the same treatment.

`onHeadersReceived`: `$csp` directives appended for documents (pages and
framed documents alike — Ghostery answers `$csp` for main frames only, so a
frame is asked about as a document); `Set-Cookie`
removed from cross-site responses under the same rule; the HTTPS upgrade
marked as held. `onBeforeRedirect`: a site that answers the upgrade by
sending the browser back to http:// is remembered as HTTP-only for the run.

The request's context is its own frame's address (from `details.frame`; an
about:blank or about:srcdoc frame's is the ancestor it inherits its origin
from), not the referrer; the top-level page decides exceptions,
cross-site-ness, and Standard's leniency. Both are handed to the engine with
their domains worked out as the cookie rules count sites — private suffixes
included — so a rule's `$third-party` agrees with Shields on what another
site is (alice.github.io and bob.github.io are two). A service worker's requests carry
no frame or page; its script's address (the referrer) stands for the site.

## 4. Addresses, HTTPS, and the warnings

- **Tracking parameters** (`url-rules.ts`): Standard removes click and
  recipient identifiers — the union of Brave's query filter and Firefox's
  query-stripping list (`fbclid`, `gclid`, `msclkid`, `mc_eid`, `_hsenc`,
  `srsltid`, …) plus site-specific ones (`si` on YouTube/Spotify, `igsh` on
  Instagram, `s`/`t` on X, …). Strict also removes campaign tags (`utm_*`)
  and loads AdGuard URL Tracking. The kept query keeps its exact spelling.
- **Bounce tracking**: redirect pages whose destination is in the address
  (google.com/url, l.facebook.com, l.instagram.com, out.reddit.com,
  youtube.com/redirect, steamcommunity linkfilter, slack-redir, LinkedIn's
  safety page, …) are skipped, as Brave's debouncing does.
- **HTTPS**: `upgrade` is Chrome's HTTPS-Upgrades, which lives in Chrome's
  browser layer and not in Electron: http:// pages (GET only — a fallback
  could only replay a form POST as a GET) load over HTTPS, private,
  single-label, IP-literal, `.test`, and explicit-port hosts excepted. When the
  upgraded load fails for a reason HTTP would not share (TLS, refused, reset —
  not DNS or offline), the tab falls back to http:// and the host is
  remembered for the run; a site that redirects the upgrade back to http:// is
  remembered the same way. `strict` (HTTPS-Only) shows the warning instead in
  both cases, and honors only the sites the person continued to from it —
  never an automatic fallback from before the switch. A Glance and a sign-in
  popup fall back (or warn) like a tab.
- **Warnings** (`interstitial.ts`): `pistachio://shields/blocked?t=…` for a
  page on a Security list, `…/insecure?t=…` under HTTPS-Only. The token stands
  for the stopped address in main, so a page cannot forge a "continue" for an
  address of its choosing; continuing lets the host through for the run.

## 5. In the page

The tab preload (`preload/tab.ts`) runs in **every frame** of a human page —
tabs, Glances, and sign-in popups set `nodeIntegrationInSubFrames` (still
sandboxed, still context-isolated) — and the rest of it, the page's own
features, runs in the top frame only. In each frame it asks main
**synchronously**, at document start, what the frame gets
(`pistachio:shields-frame` → `ShieldsFrameBootstrap`). Main answers for any
frame of a page in a protected session: hiding and scriptlets by the address
the frame committed; the exception and the fingerprinting seed by the site
being visited (the top frame's), so every frame of a page reads the same
noise. An about:, blob:, or data: frame gets the protections alone.
Then, before the frame's first script — verified in Electron 43 under a page
CSP, in same-origin, cross-origin, srcdoc, and parser-made frames:

- **Protections** run in the page's world through
  `contextBridge.executeInMainWorld(installPageProtections)`
  (`@pistachio/shell-contracts/shields-page`, self-contained).
- **Scriptlets** run in the page's world through `webFrame.executeJavaScript`,
  which no page CSP applies to.
- **Hiding CSS** for the site goes in through `webFrame.insertCSS` as a user
  style sheet (user-origin `!important` beats the page's).
- Once parsed, the DOM's classes, ids, and links are reported
  (`pistachio:shields-cosmetics`, batched 25 ms / at most 1 s, each once, in
  batches of 2,000 — none dropped) and the generic hiding CSS they call for
  comes back.

**Fingerprinting** (`installPageProtections`): `standard` is Brave's farbling
— canvas (`getImageData`, `toDataURL`, `toBlob`, OffscreenCanvas
`getImageData` and `convertToBlob`), WebGL `readPixels` (only the pixels the
read wrote, where pixel-pack state put them, into any realm's buffer), and
audio (`getChannelData`, `copyFromChannel`,
`getFloatFrequencyData` — only the samples actually written) read back with a little noise seeded by a per-run,
per-site key (HMAC of a random run key and the site, private suffixes
counted as sites) AND a digest of the content read. So a site reads the same
values all session, two sites cannot join theirs, and reading a known image
(a black canvas, silence) reveals nothing about the noise on another; and
`hardwareConcurrency` rounded down at random. `strict` also removes
`getBattery`, `navigator.connection`, and `speechSynthesis` voices, hides the
WebGL renderer string, and reports the screen as the window (Firefox's
resistFingerprinting). Patched functions print as the natives they replace,
and the initial about:blank document of a frame the page makes (a common
way to reach clean copies before any preload could run) is patched as it
appears — per realm, so a frame navigated to another same-origin document
is patched again, and never a frame its own preload already protected.
Floating-point readbacks (`rgba-float16`) move by 2⁻¹¹ instead of a flipped
bit, and an export's noised copy is drawn in the canvas's own color space
(a Display-P3 canvas keeps its gamut). The **user agent** stays Electron's
own (`Pistachio/x Chrome/… Electron/y`) at every level: Cloudflare Turnstile
fails a page whose user agent hides the `Electron/` token (error 600010 —
measured 2026-10-06 on a Clerk sign-up; dropping only `Electron/` failed,
Shields off passed), so reducing it for the whole session, as Shields first
did with fingerprinting on, broke every Turnstile CAPTCHA. Only the sites
that refuse Electron's (`CHROME_USER_AGENT_HOSTS` in `url-rules.ts`: Google's
sign-in, kept on Chrome's as a precaution — never measured either way) get
Chrome's (`Chrome/150.0.0.0`, frozen as Chrome does): their documents and
whatever their documents ask for, rewritten in `onBeforeSendHeaders`, and
`navigator.userAgent`/`appVersion` in their frames through the protections —
a blank or srcdoc frame judged by the frame it inherits its origin from, a
blob frame by the origin that made it, never by the top page (a per-tab `setUserAgent` cannot do it: set at navigation start it misses
that request's header, and set during a redirect it stalls the load). It is
there for the site to work, so a site's exception keeps it.
**GPC** sets `navigator.globalPrivacyControl`.

**WebRTC**: `webContents.setWebRTCIPHandlingPolicy` per tab — `default`
(Chromium already hides local addresses behind mDNS), `public`
(`default_public_interface_only`), `proxied` (`disable_non_proxied_udp`).
Identity egress (docs/cloud-sync-design.md) raises the floor to `proxied`.
A site with Shields down gets `default` (above the floor), re-evaluated on
every page load and whenever an exception changes. Sign-in popups take the
policy as tabs do (a new WebContents does not inherit its opener's).

## 6. Levels, sites, and the UI

`DesktopSettings.shields` (`ShieldsSettings`). A preset OWNS its knobs: a file
that says `standard` gets the standard values whatever else it holds, so a
release that improves the preset reaches everyone on it. Changing any knob
without naming a level makes it Custom; knobs that land exactly on a preset
read as that preset again (`mergeShieldsPatch`). The person's own filters
belong to no preset.

| | Standard (default) | Strict |
| --- | --- | --- |
| Ads and trackers | Standard (1st-party leniency) | Aggressive |
| Lists | uBO's defaults | + annoyances, social |
| Cookie banners | Leave | Hide |
| Tracking parameters | Trackers | + campaign tags, AdGuard URL Tracking |
| Bounce tracking | On | On |
| Cross-site cookies | Tracking cookies | All |
| Fingerprinting | Standard (farbling, Chrome UA) | Strict |
| HTTPS | Upgrade | HTTPS only |
| Referrer | Only the site | Only the site |
| WebRTC | Default | Public address only |
| GPC, `<a ping>`, dangerous sites | On | On |

Do Not Track is deliberately not offered: it is retired (Firefox removed its
toggle in 135) and only adds entropy.

**Per site** (`main/shields/site-store.ts`, `<userData>/shields/state.json`):
an exception is a hostname without `www.` and covers its subdomains. It
lowers everything above except GPC, which speaks for the person, not the
page (as in Brave). The same file keeps the running counts (requests blocked,
addresses cleaned, pages moved to HTTPS).

**UI**: Settings → Privacy & security now opens on **Ads & trackers**
(`sections/shields.tsx`): the master switch and counts, the level cards, each
protection with what it does and breaks, the lists with their freshness, My
filters (with the lines that did not parse), and the sites with Shields down.
The site popover gains a **Shields** switch with "N requests blocked" and the
hosts behind them; flipping it reloads the page. Site controls shows the same
with a link to the settings.

## 7. Other hosts

`ShellApi.shields` and `BrowserControlsSnapshot.shields` are new. The cloud
browser and the site preview refuse `shields` with their own sentence and
report `shields: null`, so the settings page renders "Not available here" and
the popover hides the switch. The settings themselves travel in the
account-global shell settings register (`ShellShieldsRecord`), like every
other shell setting.

## 8. Tests

- Unit: `apps/desktop/test/shields-{url-rules,engine,lists,request-hub}.test.ts`,
  `packages/shell-contracts/test/shields.test.ts`.
- End to end: `apps/desktop/e2e/tests/shields.spec.ts` — a two-site local
  fixture with seeded list cache: request blocking, site and generic hiding,
  a scriptlet that runs before the page's first script, GPC (header and
  property), Electron's user agent kept on the page and Chrome's on a listed
  host (`PISTACHIO_SHIELDS_CHROME_UA_HOSTS=localhost`, E2E only) for its
  requests, its page reached by a redirect, and the srcdoc and blob frames
  its cross-site iframe makes, stable farbled canvas that differs once
  Shields are down, the cross-site cookie kept out, the popover count and
  hosts, `<a ping>`, tracking parameters, bounce pages, the dangerous-site
  warning and its way through, lowering Shields for the site, and the
  settings page's levels, exceptions, lists, and persistence.
- Live: `apps/desktop/e2e/tests/shields.live.spec.ts` (`PISTACHIO_SHIELDS_LIVE=1`)
  fetches the real lists into a fresh profile and opens two news front pages.
  On 2026-10-03: 9 lists, 134,218 network and 42,694 cosmetic filters;
  theverge.com lost 17 requests (DoubleClick, Amazon ads, Google Tag
  Services, DoubleVerify, Concert, …) and rendered whole.
- Specs never reach the list servers (`PISTACHIO_E2E`);
  `PISTACHIO_SHIELDS_FETCH=1` lets them.

## 9. Not done, and known limits

- **Workers** (dedicated, shared, service) run no Shields script: an
  OffscreenCanvas or audio read inside one is not noised, and on a site that
  gets Chrome's user agent a worker's `navigator` still reports Electron's,
  as do its requests to other hosts.
- **Procedural cosmetic filters** (`:has-text`, `:upward`, …) are not applied
  (`loadExtendedSelectors: false`): they need Ghostery's extended-selector
  matcher in the preload.
- **Cookie banners** are hidden, not answered. Auto-reject would embed
  DuckDuckGo's `@duckduckgo/autoconsent` (MPL-2.0), which DuckDuckGo and
  Ghostery use.
- **Cross-site cookies** are removed from headers; `document.cookie` inside a
  third-party frame is untouched. Chromium's `test-third-party-cookie-phaseout`
  switch would block them fully, but is global, needs a restart, and cannot
  honor per-site exceptions.
- **First run** is unprotected until the lists arrive (about a second on a
  good connection); no engine is bundled. A release step could prebuild one.
- No CNAME uncloaking (Electron exposes no CNAME chain), no regional lists,
  no differential list updates, no element picker, no "report a broken site".
- No 3-second fast fallback for a slow HTTPS upgrade (Chrome has one).
- Agent run partitions and the cloud browser are not protected.
- Never use the CC BY-NC-SA datasets (DuckDuckGo Tracker Radar, Ghostery
  TrackerDB) or Google Safe Browsing (non-commercial) without a license.
