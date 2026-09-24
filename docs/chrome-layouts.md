# Chrome layouts

The desktop chrome — tabs, address, navigation, status, split, console, spaces, settings — can be arranged two ways. Settings → General → Layout chooses; the chrome re-arranges live, no restart.

- **Top tabs**: one 40px titlebar row. Tabs sit beside the traffic lights; the trailing cluster sits at the right end.
- **Sidebar**: a vertical column at the window's left edge. Toolbar row (back, forward, reload, pin toggle), address pill, the favorites grid, the tab column — the active space's header, the pinned section (folders and pins), the "New tab" row, then the day's tabs — and a footer holding the trailing cluster. The page sits beside it. See [the shelf](#the-shelf-favorites-pins-folders) below.

The sidebar has two presentations:

- **Pinned** (`pinned`): the column takes real layout width (`SIDEBAR_DEFAULT_W`, clamped to `SIDEBAR_MIN_W..SIDEBAR_MAX_W`, persisted per machine). The window's traffic lights stay visible.
- **Compact** (`compact`): the same column, auto-hidden. Hidden, the inert column is clipped offscreen, the macOS window controls are gone, and the original `SIDEBAR_EDGE_W` (10px) page inset remains. A separate `SIDEBAR_TRIGGER_W` (14px) interaction target overlaps the page without moving it. Pointer **movement** inside it expands the column's layout slot while translating the same mounted column into view; the page reflows beside it over those frames, exactly toward its pinned geometry, and reverses continuously if the pointer comes back during a close. Nothing floats over the page. `⌘S` toggles pinned ⇄ compact.

  This is shell-local layout state (`store.sidebarRevealed`, `layouts/SidebarLayout.tsx`), not a chrome view: the compact sidebar used to be a card in its own WebContentsView sliding over the page, and is not any more. The reveal/hide mechanics:
  - **Reveal on pointer movement in the edge strip**, never `pointerenter` (`components/SidebarEdge.tsx`). Chromium synthesizes an enter for whatever mounts under a cursor that has not moved — the strip at launch, or on a layout switch — so an enter-triggered reveal opened the sidebar by itself depending on where the cursor rested.
  - **One persistent motion surface.** `SidebarChrome` never unmounts during compact reveal/hide. The slot's width and the column's `translateX` share the same easing (`styles.css`): the former gives Electron's native tab view a sequence of real bounds, while the latter moves the chrome as one composited slab. Hiding makes the column `inert` immediately and `visibility: hidden` only after the 180 ms retreat, so a quick re-entry reverses the running transition rather than recreating the shelf.
  - **The OS pointer decides the leave, not the page.** The column is a window drag region, whose native handling makes the page see `mouseleave` while the pointer is still there — the mouse is left to be handled natively, so the window briefly believes the pointer left it; the traffic lights above the toolbar and the tab views above the page take the pointer with no event at all. So while the column is up the shell reports its box (`setSidebarWatch`) and main polls `screen.getCursorScreenPoint()` against it every 100 ms, sending `sidebarPointerLeft` once `pointerHoldsSidebar` (shared/chrome.ts, `test/sidebar-pointer.test.ts`) says the pointer has gone. The poll is `main/pointer-zone-watch.ts` (`test/pointer-zone-watch.test.ts`): the screen's cursor knows nothing about which window is under it, so the entry test — the one that reveals — runs only while the window is the active one, or a pointer crossing another app's window over ours would reveal the column through it; the hold test keeps running unfocused, so an open column still retreats. A leave the page sees only prompts an immediate `getCursorPoint()` check. Under Playwright main cannot read the pointer and answers null, so the page's leave stands.
  - **What holds the column** (`pointerHoldsSidebar`): on the column with 7 px slack, over the traffic lights, or past the window's edge on the column's side within the column's vertical span up to `SIDEBAR_POINTER_SLACK_X` (250 px, the outside-window offset) — sliding off the screen's edge is not leaving. A pane-resize drag on the column's handle or a row dragged out to split holds it for as long as it runs. The window deactivating is a leave regardless.
  - Main learns whether the column is up through `ShellState.sidebarRevealed`, only to show and hide the traffic lights with it. They appear at reveal start and hide after the 180 ms close transition; a reversal cancels the pending hide. A switch to pinned, top tabs, or compact-from-pinned resets the reveal, so compact always starts hidden.

