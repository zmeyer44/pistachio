# Notes

A **note** is a markdown document the person writes in Pistachio. Notes open in a tab at `pistachio://notes/<id>` as a blank page with a title and a body — no toolbar of heading buttons; the person types, and `#`, `-`, `[]`, `>`, ` ``` ` and `/` do what they do in Notion or Obsidian. There is no save: every change is kept as it is made, every note lives in the account's end-to-end-encrypted workspace and follows the person to every device, and the agent reads and writes notes as first-class tools. `pistachio://notes` is the library.

Every section below is normative for the implementation on branch `notes`. Where a piece copies an existing one, the original is named and the copy follows it.

| Piece | Where |
| --- | --- |
| Types, caps, sanitizers, search, tool views (pure) | `packages/agent-runtime/src/views/notes.ts`, re-exported by `packages/shell-contracts/src/notes.ts` |
| Markdown → self-contained HTML, snippets (pure) | `packages/notes` (`@pistachio/notes`) |
| Sync records | `packages/sync-protocol/src/records.ts` (`NoteRecord`, `NoteBlobRecord`), `workspace.ts` (`note:`, `note-blob:`) |
| Desktop store, sync, IPC | `apps/desktop/src/main/note-store.ts`, `sync/workspace-map.ts`, `sync/records.ts`, `index.ts` |
| Page routing | `packages/shell-contracts/src/shell-pages.ts` (`"notes"`) |
| Editor, library, store, commands | `packages/shell-ui/src/components/notes/`, `src/lib/notes-*.ts` |
| Agent tools | `packages/agent-runtime/src/runner.ts` (`noteTools`), `tool-groups.ts` (`user_notes`), desktop `run-controller.ts`, cloud `sync/workspace-tools.ts` + `runs/executor.ts` |
| Cloud shell host | `services/cloud-browser/src/sessions/shell-host.ts` (`notes`, `onNotes`; `HostTab.shellPage`) |
| Sharing | control `hosted_artifacts.kind`, `/v1/notes/*`; www `/notes/<shareId>`, `/app/notes`; desktop share popover |

## 1. Decisions

| # | Decision | Choice |
| --- | --- | --- |
| N1 | Canonical format | **Markdown text** (CommonMark + GFM task lists, tables, strikethrough). The editor's ProseMirror document is a view of it; the record holds markdown, never editor JSON. |
| N2 | One register per note | `note:<id>` holds `NoteRecord` — metadata **and** markdown in one sealed LWW register, like an artifact. No index register: readers list by prefix, and an index would be one contended key. |
| N3 | Images are sibling registers | `note-blob:<id>` holds one immutable, content-addressed image (`id` = first 24 hex of SHA-256 of the bytes). Markdown references it as `![alt](note-blob:<id>)`. Text and bytes never share a register, so autosave re-seals kilobytes, not megabytes. |
| N4 | Caps (client-enforced everywhere; nothing server-side stops growth) | `MAX_NOTES = 500`, `MAX_NOTE_TITLE = 200`, `MAX_NOTE_MARKDOWN_BYTES = 262_144`, `MAX_NOTE_BLOB_BYTES = 1_500_000` (after base64: ~2 MB, under `FRAME_BUDGET_BYTES`), `MAX_NOTE_BLOBS_PER_NOTE = 40`. The editor downscales a dropped image to ≤ 2048px on its long side and re-encodes (JPEG 0.85, or PNG kept when it has transparency) before it is ever stored. |
| N5 | Conflicts | Last-writer-wins by HLC, whole note — the sync layer's only merge (`mergeLww`). Two devices editing *different* notes never contend. The editor keeps typing local until idle; a remote version that lands while the editor is dirty is applied on the next idle save cycle *only if it is newer than what we last wrote* (see §5). No CRDT in v1; ProseMirror keeps the `y-prosemirror` door open. |
| N6 | Ids | Twelve lowercase hex, `randomBytes(6)`, like artifacts (`isArtifactId` regex reused as `isNoteId`). |
| N7 | Tool group | `user_notes` with tools `note_list`, `note_search`, `note_read`, `note_create`, `note_update`, `note_delete`. **Not** `notes` — that is the agent's per-run scratchpad (`task_notes`) and is stripped on answer turns (`runner.ts` `mode === "answer"`). Protocol request names are `note.*` singular (`notes.*` is the scratchpad's). |
| N8 | Shortcut | `newNote` = `Mod+Alt+N` (⌘⌥N). `openNotes` exists as a configurable action, default unbound. Appended **last** in `SHORTCUT_DEFINITIONS`. |
| N9 | Sharing | Read-only sharing reuses the artifact hosting pipeline: `hosted_artifacts` gains `kind ('artifact'|'note')`, routes `/v1/notes/:id/visibility|revision` and `/v1/public/notes/:shareId` copy the artifact ones, www proxies `/notes/<shareId>`. The published body is finished HTML rendered **on the owner's device** by `@pistachio/notes`; control never learns markdown. Edit permission is a separate stage (§9). |
| N10 | Web | The notes pages are shell-drawn, so they run in `apps/web` once the cloud `ShellHost` answers `notes`/`onNotes` over `WorkspaceToolStore` and treats `pistachio://notes…` as a shell page. `apps/www` `/app/notes` is a read-only library + viewer over the decrypted workspace (like `/app/artifacts`). |
| N11 | Editor library | TipTap 3 (ProseMirror) inside `packages/shell-ui`, lazily loaded. No Lexical, no custom contenteditable, no `dompurify` (a closed schema is the sanitizer), no `shiki`. |

