import { describe, expect, it } from "vitest";
import {
  isNoticeEvent,
  isNoticeFrame,
  NOTICE_FOOT,
  NOTICE_POSITIONS,
  noticeAlign,
  noticeEdge,
  type NoticePosition,
  NOTICE_GAP,
  NOTICE_PAD_TOP,
  NOTICE_PAD_X,
  NOTICE_VIEW_MAX_H,
  NOTICE_VIEW_MIN_H,
  NOTICE_WIDTH,
  noticeSpreadHeight,
  noticeSpreadLift,
  noticeViewHeight,
  noticeViewSlot,
} from "../src/notice.js";
import { CHROME_VIEW_HASHES, chromeViewFromHash } from "../src/chrome.js";

const item = { id: 1, message: "URL copied", tone: "success", actionLabel: null, bumps: 0 };

describe("notice wire shapes", () => {
  it("accepts a frame of notices with or without an anchor", () => {
    expect(isNoticeFrame({ items: [item], position: "bottom", anchor: null })).toBe(true);
    expect(isNoticeFrame({ items: [], position: "top-left", anchor: { x: 0, y: 40, width: 900, height: 600 } })).toBe(true);
  });

  it("refuses a frame that is malformed, over the limit, or carries anything but a label for the action", () => {
    const frame = { items: [item], position: "bottom", anchor: null };
    expect(isNoticeFrame({ ...frame, items: [item, item, item, item] })).toBe(false);
    expect(isNoticeFrame({ ...frame, items: [{ ...item, message: "" }] })).toBe(false);
    expect(isNoticeFrame({ ...frame, items: [{ ...item, tone: "loud" }] })).toBe(false);
    expect(isNoticeFrame({ ...frame, items: [{ ...item, actionLabel: 7 }] })).toBe(false);
    expect(isNoticeFrame({ ...frame, anchor: { x: 0, y: 0, width: Number.NaN, height: 1 } })).toBe(false);
    expect(isNoticeFrame({ ...frame, position: "middle" })).toBe(false);
    expect(isNoticeFrame({ items: [item], anchor: null })).toBe(false);
    expect(isNoticeFrame({ items: [item], position: "bottom" })).toBe(false);
  });

  it("accepts only the three things a stack can say back", () => {
    expect(isNoticeEvent({ type: "dismiss", id: 1 })).toBe(true);
    expect(isNoticeEvent({ type: "action", id: 1 })).toBe(true);
    expect(isNoticeEvent({ type: "hover", hovering: false })).toBe(true);
    expect(isNoticeEvent({ type: "dismiss" })).toBe(false);
    expect(isNoticeEvent({ type: "hover", hovering: "yes" })).toBe(false);
    expect(isNoticeEvent({ type: "run", id: 1 })).toBe(false);
  });

  it("names the view", () => {
    expect(chromeViewFromHash(CHROME_VIEW_HASHES.notice)).toBe("notice");
  });
});

describe("notice geometry", () => {
  it("measures the spread column: every card and the gaps between", () => {
    expect(noticeSpreadHeight([])).toBe(0);
    expect(noticeSpreadHeight([44])).toBe(44);
    expect(noticeSpreadHeight([44, 62, 44])).toBe(150 + 2 * NOTICE_GAP);
    expect(noticeSpreadLift([44, 62, 44], 0)).toBe(0);
    expect(noticeSpreadLift([44, 62, 44], 2)).toBe(44 + 62 + 2 * NOTICE_GAP);
  });

  it("sizes the view to the stack plus its margins, within bounds", () => {
    expect(noticeViewHeight(44)).toBe(44 + NOTICE_PAD_TOP + NOTICE_FOOT);
    expect(noticeViewHeight(0)).toBe(NOTICE_VIEW_MIN_H);
    expect(noticeViewHeight(10_000)).toBe(NOTICE_VIEW_MAX_H);
  });

  it("stands the view centred at the foot of the browser surface", () => {
    const anchor = { x: 260, y: 8, width: 1000, height: 700 };
    const slot = noticeViewSlot(anchor, 84)!;
    expect(slot.width).toBe(NOTICE_WIDTH + 2 * NOTICE_PAD_X);
    expect(slot.x + slot.width / 2).toBe(anchor.x + anchor.width / 2);
    expect(slot.y + slot.height).toBe(anchor.y + anchor.height);
  });

  it("stands it at any of the six places: either edge, either corner or the middle", () => {
    const anchor = { x: 260, y: 8, width: 1000, height: 700 };
    const width = NOTICE_WIDTH + 2 * NOTICE_PAD_X;
    const at = (position: NoticePosition) => {
      const slot = noticeViewSlot(anchor, 84, position)!;
      return [slot.x, slot.y];
    };
    const left = anchor.x;
    const middle = anchor.x + (anchor.width - width) / 2;
    const right = anchor.x + anchor.width - width;
    const top = anchor.y;
    const foot = anchor.y + anchor.height - 84;
    expect(NOTICE_POSITIONS.map(at)).toEqual([
      [left, top],
      [middle, top],
      [right, top],
      [left, foot],
      [middle, foot],
      [right, foot],
    ]);
    expect(NOTICE_POSITIONS.map(noticeEdge)).toEqual(["top", "top", "top", "bottom", "bottom", "bottom"]);
    expect(NOTICE_POSITIONS.map(noticeAlign)).toEqual(["left", "center", "right", "left", "center", "right"]);
  });

  it("narrows to a narrow surface and gives up when there is no room", () => {
    expect(noticeViewSlot({ x: 0, y: 0, width: 300, height: 600 }, 84)).toMatchObject({ x: 0, width: 300 });
    expect(noticeViewSlot({ x: 0, y: 0, width: 80, height: 600 }, 84)).toBeNull();
    expect(noticeViewSlot({ x: 0, y: 0, width: 900, height: 30 }, 84)).toBeNull();
  });
});
