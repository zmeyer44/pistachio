# A space of tabs, or of windows

(The code calls a space a tab group, and a Profile a Space: `docs/spaces.md`.)

Since 2026-11-02 a space shows its tabs **as a browser does** to start with, the way Home does: one page at a time, the tab in use filling the desk. Going from tab to tab goes from one whole page to the next. Until then every space on the rail showed its tabs as **windows**, the desk's free windows side by side (`docs/desk.md`). A space still becomes one of windows, and works exactly as before, once the person asks for it or makes a second window. They can go back to tabs whenever they like.

Desktop only: it is the desk's. The web app and the cloud browser keep their panes, unchanged.

## 1. What a person sees

**Tabs** (every space's way until it is made one of windows). The space's page fills the desk, as a Home tab's does. Any of these make another tab the page, filling the desk while the one before goes home:
- a row chosen in the card, the tab switcher, the palette;
- ⌘T or the card's New tab (a tab of the space);
- a tab closed (the next in use);
- a Glance filled.

The page goes as the desk passing to another space sends its windows, by Settings › General's *Switching spaces* and *Arriving windows*: by default it blooms away where it stands and the next sharpens in at its place. So going between tabs here looks like going between Home tabs. Nothing else about the space changes: its Bar, its chat and its Stack stay. Its tile on the rail and its hover card show the page it is on, filling its desk.

**Windows.** The desk as `docs/desk.md` has it: windows out side by side, moved, resized, laid out (the space's layouts appear in its card once two are out), minimized, masked, put away into their rows.

**Tabs to windows**, in any of these ways:
- *Carried off the desk.* The page is taken by its frame (its drawer, at the top) and let go short of filling the desk, or resized, let go of with ⤢, or masked. It stays where it was let go, and the space's other tabs stay in their rows.
- *A second window.* A row dragged out of the card onto the desk beside the page, a Glance taken in as a tile, or the agent bringing windows out. Everything stays where it was put.
- *A document's window.* A file dropped on the desk, or a document opened from the Stack: a document is no tab, so its window makes the space one of windows wherever it comes out, even on an empty desk, as a file given to a Home tab does. That way the window is kept where it was put.
- *Asked for.* The card's **Tabs | Windows** control, under the space's name, or *Show as windows* in the space's menu (its ⋯, its tile's right click). The windows come back as the space last had them as windows — masked and minimized ones as they were, and an arrangement of the one window alone too: its arrangement is kept while it shows tabs, and nothing is saved over it. A space never laid out as windows brings out the tab in use and the tabs used most lately beside it, four windows at most, tiled with the page in the main place. A space of one tab lets its window go to the box it had before it filled the desk, or the middle. Asked from the menu of a space not in front (its tile's right click), the space comes up as windows when the desk next passes to it: as it last had them (a window minimized stays so, as any space chosen comes up as left), or, never laid out so, it comes in as tabs and then its tabs come out tiled.

**Windows to tabs** only when asked: the control's *Tabs*, or *Show as tabs* in the menu. The window in use fills the desk (grown back if minimized, its mask let go of) and every other window goes home into its row. The arrangement as it stood is kept for *Windows*.

**Home is unchanged.** Each Home tab is a space of its own, the whole desk already, so a Home tab is neither tabs nor windows. A Home tab becomes a space as before (`docs/double-sidebar.md` §1), and the space it becomes is one of **windows**, as Home's always grew:
- its row's + (*Open a window beside it*): two windows side by side;
- its window carried off the whole desk;
- a row or window let go on the desk beside it;
- a Glance taken in as a tile;
- something put in its Context.

Gone back to Home (a grown space closed down to one tab, a page's space down to its page), it is a Home tab again, and grown again it is one of windows again.

**Every other new space shows tabs:** New space, ⌘N, a row let go on New space or the rail's ground, *Group selected tabs*, Tidy's spaces, and a merge (the space taken into keeps its own way). So do the spaces people already had when this shipped: the flag is new, so every existing space opens as tabs, its old arrangement waiting for *Windows*. A space closed and restored comes back as it was, tabs or windows (`ArchivedGroupEntry.group.windows`).

## 2. How it works

- **Main** (`browser-controller.ts`): `TabGroupInfo.windows?: true` (absent means tabs; never on a loose space). It is persisted with the session (`sanitizeTabGroups`), mirrored in sync-protocol's `DurableTabGroup`, kept by `asPersons`, and dropped by `looseInPlace` (going back to Home). `TabGroupCommand` `setWindows {groupId, windows}` (`setWindows`, a no-op on a loose space) sets it, and `create` may make a space of windows from the start (its `windows`; nothing in the shell asks for that yet, but the e2e harness does). `ownSpace` always makes a space of windows. `addToTabGroup` sets it when a Home space (a loose one, or a page's alone) is given a second tab: that is always a second-window gesture, a row's +, a drop beside it, or a Glance tile. The pure rules are in `contracts/tab-groups.ts`: `isHomeGroup`, and `spaceShowsTabs` (not Home's, not `windows`).
- **The desk engine** (`desk-engine.ts`) has `#tabbed`, set by `start`, `switchGroup` and `regroup` (their `tabbed`), and by `setTabbed`.
  - *A tabs desk comes up* (`#laidOut` with `tabbed`) as its entry alone, filling the desk, whatever is saved for it.
  - *Choosing another tab* (`activeChanged` → `add` → `#swapTo`): the windows out go as a passing's do (`#departing` with the posed exit, or `#sendAway` into their own rows for *Into its icon*), and the chosen one comes in filling the desk (`#comingIn` and `#awaitEntrance` for *matched*, else `#flyingIn`). A window on its way out turns round (`#takeBack`); one minimized or masked is made whole and filling (`#fillWin`); a Glance's window is made where it landed. A window in hand is never swapped: pulling a row out selects its tab mid-gesture.
  - `#save` does nothing while tabbed, so the space's last arrangement as windows waits.
  - *Leaving tabs by gesture*: `#toWindows` flips the engine at once and tells the host (`DeskHost.windowed` → `setWindows`). It is called from `#brokeAway`, `applyMask`, a spawned row let go beside the page or short of the desk (`#gestureEnd`), `add` with a box beside another window (`addAt`), `openAt` and `add` of a document (anywhere), `receiveGlance("tile")`, and `#addQuiet` (the agent, ⌃Z).
  - *Leaving tabs by request*: `setTabbed(false, {spread})` lays out the saved arrangement (`#laidOut` with `reveal`: any window it holds that is not the freshly laid-out entry; a reused window is masked again with `#maskWindow`, or minimized), or tiles the most recent tabs (`#addQuiet`, then `#layOut("tile")`), or lets one window go. While the desk is still passing (`entering`) the spread waits (`#pendingSpread`, run in `#tick` as it opens). `setTabbed(true, {entry})` saves first, then `#gather`s.
  - `sketchSpace` and `savedGeometry` take `tabbed` too (the rail's hover card, a live share's report of a space not in front).
- **DeskSurface** derives `tabbed` from the current space (`spaceShowsTabs`) and hands it to the engine at start, at every passing (a tabs space comes up on its tab used last, not the saved top window: `byRecency`) and in place. A layout effect follows a change of the flag for the space in front. If the engine is already there (it made the change itself), nothing moves. Otherwise it calls `setTabbed`, with `spread` (the saved arrangement and the tabs by recency) for a change to windows, and with none for a space gone back to Home. `selectSpace` (`lib/desk/open.ts`) names no tab for a tabs space: main's choice, its tab used last. A space made one of windows from its tile's menu while another is in front is remembered (`askSpread`); the desk passing to it, if it has no arrangement of its own to come back to (a saved window of one of its tabs, or of a document still in its Context, as `#laidOut` counts them), brings it up as tabs and spreads it (`takeSpread`); with one, the passing restores it as left.
- **Live share**: what reads masks for *Guests can use* (`guestsCanBeLetUse`, in the Live card and a window's menu) reads no arrangement for a space of tabs (`sharedArrangement`): its saved one, masks and all, waits unused while its page is whole.
- **The card**: `SpaceModeControl` (`components/space-rail/SpaceModeControl.tsx`, under `SpaceHead` in `SpaceView`; hidden for an empty space) and `spaceModeEntries` (in `chrome/tab-group-menu.tsx`'s space menu and `pageSpaceMenu`). `SpaceColumn`'s stable key for the rail's spaces includes `windows`; without it the card never heard the change.
- **Tests**: `packages/shell-contracts/test/tab-groups.test.ts` ("a space of tabs, or of windows"), `packages/shell-ui/test/desk-engine.test.ts` ("a space of tabs"), `spaces-shell.test.ts` (`selectSpace`). The e2e is `apps/desktop/e2e/tests/space-tabs.spec.ts`, plus `windows: true` checks in `double-sidebar.spec.ts`'s Home growth and breakaway. The harness's `createGroup` makes a space of windows unless told `{ windows: false }`, because the desk's specs were written for windows. It does so in one step, with `create`'s `windows`: a space made as tabs and then set to windows would, if it took the tab in use, be spread out as the person's *Windows* spreads it, bringing out extra windows.

## 3. Open

- Tidy's archive of an idle space it made does not keep the flag (only Close space does): such a space restored comes back as tabs.
- Tile, Cascade and Arrange (⌘⌥T, ⌘⌥C, ⌘⌥L, the More card) do nothing in a space of tabs, which has one window out. They could make it one of windows and lay its tabs out.
- There is no ⌃Z for the switch either way, and no keyboard shortcut for it.
- Minimizing the page of a space of tabs parks it, as in Home: the desk is empty but for the shelf until a tab is chosen.
