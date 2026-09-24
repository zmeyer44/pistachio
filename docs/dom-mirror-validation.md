# DOM mirror implementation and validation

The cloud browser remains authoritative for JavaScript, network access, cookies
and application state. The web app now renders a synchronized DOM in an
opaque-origin iframe, with native layout, selection, scrolling and ordinary
form input. The trusted controller is the only script permitted in the iframe.
Unsupported content automatically returns the tab to the existing pixel path.

## Review findings addressed

- **Startup and lifecycle:** initialization no longer references helpers before
  declaration. A snapshot waits for recorder installation, including the faster
  production shell. Realm-dependent node checks are removed. Each iframe owns
  one controller and one set of input listeners; callbacks remain stable and
  tab switches remount the correct pane. Teardown cancels transfers and timers,
  releases held mouse buttons and revokes object URLs.
- **Document isolation:** the iframe omits `allow-same-origin`. The parent hands
  a single private MessagePort to that iframe's WindowProxy. Scripts, handlers,
  navigation and uncontrolled asset requests from site markup are suppressed;
  shell storage and authentication material remain outside the frame.
- **Assets:** the broker captures original guarded page responses before
  navigation. It never refetches a URL through an unguarded request client.
  IDs belong to a document, references are invalidated on navigation, and the
  shared cache includes images, fonts, CSS and blobs. Cross-origin stylesheets,
  nested imports, relative dependencies, dynamic stylesheet links, image source
  changes and page-owned blobs reach the local renderer.
- **Transport:** small asset announcements travel on the control socket; bytes
  use independent authenticated HTTP transfers (including the fleet route).
  Tests cover viewer keys, CORS, disconnection and document authorization.
  Assets, queues, cache bytes and pending input are bounded. Missing resources
  cause fallback instead of silently leaving a broken page.
- **Input and recovery:** node-addressed input checks frame/epoch and control
  generation, then rechecks authority after target lookup. Input is serialized;
  missing targets are dropped. Edit/scroll revisions and acknowledgements are
  viewer-specific. Old replies cannot clear newer local edits. Native textarea,
  select and change-on-blur behavior is retained. Read-only viewers can resync
  while the agent acts, and lagging viewers cannot buffer indefinitely.
- **Viewport and compatibility:** one active viewer owns the cloud viewport;
  passive viewers reflow locally. Embedded pages, rich editors, WebGL, video,
  plugins and prefilled passwords trigger pixel fallback. A static pixel page
  gets a fresh still after viewport resize even when Chromium produces no new
  compositor frame. This fixes the letterboxed first-frame case found by visual
  comparison.
- **Build gate:** `NEXT_PUBLIC_PISTACHIO_DOM_MIRROR` participates in Turbo's
  environment and cache key. Pixels remain the default when the flag is unset.

## Reproducible checks

Run from the repository root:

```sh
pnpm --filter @pistachio/dom-mirror test
pnpm --filter @pistachio/cloud-browser exec vitest run --maxWorkers=2
pnpm --filter @pistachio/desktop exec vitest run --config vitest.config.ts --maxWorkers=2
pnpm exec turbo run lint check-types --filter=web --filter=@pistachio/cloud-browser --filter=@pistachio/dom-mirror
pnpm --filter @pistachio/desktop check-types
pnpm exec turbo run build --filter=web
NEXT_PUBLIC_PISTACHIO_DOM_MIRROR=1 pnpm exec turbo run build --filter=web
```

Browser journeys, run from `apps/desktop`:

```sh
pnpm exec playwright test -c e2e/playwright.config.ts \
  e2e/tests/web-mirror.spec.ts e2e/tests/web-mirror-assets.spec.ts \
  e2e/tests/web-browse.spec.ts e2e/tests/web-two-apps.spec.ts \
  e2e/tests/web-onboarding.spec.ts e2e/tests/web-credential-capture.spec.ts \
  e2e/tests/web-split-links.spec.ts
PISTACHIO_E2E_WEB_PRODUCTION=1 pnpm exec playwright test \
  -c e2e/playwright.config.ts e2e/tests/web-mirror.spec.ts e2e/tests/web-mirror-assets.spec.ts
```

