# Tab Tidy — auto-archive, spaces, favorites reset

(Until 2026-10-09 the UI called a space a "tab group", and a Profile a "Space"; identifiers keep the old words.)

**Status:** implemented on branch `tab-tidy` (2026-09-19), desktop. QA: `docs/qa/2026-09-19/tab-tidy/README.md`. Not yet: the cloud host (spaces and Tidy report "unsupported" there).

Tabs pile up. Arc answers that with a clock (idle tabs leave after 12 hours);
Dia answers it with structure (related tabs fold into a titled group). Tidy is
both, decided by a model: on a schedule — or when asked — Pistachio looks at
the day's tabs, **archives** the ones that are done, **gathers** the ones that
belong together into spaces, and sends every **favorite** back to its home address.

One sentence for the person: *things you touched stay; things the browser
made, the browser cleans up; nothing is ever lost.*

## 1. Principles

1. **Nothing is destroyed.** Archiving closes a tab and keeps it — address,
   title, icon, back/forward stack, scroll/draft checkpoint — restorable for
   30 days. Closing a space archives it as one entry. Every run has one Undo.
2. **Never touch what is in use.** A tab that is visible, playing audio,
   owned by an agent run, pinned, a favorite, or in a split view is never
   archived. A tab in a space the person made is never archived, and nothing in
   the current space, or in a space that holds a Stack or a conversation, is
   touched (`tidyReach`, docs/spaces.md §1).
3. **The person's hand outranks the model's.** Renaming, recolouring, or
   adding a tab to an auto-made space makes it theirs (`origin: "manual"`),
   and Tidy stops managing it. Tidy never renames, dissolves, or reorders a
   space it did not make, and never moves a tab *out* of any space.
4. **Quiet, legible, reversible.** A run says what it did in one notice
   ("Archived 6 tabs · made 2 spaces — Undo"). If the window was not in front
   when it ran, the notice waits until it is.
5. **Degrades to Arc.** Signed out, offline, model timeout, or gathering
   into spaces turned off: idle tabs are still archived by the clock alone; no spaces are
   made. The model can only choose *among allowed outcomes* (§4) — a pure
   policy validates everything it returns.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| **Loose tab** | A human day tab (no anchor) in no named space: in its loose space (`TabGroupInfo.loose`, docs/spaces.md: a space of one, made for every listed tab, drawn as the tab alone), which Tidy never sees. Archived or put in a space by Tidy, the tab leaves it, and the emptied loose space is gone unless it holds a Stack or a conversation. |
| **Space** | A titled, coloured run of day tabs drawn as one row that opens on hover — a tab group until 2026-10-09; the identifier is still `TabGroupInfo` (docs/spaces.md). `origin` is `auto` (Tidy made it, Tidy may archive it) or `manual`. |
| **Archive** | Closed tabs and closed spaces, per Profile, newest first, kept 30 days (max 500 entries). A shell page over the content, like Watchtower — not a tab. |
| **Tidy run** | One pass over one Profile: archive + gather into spaces + reset favorites, applied atomically, undoable until the next run. |
| **Idle** | `now − lastActiveAt ≥ archiveAfterHours`. Viewing a tab resets it (`#activateTab` already stamps `lastActiveAt`). |

## 3. User flows

### 3.1 Automatic tidy (the core flow)

1. The tab lifecycle sweep (every 60 s, the one that already suspends idle
   tabs) asks whether a run is **due** for each Profile: auto-archive is on, and
   at least one of — a loose tab is idle; an `auto` space is wholly idle; a
   favorite's tab is idle and away from its home address — and no run
   happened in the last 30 minutes. Waking the Mac or unlocking the screen
   asks the same question at once (the morning case).
2. Main gathers the Profile's loose tabs and spaces, asks the model (§4),
   validates the answer, and applies it in one step: archive → gather → reset
   favorites → one publish. Rows glide to their new places (the shelf FLIP).