Persisted in `<userData>/settings.json` as `layout: { mode: "top" | "sidebar", sidebar: "pinned" | "compact" }` (`src/shared/settings.ts`; defaults `sidebar` / `pinned`; each field sanitized with `oneOf` on its own, so one bad value never drags the other to its default). `test/settings.test.ts` pins that.

## Declare once, place everywhere

A feature must never ship to one layout only. The mechanism is a manifest, not discipline.

`renderer/src/chrome/manifest.ts` (pure TypeScript, no React) declares every chrome feature once, with a placement in BOTH layouts:

```ts
export type TopRegion = "leading" | "tabs" | "trailing";
export type SidebarRegion = "toolbar" | "address" | "favorites" | "tabs" | "footer";
export type Placement<R extends string> = { region: R; order: number } | { hidden: string /* the reason, ≥ 10 chars */ };
export interface ChromeFeaturePlacements { top: Placement<TopRegion>; sidebar: Placement<SidebarRegion>; }
export const CHROME_MANIFEST = { navigation: { top: …, sidebar: … }, … } satisfies Record<ChromeFeatureId, ChromeFeaturePlacements>;
export const CHROME_FEATURES: readonly ChromeFeature[]; // the rows, derived from CHROME_MANIFEST in declaration order
```

| id | top | sidebar |
|---|---|---|
| navigation | hidden: "Back, forward, and reload unfold from the active tab's favicon (TabNavCluster)" | toolbar 10 |
| sidebarPin | hidden: "There is no sidebar to pin in the top layout" | toolbar 90 |
| address | hidden: "The active tab is the omnibox: its title cross-fades to its address on hover (ActiveTabLabel)" | address 10 |
| siteInfo | hidden: "Sits at the active tab's leading edge, since the active tab is the omnibox (SiteInfoButton in TabStrip)" | hidden: "Sits in the pane toolbar over the page card, beside the bookmark button (SiteInfoButton in PaneToolbar)" |
| favorites | hidden: "The strip has no shelf; favorites, presets, and pins open from the address bar's browse mode (UrlBar)" | favorites 10 |
| tabs | tabs 10 | tabs 10 |
| policy | trailing 10 | footer 10 |
| split | trailing 20 | footer 20 |
| console | trailing 30 | footer 30 |
| spaces | trailing 40 | footer 40 |
| settings | trailing 50 | address 20 |

Orders are spaced by 10 so a feature can be slotted between two others without renumbering.

The `policy` feature is the compact status icon (`components/StatusControl.tsx`). Hover or keyboard focus raises a card containing deterministic-policy, human/task-session, hosted-control, and current-site enforcement state; clicking the icon or the card's Site controls row opens the full controls page. There is no full-window status footer, so both layouts give that height back to the page.

Three guarantees hold the rule:

1. **Type-level.** `CHROME_MANIFEST` is a `Record` keyed by the `ChromeFeatureId` union, and each row requires both `top` and `sidebar`. An id added to the union without a row, or a row with no placement in a layout, does not compile. A `hidden` placement must carry a reason string — it is greppable and it is reviewed; "we forgot" cannot be spelled.
2. **Renderer-level.** `renderer/src/chrome/manifest-renderers.tsx` exports `CHROME_RENDERERS: Record<ChromeFeatureId, React.FC<{ orientation }>>`. (Deliberately not `manifest.tsx`: an extensionless `import "./manifest"` resolves to `manifest.ts` first, so a `.tsx` sibling would be unreachable.) A `Record` keyed by the id union, so adding an id without a renderer is a type error. `ChromeRegion({ layout, region })` renders `featuresIn(layout, region)` in order, passing `orientation` (top → `horizontal`, sidebar → `vertical`). Layouts never list features; they only place regions. `TopLayout` is `[traffic-lights pad] leading · tabs · trailing`; `SidebarChrome` is `toolbar · address · favorites · tabs · footer` (the favorites and tabs regions share one drag surface, `ShelfDragProvider`, which the column hosts around both).
3. **Test-level.** `test/chrome-manifest.test.ts` (vitest, node) asserts: the rows are the manifest's ids, each exactly once; every placement is a region or a hidden-with-reason; `tabs` is placed (not hidden) in both layouts; every referenced region exists.

