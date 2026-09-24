# Reports and the daily brief

A **report** is a page Pistachio puts together for one person from their own material: a calendar, a mailbox, to-dos, what they were reading. The first kind is the **daily brief** at `pistachio://brief/`.

Reports are not generated HTML. A report is a [json-render](https://json-render.dev) spec over a fixed catalog of components that ship with the app, so every report looks like Pistachio and nothing in one is drawn on the fly. Models choose; they do not write the page.

| Piece | Where |
| --- | --- |
| Catalog, contract, validator, brief pipeline (pure) | `packages/reports` |
| The morning schedule | `apps/desktop/src/main/brief-scheduler.ts`, `announceBrief` in `index.ts` |
| Gathering, storage, models | `apps/desktop/src/main/brief-service.ts`, `account/integration-service.ts` (`mailDigest`), `model-provider.ts` (`configuredBriefModel`) |
| React registry, report view, brief page, home teaser | `packages/shell-ui/src/components/reports/`, `components/home/HomeBrief.tsx`, `lib/reports.ts` |
| Shell-drawn page routing | `packages/shell-contracts/src/shell-pages.ts` |
| Shell method | `reports(request)` in `shell-contracts/ipc.ts`; the cloud host refuses it |

## Who decides what

Three parties, each held to what it is good at.

1. **The app fills the blocks.** `buildBriefDraft` (`brief/candidates.ts`) turns the day's materials into *candidates*: finished catalog elements whose props come straight from source material — an event's title and times, a message's sender, subject and Gmail's own snippet, a to-do's text. A block that can be drawn more than one way is offered once per presentation under a shared `resource` (the schedule as `Timeline` or `AgendaList`; mail as `MessageCards` or `SourceList`; reading as `LinkCards` or `SourceList`; the focus card once per contender; the masthead once per tone).
2. **Jev composes.** json-render's `experimental_composeSpec` asks an evaluation model two rounds of choice questions — which candidates belong, then each one's slot and position — and assembles the spec. `evaluatorFor` adapts the AI SDK's `experimental_evaluate` to it, so the calls go through control's `/v1/ai` proxy like every other model call and are metered there as `evaluation-model`. Jev reads candidate *descriptions* and a context of counts; it never sees props and cannot change them. It also triages mail first (`brief/triage.ts`: reply / update / skip per message, from sender, subject and opening words).
3. **A language model writes one sentence.** `writeHeadline` produces the masthead's single line reading the shape of the day. It lives in the spec's state (`/text/headline`), and the masthead's `summary` prop is bound to it. Everything else on the page is source material or fixed copy.

Measured live on 2026-09-20 against the fixture day: three Jev evaluations plus one Haiku call, 1.7–2.2 s end to end. `PISTACHIO_REPORTS_LIVE=1 pnpm --filter @pistachio/reports test` repeats it; what it guards is the *wording* of descriptions and guidance, which is all Jev reads.

### When a model is missing or wrong

A brief is never blocked on a model.

- No evaluation model (signed out, `PISTACHIO_INTENT_MODEL=off`, a spend cap, a timeout, an answer outside the offered set): `defaultSpec` lays the page out — the first candidate of each resource, which `buildBriefDraft` orders as the sensible default — and Gmail's category labels triage the mail. No language model: `templateHeadline` writes the line from counts.
- After a composition, `guardLayout` enforces rules about the page itself, changing placement and never content: one masthead, first, alone in the header; wide blocks (`WIDE_COMPONENTS`) never in the 260px aside; a block marked `essential` (it has content for today) that Jev left out entirely comes back in its default form. The page takes the masthead's tone.
- Reading order is stated in the compose request (`readingOrder`), because that is the one place the composer's ordering questions look. It follows the day: mail leads when the calendar is empty.

## The catalog

`packages/reports/src/catalog.ts` is the whole vocabulary: `ReportPage` (slots `header`, `main`, `aside`), `Masthead`, `FocusCard`, `Timeline`, `AgendaList`, `MessageCards`, `SourceList`, `LinkCards`, `Checklist`, `StatPanel`, `Notice`, `Prose`, and three actions — `open_url`, `ask_agent`, `open_settings`. Components are blocks that take their items as props, which is what lets a candidate be atomic.

`shell-ui/components/reports/registry.tsx` implements each name once, with the shell's tokens (so it follows theme and colour scheme) and container queries (a pane can be half a window). The page's proportions come from an events-calendar page: a tinted wash behind a transparent bar, a 3.5:1 cover with the mark's tile hanging off its lower edge, a 960px column with 16px gutters, a main column beside a 260px sticky aside, a dashed timeline of roomy cards. A list placed in the aside draws as a quiet panel; the same list in main is a section — the block adapts its frame, the composer decides where it goes.

The page steps down by the **pane's** width, never the window's, and every step is one of five:

| Pane | What changes |
| --- | --- |
| ≤ 1008px | The cover loses its corners and its 24px overhang and runs edge to edge. |
| ≤ 1000px | The gutter between main and the aside tightens from 40px to 24px. |
| ≤ 820px | One column, the aside's panels pairing up under main; the wash goes; title 36 → 32px, section headings 24 → 20px, tile 96 → 80px. |
| ≤ 650px | Title 28px, tile 72px, card titles 20 → 18px and card lines 16 → 14px. |
| ≤ 450px | Title 24px, tile 64px, cards pad 12px all round, sections and cards sit closer, the bar drops "Updated". |

Two rules keep that true. Tailwind's `@max-[N]` means *narrower than* N, so a step is written as its width plus one (`@max-[821px]`). And nothing inside the report may become a container: an unnamed container query answers to the nearest one, so a `@container` on main would silently re-base every step under it. Where a block needs to fit its own column rather than the pane (`LinkCards`), it uses an intrinsic grid instead.

The bar above the report (`BriefPage`) is page chrome, not catalog: full width, 52px, no fill. The report's wash runs up behind it by `--report-bleed-top`, which the page sets to the height of whatever it hangs above the report.

### The preview panel

Pressing an item on a report — a meeting, a message, a to-do, a page, the focus card — does not open a tab: it opens the item's **preview** over the right of the pane (`components/reports/preview.tsx`). The panel is chrome, like the bar, not a catalog component: a spec cannot place one, and everything in it is the pressed item's own props, restated — a cover (the date, the sender's initials, the site's icon), what it is and where it came from, its name, one or two facts, a **Next step** card holding where it stands now and everything that can be done about it (*Join meeting*, *Prep me* / *Draft a reply*, its tick), and any source text at length. The header has *Copy Link*, *Open in …* (the one place an item's URL still opens a tab) and arrows that step through every item on the page in reading order.

A block makes an item previewable with `usePreviewable(item)`: `card` goes on the item's frame so a press anywhere that is not already a control opens it, `open` on the control that is its name, for the keyboard. It is modal: focus moves to the panel and comes back to the opener, Tab goes round it, Escape and the scrim close it. Ticks in the panel are the same state binding as the page's, so they file the same way.

The container is the reference page's event panel to the pixel — 550px wide, 8px clear of the pane's top, right and bottom, 16px corners, a 48px header of 30px controls, a body padded 12/16/16 with sections 24px apart, the page behind greyed and drained of a third of its colour — and it steps with the pane like the page: 480px at ≤ 650, 420px at ≤ 500, and at ≤ 450 a sheet, full width, 32px from the top, 32px corners. Its motion is that page's too, read out of its bundle rather than judged by eye: beside the page it travels 500px and fades on one 300ms `cubic-bezier(0.4, 0, 0.2, 1)`, in and out, and the scrim fades on the same; as a sheet it comes up on a spring (stiffness 550, damping 45, from rest — baked into a `linear()` easing, `--ease-sheet-spring` in `theme.css`, since CSS has no spring) and leaves on the curve. `CLOSE_MS` in `preview.tsx` is the length of the exit and must move with it. It fills the *pane*: `BriefPage` hands it an element laid over the pane outside what scrolls (`ReportOverlayHost`); anywhere else mounts a report without one, it falls back to the viewport.

Adding a component: a zod props schema and description in the catalog, one React function in the registry, and a candidate that uses it. Adding a **new kind of report** is a new candidate builder and prompt over the same catalog.

### Validation

`catalog.validate` from json-render checks a tree's shape but not its props, so `validateReportSpec` (`validate.ts`) is the gate: known component, props that parse against its schema (after resolving `$state`), only declared slots and events, only catalog actions with valid params, no `repeat`/`visible`/`watch`, a tree with no cycles or orphans, bounded size. Main runs it before storing and after reading from disk; `ReportView` runs it again before anything reaches React. `open_url` additionally admits only `http(s)` URLs.

## The brief

Sections, after Dia's: a masthead named for the day ("The Monday Brief") with the one-line summary; **Push your work forward**, the single highest-leverage item with *Let's do it* / *Prep me*; **Your day**; **Waiting on you** and **New updates** from mail; **Top to-dos**; reminders; **Pick up where you left off**; recent agent conversations; numbers; notices for sources that are not connected.

- **Prompts are work orders.** *Prep me*, *Let's do it* and *Draft a reply* start a fresh agent conversation with a prompt that names real identifiers — the event and its link, the Gmail thread id — under a "Where to look:" list, so the agent reads the sources through its own tools. A run already in flight is never interrupted.
- **The schedule knows the time.** Past / live / next are computed on the page from each item's instants (`scheduleMoments`), not stored: a brief is made once and read all day.
- **Ticks** live in the spec's state under `/ticks/<source key>` and are the only state the page may write back (`reports({type:"state"})`). Keys are source ids, so ticks survive a refresh. The home page is the truth about to-dos in **both** directions: a `todo:` tick finishes the to-do there; one finished there is ticked here; one *reopened* there is unticked here, whatever the brief had on file. `ReportView` takes those decided ticks as a prop, lets them win at mount and whenever they change while mounted (`TickSync`), and files any disagreement with the stored brief (`tickChanges`), so a refresh — which keeps ticks — cannot bring a stale one back.

### Sources

| Source | Read by | Notes |
| --- | --- | --- |
| Google Calendar | `IntegrationService.calendarAgenda` | The reader's local day, from exact local midnight to the next (`dayWindow`/`startOfLocalDay`; 23 or 25 hours when the clocks change). Same read as the home schedule. The agenda arrives calendar by calendar, not in order: `sortEvents` orders the day before it is capped and before anything asks what is "next". |
| Gmail | `IntegrationService.mailDigest` | `in:inbox newer_than:2d`, metadata format: headers and snippet, never a body; one row per thread. Any access level suffices. Does not stamp `last_used_at`. |
| Reminders | `ReminderStore.snapshot()` | Upcoming today go on the schedule; unacknowledged ones get their own block. |
| To-dos, recents | the shell, in the `generate` request | They live in the shell's localStorage; main never had them. `reportLocalOf` fits them to the request's limits first (shown text clipped, an oversized URL or id left out) — the host validates the whole request, so one long page title would otherwise refuse the brief. |
| Watchtower | `watchtower.request({type:"search"})` | Articles and videos of the last two days, when the archive is on. Falls back to recents. |
| Threads | `ThreadStore` | The last two days, this Space only. |

Opening today's brief makes it; if the host is already making one for the Space (another window, the morning schedule), the page *joins* it by asking too — the host runs one generation per Space and hands every asker the same result (`briefLoadAction`) — rather than waiting for news that would never reach its store. `briefReady` also re-reads the day into the window's store.

Each source fails alone (`within`, 12 s): a brief without a calendar is still a brief, and the footer and notices say what was used.

### Privacy

- Making a brief sends event titles and times, and each inbox message's sender, subject and snippet, to the evaluation model and the headline model through control's proxy — the same path and the same material the agent uses with these connections. It is therefore **never made unasked by default**: opening the brief makes it, and the morning schedule below is off until the person turns it on.
- What the person read reaches a model only when Watchtower's **agent access** is on (`pagesShareable`). With it off the pages still appear in the brief, and the models are told only how many there are.
- Briefs are stored in plaintext under `<userData>/briefs/` (mode 0600), one per Space per local day, thirty days kept. Beside them sit `local.json` (the to-dos and recents a shell last sent, for a morning with no window) and `schedule.json` (the day the schedule last tried). None of it is synced.
- Message and event text is quoted to the models as evidence; both prompts say to treat it as content, never as instruction, and nothing a model returns can alter a block.

## The morning brief

Settings → General → *Prepare my daily brief each morning* (`general.morningBrief`, off by default), *Ready by* (`morningBriefTime`, local `HH:MM`, default `07:00`) and *Notify me when it is ready* (`morningBriefNotify`, default on).

`BriefScheduler` in main looks every 30 s, on `resume` and `unlock-screen`, and whenever settings change. The rule (`briefDue`) is not "it is exactly 7:00" but **the time has passed today, there is no brief for today, and today has not been tried** — so a Mac that was asleep or closed at the hour makes the brief as soon as it is back. One attempt a day, remembered in `schedule.json`, so a failure is not retried in a loop and a relaunch does not make a second brief. The Space is the one in front — read from the Space store when no window is open, since closing the last window on macOS leaves the app running without a browser controller.

- **Who makes it.** The home page's to-dos live in the shell, so a due brief is first asked of the shell: main sends `prepareBrief`, and the shell generates through the ordinary `reports({type:"generate"})` with fresh materials. If no generation has started within `BRIEF_SHELL_GRACE_MS` (20 s) — no window, a shell still loading — main calls `generateFromLastLocal`, using the materials a shell last sent; those to-dos may be a day old, which beats a brief with none, and the next refresh corrects it.
- **Saying so.** Every filed brief reaches the scheduler through `onGenerated`; only one it asked for is announced. In front of the person that is a note in the window (`briefReady` → "The Monday Brief is ready · Read"). Behind other apps it is a system notification titled the same, whose body is the brief's headline and whose click raises the window and opens the brief. With notifications off, or when the system refuses one (turned off for Pistachio in System Settings; always, for an unsigned development build — `UNErrorDomain error 1`), the note waits for the window to come forward instead. Under `PISTACHIO_E2E=1` no system notification is ever posted.
- The app has to be running. Nothing wakes the Mac or launches Pistachio for a brief; opened at 9:40, a 7:00 brief is made at 9:40.

## Testing

- `packages/reports/test` — the pipeline with scripted evaluators and a fake Jev through the real AI SDK; the guard; the validator; `brief.live.test.ts` for the real models.
- `apps/desktop/test/brief-service.test.ts`, `brief-scheduler.test.ts`, `integration-service.test.ts` — gathering, storage, ticks, the schedule's rule and its shell-first/main-fallback behaviour, the Gmail digest.
- `apps/desktop/e2e/tests/daily-brief.spec.ts` — the real app with a scripted day, including a launch past the scheduled hour that makes the brief and says so untouched (`PISTACHIO_BRIEF_SCRIPT`, honoured only under `PISTACHIO_E2E=1`; the models stay off unless `PISTACHIO_AGENT_LIVE=1`).

Env: `PISTACHIO_INTENT_MODEL` (Jev; `off` disables composing and triage), `PISTACHIO_BRIEF_MODEL` (headline; `off` keeps the template).

## Not done

- Launching Pistachio (or waking the Mac) for the brief: the schedule runs only while the app does. The system notification itself is unverified — it cannot be posted from the unsigned development build; the refusal path and the in-window note are.
- The web app and cloud sessions: the cloud host refuses `reports` and does not route `pistachio://brief/`.
- Other report kinds (meeting prep, a weekly review) and an "ask for a report" entry in the agent; the catalog and composer are ready for them.
- A hero image, "owed to you" / "gone quiet" sections, and feeding ticks back to the sources (archiving the handled mail).
- Sync of briefs across devices.
