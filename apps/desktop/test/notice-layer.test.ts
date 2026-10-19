/**
 * What of the window the notice stack covers (main/notice-layer.ts): a live
 * share's outlines go under it (docs/live-share.md §6.3). From the moment a
 * card arrives — before the view even hears of it — the whole view, until
 * the view says where it draws its cards; then those, placed by the view's
 * box; a word measured in a view of another size than the one placed is not
 * taken (the view was resized since, and says it again); nothing once the
 * cards are gone or the view is down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import type { NoticeItem } from "@pistachio/shell-contracts/notice";
import type { ChromeOverlayView } from "../src/main/chrome-view";
import { NoticeLayer } from "../src/main/notice-layer";

const ANCHOR = { x: 240, y: 0, width: 1040, height: 820 };
/** Where a one-line stack's view stands at the foot of ANCHOR: 404 wide, centred; 96 tall. */
const SLOT = { x: 558, y: 724, width: 404, height: 96 };
const item = (id: number): NoticeItem => ({ id, message: `notice ${String(id)}`, tone: "neutral", actionLabel: null, bumps: 0 });

function setup() {
  const log: string[] = [];
  const covers: Array<ContentBounds | null> = [];
  let shown = false;
  let slot: ContentBounds | null = null;
  const view = {
    get shown() {
      return shown;
    },
    webContents: { isDestroyed: () => false, isFocused: () => false, send: () => log.push("view hears") },
    setSlot: (next: ContentBounds | null) => (slot = next),
    setShown: (next: boolean) => (shown = next),
    raise: () => undefined,
  };
  const window = { isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 820 }) };
  const layer = new NoticeLayer(view as unknown as ChromeOverlayView, window as unknown as BrowserWindow, () => undefined, (cover) => {
    log.push("cover");
    covers.push(cover);
  });
  const say = (items: NoticeItem[]): void => layer.setFrame({ items, position: "bottom", anchor: ANCHOR });
  const drawn = (box: ContentBounds | null, size = { width: SLOT.width, height: SLOT.height }): void => layer.footprint(box === null ? null : { box, view: size });
  return { layer, log, covers, say, drawn, slot: () => slot };
}

describe("what of the window the notice stack covers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is the whole view from the moment a card arrives, before the view hears of it, until the view says where its cards are", () => {
    const { layer, log, covers, say, drawn, slot } = setup();
    say([item(1)]);
    expect(slot()).toEqual(SLOT);
    expect(log).toEqual(["cover", "view hears"]);
    expect(covers.at(-1)).toEqual(SLOT);
    drawn({ x: 69.5, y: 22, width: 265, height: 50 });
    expect(covers.at(-1)).toEqual({ x: 627.5, y: 746, width: 265, height: 50 });
    // A card said again (a bump) is no arrival; a new one is.
    say([{ ...item(1), bumps: 1 }]);
    expect(layer.cover()).toEqual({ x: 627.5, y: 746, width: 265, height: 50 });
    say([{ ...item(1), bumps: 1 }, item(2)]);
    expect(layer.cover()).toEqual(SLOT);
  });

  it("takes no word measured in a view of another size: the view resized lays its cards out afresh, and says so again", () => {
    const { layer, say, drawn, slot } = setup();
    say([item(1), item(2)]);
    drawn({ x: 69, y: 22, width: 265, height: 50 });
    // The stack's spread needs more room: the view grows up from its foot.
    layer.resize(110);
    const grown = slot()!;
    expect(grown.height).toBeGreaterThan(SLOT.height);
    expect(layer.cover()).toEqual(grown);
    drawn({ x: 69, y: 22, width: 265, height: 74 });
    expect(layer.cover()).toEqual(grown);
    drawn({ x: 69, y: grown.height - 74 - 24, width: 265, height: 74 }, { width: grown.width, height: grown.height });
    expect(layer.cover()).toEqual({ x: grown.x + 69, y: grown.y + grown.height - 98, width: 265, height: 74 });
  });

  it("is nothing once the cards are gone, nor once the view is down", () => {
    const { layer, covers, say, drawn } = setup();
    say([item(1)]);
    drawn({ x: 69, y: 22, width: 265, height: 50 });
    say([]);
    // (The card's exit plays in the view, which still says where it is.)
    expect(layer.cover()).not.toBeNull();
    drawn(null);
    expect(covers.at(-1)).toBeNull();
    say([item(2)]);
    expect(layer.cover()).toEqual(SLOT);
    say([]);
    vi.advanceTimersByTime(1_000);
    expect(covers.at(-1)).toBeNull();
    expect(layer.cover()).toBeNull();
  });
});
