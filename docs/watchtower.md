# Watchtower

Watchtower is the browser's photographic memory: a local, searchable
Markdown archive of what the person actually read, not just where they went.
"That article about pistachio blight from a few weeks ago" and "the video
where the guy rebuilds a lathe" are both Watchtower questions. Every answer
is a **visit** — a moment in time — that opens the exact page content seen
then, whole, even though the archive never stores the same paragraph twice.

Status: **design, revision 1** (2026-09-18). Nothing here is built yet.
Desktop only; the cloud host lists the API as unsupported (§9).

## 1. Principles

1. **Record attention, not loads.** A page is archived once the person has
   looked at it for a few seconds. Redirect hops, background tabs never
   opened, prerenders and link previews are not memories.
2. **Keep the substance only.** What is stored is the readable content as
   Markdown plus a small metadata card. No markup, class names, scripts,
   styles, navigation, or form values.
3. **Never store the same text twice.** Content is cut into chunks that are
   addressed by their hash. A revisit with no change costs one ~50-byte visit
   row; a changed page costs only its changed chunks — in the body store
   *and* in the search index.
4. **Every visit resolves to a whole page.** Versions are manifests of chunk
   hashes (a git tree), not delta chains. Reconstructing any version is a
   lookup, never a replay, and deleting one version can never damage another.
5. **Invisible cost.** The browser's main process does no parsing, hashing,
   compression or SQL. In-page work runs at idle, once per settled page.
6. **Local and erasable.** The archive never leaves the machine, never
   syncs, and is never sent to a model except as results of a search the
   person (or their agent run) asked for. Pause, exclude, forget and wipe are
   first-class.

## 2. Verified foundations

Probed on this repo's Electron (43.4.1, Node 24.18.1) on 2026-09-18:

| Fact | Result |
| --- | --- |
| `node:sqlite` in main and in `utilityProcess` | works, SQLite 3.53.1 |
| FTS5, `porter`/`unicode61`, `trigram`, `contentless_delete=1` | all available |
| `zlib.zstdCompressSync` | available |
| 20,000 × 900-char chunks into contentless FTS5, in a utility process | 103 ms |
| Two-term query over that index | 0.09 ms |

So Watchtower gets a real full-text index and compression with **no native
module**: `electron-builder.yml` keeps `npmRebuild: false`, nothing changes
for signing or notarization. Vitest runs the same storage code under system
Node (≥ 22.13 has `node:sqlite` unflagged).

Rejected alternatives: `better-sqlite3` (the app's first native dependency,
for nothing `node:sqlite` lacks); the JSON-file store pattern used elsewhere
(whole-file rewrite cannot hold hundreds of MB, and there is no index);
one `.md` file per page on disk (tens of thousands of small files, no
dedup, no index — Markdown-on-disk is an **export**, §8); textual delta
chains (fragile to deletion, slow to reconstruct, and the index would still
duplicate).

## 3. Model

```
page ──< version ──< version_chunk >── chunk ── (FTS5 row)
  └──< visit ───────┘ (each visit points at the version that was seen)
```

- **Page** — one canonical address within one Space: `(space_id, url_key)`.
  `url_key` drops the fragment, tracking parameters and `www.`, and honors a
  same-host `<link rel=canonical>` — the rules `bookmarkUrlKey` already
  implements, lifted into the shared package. Pages are per Space because two
  Spaces can be signed in as different people; chunk addressing makes the
  overlap free.
- **Chunk** — a run of Markdown blocks, addressed by the first 16 bytes of
  its SHA-256. Boundaries are structural: a chunk never crosses a heading,
  and within a section blocks are packed greedily to ~1,200 characters. An
  edit therefore dirties one chunk, and an insertion shifts boundaries only
  to the end of its own section. Text is stored zstd-compressed. Chunks are
  shared across versions, pages and Spaces.
- **Version** — what a page said at one time: title, metadata card, kind,
  word count, a content hash (hash of the ordered chunk hashes), and its
  manifest in `version_chunk(version_id, seq, chunk_id)`. A capture whose
  content hash equals the page's head version creates **no** version.
