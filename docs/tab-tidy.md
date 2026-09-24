# Tab Tidy — auto-archive, tab groups, favorites reset

**Status:** implemented on branch `tab-tidy` (2026-09-19), desktop. QA: `docs/qa/2026-09-19/tab-tidy/README.md`. Not yet: the cloud host (groups and Tidy report "unsupported" there).

Tabs pile up. Arc answers that with a clock (idle tabs leave after 12 hours);
Dia answers it with structure (related tabs fold into a titled group). Tidy is
both, decided by a model: on a schedule — or when asked — Pistachio looks at
the day's tabs, **archives** the ones that are done, **groups** the ones that
belong together, and sends every **favorite** back to its home address.

One sentence for the person: *things you touched stay; things the browser
made, the browser cleans up; nothing is ever lost.*

## 1. Principles

1. **Nothing is destroyed.** Archiving closes a tab and keeps it — address,
   title, icon, back/forward stack, scroll/draft checkpoint — restorable for
   30 days. Closing a group archives it as one entry. Every run has one Undo.
2. **Never touch what is in use.** A tab that is visible, playing audio,
   owned by an agent run, pinned, a favorite, or in a split view is never
   archived. A tab the person grouped themselves is never archived.
3. **The person's hand outranks the model's.** Renaming, recolouring, or
   adding a tab to an auto-made group makes it theirs (`origin: "manual"`),
   and Tidy stops managing it. Tidy never renames, dissolves, or reorders a
   group it did not make, and never moves a tab *out* of any group.
4. **Quiet, legible, reversible.** A run says what it did in one notice
   ("Archived 6 tabs · made 2 groups — Undo"). If the window was not in front
   when it ran, the notice waits until it is.
5. **Degrades to Arc.** Signed out, offline, model timeout, or grouping
   turned off: idle tabs are still archived by the clock alone; no groups are
   made. The model can only choose *among allowed outcomes* (§4) — a pure
   policy validates everything it returns.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| **Loose tab** | A human day tab (no anchor) that is in no tab group. |
| **Tab group** | A titled, coloured run of day tabs drawn as one row that opens on hover. `origin` is `auto` (Tidy made it, Tidy may archive it) or `manual`. |
| **Archive** | Closed tabs and closed groups, per Space, newest first, kept 30 days (max 500 entries). A shell page over the content, like Watchtower — not a tab. |
| **Tidy run** | One pass over one Space: archive + group + reset favorites, applied atomically, undoable until the next run. |
| **Idle** | `now − lastActiveAt ≥ archiveAfterHours`. Viewing a tab resets it (`#activateTab` already stamps `lastActiveAt`). |

## 3. User flows

### 3.1 Automatic tidy (the core flow)

1. The tab lifecycle sweep (every 60 s, the one that already suspends idle
   tabs) asks whether a run is **due** for each Space: auto-archive is on, and
   at least one of — a loose tab is idle; an `auto` group is wholly idle; a
   favorite's tab is idle and away from its home address — and no run
   happened in the last 30 minutes. Waking the Mac or unlocking the screen
   asks the same question at once (the morning case).
2. Main gathers the Space's loose tabs and groups, asks the model (§4),
   validates the answer, and applies it in one step: archive → group → reset
   favorites → one publish. Rows glide to their new places (the shelf FLIP).