Every chrome BUTTON is likewise an action declared once in `renderer/src/chrome/actions.tsx` (`CHROME_ACTIONS: Record<ChromeActionId, ChromeAction>` — label, icon, hint, active, enabled, run). `ActionButton({ id, variant })` renders it in the top strip or sidebar. An action's `hint` ("⌘I") is also its keyboard shortcut: `ChromeShortcuts` maps the key to the action, and an action whose key should do something other than its button — ⌘\ toggles a split where the button cycles the orientations — says so with `shortcut`.

### Adding a feature

1. One row in `CHROME_MANIFEST` (`renderer/src/chrome/manifest.ts`) — a placement for `top` AND for `sidebar`, or a `hidden` reason for the one it genuinely does not belong in.
2. One renderer in `CHROME_RENDERERS` (`renderer/src/chrome/manifest-renderers.tsx`), taking `orientation` and answering to it.
3. If it is a button: one action in `CHROME_ACTIONS` (`renderer/src/chrome/actions.tsx`), rendered through `ActionButton`.

Never a layout-specific component. If a feature seems to need one, the renderer branches on `orientation`; the manifest row still names both layouts.

## The shelf: favorites, pins, folders

The sidebar keeps pages on a persistent shelf; the model is `src/shared/sidebar.ts`:

- **Favorites** — a page kept as an icon in the grid under the address row. The organization's **preset links** (Settings → Workspace links; `settings.json` → `workspace.presetLinks`, so a managed install seeds them) lead the grid with a building mark and cannot be moved or removed there; the person's own follow.
- **Pins** — a page kept as a row above the day's tabs, optionally inside a **folder** (one level deep). Pins and folders are one flat `entries` list in display order; a pin names its folder with `folderId`, and every move is a `Placement` (`{ folderId, index }` among that container's children — `placeEntry`).
- **Anchors** — a live tab binds to the entry it is the page of (`BrowserTabInfo.anchorId`: a pin's or favorite's id, or `preset:<url>`). Closing an anchored tab keeps the entry (the row dims; the tile loses its dot); opening the entry again binds a fresh tab to it. Unpinning frees the tab into the day's tabs.

The shelf lives in **main** (`<userData>/sidebar.json`, `main/sidebar-store.ts`) and rides on `ShellSnapshot.sidebar`, beside the tab state it anchors into and outside the lifecycle of any renderer. Renderers change it only through `SidebarCommand`s (`pistachio:sidebar-command`, validated by `isSidebarCommand`, applied by `main/sidebar-controller.ts` against the store and the live tabs together). An anchored tab's title and favicon are folded into its entry on every publish, so a closed pin still shows what it last was.

Every shelf operation has two routes: **drag** (`renderer/src/chrome/shelf-drag.tsx` over the pure geometry in `renderer/src/lib/sidebar-tree.ts`, `test/sidebar-tree.test.ts`) — a day tab above the "New tab" row becomes a pin, a pin into a folder joins it, a pin below the divider becomes a day tab, anything onto the grid becomes a favorite, a tile into the list becomes a pin, a row with one live page dragged right over the page splits — and the **context menu** on any row or tile (`components/ContextMenu.tsx`). `⌘D` pins or unpins the active tab (the `togglePin` action); the pin toggle also sits behind every tab's dots. In the top layout the strip lists live tabs only; presets, favorites, and pins open from the address bar's browse mode ("Pinned & favorites").

## Split groups

A split is a persistent tab unit, not a global second-pane slot. Main owns every pair in `ShellSnapshot.splitGroups` with its two tab ids and orientation; `activeTabId`, `secondaryTabId`, and `splitMode` describe only the unit currently on screen. Selecting a lone tab shows it full-size without changing any saved pair. Selecting either member of a pair restores those same two tabs and their saved orientation. Closing either member dissolves only that pair and promotes its survivor to a lone full-size tab; it never borrows another open tab to fill the empty pane.

Both tab renderers derive their rows from the complete group list, so inactive splits remain one fused tab in the top strip or sidebar. An explicit split drop may re-pair a tab, freeing either participant from its previous group; ordinary tab selection never does.

## The shell-host rule

All visible action chrome lives in the shell renderer. Every component that touches shell-local state (which modal is up, whether the console is open, the layout setting) goes through `useShell().run(command)` with a `ShellCommand` (`src/shared/chrome.ts`). `renderer/src/chrome/shell-host.tsx` derives the action state from the store and applies `runShellCommand` to that store directly. The shell also publishes the narrow `ShellState` main needs to coordinate traffic lights and veil native utility views.