- **Visit** — `(page, version, at, dwell_ms)`. This is provenance: "what did
  I see two weeks ago" finds visits in that window and opens *their*
  versions, not today's.

**Kinds.** `article` (reader extraction succeeded), `page` (generic
fallback), `video` (JSON-LD `VideoObject` or `og:type=video*`). The metadata
card carries description, site name, byline, published date, language, lead
image URL (the URL only — no image bytes), and for videos the channel,
duration and description. The card's text is a chunk like any other, so a
half-remembered video is findable by its description or channel.

**Deletion and retention.** Removing a version removes its manifest rows;
chunks whose last reference went away are swept (body and index row) by a
background pass. Retention evicts oldest versions first and keeps visit rows
with title and URL, so old history degrades to "classic history" instead of
vanishing.

### Schema (`<userData>/watchtower/watchtower.db`, WAL)

```sql
page(id, space_id, url_key, url, host, title, first_at, last_at,
     visit_count, head_version_id, UNIQUE(space_id, url_key))
version(id, page_id, content_hash, at, kind, title, word_count, meta_json)
version_chunk(version_id, seq, chunk_id, PRIMARY KEY(version_id, seq)) WITHOUT ROWID
chunk(id INTEGER PRIMARY KEY, hash BLOB UNIQUE, body BLOB /* zstd */, chars)
visit(id, page_id, version_id, at, dwell_ms)
chunk_fts  USING fts5(body, content='', contentless_delete=1,
                      tokenize='porter unicode61 remove_diacritics 2')  -- rowid = chunk.id
page_fts   USING fts5(title, url_words, headings, content='', contentless_delete=1, ...)
                                                                        -- rowid = page.id
meta(key, value)   -- schema_version, counters, last sweep
```

The index is contentless: FTS5 keeps only its inverted index, the text lives
once in `chunk.body`. Snippets are cut in TypeScript from the decompressed
chunks of the top results.

**Budget (estimate, to be measured in stage 1).** ~250 page views a day, of
which ~40 % are new content at ~6 KB of Markdown: ≈ 0.6 MB/day raw, ≈ 0.5
MB/day on disk after zstd plus index, ≈ 180 MB/year. Default size cap 2 GB.

## 4. Capture

Hooked in `BrowserController.#wireManagedTab`, behind a narrow
`WatchtowerCapture` interface so the controller only reports events.

**Eligibility.** `kind === "human"`, listed, `lifecycle === "live"`,
`http(s)` only, Watchtower on and not paused, the tab's Space not excluded,
the host not on the exclusion list. Glance previews are captured only once
promoted to a tab.

**Timing.** A navigation (`did-navigate`, or `did-navigate-in-page` for SPA
routes) arms the tab. Capture fires when the page has been **settled ≥ 1.5 s**
(`did-stop-loading`, debounced by title updates) **and the tab has been the
visible tab of its pane for ≥ 4 s** in total. If the person dwelt > 30 s,
one more capture runs on leave (navigate away, close, suspend) to catch
content that grew; per page, at most one new version per 10 minutes. One
capture in flight per tab, two globally.

**Extraction** runs in the page via `executeJavaScriptInIsolatedWorld` (the
page's patched prototypes can't feed it lies), inside `requestIdleCallback`
with a 2 s timeout, and returns data that main-side code re-validates:

1. The existing `READER_EXTRACT_SCRIPT` scoring, generalized: when it finds
   an article, use it (the 120-word reader floor does not apply here).
2. Otherwise the **generic walk**: the `main` / `[role=main]` landmark, or
   the body minus `nav, header, footer, aside, form, [hidden],
   [aria-hidden=true]`, script/style/template, into the same block model
   (headings, paragraphs, lists, quotes, code, tables as text).
3. Always the **card**: title, meta description, Open Graph, canonical,
   language, JSON-LD reduced to a few typed fields.