3. One notice: **"Archived 6 tabs · made 2 groups"** with **Undo**. Held
   until the window is in front (main waits for the window's focus), then up
   as long as any notice with an action. The very first run says what the
   feature is: "Archived 6 tabs — idle tabs are archived after 12 hours".
   A run that only sent favorites home says nothing.
4. **Undo** reopens what the run archived — only what is STILL in the archive:
   a tab the person already restored from the archive page, or removed from
   it, is not Undo's to open again — dissolves the groups the run made,
   removes tabs it added to existing groups, puts the whole row back in the
   ORDER the run found it (grouping gathers tabs; dissolving a group does not
   scatter them again), and sends favorites back to where they had been. Also in the
   command palette as "Undo last tidy" until the next run.

### 3.2 Tidy now

**⌘⇧K** (`shortcuts.tidyTabs`, rebindable in Settings → Keyboard shortcuts
like any other, and relayed from a web page that has the keyboard), "Tidy
tabs" in the **sidebar menu** with the key beside it, View › Tidy Tabs in the
application menu, the command palette, the *Live tabs* header's context menu
and its hover button (sparkles), and Settings → Tabs. Same run, same rules, same
notice; the 30-minute spacing does not apply. The hover button spins while
the model is asked (≤ 12 s). With nothing to do: "Tabs are already tidy".

### 3.3 A group in the sidebar

- **At rest** one row: where a tab has its icon, the group's icons as a small
  PILE of round bubbles that overlap the way a stack of avatars does — one
  large, two on the diagonal, three in a loose triangle, four unevenly, and
  past four, three with a "+N" badge in the group's colour. Hand-placed and
  a little uneven on purpose (a grid reads as a grid); each bubble is ringed
  in the surface colour; an icon FILLS its bubble the way a face fills an
  avatar (clipped round — an icon drawn on transparency shows the bubble's
  surface behind it), and a page with no icon is a bubble of the group's
  colour. Then the title in the group's colour on a tint of it, and the tab
  count at the far end.
- **Hover** (after 140 ms of intent, so crossing the list does not make it
  ripple) the group opens in place and its tabs appear as ordinary rows,
  indented under a coloured rail. Leaving closes it after 240 ms. It also
  stays open while it holds a tab in view, a context menu, keyboard focus,
  or its name field. Only one group is open by hover at a time, and when one
  closes above the pointer the list scrolls by the same distance, so the row
  under the pointer stays under it and the list never ripples.
- **Click the header** to hold it open / let it close again (persisted,
  like a folder's disclosure). **Double-click** the title to rename — in
  place: the words stay where the title was, in the group's colour, unboxed,
  and the row (a shade deeper, softly ringed), the caret and the selection
  say it is being typed. A pinned folder is renamed the same way, in neutral.
- **Header controls on hover:** *Open as split view*, *Close group*.
- **Header context menu:** Rename · Colour ▸ · New tab in group · Open as
  split view · Ungroup tabs · Close group.
- **A group made by hand is named from its tabs.** "New group with this
  tab" and "Group selected tabs" send no title; the host asks the fast model
  (`nameTabGroup`, ≈1 s, 6 s deadline, under the *Group related tabs* switch —
  it sends the same thing Tidy does) and the row reads "Naming…" until the
  name arrives. The person's word wins: a rename while the model is thinking
  drops its answer. When nobody can be asked — signed out, switched off — or
  the asking comes to nothing, the group is "New group" and the name field
  opens, as it always did (`useNewGroupNaming`). `naming` is of the moment:
  never stored.
- **A tab's context menu** gains "Add to group ▸ (New group…, each group)"
  and, inside a group, "Remove from group". A multi-selection gains "Group
  selected tabs".
- **Drag** (the sidebar's one drag surface; geometry in
  `lib/sidebar-tree.ts`, pure and tested). A group's header is its row among
  the day's UNITS; while it is open each of its tabs is a slot INSIDE it.
  - A tab or a split dropped on the **middle of a header** joins the group at
    its end — a closed group included, which opens for as long as it is the
    target and shows the row where it will sit (the header rings in the
    group's colour). The header's top and bottom edges are the slots before
    and after the group, as with a folder.
  - Dropped **between two of an open group's tabs**, or just under its
    header, it joins at that place; the same gesture reorders a tab within
    its own group. Under the group's LAST tab the pointer's x decides, the
    way an outliner does it: indented stays in, flush left leaves.
  - A tab dragged from a group down among the day's rows **leaves** it.
  - A **group** drags as one unit and never lands inside another; pins and
    favorites dropped over a group land beside it.
  - Dropping is the person's hand, so it makes an `auto` group theirs.
  - After a drop the group stays open while the pointer is seen to be on it,
    and otherwise lets go after a moment — the drop settles only once main
    has published it, by when the pointer may be long gone.
  - In the strip, where a group's tabs are in the row, setting a tab down
    between two of them joins it and moving it away leaves.
- The top-strip layout draws a group as a coloured chip ahead of its tabs,
  with the same menu.

### 3.4 Open a group as a split view

Panes are the group's tabs in group order — all of them up to four
(`MAX_SPLIT_PANES`); for a larger group, the four most recently used. Any
split a member was already in is dissolved first. Two tabs → side by side,
three → grid with one spanning, four → 2×2. The group stays a group; the
split is an ordinary split (existing controls close it). Disabled for a
group of one.

### 3.5 Close a group

Closes every tab in it and files the group in the archive as one entry.
Notice: "Closed “Trip planning” · 5 tabs — Undo". Restoring it from the
archive brings back the group, its title, colour and tabs.

### 3.6 The archive

A shell-drawn page over the content (like Watchtower): entries for the active Space grouped
by day, a filter box, each row with favicon / title / address / "archived 3 h
ago · idle", **Restore** and **Remove**. A group entry shows its cluster and
title, expands to its tabs, and restores whole or one tab at a time. Header:
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

### 3.8 Keeping a tab

Pin it, or put it in a group of your own — the two things that already mean
"I want this". There is no third "don't archive" switch to learn.

### 3.9 Settings → Tabs

| Setting | Default |
| --- | --- |
| Archive idle tabs after — Never / 12 hours / 24 hours / 7 days / 30 days | 12 hours |
| Group related tabs (uses AI; sends tab titles and addresses without query strings) | on |
| Return favorites to their home page | on |
| Keep archived tabs for — 7 / 30 / 90 days | 30 days |
| *Tidy now* · *Open archive* | |

"Never" turns the automatic run off entirely; *Tidy now* still works.

## 4. The model's part

One `generateObject` call per run per Space through the control proxy
(`model-provider.ts`), model `PISTACHIO_TIDY_MODEL` (default
`anthropic/claude-haiku-4.5`, ≈2 s; `off` keeps Tidy to the clock), 12 s
deadline, no retries. The plan is made against the tabs as they are AFTER
the model answers, so a tab clicked meanwhile falls out of it. Jev cannot do this — it scores choices, it
does not write titles.

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
- **Main** (`apps/desktop/src/main`): `BrowserController` owns groups beside
  split groups (members kept contiguous in `#tabOrder`), applies plans and
  undo; `tab-archive-store.ts` (`<userData>/tab-archive.json`, atomic
  rewrite); `tab-tidy.ts` (due check, run, model call via
  `packages/agent-runtime/src/tab-tidy.ts`).
- **Shell UI** (`packages/shell-ui`): `TabGroupRow` in `TabList.tsx`, strip
  chip, menus, `components/archive/ArchivePage.tsx`, settings section
  `tabs`, palette actions, the run notice.
- **Cloud host:** groups and tidy are reported unsupported in v1;
  `tabGroups: []`.

## 6. Test plan

Pure: group sanitizer, contiguity normaliser, plan policy (every rule in §4),
archive retention. Main: due check with a fake clock, apply/undo round trip,
favorites reset skips. E2E with a scripted model (`PISTACHIO_TIDY_SCRIPT`)
and backdated `lastActiveAt` in a seeded session: run → groups + archive →
hover-expand → split → close group → restore → undo, screenshots reviewed.
