# The desk

An experiment in a different browser. A tab group can open as a **desk**: its tabs are free windows, dragged, thrown, resized and stacked inside the page area, and the group's tabs sit down the side as an inventory of thumbnails. It asks what browsing feels like when a tab is a window you place rather than a button that fills the screen. It ships with switchable **variants**, because the point is to feel the options side by side.

Desktop only (it needs native page views to move). Branch `desk`.

## 1. What a person does

**Open it.** Hover a tab group's row in the sidebar and press the window button (or right-click the group → *Open as desk*; the top layout's group chip has the same menu item). The page in view lifts off into a window without a flicker, and the inventory slides in from the left. The group's last arrangement comes back if there is one.

**The inventory.** Every tab in the group, as a thumbnail. A ring and a dot mark tabs whose windows are out on the desk; the window in use has the stronger ring.
- *Click* a thumbnail: that tab comes out as a window (flying out of its thumbnail), or its window comes to the top. Either way it becomes the active tab.
- *Drag* a thumbnail out: it grows from thumbnail size into a window as it leaves the column, and lands wherever it is dropped (edge zones and throws apply).

**Windows.**
- *Move* by the frame (title bar, tab or handle, depending on the frame variant). A press raises the window; a click gives its page the keyboard.
- *Hold Shift and drag anywhere on a window*, including on its live page. The press never reaches the page. The key is a variant: Shift, Option, Command or off.
- *Stick*: an edge within 14px of the desk's edge, or of a neighbour's edge (beside it with the gap, or flush), snaps onto it and a guide line shows.
- *Edge zones*: push the pointer into the desk's left or right edge for that half, the top edge for the whole desk, and the corners for quarters. The zone lights in the group's colour; let go and the window fills it.
- *Throw*: release while moving and what happens depends on the Throw variant (below).
- *Resize* from any edge or corner. Edges stick the same way.
- *Double-click* the frame, or press its ⤢ button, to fill the desk and back.
- *Put away*: drop a window on the inventory, fling it hard at it, or press its − button. It shrinks onto its thumbnail. The tab stays open.

**Arrange** (buttons under the inventory): tile every window, cascade them, or bring every tab out tiled.

**Leave**: the × in the inventory's header. The window in use grows back into the whole surface and becomes the pane again; the rest fly home. Choosing a tab outside the group (sidebar, ⌘T) also leaves the desk, straight away. The group being closed, ungrouped or left in another Space ends it too.

## 2. Variants

Under **Feel** in the inventory. Click a row to cycle it; Shift-click goes back. Choices persist on this device.

| Axis | Choices | What changes |
| --- | --- | --- |
| Throw | **Glide** · Snap · Free | Glide: momentum that fades (τ 0.3 s); meeting an edge ends the coast in a rebound that settles flush against it. Snap: every release lands in a tile, read from where the throw would carry the pointer, on the desk in thirds (corners → quarters, sides → halves, top middle → full, middle → a centred window). Free: stays where it is dropped (magnets only). |
| Spring | **Snappy** · Bouncy · Smooth | The spring every settle rides: response 0.26 s / damping 0.86, 0.42 / 0.56, 0.48 / 1. |
| In hand | **Lifted** · Live | Lifted: a carried window shows its still. It lifts (scale 1.035, deeper shadow), tilts with the swing about the point it is held by, shrinks when held over the inventory, and may travel anywhere. Live: the page stays live and flat in hand, and stays on the desk. |
| Frame | **Title bar** · Tab · Bare | A title bar above the page; a folder tab on its shoulder; or just the page with a handle pill above it. |
| Grab key | **⇧ Shift** · ⌥ Option · ⌘ Command · Off | The key that grabs a window from anywhere on it. |

Reduced motion replaces every spring with a quick critically damped one and drops the tilt.

## 3. How it works

A desk window is two things drawn by two processes: its **frame** is the shell's DOM, and its **page** is the tab's native view, placed by main over the hole the frame leaves. A native view paints over everything the shell draws, so:

- **Covered windows are drawn by the shell.** A window with anything stacked above it shows its *still* where the page would be, so the stacking is the DOM's and always right. Only uncovered windows go live (`uncoveredWindows` in `lib/desk/geometry.ts`). An armed zone counts as a cover, so the pages under it give way.
- **Transformed windows are drawn too.** A native view cannot scale or rotate, so a lifted, flying or (in Lifted) settling window is its still.
- **A still must be fresh before it stands in.** Each window records when it began wanting one, and only a still requested after that (and painted) may replace the live page. Until then the page stays up. Stills are captured at the start of every gesture for all live windows, so they are ready in time.
- **Live pages stack in the windows' order.** `BrowserLayout.stacked`: main re-adds the shown views bottom to top when the order changes (a raise), so even during the moments above the pages overlap correctly.

The motion is imperative (`components/desk/desk-engine.ts`): rects, springs, the coast and the tilt run per frame outside React, write transforms straight to the elements, and report the live pages' boxes to main (`setLayout`, deduped). React re-renders only when a window is added, raised, becomes drawn or live, or starts or ends a flight. Gestures use the drag layer (`lib/pane-drag.ts`), as pane resizes do, so the pointer is never lost over a page.

**Grabbing a live page** (`@pistachio/shell-contracts/desk`). The shell tells main which views are desk windows and which key grabs (`setDesk`). Main follows the key from every view's key events (`noteDeskKey`), because the mouse events `before-mouse-event` delivers carry no modifiers. A press on a desk page with the key held is taken from the page, the shell hears `onDeskGrab`, and the rest of the press is relayed on the drag-sample channel. Points are anchored to the screen at the press, since the view moves under the pointer. While the key is held, every desk page shows an open hand (a user-origin `!important` cursor rule). A plain press on a desk page makes it the active tab.

**Entering and leaving are seamless on purpose.** The first window starts as a window whose *page* is exactly the pane's box, so main's view does not move. It shrinks into place only once its still is up. Leaving runs the same path backwards, and the surface goes back to panes only after that window is live at the pane's box again.

Main also keeps desk windows from being suspended as idle (`suspendTab` skips any tab in the layout).

State: which group has its desk up, the variants, and each group's arrangement (as fractions of the desk, bottom to top). These are the shell's, in `lib/desk/store.ts` and this device's localStorage (`pistachio.desk.v1`). Main never stores an arrangement.

## 4. Files

- `packages/shell-contracts/src/desk.ts`: the native side's contract; `ipc.ts`: `setDesk`, `captureTabStills`, `focusTab`, `onDeskGrab`, `BrowserLayout.stacked`; `chrome.ts`: resize cursors for the drag layer.
- `apps/desktop/src/main/browser-controller.ts`: desk section (grab hook, cursor, stills, focus, restack); `index.ts`: IPC and hooks.
- `packages/shell-ui/src/lib/desk/`: `geometry.ts`, `motion.ts` (pure, tested), `store.ts`, `open.ts`.
- `packages/shell-ui/src/components/desk/`: `desk-engine.ts`, `DeskSurface.tsx`, `DeskWindow.tsx`, `DeskRail.tsx`; styles under "The desk" in `shell.css`.
- Tests: `packages/shell-ui/test/desk-geometry.test.ts`, `packages/shell-contracts/test/desk.test.ts`, `apps/desktop/e2e/tests/desk.spec.ts` (screenshots in `e2e/screenshots/desk/`, composited with the live pages).

## 5. Not done / open questions

- The feel numbers (coast τ, restitution, magnet reach, lift, tilt, spring presets) are first guesses, tuned against screenshots rather than a hand on a trackpad.
- **Live** in hand: the frame (DOM) and the page (native) are separate compositors, so during a fast drag the title bar may run a frame ahead of the page. Not measured.
- A covered window's still is refreshed every 3 s; it is not a live page.
- A tab dragged from the sidebar onto the desk still offers the old split zones; the desk does not take sidebar drags yet.
- Split groups among the desk's tabs are ignored while the desk is up (they come back on leaving).
- With Shift as the grab key, a desk page loses Shift-click (extend selection, open in new window). Option or Command avoid that.
- Keyboard: no shortcuts for snapping or cycling windows yet.