Never read: input/textarea/select values, `contenteditable` regions,
cross-origin frames. **Skip the page entirely** when it has a visible
`input[type=password]`, or yields < 40 words and no card description.
Payload cap 400 KB of text, 1,500 blocks (the reader's caps).

**Hand-off.** Main forwards the validated payload to the worker and is done.
The worker renders Markdown (`renderReaderMarkdown`, extended for tables and
the card), chunks, hashes, and commits page + version + visit + new chunks +
index rows in one transaction. The queue is bounded (64); overflow drops the
oldest pending capture and counts it.

## 5. Processes and packages

- **`packages/watchtower`** (`@pistachio/watchtower`, pure TS, raw-source
  like its neighbors): URL keys, chunker, Markdown rendering of a capture,
  query parser, result merging/ranking, snippet cutting, the schema and the
  `Archive` class over an injected `DatabaseSync`. Everything testable under
  vitest with an in-memory database. Add to `workspacePackages` in
  `electron.vite.config.ts`.
- **`apps/desktop/src/main/watchtower/worker.ts`** — the repo's first
  `utilityProcess`; a second main-build entry (`input: { index,
  "watchtower-worker" }`). Owns the database exclusively. Speaks a small
  typed request/response protocol over `parentPort`: `ingest`, `search`,
  `timeline`, `page`, `version`, `diff`, `forget`, `stats`, `export`,
  `sweep`.
- **`main/watchtower/service.ts`** — spawns and supervises the worker
  (restart with backoff; captures are dropped, never buffered unboundedly,
  while it is down), owns the capture scheduler, and exposes the narrow
  interfaces the controller, IPC layer, protocol handler and run controller
  use. No Electron import in the scheduler, so it is unit-testable with a
  fake clock, like the reminder scheduler.
- **`main/watchtower/capture-script.ts`** — the in-page script string,
  living beside `reader-extract.ts` in `shell-contracts` if the reader ends
  up sharing the generalized walk.

## 6. Search

Query syntax: free text, `"exact phrases"`, and filters `site:`, `kind:video`,
`space:`, `before:` / `after:` / `on:` (ISO dates and words: `yesterday`,
`last week`, `august`). The parser is pure and shared by the UI and the
agent tool.

Execution: (1) all terms within one chunk (`chunk_fts`, BM25); (2) terms in
title / URL / headings (`page_fts`, weighted higher); (3) if thin, the OR
relaxation, scored by term coverage. Hits are mapped chunk → versions →
pages, collapsed to **one result per page** carrying its best snippet, the
matching version, and the visits in the filter window. Final score blends
BM25 with recency and visit count. Target: < 30 ms at 1 M chunks.

No embeddings in v1. The app's embedder is a remote provider; shipping the
person's whole reading history to it is not acceptable as a default. Vague
recall is handled by the agent instead (§7), which can try several phrasings
and read candidates. A local embedding model is a possible later stage.

## 7. Surfaces

- **Archive page** — `pistachio://watchtower`, a chrome overlay like
  Bookmarks (`Overlay` variant, `ShellCommand` `openWatchtower`, intercepted
  in `tabCreate`/`tabNavigate`). A search field over a day-grouped timeline;
  site and kind filters; each row shows title, host, time, snippet.
- **Snapshot** — `pistachio://watchtower/v/<versionId>?visit=<id>`, a real
  document in a real tab served by `WatchtowerService.respond()` from both
  protocol handlers (`main/index.ts` and `#configureSession`). Inert HTML in
  the reader's typography, with a banner: *Snapshot from 4 Sep 2026, 15:12 ·
  Open live page · 3 versions · What changed*. Being a tab, it splits beside
  the live page, and find-in-page works. `…/md` returns `text/markdown`.
  **What changed** is a manifest diff (chunks added/removed), then a word
  diff inside replaced chunks.
- **Address palette** — a `watchtower` `Entry` variant: up to three content
  matches below history rows, queried from the worker with an 80 ms
  debounce, for queries of ≥ 3 characters.
- **Agent** — tool group `watchtower`: `watchtower_search(query, after?,
  before?, site?, kind?)` returning titled, dated snippets with visit ids,
  and `watchtower_read(visitId | versionId, maxChars)`. Mirrors the
  `bookmark_search` recipe (`WatchtowerToolHost` in `runner.ts`,
  `#watchtowerInput` in `run-controller.ts`, a system-prompt line, the group
  in `tool-groups.ts` and in `docs/cloud-sync-design.md`'s list).
- **Chrome actions** — `watchtower.open`, `watchtower.pause`,
  `watchtower.forgetPage`, in `CHROME_ACTIONS` (so they reach the palette),
  with a default shortcut for open. Manifest placement: the folded sidebar
  menu / top overflow; a paused state is visible wherever the toggle is.

## 8. Privacy, settings, lifecycle

`settings.watchtower`: `enabled`, `paused`, `excludedHosts[]` (suffix match),
`excludedSpaces[]`, `retentionDays` (0 = forever), `maxSizeMb` (2048),
`agentAccess` (on). Settings → Privacy → **Watchtower** shows the switches,
the exclusion list, live stats (pages, versions, size, dedup ratio), *Forget
the last hour / day / a site / everything*, and *Export as Markdown* (a
folder of `YYYY/MM/host/title.md` with front matter, one file per version).

- The exclusion list ships seeded with categories where an archive is a
  liability: webmail, banking and payments, password managers, health
  portals. The person can edit it. *(Open question 2.)*
- `browsingDataClear` and deleting a Space delete that Space's pages.
- Agent tabs (`kind: "agent"`) are never archived.
- The database is not encrypted at rest (FTS over ciphertext is not
  possible without SQLCipher); it relies on the OS account and FileVault,
  like Chromium's own History file. Stated plainly in the settings page.
- Settings stay local like every other desktop setting; nothing is added to
  `sync-protocol`.

## 9. Contract parity

New `ShellApi` members (`watchtowerSearch`, `watchtowerTimeline`,
`watchtowerStats`, `watchtowerForget`, `watchtowerExport`) go in
`shell-contracts/src/ipc.ts`, the preload, and `installIpc()` (shell-only
guards). `services/cloud-browser`'s `ShellHost` lists them in `UNSUPPORTED`
with the reason "Watchtower archives pages on the person's own machine".
The shell hides the entry points when the API is unsupported.

## 10. Stages and gates

Each stage ends green on `pnpm check-types`, `pnpm lint`, `pnpm test`, and
its own spec.

1. **Archive core** — `packages/watchtower`: URL keys, chunker, schema,
   `Archive` (ingest / reconstruct / dedup / forget / sweep), query parser,
   search. Property tests: any ingested version reconstructs byte-identical;
   re-ingest adds zero chunks; a one-paragraph edit adds ≤ 2 chunks; forget
   never breaks another version. A benchmark script over a synthetic year
   validates the §3 budget.
2. **Capture** — worker + service + scheduler + capture script + controller
   hook + settings section (enable / pause / exclusions). E2E: browse a local
   fixture site, assert rows; password page and excluded host produce none;
   a revisit produces a visit but no version.
3. **Archive page and snapshot tab** — overlay, timeline, search, snapshot
   document, versions and diff, forget/clear, stats. E2E with screenshots;
   a `docs/qa/<date>/watchtower/` run.
4. **Palette and agent** — `Entry` variant, tool group, system-prompt line.
5. **Retention and export** — size/age eviction, sweep, Markdown export.
6. **Later, unscheduled** — local embeddings; video transcripts; wiki
   backlinks between archived pages; trigram index for CJK.

## 11. Open questions

1. **Default state.** Recommended: on for new and existing profiles, with a
   one-time notice that links to the settings page. The alternative is
   opt-in from onboarding.
2. **Seeded exclusions.** Recommended: ship the seeded category list (§8).
   The alternative is an empty list plus the password-field rule only.
3. **History import.** Recommended: none — Watchtower starts from the day
   it is enabled; `recents` has no content to import.
