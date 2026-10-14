import { Component, createRef, type ReactNode } from "react";
import { SIDEBAR_DEFAULT_W, SIDEBAR_MAX_W, SIDEBAR_MIN_W } from "@pistachio/shell-contracts/chrome";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { ChromeRegion } from "../../chrome/manifest-renderers";
import { useDockLit } from "../../lib/desk/chrome";
import { useAppStore } from "../../store";
import { ResizeHandle } from "../ResizeHandle";
import { HomeView } from "./HomeView";
import { HOME_VIEW, type ColumnView } from "./rail-model";
import { SpaceView } from "./SpaceView";

/**
 * The double sidebar's card (docs/double-sidebar.md §1): the chosen rail
 * item in detail. Its sheet — the outline with the tab and the shoulder,
 * the wash of a space's colour — is drawn by the column under it
 * (SpaceColumn), so this is only what sits on it: on the shoulder, right of
 * the traffic lights, back, forward and reload and at its trailing end the
 * desk's ⋯ and the sidebar's button (the toolbar's region); under them the
 * address (⌘L); then the chosen view, Home's or the space's, cross-faded
 * as the choice changes; and at its foot the footer's pills when they have
 * something to say. Its trailing edge is the sidebar's width, dragged.
 */
export function SpaceCard({
  view,
  group,
  page,
  width,
  reduced,
}: {
  view: ColumnView;
  /** The space shown (null for Home's). */
  group: TabGroupInfo | null;
  page: boolean;
  width: number;
  reduced: boolean;
}) {
  const setSidebarWidth = useAppStore((state) => state.setSidebarWidth);
  // A desk window carried over the card, to be put away into its row: a quiet cue on the card's list (lib/desk/chrome.ts).
  const dropping = useDockLit("card");
  return (
    <div data-testid="space-card" data-view={view === HOME_VIEW ? "home" : "space"} data-dropping={dropping ? "" : undefined} className="space-card" style={{ width }}>
      <div className="space-card-shoulder">
        <ChromeRegion region="toolbar" />
      </div>
      <div className="space-card-address">
        <ChromeRegion region="address" />
      </div>
      <ViewFade viewKey={view} reduced={reduced}>
        {view === HOME_VIEW || group === null ? <HomeView /> : <SpaceView group={group} page={page} />}
      </ViewFade>
      {/* (All buttons, so the row opts out of the window's drag region as one, as the single sidebar's footer does.) */}
      <div className="space-card-foot no-drag">
        <ChromeRegion region="footer" />
      </div>
      <ResizeHandle
        side="right"
        width={width}
        min={SIDEBAR_MIN_W}
        max={SIDEBAR_MAX_W}
        defaultWidth={SIDEBAR_DEFAULT_W}
        label="Resize sidebar"
        setWidth={setSidebarWidth}
        // (Its line on the card's edge, not 3px in: the column's gap to the desk lies past it, no window drag region.)
        straddle
      />
    </div>
  );
}

/** The view coming in fades up this long; the one going, out a little faster (the lab's 190 and 140ms). */
const VIEW_OUT_MS = 140;

/** What a picture of the view going must not carry: anything the shell, the desk or a spec finds a live row by. */
const LIVE_ATTRIBUTES = ["data-testid", "data-tab-id", "data-live-tab-id", "data-group-id", "data-flip-id", "data-row-kind", "data-rail-key", "id", "role", "tabindex", "aria-selected"];

/**
 * The card's views, cross-faded as the choice changes: the view coming in
 * fades up (CSS, `.space-card-view`), and the one going stays a moment as a
 * PICTURE of itself — its DOM copied just before React replaces it
 * (getSnapshotBeforeUpdate, the one place that DOM still stands), stripped of
 * every id a live row is found by, inert, its scroll kept — fading out over
 * it. Never the view itself kept mounted: two lists would hold the shelf
 * drag's refs, and the desk would find a tab's row in the one going.
 */
class ViewFade extends Component<{ viewKey: string; reduced: boolean; children: ReactNode }> {
  private readonly box = createRef<HTMLDivElement>();

  override getSnapshotBeforeUpdate(previous: Readonly<{ viewKey: string }>): HTMLElement | null {
    if (previous.viewKey === this.props.viewKey || this.props.reduced) return null;
    const going = this.box.current?.querySelector<HTMLElement>(":scope > .space-card-view:not([data-going])") ?? null;
    return going === null ? null : pictureOf(going);
  }

  override componentDidUpdate(_props: unknown, _state: unknown, picture: HTMLElement | null): void {
    const box = this.box.current;
    if (picture === null || box === null) return;
    box.appendChild(picture);
    restoreScroll(picture);
    const fade = picture.animate([{ opacity: 1 }, { opacity: 0 }], { duration: VIEW_OUT_MS, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)", fill: "forwards" });
    const gone = (): void => picture.remove();
    fade.finished.then(gone, gone);
  }

  override render(): ReactNode {
    // Out of the window's drag region, both views whole (SpaceColumn marks the column a drag region, as the single
    // sidebar's is): on macOS a click there would move the window, and a double-click on a space's name zoom it. The
    // card's ground above them — the shoulder round its buttons, the address's margin — still moves the window.
    return (
      <div ref={this.box} className="space-card-views no-drag">
        <div key={this.props.viewKey} className="space-card-view">
          {this.props.children}
        </div>
      </div>
    );
  }
}

/** A still copy of the view going: no ids, inert, its scrollers' offsets noted for once it is in place (restoreScroll). */
function pictureOf(view: HTMLElement): HTMLElement {
  const picture = view.cloneNode(true) as HTMLElement;
  picture.dataset["going"] = "";
  picture.setAttribute("aria-hidden", "true");
  picture.inert = true;
  const originals = [view, ...view.querySelectorAll<HTMLElement>("*")];
  const copies = [picture, ...picture.querySelectorAll<HTMLElement>("*")];
  copies.forEach((copy, index) => {
    const original = originals[index];
    if (original !== undefined && (original.scrollTop !== 0 || original.scrollLeft !== 0)) {
      copy.dataset["scrollTop"] = String(original.scrollTop);
      copy.dataset["scrollLeft"] = String(original.scrollLeft);
    }
    for (const name of LIVE_ATTRIBUTES) copy.removeAttribute(name);
  });
  return picture;
}

function restoreScroll(picture: HTMLElement): void {
  for (const el of [picture, ...picture.querySelectorAll<HTMLElement>("[data-scroll-top]")]) {
    const top = el.dataset["scrollTop"];
    const left = el.dataset["scrollLeft"];
    if (top !== undefined) el.scrollTop = Number(top);
    if (left !== undefined) el.scrollLeft = Number(left);
  }
}