Tab operations — select, close, navigate, back, forward, reload, reorder, split — are NOT commands. They are IPC to main and work from any renderer; components call the store for them.

Keyboard: the shell mounts `ChromeShortcuts` inside `ShellHostProvider`. When a native tab page, drag layer, or find layer has focus, main catches the configured binding and relays the same `ShellCommand` to the shell, so ⌘T, ⌘L, ⌘S, ⌘I, ⌘\, ⌘[ and the rest work wherever the last click landed. Main also sets an explicit application menu with no `close` or `reload` role, so a ⌘W or ⌘R that reaches no page handler cannot close the window or reload a renderer. A hidden utility view hands keyboard focus back to the shell.

## How the compact column works

The tab `WebContentsView`s sit above the shell window's own page, so a shell element cannot float over them. That rules out a simple absolute overlay: the compact sidebar instead takes real layout width while revealed, keeping its shell chrome beside the native page views and letting `BrowserSurface` report each intermediate pane bound to main.

`SidebarLayout` always mounts one motion slot and one `SidebarPane`. In compact-hidden state the slot is 10px wide with an 8px negative trailing margin, clips its fixed-width pane, and translates that pane left. The 14px trigger is an independent absolute target; main also watches that width with the OS pointer because its last 4px overlap the native tab view above the shell. Reveal removes the hidden attributes: width and `translateX` transition together to the stored sidebar width. Hide runs the same geometry backward, then switches the inert pane to `visibility: hidden`. Because the DOM subtree stays put, an interrupted close naturally reverses the running CSS transitions; sidebar state, scroll, focus history, and drag providers are not reconstructed.

Traffic lights: `applyWindowButtons()` in `main/index.ts` keeps the macOS window controls visible unless `layout.mode === "sidebar" && layout.sidebar === "compact"` and the sidebar is hidden. It re-runs on every settings and shell-state change (`BrowserWindow.setWindowButtonVisibility`, darwin only). On close, main waits `SIDEBAR_CLOSE_MS` for the retreat to land before hiding the controls; a reveal cancels the pending timer. The toolbar pads its leading edge by `TRAFFIC_LIGHTS_W` and centres its buttons on `TRAFFIC_LIGHTS_CENTER_Y`, the native controls' line.

With the sidebar and the controls hidden, nothing in the titlebar is draggable. The content card's 8px gutter is a `drag-region` in the sidebar layout (the panes and the split divider are `no-drag`), so the window can still be moved by its edge.

## How the pane toolbar works

In the sidebar layout the page card has no titlebar of its own, so the per-pane controls — close, pin/unpin, bookmark/unbookmark, and the tab's mark and title as a button into the address modal — live in a row the card slides down to reveal (`renderer/src/components/PaneToolbar.tsx`). Pointer movement in the gap between the card and the window's top edge brings it out; it is the sidebar toolbar's row (`PANE_TOOLBAR_H === TRAFFIC_LIGHTS_H`, `src/shared/chrome.ts`), so its buttons sit on the same line as back, forward, reload and the pin toggle, in the same 24px style (`chromeIconButtonClass` in `chrome/actions.tsx`). A split view gets one cluster per visible pane, laid over that pane's column; panes that share a column split it in pane order (`renderer/src/lib/pane-toolbar.ts`).

The slide reuses the compact column's mechanism turned vertical: `BrowserSurface`'s top padding transitions from the gutter to the row's height, its `ResizeObserver` reports each intermediate pane box to main, and the native views reflow under the row frame by frame; the row itself translates in over the same frames and stays mounted, so an interrupted hide reverses. Nothing paints over a native view at any point — the row occupies the space the card vacates.

Who decides the pointer is there is main, as for the compact sidebar: the gap is a drag region (whose native handling keeps pointer moves from the page) and the tab views take the pointer below the row, so the shell reports the trigger box and, once the row is up, the hold box (`setPaneToolbarTrigger` / `setPaneToolbarWatch`, both served by the same `PointerZoneWatch` in `main/index.ts` that the sidebar's watch is built on), and main says when the pointer has moved in or left. The shell's own leave events only prompt a check. The row does not come out under a shell page or modal, during a Glance, or while a pane-resize or tab drag is reshaping the panes, and it leaves if one of those begins.