3. One notice: **"Archived 6 tabs · made 2 spaces"** with **Undo**. Held
   until the window is in front (main waits for the window's focus), then up
   as long as any notice with an action. The very first run says what the
   feature is: "Archived 6 tabs — idle tabs are archived after 12 hours".
   A run that only sent favorites home says nothing.
4. **Undo** reopens what the run archived — only what is STILL in the archive:
   a tab the person already restored from the archive page, or removed from
   it, is not Undo's to open again — dissolves the spaces the run made (not one
   the person has since given a Stack or a conversation),
   removes tabs it added to existing spaces, puts the whole row back in the
   ORDER the run found it (gathering moves tabs together; dissolving a space
   does not scatter them again), and sends favorites back to where they had been. Also in the
   command palette as "Undo last tidy" until the next run.

### 3.2 Tidy now

**⌘⇧K** (`shortcuts.tidyTabs`, rebindable in Settings → Keyboard shortcuts
like any other, and relayed from a web page that has the keyboard), "Tidy
tabs" in the **sidebar menu** with the key beside it, View › Tidy Tabs in the
application menu, the command palette, the *Live tabs* header's context menu
and its hover button (sparkles), and Settings → Tabs. Same run, same rules, same
notice; the 30-minute spacing does not apply. The hover button spins while
the model is asked (≤ 12 s). With nothing to do: "Tabs are already tidy".

### 3.3 A space in the sidebar