## 2. Records

`packages/sync-protocol/src/records.ts` (dependency-free, mirrored by `agent-runtime/src/views/notes.ts` and held together by `shell-contracts/test/record-docs.test.ts`):

```ts
export interface NoteRecord {
  id: string;             // 12 hex
  title: string;          // "" allowed; the library shows "Untitled"
  markdown: string;       // canonical body; never includes the title
  icon: string | null;    // one emoji, or null
  blobIds: string[];      // every note-blob this note references (for cleanup and caps)
  createdAt: string;      // ISO
  updatedAt: string;      // ISO
  revision: number;       // monotone, bumped on every local write
  source: { kind: "user" | "agent"; runId: string | null };
}

export interface NoteBlobRecord {
  id: string;             // 24 hex, sha256 prefix of the bytes
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  byteLength: number;
  data: string;           // base64
  createdAt: string;
}
```

`workspace.ts`: `NoteDoc {kind:"note", note}` and `NoteBlobDoc {kind:"noteBlob", blob}`; `workspaceKeyFor` → `note:<id>` / `note-blob:<id>`; both prefixes join `RECORD_KEY_PREFIXES`. A register holding `null` is a deletion.

`packages/agent-runtime/src/views/notes.ts` (Node-typed, the desktop's own type): `Note` (same shape as `NoteRecord`), `NoteSummary` (`Note` minus `markdown` plus `snippet: string` — the first ~160 chars of plain text), `NoteInput`, `NotePatch`, the caps, `isNoteId`, `sanitizeNote`, `sanitizeNoteInput`, `sanitizeNotePatch`, `noteSnippet(markdown)`, `searchNotes(notes, query, {limit})` (title, then body, case-folded, ranked like `searchBookmarks`), `noteToolView(note)` (what the model sees: id, title, updatedAt, snippet or full markdown), `describeNote`. `packages/agent-runtime/package.json` exports `./notes`.

`packages/notes` (`@pistachio/notes`, pure, browser-safe): `renderNoteHtml(note, {blobs: (id) => NoteBlobRecord | null, theme})` → one self-contained HTML document (inline CSS in the shell's tokens, light/dark via `prefers-color-scheme`, blobs inlined as `data:` URIs, links `rel="noopener"`, no scripts) suitable for `hosted_artifacts.public_html` under the artifact CSP; `noteToPlainText(markdown)`; `wordCount`. Uses `markdown-it` with task lists and `linkify` off; HTML in markdown is **escaped, not rendered** (`html: false`). Tests round-trip the fixture notes.

## 3. Desktop store and sync

`apps/desktop/src/main/note-store.ts` copies `ArtifactStore`'s split: `<userData>/notes.json` (metadata, whole-file atomic rewrite), `<userData>/notes/<id>.md` (bodies, read per request), `<userData>/note-blobs/<id>` (bytes, with the media type in the index). Surface:

- `list(): NoteSummary[]` (most recently updated first), `get(id): Note | null`, `search(query, limit)`.
- `create(input, source): Note`, `update(id, patch, source): Note` (bumps `revision`, stamps `updatedAt`, recomputes `blobIds` from the markdown), `remove(id)` (tombstones the note **and** every blob no other note references).
- `putBlob(bytes, mediaType): NoteBlobRecord` (hashes, dedupes, enforces `MAX_NOTE_BLOB_BYTES`), `getBlob(id)`.
- `onChange(listener: (snapshot: NoteSnapshot) => void)` — renderer-facing, **metadata only** (`{notes: NoteSummary[]}`), so a 500-note library never serialises bodies on a keystroke.
- `onRecordChange(listener: (kind: "note" | "noteBlob", id) => void)` — sync-facing, local writes only.
- `syncAll()`, `syncGet(kind, id)`, `applyRemote(kind, value)`, `removeRemote(kind, id)` — remote applies never echo back to `onRecordChange`; an identical value short-circuits.

Wire it exactly as the artifact adapter is at `index.ts` (`new WorkspaceRecords({...})`): `"note"` and `"noteBlob"` join `WORKSPACE_RECORD_KINDS`, `recordDocFor`, `recordOfDoc`, `readRecordDoc` in `sync/workspace-map.ts`, and `WorkspaceRecords` in `sync/records.ts`. The global 40 ms publish debounce stays; the editor's own 600 ms idle debounce (§5) is what limits publish frequency.

## 4. Shell API and pages

`packages/shell-contracts/src/notes.ts`: re-exports the views, plus `NOTES_PAGE_URL = "pistachio://notes/"`, `NOTES_PAGE_TITLE = "Notes"`, `NOTES_PAGE_FAVICON`, `isNotesUrl(url)`, `notesUrlId(url)` (`null` = library, `string` = note id, `undefined` = not ours — the `briefUrlDate` convention), `noteUrl(id)`, and the request union:

```ts
type NoteRequest =
  | { type: "list" }
  | { type: "search"; query: string; limit?: number }
  | { type: "get"; id: string }
  | { type: "create"; input?: NoteInput }
  | { type: "update"; id: string; patch: NotePatch }
  | { type: "delete"; id: string }
  | { type: "putBlob"; mediaType: NoteBlobMediaType; data: string /* base64 */ }
  | { type: "getBlob"; id: string }
  | { type: "exportHtml"; id: string };
type NoteResponse =
  | { type: "list"; notes: NoteSummary[] }
  | { type: "note"; note: Note }
  | { type: "maybeNote"; note: Note | null }
  | { type: "deleted" }
  | { type: "blobId"; id: string }
  | { type: "blob"; blob: NoteBlobRecord | null }
  | { type: "html"; html: string };
```

`ShellApi` gains `notes(request: NoteRequest): Promise<NoteResponse>` and `onNotes(listener: (snapshot: NoteSnapshot) => void): () => void` (`IPC.notes`, `IPC.notesChanged`; `SHELL_METHOD_NAMES`, `SHELL_EVENT_CHANNELS`; preload; `ipcMain.handle` with `shellOnly`). The cloud host implements both in stage 2; until then it lists `notes` in `UNSUPPORTED` with a stub so `implements ShellApi` compiles.

`shell-pages.ts`: `ShellPage` gains `"notes"`; `shellPageOf` recognises `isNotesUrl`; `shellPagePlaceholderHtml` emits the title (`Notes`, or the note's title is set later by the page through the tab — see below) and favicon. **Tab title:** main sets it from the placeholder (`page-title-updated`), which is static. The editor therefore calls `shellApi().setTabTitle(tabId, title)` — a new, tiny `ShellApi` member (`IPC.setTabTitle`; desktop main sets `tab.info.title` and republishes; cloud sets `HostTab.title`) — whenever the note's title changes. Only shell pages may use it; main refuses it for a tab whose URL is not a shell page.

Commands (`chrome.ts` `ShellCommand`): `{type:"openNotes"; noteId?: string}` and `{type:"newNote"}`. Store (`store.ts`): `openNotes(noteId?)` selects an open tab at that URL or creates one; `newNote()` calls `notes({type:"create"})` then opens the new note. Chrome actions `openNotes` (label "Notes", `NotebookPen` icon) and `newNote` (label "New note", `shortcutId: "newNote"`), which makes them palette rows for free; add `ACTION_KEYWORDS` and `action-intents.ts` entries and a `SidebarMenu` item (`testId="notes-button"`). The palette also lists matching notes by title as `Saved` rows when the query matches (top 5, via `notes({type:"search"})`, debounced).

`ContentArea.tsx` `SplitPane` gains the third arm: `notesUrlId(tab.url) !== undefined` → `<NotesPage tabId noteId active />` (`React.lazy`, so the editor's chunk loads on first use).

## 5. The editor

`packages/shell-ui/src/components/notes/` — `NotesPage.tsx` (routes library vs editor), `NoteLibrary.tsx`, `NoteEditor.tsx`, `NoteTitle.tsx`, `SlashMenu.tsx`, `BubbleMenu.tsx`, `ShareMenu.tsx` (stage 2), `use-notes.ts` (its own zustand store like `use-brief.ts`: `summaries`, `bodies: Record<id, Note>`, `blobUrls: Record<id, string>`, `unsupported`, `error`, actions). Pure logic in `src/lib/notes-markdown.ts` (schema ↔ markdown), `notes-slash.ts` (command catalog + filtering over `lib/fuzzy.ts`), `notes-images.ts` (accept/downscale/hash), `notes-autosave.ts` (the state machine below) — all covered by `test/**/*.test.ts` without a DOM.

**Look.** `bg-background-200` page, `mx-auto w-full max-w-[760px] px-6` measure, a 52 px bar (back to library, breadcrumb of the title, `…` menu with Share / Copy as markdown / Delete). Title: an autosizing textarea at `text-[40px] leading-[1.15] font-semibold tracking-[-0.03em]`, placeholder "Untitled", Enter moves into the body. Body: `text-[16px] leading-7 text-gray-1000`; H1/H2/H3 at 30/24/20 on the `text-heading-*` tracking; `hr` = `border-b border-alpha-300`; inline code on `font-mono bg-alpha-100 rounded-sm px-1`; code blocks `bg-alpha-100 rounded-lg p-4 font-mono text-[13px]`; quotes `border-l-2 border-alpha-400 pl-4 text-gray-800`; task items with the home page's tick; images `rounded-lg max-w-full` with a selected ring. Editor root sets `user-select: text; cursor: text` (the shell turns selection off globally). Placeholder on the empty first paragraph: "Type / for commands". Floating UI (slash menu, bubble menu) wears `bg-background-100 shadow-menu rounded-xl` with rows on `PALETTE_ROW_CLASS`; positioned with `@floating-ui/react` inside the pane.

**Extensions.** `StarterKit` (history, headings 1–3, lists, code, blockquote, hr, bold/italic/strike/code, hard break), `Placeholder`, `Link` (`openOnClick: false`; a click with Mod opens through the store's `openLink`), `TaskList`/`TaskItem`, `Image` (custom: `src` is `note-blob:<id>`; the node view resolves it to an object URL from `use-notes` `blobUrls`, showing a `bg-alpha-100` box while it loads), `Table` if it comes free with the markdown serializer, a `Suggestion`-driven slash command (`/` at line start or after a space: Text, Heading 1–3, Bulleted list, Numbered list, To-do list, Quote, Code block, Divider, Image (opens a file picker)), a bubble menu on a text selection (bold, italic, strike, code, link, turn into ▾). Drag handle for block reordering if `@tiptap/extension-drag-handle` is open source in the installed major; otherwise Mod+Shift+↑/↓ moves the block and the handle is deferred. Markdown input rules come with StarterKit; paste of markdown text is parsed as markdown when it contains block syntax.

**Images.** Drop or paste (`carriesFiles` / `clipboardData.files`, the `AgentConsole` pattern): `notes-images.ts` refuses non-images and files over 20 MB before decoding, downscales per N4 on a canvas, hashes with `crypto.subtle.digest`, and the store calls `notes({type:"putBlob"})`; the image node is inserted with `src: note-blob:<id>` and a local object URL is cached at once so nothing flickers. Multiple files insert in order.

**Autosave (`notes-autosave.ts`).** Pure state: `{local: {title, markdown} , saved: {revision, title, markdown}, dirty, inflight}`. Edits mark dirty and arm a 600 ms idle timer (also flushed on blur, on tab switch, on window hide, and before the page unmounts). A flush sends one `update` carrying only changed fields, then records the returned `revision`. A remote `onNotes` summary for this id with `revision > saved.revision`: if not dirty and nothing in flight, fetch and replace the editor content (selection kept by position when the doc still fits); if dirty, remember it and re-check after the next flush — by then our write has a later HLC and wins, which is N5, and the bar shows "Edited on another device" for 4 s so the loser is at least visible. Every host failure is swallowed into an `error` badge ("Not saved — retrying") with exponential retry; the page never blocks typing.

**Library (`NoteLibrary.tsx`).** "Notes" at `text-[34px]` with a `New note` pill, a search field (client-side over summaries, `Saved` group), then a list of rows — icon or a `FileText` glyph, title, snippet, relative time — sorted by `updatedAt`; an empty state with one line and the shortcut. Right-click / `…`: Open, Open in split, Copy link, Delete (confirm). Keyboard: ↑↓ Enter.

**Home teaser.** `components/home/HomeNotes.tsx`: the three most recent notes and "New note", mounted beside `HomeBrief` (hidden when the host refuses `notes`).

## 6. Agent tools

`packages/agent-runtime`:

- `NoteToolHost { list(); search(query, limit); get(id); create(input); update(id, patch); remove(id) }` (in `runner.ts` beside `BookmarkToolHost`); `AiAgentRunInput.notes?: { host: NoteToolHost }`.
- `noteTools(host, callbacks)` copies `bookmarkTools`: `note_list` (summaries), `note_search {query}`, `note_read {id}` (full markdown), `note_create {title, markdown}`, `note_update {id, title?, mode: "replace" | "append" | "prepend" | "replace_section", markdown, section?}` (`replace_section` replaces the body under the heading whose text matches `section`, up to the next heading of equal or higher level — implemented purely in `views/notes.ts` `applyNoteEdit`), `note_delete {id}` (prompt says: only when the person asks). Every write is sourced `{kind:"agent", runId}`; results use the `{ok, result} | {ok:false, error}` shape and never throw.
- `NOTE_RULES` in the prompt: notes are the person's own writing; quote them faithfully; when asked to "write this down" or "add to my note" prefer `note_update` on the existing note over a new one; never rewrite a whole note to change a line; never put credentials in a note.
- `TOOL_GROUPS.user_notes`; `packages/protocol` `NoteToolRequest` (`note.list` … `note.delete`) in `AgentToolRequest`; `packages/run-view` `ToolFamily` `"note"` with nouns/actions.
- Desktop `run-controller.ts`: `#noteInput(run)` over `NoteStore`, spread into `extras`; `toolFamily` `note.` → `"note"`; **`answerPathTools` adds "search, read and write the person's notes"** (or the router never answers note questions without a browser). `pageInView` / `#readPageInView` / `pageContextLine`: when the active tab is `pistachio://notes/<id>`, the page in view is the note — title, address `pistachio://notes/<id>`, text = markdown — through the same `PAGE_IN_VIEW_HEADER` block, so "summarise this" over an open note just works, and the prompt tells the model the note's id so it can `note_update` it.
- Cloud: `NoteDoc`/`NoteBlobDoc` in `workspace-tools.ts` (`KEPT_PREFIXES`, `storedDoc`, `#notes()`, `#putNote`…; **`note-blob:` writes excluded from `#notifyRecords`** like `browser-session:`), `WorkspaceToolStore.notes(runId): NoteToolHost`, `"user_notes"` in `CLOUD_TOOL_GROUPS`, passed into `runAiBrowserAgent`.
- Tests: `test/notes-view.test.ts` (sanitizers, search, `applyNoteEdit`), `agent-turns.test.ts` cases per tool on both `browse` and `answer`, `apps/desktop/test/note-store.test.ts`, `run-controller.test.ts` (host wiring, note as page in view), `services/cloud-browser/test/workspace-tools.test.ts` (note + blob round trip).

## 7. Cloud host and the web browser

`services/cloud-browser/src/sessions/shell-host.ts`: `HostTab.home: boolean` becomes `shellPage: ShellPage | null`; `#showsHome`/`#showHome`/`#createTab`/`#wakeOnce` generalise to any shell page (placeholder `data:` document from `shellPagePlaceholderHtml`, reported URL kept as given, title from the placeholder or `setTabTitle`). `notes(request)` and `onNotes` are answered by `WorkspaceToolStore.person()` (`WorkspacePersonHost` gains the note half); `exportHtml` renders with `@pistachio/notes` on the worker (the note is already open there); `shell-server.ts` `READ_ONLY_METHODS` gets `notes` for the read requests only (a viewer without the wheel may read, not write — the server inspects `request.type`).

Three things stage 2a settled that the sketch above left open:

- **`HostTab` also gains `shellTitle: {url, title} | null`**, the desktop's pair (`browser-controller.ts`). The placeholder's static `<title>` lands on every load and on every Back, so a name `setTabTitle` set has to be bound to the address it was set for or it is written back over — and going library → note → back must not leave the note's name on the library.
- **The placeholder carries its own address**, appended as `\n<!--pistachio://notes/<id>-->`. `shellPagePlaceholderHtml` is byte-identical for `pistachio://notes/` and for one note, and a cloud tab's address IS its document: two history entries cannot share one `data:` URL, so without this Back from a note landed on the note again. The host reads the address back out of the `data:` URL (`shellDocumentAddress`) rather than remembering a map, so a tab that goes Back to a note opened an hour ago still knows which note it is. `HostTab.url` therefore stays the `pistachio://` address throughout — the strip, the record and `#isRestorable` all read it directly — and only the blank moment between `openTab` and the placeholder's load needs `shellPage` to hold the address still.
- **`shell-server.ts` grows `READ_ONLY_PREDICATES`**, `Partial<Record<string, (args) => boolean>>` beside `READ_ONLY_METHODS`, and one `isReadOnlyCall(method, args)` the three wheel checks share. A member with no predicate falls back to the name set; `notes` is the only one with a verb in its arguments. `setTabTitle` is a plain write.

`sharing` answers `{hosting: null}` and `setVisibility` throws "Sharing from the web arrives later": publishing reads and writes `hosted_artifacts` with a DEVICE bearer, which control forbids a `cloud` device, so stage 2b gives this host a route of its own rather than the shell a second answer.

`apps/www/app/app/notes/page.tsx` + `[noteId]/page.tsx`: read-only library and viewer over `useSession().workspace.notes` (`web-account/src/records.ts` gains `notes`, `noteRecord()` hostile-shape check, `noteBlobRecord()`), rendered with `@pistachio/notes` into the same sandboxed iframe as artifacts, with the Publish / Copy link / Make private toolbar from `/app/artifacts/[artifactId]`. Nav entry in the `library` group. (A writable `/app/notes` needs the browser-side workspace publish path, which does not exist; the writable web surface is `apps/web`, per N10.)

## 8. Sharing (view)

Control: `hosted_artifacts` gains `kind text NOT NULL DEFAULT 'artifact' CHECK (kind IN ('artifact','note'))` as its own appended idempotent `ALTER` in `migrate.ts`, mirrored in `schema.ts`; the primary key stays `(user_id, artifact_id)` (a 12-hex id is minted once per account, so a note and an artifact never collide in practice; the routes filter by `kind` anyway, and an id already held by the other kind is refused `409 id_in_use` rather than overwritten). Routes `GET /v1/notes`, `GET /v1/notes/:noteId`, `PUT /v1/notes/:noteId/visibility`, `PUT /v1/notes/:noteId/revision`, `GET /v1/public/notes/:shareId` (+ `PUBLIC_NOTE_RE`, GET only, off the credential gate), and the `/internal/users/:userId/notes/:noteId[/revision]` pair. Each is the artifact route over the same helpers — `ownedHosted`, `hostedOfAnyKind`, `publishHostedRevision`, `publicHosted`, `listHosted`, `setHostedVisibility` all take `kind` — so a share id minted for a note never answers at `/v1/public/artifacts` and vice versa. The two kinds differ only in the name of the id they report: `hostedFields` is shared, `hostedArtifactView` adds `artifactId`, `hostedNoteView` adds `noteId`, and a note route answers `{note}` / `{notes}`. Same HTML cap, same sandboxed CSP response. Audit kinds `note.published` / `note.unpublished`. Anonymous accounts reach none of it (the `anonymousAllowed` allow-list). Tests: `test/notes-hosting.test.ts`.

Desktop: `control-client.ts` gains `ControlHostedNote`, `notePublishing`, `setNoteVisibility`, `putNoteRevision`; `index.ts` gains `noteHtml(id)` (store + `renderNoteHtml`), `refreshPublicNote` (read hosting status, upload a fresh document only while `public`) and `refreshPublicNotes` on enrolment, beside the artifact pair. The per-record hook is `notes.onRecordChange` filtered to `kind === "note"` and debounced `NOTE_PUBLISH_DEBOUNCE_MS = 2_000` per id — the editor saves every 600 ms of quiet, which the artifact hook never has to cope with. `NoteRequest` gains `{type:"sharing"; id}` and `{type:"setVisibility"; id; visibility}`; both answer `{type:"sharing"; hosting}`, and both answer `null` on a Mac with no account. `setVisibility` sends the current revision and, when publishing, the rendered HTML.

The editor's Share menu (`components/notes/ShareMenu.tsx`, the `…` menu's Share item) is a 320 px panel hanging off the bar: with no account, one line saying to sign in — read from the shell's own `account.state`, not from `hosting`, because a never-published note on an enrolled Mac has no hosting row either; while private, "Publish to web" and then a confirm step in the same panel naming what becomes public; while public, the address in a read-only field with Copy link, Open (a new tab) and Make private. `use-notes.ts` gains `hosting: Record<id, NoteHosting | null>`, `sharing(id)` and `setVisibility(id, visibility)`; every failure lands in `error` like the rest of the store.

www: `apps/www/app/notes/[shareId]/route.ts` copies the artifact proxy route and headers. `web-account/src/records.ts` gains `notes` and `noteBlobs` on `WorkspaceView` (the blobs with their bytes: the viewer inlines them as `data:` URIs) with `noteRecord()`/`noteBlobRecord()` hostile-shape checks beside `artifactRecord()`; `control.ts` gains `HostedNote`, `listHostedNotes`, `setNoteVisibility`, `putNoteRevision`; a new `notes.ts` holds `noteDocumentHtml`, `isolatedNoteDocument` (the artifact wrapper around `renderNoteHtml`), `publicNotePath`, `NOTE_UNTITLED` and `noteSnippet`. `/app/notes` is the read-only library and `/app/notes/[noteId]` the viewer — the same sandboxed frame as an artifact's, minus `allow-scripts` since a rendered note carries none — with the Publish / Copy link / Open / Make private toolbar and the same heal-on-view when `hosting.revision < note.revision`. Nav entry "Notes" in the `library` group.

## 9. Sharing (edit)

The first cross-account authorisation in control, and a deliberate departure from E2EE for the shared body: the note's text is held on the server in plaintext, for exactly as long as a share stands, and every surface that offers a share says so in one sentence. It is the trade `public_html` already makes, made for named people instead of a link.

There is **no invite step**. A share names an account that already exists, by exact email, and is live the moment it is made — so `note_shares` has no pending state and no token, and a stranger cannot be reached at all.

**Control schema** (`migrate.ts` appended idempotent statements, mirrored in `schema.ts`, columns held together by `test/schema-parity.test.ts`):

- `note_shares (id uuid PK default gen_random_uuid(), owner_user_id → users cascade, note_id text CHECK ^[a-f0-9]{12}$, recipient_user_id NOT NULL → users cascade, role CHECK IN ('viewer','editor'), created_at, revoked_at NULL)`, `UNIQUE (owner_user_id, note_id, recipient_user_id)` and `CHECK owner ≠ recipient`, plus an index on `recipient_user_id` for the "shared with me" listing. A grant is never deleted: revoking stamps `revoked_at`, and every read filters on it.
- `shared_notes (owner_user_id, note_id, title, markdown, revision, updated_at, updated_by_user_id NULL, PK (owner_user_id, note_id))`. Markdown is capped at `MAX_NOTE_MARKDOWN_BYTES` (262 144) and the title at `MAX_NOTE_TITLE` (200), both **restated** in `app.ts` rather than imported, as `MAX_ARTIFACT_HTML_BYTES` is: a cap that drifts upward on a device must not widen what the server accepts.

**`noteAccess(userId, ownerId, noteId) → 'owner' | 'editor' | 'viewer' | null`** is the one helper in `app.ts` allowed to read a row whose owner is not `c.get("userId")`, and it is commented as such. Everywhere else authorisation stays structural (`eq(table.userId, c.get("userId"))`). A revoked grant answers `null`, which every route turns into **404**: a recipient whose access ended learns only that there is nothing there.

**Owner routes** (device bearer; anonymous accounts reach none of them — the `anonymousAllowed` allow-list):

| Route | Answer |
| --- | --- |
| `GET /v1/note-shares` | `{shares: [{noteId, id, email, role, createdAt}]}` — every live grant this account has made, so a Mac holding five hundred notes learns which two to keep current in one request. Its own path, not `/notes/shares`, which would shadow a note id. |
| `GET /v1/notes/:noteId/shares` | `{shares: [{id, email, role, createdAt}]}` |
| `POST /v1/notes/:noteId/shares {email, role}` | Resolves `users.email` (lower-cased, non-anonymous). **200 either way**: `{share: null, shares}` when nothing matched — no existence oracle — and `{share, shares}` when it did, upserting on the unique key so sharing again is how a role changes and how a revoked grant comes back. Sharing with yourself is `400 cannot_share_with_self`. Audit `note.shared`. |
| `DELETE /v1/notes/:noteId/shares/:shareId` | Stamps `revoked_at`, answers `{shares}` (the ones still standing), 404 for an unowned or already-revoked share. Audit `note.share_revoked`. **When the last live share goes, the `shared_notes` row is deleted** — the plaintext must not outlive its reason to exist, which is the `public_html` rule again. |
| `PUT /v1/notes/:noteId/shared {title, markdown, revision}` | The owner pushes the body every share reads. `404 not_shared` when the note has no live grant, so a body is never stored without one; `{stale: true}` when `revision < held`; otherwise upserts (clearing `updated_by_user_id`) and answers `{stale: false, note}`. |
| `GET /v1/notes/:noteId/shared` | `{note: {title, markdown, revision, updatedAt, updatedByUserId} \| null}` — the owner reading back what an editor wrote. |

**Recipient routes:**

| Route | Answer |
| --- | --- |
| `GET /v1/shared-notes` | `{notes: [{ownerId, ownerEmail, noteId, title, role, revision, updatedAt}]}`, read by `recipient_user_id = me` so every row names the reader. `title`/`revision`/`updatedAt` are null until the owner's device has pushed the body once. |
| `GET /v1/shared-notes/:ownerId/:noteId` | `{role, note}` for a viewer or an editor, 404 otherwise. |
| `PUT /v1/shared-notes/:ownerId/:noteId {title, markdown, revision}` | Editors only (`403 forbidden` for a viewer, 404 for a revoked one). `409 stale_revision` unless `revision > held`; on success stores `updated_by_user_id`. |

Tests: `test/note-shares.test.ts` — sharing with an existing and a non-existing email, a role change, revoke → recipient 404 **and** the plaintext row gone, a viewer's write refused, an editor's write read back by the owner, a stale write refused, cross-account isolation, anonymous 403.

**Owner's device** (`index.ts`, `account/control-client.ts`). `noteSharing: Map<id, {shared, mirror}>` is what this Mac believes: whether anyone is named on a note, and what control last agreed its body was. It is seeded by one `GET /v1/note-shares` on enrolment and on every poll, and corrected whenever the Share menu asks.

- Every local write that passes the existing `NOTE_PUBLISH_DEBOUNCE_MS` (2 s, one timer per id) also calls `pushSharedNote` beside `refreshPublicNote`. A note nobody shares sends nothing. Nothing is sent when the mirror already agrees, so an untouched note is not re-uploaded every poll.
- A 30 s interval and `app.on("browser-window-focus")` call `pullSharedNote` for each shared note. A revision above this Mac's is applied as **the person's own write** (`update(id, {title, markdown}, {kind:"user", runId:null})`) — it is their note, edited by someone they named — so it seals, syncs to their other devices, and lands in an open editor like any other remote change. That write climbs past the shared revision, so it is pushed straight back and the two agree; the mirror is what stops the two chasing each other.
- `NoteRequest` gains `{type:"shares"; id}`, `{type:"share"; id; email; role}` and `{type:"unshare"; id; shareId}`; all three answer `{type:"shares"; shares: NoteShare[] | null; found: boolean}` — `null` on a Mac with no account, `found: false` only when an email matched no Pistachio account. `NoteShare {id, email, role, createdAt}` lives in `shell-contracts/notes.ts`.

**Share menu.** `ShareMenu.tsx` grows a "People" section under the link section: the list (email, a role select, a × to remove), an email field with a role and a Share button, a result line ("Shared with …" / "No Pistachio account with that email."), and the sentence that has to be there — *People you share with can read this note on the web; its text is stored on Pistachio's servers for them.* `use-notes.ts` gains `shares`, `loadShares(id)`, `share(id, email, role)` and `unshare(id, shareId)`, refusing through the same `refuse()` path as everything else.

**www.** `web-account/src/control.ts` gains `listSharedNotes`, `getSharedNote`, `putSharedNote` and `listNoteShares`; `notes.ts` gains `isolatedSharedNoteDocument` (the same sandboxed wrapper, with `blob: () => null` — a share carries text, not the owner's sealed pictures, so each one draws the renderer's "unavailable" placeholder). `/app/shared` is "Shared with me" (owner email, title, role, updated); `/app/shared/[ownerId]/[noteId]` renders read-only for a viewer and, for an editor, a markdown field beside a live rendering of it, autosaving 1 s after the typing stops with `revision + 1` and showing "Saved" or "Someone else saved a newer version — reload." on 409. Nav entry "Shared with me" in the `library` group. The owner's `/app/notes/[noteId]` lists who a note is shared with, read-only, and says that adding and removing people is done from the Mac — the body a share reads is pushed from there.

That page is **not** the shell's TipTap editor. `NoteEditor.tsx` reaches for `shellApi()` and the shell store before its first paint, and `@pistachio/shell-ui` is not a dependency of `www`; giving the web the same writing surface means lifting the editor out of the shell package first. Markdown is the note's canonical format (N1), so a field over it loses the affordances and nothing else.

Deferred beyond this: invites to strangers, per-share key wrapping, sharing the pictures, realtime co-editing, comments, and sharing from the cloud host (the `notes` seam in `shell-host.ts` still refuses every sharing verb).

## 10. Stages and gates

| Stage | Work | Gate |
| --- | --- | --- |
| 0 | Contracts: records, views, `@pistachio/notes`, shell-contracts (`notes.ts`, `shell-pages`, `ipc`, `chrome`, `shortcuts`), protocol + run-view, cloud host stubs, deps installed | `pnpm check-types` green repo-wide; `record-docs`, `shell-api`, `shell-pages`, `socket` tests pass |
| 1a | Desktop store + sync + IPC + `setTabTitle` + menu | `note-store.test.ts`; two dev instances converge |
| 1b | Editor, library, store, commands, palette, sidebar, home teaser | pure-lib tests; manual: type, `/`, drop image, reload, all kept |
| 1c | Agent tools, desktop + cloud hosts, page-in-view | `agent-turns`, `run-controller`, `workspace-tools` tests; live: "add a line to my note X" |
| 2a | Cloud host `shellPage` + `notes`; www `/app/notes` | `apps/web` shows and edits a note |
| 2b | Public sharing end to end | control `notes-hosting.test.ts`; share link opens without an account; unpublish 404s |
| 3 | Edit sharing | `note_shares` tests; editor on www writes back; owner sees it |
| — | `apps/desktop/e2e/tests/notes.spec.ts` (new note by shortcut, type a heading + list, image drop via `setInputFiles`, reload persists, library lists it; `visibleTabViews(app)` is 0), `docs/console-routing.md` table, `docs/chrome-layouts.md` untouched (no manifest feature) | e2e green on a clean profile |

Everything is off until enrolment for sync and sharing, as always; a signed-out Mac still has its local notes (`PISTACHIO_E2E=1` never dials control).