The production option builds Next with the test stack's public URLs and renderer
flag, then serves it with `next start`. Every build uses a private output directory.
The tests run real Chromium, the control service, the worker and the web app;
the latency test delays the actual WebSocket traffic rather than mocking the
cloud browser.

## Results

Verified locally on 2026-09-10:

| Check | Result |
| --- | --- |
| DOM-mirror package | 16 tests passed |
| Full cloud-browser suite | 344 tests passed across 45 files |
| Desktop unit suite | 536 passed; 2 live-agent tests skipped |
| Seven web regression journeys | All passed |
| Two mirror journeys against production builds | Both passed |
| Affected packages: lint and type checks | All passed (31 Turbo tasks) |
| Desktop type checks and changed E2E-file lint | Passed |
| Standard Turbo production builds, flag unset and enabled | Both passed; enabled bundle contains the literal flag |
| Whitespace/diff check | Passed |

The broad desktop lint command still fails on **153 existing warnings across
23 unchanged files** (including exploratory E2E scripts and cloud-run-service
unused declarations). None of those files was modified by this implementation;
lint of the changed E2E files passes. This is the remaining repository-wide
check failure, not a claim that the entire repository has clean lint.

The production fixture measured **2.6 ms median / 14.9 ms maximum** from a local
input event to the next animation frame with **400 ms added round-trip latency**.
Median opening times across five trials were **261 ms DOM / 248 ms pixels**.
Observed traffic was 1,218,937 bytes for DOM (including 148,645 asset bytes) and
1,261,187 bytes for pixels. These are small local-fixture samples, not a general
bandwidth or navigation-speed guarantee.

## Screenshot review

Screenshots live under `apps/desktop/e2e/screenshots/`. These paths are generated
artifacts, excluded from version control.

| Mirror assets screenshot | Checked state and visual verdict |
| --- | --- |
| `web-mirror-assets/01-shell.png` | Welcome shell and sidebar render without layout errors. |
| `web-mirror-assets/02-assets.png` | Heading uses the captured font and color. The fixture PNGs are transparent; decoded dimensions are verified separately. |
| `web-mirror-assets/03-local-under-latency.png` | Smaller viewport reflows text; the complete typed value is visible despite the delayed transport. |
| `web-mirror-assets/04-reconnected.png` | Accepted input survives reconnect and remains visible. |
| `web-mirror-assets/05-submitted.png` | Cloud form submission displays the Saved page. |
| `web-mirror-assets/06-fallback.png` | The embedded page is visible in pixel mode, including its green heading. |
| `web-mirror-assets/07-pixels-comparison.png` | The settled pixel frame fits the pane after resize. |
| `web-mirror-assets/07-dom-comparison.png` | The settled DOM view shows the same fixture at local resolution, after font loading. |

The five `web-mirror/` screenshots are also checked against the production
build: `01-shell-open.png` shows the working shell; `02-mirror-painted.png`
shows the styled document; `02-context-menu.png` shows the shared page menu at
the local pointer position; `03-typed.png` shows the complete input;
`04-submitted.png` shows the saved response. Each is visually correct. The menu
is portaled to the shell document so transformed pane ancestors cannot offset
or clip it. No new application test IDs were required.

## Performance interpretation and compatibility limits

`web-mirror-assets/measurements.json` records five opening trials per renderer,
input-event-to-animation-frame times and received socket/asset bytes. The local
input test adds 200 ms of transport latency in each direction. Opening trials
use the local fixture without added latency and include shell tab creation;
pixel first-frame and DOM first-document are different readiness criteria.
Font-complete screenshots wait separately. Byte counts include shell updates
and background activity during the trials, not just the page payload.

These measurements establish that ordinary local typing and CSS reflow do not
wait for a cloud round trip. They do not establish universal navigation speed,
bandwidth savings, video quality, or parity across every website/browser/device.
Website JavaScript still runs remotely. DOM chosen by JavaScript, virtualized
lists and server-side behavior reconcile after cloud work. Small 2D canvases
are sampled; complex graphics, nested browsing contexts and rich editors use
pixels. Prefilled passwords use pixels to avoid editing a redacted placeholder
as if it were the original secret. This is the planned hybrid renderer, with
explicit compatibility fallback rather than a second local execution of sites.