(A tab group in the sidebar until 2026-10-09. What a space is, and an empty one's row, are `docs/spaces.md`.)

- **At rest** one row: where a tab has its icon, the space's mark — its
  first four tabs' icons in a 2×2 of small rounded squares, each icon filling
  its square, left to right and down (a lone tab's fills the mark), in the
  style of the desk rail's favorites folder (docs/desk.md). A page with no
  icon is a square of the space's colour. Then the title in the space's
  colour on a tint of it, and the tab count at the far end. On the desk's
  rail, where the row is its mark alone, the mark is a tile of the space's
  colour with the count on its corner, as the favorites folder's is.
  (Until 2026-10-02 the mark was a pile of overlapping round bubbles, like a
  stack of avatars.)
- **Hover** (after 140 ms of intent, so crossing the list does not make it
  ripple) the space opens in place and its tabs appear as ordinary rows,
  indented under a coloured rail. Leaving closes it after 240 ms. It also
  stays open while it holds a tab in view, a context menu, keyboard focus,
  or its name field. Only one space is open by hover at a time, and when one
  closes above the pointer the list scrolls by the same distance, so the row
  under the pointer stays under it and the list never ripples.
- **Click the header** of another space to pass the desk to it (docs/spaces.md);
  the current space's header holds it open / lets it close again (persisted,
  like a folder's disclosure). **Double-click** the title to rename — in
  place: the words stay where the title was, in the space's colour, unboxed,
  and the row (a shade deeper, softly ringed), the caret and the selection
  say it is being typed. A pinned folder is renamed the same way, in neutral.
- **Header controls on hover:** *Close space* (and *Open as split view* where
  splits are, the web).
- **Header context menu:** Rename · Colour ▸ · New tab in space · Keep open ·
  Release the tabs · Close space (and *Open as split view* where splits are).
  Until 2026-10-09 it also had *Open as desk*, and *Ungroup tabs* for Release.
- **A space made by hand is named from its tabs.** "New space with this
  tab" and "New space with selected tabs" send no title; the host asks the fast model
  (`nameTabGroup`, ≈1 s, 6 s deadline, under the *Gather related tabs into spaces* switch —
  it sends the same thing Tidy does) and the row reads "Naming…" until the
  name arrives. The person's word wins: a rename while the model is thinking
  drops its answer. When nobody can be asked — signed out, switched off — or
  the asking comes to nothing, the space is "New space" and the name field
  opens, as it always did (`useNewGroupNaming`). `naming` is of the moment:
  never stored.
- **A tab's context menu** gains "New space with this tab", "Add to “…”"
  for each space and, inside a space, "Remove from “…”". A multi-selection
  gains "New space with selected tabs". The day's tabs end with *New space*
  beside New tab and New folder: an empty space, its name field open.
- **Drag** (the sidebar's one drag surface; geometry in
  `lib/sidebar-tree.ts`, pure and tested). A space's header is its row among
  the day's UNITS; while it is open each of its tabs is a slot INSIDE it.
  - A tab or a split dropped on the **middle of a header** joins the space at
    its end — a closed space included, which opens for as long as it is the
    target and shows the row where it will sit (the header rings in the
    space's colour). The header's top and bottom edges are the slots before
    and after the space, as with a folder.
  - Dropped **between two of an open space's tabs**, or just under its
    header, it joins at that place; the same gesture reorders a tab within
    its own space. Under the space's LAST tab the pointer's x decides, the
    way an outliner does it: indented stays in, flush left leaves.
  - A tab dragged from a space down among the day's rows **leaves** it.
  - A **space** drags as one unit and never lands inside another. A pin or
    favorite dropped in a space brings its page down into it, the entry
    staying, closed (docs/desk.md, "Bringing an entry's page down").
  - Dropping is the person's hand, so it makes an `auto` space theirs.
  - After a drop the space stays open while the pointer is seen to be on it,
    and otherwise lets go after a moment — the drop settles only once main
    has published it, by when the pointer may be long gone.
  - In the strip, where a space's tabs are in the row, setting a tab down
    between two of them joins it and moving it away leaves.
- The top-strip layout draws a space as a coloured chip ahead of its tabs,
  with the same menu.

### 3.4 Open a space as a split view

(The web's alone since 2026-10-09: the desktop has no split view, and the menu offers this only where `splitAvailable()`, docs/spaces.md §1.)

Panes are the space's tabs in space order — all of them up to four
(`MAX_SPLIT_PANES`); for a larger space, the four most recently used. Any
split a member was already in is dissolved first. Two tabs → side by side,
three → grid with one spanning, four → 2×2. The space stays a space; the
split is an ordinary split (existing controls close it). Disabled for a
space of one.

### 3.5 Close a space

Closes every tab in it and files the space in the archive as one entry,
with its id (`ArchivedGroupEntry.groupId`, since 2026-10-09). Notice: "Closed
“Trip planning” · 5 tabs — Undo" (an empty space's says no count). Restoring
it from the archive brings back the space, its title, colour and tabs, under
the same id when it is free, so its Stack and conversation come back with it;
an empty space with a Stack is filed and restored the same way.

### 3.6 The archive

A shell-drawn page over the content (like Watchtower): entries for the active Profile grouped
by day, a filter box, each row with favicon / title / address / "archived 3 h
ago · idle", **Restore** and **Remove**. A space's entry shows its cluster and
title, expands to its tabs, and restores whole or one tab at a time; an empty
space's says what its Stack holds ("Space · 2 files", or "Empty space"). Header:
"Clear archive…" (confirmed) and a line stating the rule in force with a link
to the setting. Reached from the sidebar menu, the *Live tabs* header's
menu, the command palette ("Archived tabs"), and Settings → Tabs.

### 3.7 Favorites return home

On every run, a favorite (or organization preset) whose live tab has wandered
from its address goes back to it — X on a tweet returns to the X home page.
Skipped when the tab is visible, playing audio, or owned by a run. The tab is
put to sleep and re-addressed rather than navigated — nothing loads until the
favorite is next opened — with the page it was on kept in its stack, so
**Back** still returns to it. Pins are left alone: they already have "Return to pinned
page", and a pin is often a deliberate deep link.

A favorite with a space of its own — tabs opened on its desk (docs/desk.md, "A
page's space") — goes home whole, and first: once every tab of it is out of
view, silent and settled (a quarter of an hour on Tidy's own clock; at once
when asked), the space goes to the archive as one entry under the favorite's
name if all of it has gone idle (the archive age), or else comes down into the
day's tabs, after them, as a space like any other, named from its tabs. Either
way the favorite is left closed, to open afresh at its address. Such a space
makes a Profile due on Tidy's clock, and the notice says "Brought down 1
favorite's space"; Undo makes it the favorite's again (an archived one
reopened, led by its page). A pin's space is never reset, nor the current
space, and one that holds a Stack or a conversation is brought down, never
archived. (`favoriteGroupsDue`,
`archivePageGroup`, `bringDownPageGroup`, `leadGroup`.)

### 3.8 Keeping a tab

Pin it, or put it in a space of your own — the two things that already mean
"I want this". There is no third "don't archive" switch to learn.

### 3.9 Settings → Tabs

| Setting | Default |
| --- | --- |
| Archive idle tabs after — Never / 12 hours / 24 hours / 7 days / 30 days | 12 hours |
| Gather related tabs into spaces (uses AI; sends tab titles and addresses without query strings) | on |
| Return favorites to their home page | on |
| Keep archived tabs for — 7 / 30 / 90 days | 30 days |
| *Tidy now* · *Open archive* | |

"Never" turns the automatic run off entirely; *Tidy now* still works.

## 4. The model's part

One `generateObject` call per run per Profile through the control proxy
(`model-provider.ts`), model `PISTACHIO_TIDY_MODEL` (default
`anthropic/claude-haiku-4.5`, ≈2 s; `off` keeps Tidy to the clock), 12 s
deadline, no retries. The plan is made against the tabs as they are AFTER
the model answers, so a tab clicked meanwhile falls out of it. Jev cannot do this — it scores choices, it
does not write titles.

The prompt, its schema and the namer's (`packages/agent-runtime/src/tab-tidy.ts`) still say "group" on purpose (2026-10-09): it is plain English for the operation, `groups`, `joins`, `groupId` and `existingGroups` are identifiers, and the prompt is tuned (re-run `tab-tidy.live.test.ts` if it changes). Below, a "group" is the model's; the person sees a space. The namer's placeholder check (`tidyGroupName`) rejects "New space" as it did "New group".

**Input:** loose tabs as `{ id: "t3", title, host, path, idleHours,
eligible }` (ids anonymised, query strings and fragments dropped, at most 80
tabs, most recent first) and existing groups as `{ id: "g1", title }`.

**Output:** `{ groups: [{ title, tabIds }], joins: [{ groupId, tabIds }],
archive: [tabId] }`.

**Policy (`tidy-plan.ts`, pure, tested)** turns that into a plan or drops it:

- unknown or duplicate ids are dropped; a tab gets one outcome;
- `archive` ⊆ eligible (idle) tabs — the model cannot archive a fresh tab;
- an eligible tab the model neither grouped nor archived **is archived**:
  for an idle tab the model's choice is *group or archive*, never "keep";
- a new group needs ≥ 2 tabs and a 1–40 character title; at most 8 new
  groups per run; titles are de-duplicated against existing groups;
- a group made only of idle tabs is not made — those tabs are archived
  TOGETHER, as one titled entry, restorable as a group (grouping must not be
  a way for stale tabs to live forever, and the model's title is worth
  keeping);
- `auto` groups wholly idle are archived as group entries, by the clock,
  without asking the model.

With no model: every eligible tab is archived, nothing is grouped.

## 5. Shape

- **Contracts** (`packages/shell-contracts/src`): `tab-groups.ts` (types,
  colours, sanitizer, `TabGroupCommand`), `tab-archive.ts` (entries, request
  union, retention), `tidy.ts` (candidates, model answer, plan policy,
  summary). `ShellSnapshot.tabGroups`; `DurableSpaceSession.tabGroups`.
- **Main** (`apps/desktop/src/main`): `BrowserController` owns spaces beside
  split groups (members kept contiguous in `#tabOrder`), applies plans and
  undo; `tab-archive-store.ts` (`<userData>/tab-archive.json`, atomic
  rewrite); `tab-tidy.ts` (due check, run, model call via
  `packages/agent-runtime/src/tab-tidy.ts`).
- **Shell UI** (`packages/shell-ui`): `TabGroupRow` in `TabList.tsx`, strip
  chip, menus, `components/archive/ArchivePage.tsx`, settings section
  `tabs`, palette actions, the run notice.
- **Cloud host:** spaces and tidy are reported unsupported in v1;
  `tabGroups: []`.

## 6. Test plan

Pure: space sanitizer, contiguity normaliser, plan policy (every rule in §4),
archive retention. Main: due check with a fake clock, apply/undo round trip,
favorites reset skips. E2E with a scripted model (`PISTACHIO_TIDY_SCRIPT`)
and backdated `lastActiveAt` in a seeded session: run → spaces + archive →
hover-expand → split → close space → restore → undo, screenshots reviewed.
