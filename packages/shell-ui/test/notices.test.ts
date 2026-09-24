import { describe, expect, it } from "vitest";
import { NOTICE_GAP, NOTICE_LIMIT, NOTICE_PEEK, type NoticeItem } from "@pistachio/shell-contracts/notice";
import {
  cardPose,
  liveHeights,
  NOTICE_DISTANCE,
  noticeItem,
  promoteCards,
  pruneCard,
  pushNotice,
  reconcileCards,
  type ShellNotice,
  type StackCard,
} from "../src/lib/notices";

const item = (id: number, message = `notice ${String(id)}`): NoticeItem => ({ id, message, tone: "neutral", actionLabel: null, bumps: 0 });

/** Bring a list of items fully on screen: reconciled, then promoted. */
function settled(items: NoticeItem[], from: StackCard[] = []): StackCard[] {
  return promoteCards(reconcileCards(from, items));
}

describe("pushNotice", () => {
  it("adds to the front, oldest first", () => {
    const notices = pushNotice(pushNotice([], 1, "URL copied", { tone: "success" }), 2, "Tab unpinned");
    expect(notices.map((notice) => notice.message)).toEqual(["URL copied", "Tab unpinned"]);
    expect(notices[0]).toMatchObject({ tone: "success", action: null, bumps: 0 });
    expect(notices[1]).toMatchObject({ tone: "neutral" });
  });

  it("nudges the newest card when the same words are said again, rather than stacking a copy", () => {
    const once = pushNotice([], 1, "URL copied", { tone: "success" });
    const twice = pushNotice(once, 2, "URL copied", { tone: "success" });
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ id: 1, bumps: 1 });
  });

  it("stacks the same words when something else was said in between, or when an action rides along", () => {
    const between = pushNotice(pushNotice(pushNotice([], 1, "URL copied"), 2, "Tab unpinned"), 3, "URL copied");
    expect(between.map((notice) => notice.id)).toEqual([1, 2, 3]);
    const action = { label: "Undo", run: () => undefined };
    expect(pushNotice(pushNotice([], 1, "Pinned", { action }), 2, "Pinned", { action })).toHaveLength(2);
  });

  it("drops the oldest past the limit", () => {
    let notices: ShellNotice[] = [];
    for (let id = 1; id <= NOTICE_LIMIT + 2; id += 1) notices = pushNotice(notices, id, `notice ${String(id)}`);
    expect(notices.map((notice) => notice.id)).toEqual([3, 4, 5]);
  });

  it("sends the action's label, never its code", () => {
    const [notice] = pushNotice([], 1, "Pinned", { action: { label: "Bookmark instead", run: () => undefined } });
    expect(noticeItem(notice!)).toEqual({ id: 1, message: "Pinned", tone: "neutral", actionLabel: "Bookmark instead", bumps: 0 });
  });
});

describe("reconcileCards", () => {
  it("brings a new notice in at the entrance, in front, and pushes the others back at once", () => {
    const cards = reconcileCards(settled([item(1)]), [item(1), item(2)]);
    expect(cards.map((card) => [card.item.id, card.phase, card.depth])).toEqual([
      [1, "live", 1],
      [2, "enter", 0],
    ]);
    expect(promoteCards(cards).every((card) => card.phase === "live")).toBe(true);
  });

  it("fades a dismissed card where it stood and brings the rest forward", () => {
    const cards = reconcileCards(settled([item(1), item(2), item(3)]), [item(1), item(2)]);
    expect(cards.map((card) => [card.item.id, card.phase, card.depth])).toEqual([
      [1, "live", 1],
      [2, "live", 0],
      [3, "out", 0],
    ]);
  });

  it("sends the oldest off the back when an arrival overflows a full stack", () => {
    const cards = reconcileCards(settled([item(1), item(2), item(3)]), [item(2), item(3), item(4)]);
    expect(cards.map((card) => [card.item.id, card.phase, card.depth])).toEqual([
      [1, "back", 3],
      [2, "live", 2],
      [3, "live", 1],
      [4, "enter", 0],
    ]);
  });

  it("keeps a leaving card until it is pruned, and leaves it out of the measure", () => {
    const cards = reconcileCards(settled([item(1), item(2)]), [item(2)]);
    const again = reconcileCards(cards, [item(2), item(3)]);
    expect(again.map((card) => [card.item.id, card.phase])).toEqual([
      [1, "out"],
      [2, "live"],
      [3, "enter"],
    ]);
    expect(liveHeights(again, new Map([[1, 44], [2, 50], [3, 60]]))).toEqual([60, 50]);
    expect(pruneCard(again, 1).map((card) => card.item.id)).toEqual([2, 3]);
    // Only a leaving card can be pruned: a late timer never takes a live one.
    expect(pruneCard(again, 2)).toHaveLength(3);
  });

  it("carries a nudge through to the card", () => {
    const cards = reconcileCards(settled([item(1)]), [{ ...item(1), bumps: 2 }]);
    expect(cards[0]).toMatchObject({ phase: "live", item: { bumps: 2 } });
  });
});

describe("cardPose", () => {
  const cards = settled([item(1), item(2), item(3)]);
  const heights = [44, 62, 44];
  const byId = (id: number): StackCard => cards.find((card) => card.item.id === id)!;

  it("holds an arriving card closed: 16px toward the edge, 0.97, blurred, unseen", () => {
    const [entering] = reconcileCards([], [item(1)]);
    expect(cardPose(entering!, false, [])).toMatchObject({ y: NOTICE_DISTANCE, scale: 0.97, opacity: 0, blur: 2 });
  });

  it("closes a card back to the very pose it opened from", () => {
    const [entering] = reconcileCards([], [item(1)]);
    const [leaving] = reconcileCards(settled([item(1)]), []);
    const { z: _opening, ...opened } = cardPose(entering!, false, []);
    const { z: _closing, ...closed } = cardPose(leaving!, false, [44]);
    expect(closed).toEqual(opened);
  });

  it("closes a card further back from where it stands, under the rest", () => {
    const leaving = reconcileCards(cards, [item(2), item(3)]).find((card) => card.item.id === 1)!;
    const rest = cardPose(byId(1), false, heights);
    expect(cardPose(leaving, false, heights)).toEqual({ y: rest.y + NOTICE_DISTANCE, scale: rest.scale * 0.97, opacity: 0, blur: 2, z: 0 });
  });

  it("collapses older cards behind the front one: a sliver higher, smaller, fainter, and under it", () => {
    const front = cardPose(byId(3), false, heights);
    const middle = cardPose(byId(2), false, heights);
    const last = cardPose(byId(1), false, heights);
    expect(front).toEqual({ y: 0, scale: 1, opacity: 1, blur: 0, z: 3 });
    expect(middle.y).toBe(-NOTICE_PEEK);
    expect(last.y).toBe(-2 * NOTICE_PEEK);
    expect(last.scale).toBeLessThan(middle.scale);
    expect(last.opacity).toBeLessThan(middle.opacity);
    expect(middle.z).toBeLessThan(front.z);
  });

  it("spreads them into a column by the heights of the cards in front, at full size", () => {
    expect(cardPose(byId(2), true, heights)).toMatchObject({ y: -(44 + NOTICE_GAP), scale: 1, opacity: 1, blur: 0 });
    expect(cardPose(byId(1), true, heights)).toMatchObject({ y: -(44 + NOTICE_GAP + 62 + NOTICE_GAP) });
  });

  it("turns the stack upside down at the top: a card drops in from above, and the older ones go down behind it", () => {
    const [entering] = reconcileCards([], [item(1)]);
    expect(cardPose(entering!, false, [], "top").y).toBe(-NOTICE_DISTANCE);
    expect(cardPose(byId(3), false, heights, "top").y).toBe(0);
    expect(cardPose(byId(2), false, heights, "top").y).toBe(NOTICE_PEEK);
    expect(cardPose(byId(1), true, heights, "top").y).toBe(44 + NOTICE_GAP + 62 + NOTICE_GAP);
    // Only the direction changes: the size, the fade and the order do not.
    const { y: _foot, ...atFoot } = cardPose(byId(2), false, heights);
    const { y: _top, ...atTop } = cardPose(byId(2), false, heights, "top");
    expect(atTop).toEqual(atFoot);
  });

  it("sinks the front card as it leaves, over the one coming forward", () => {
    const leaving = reconcileCards(cards, [item(1), item(2)]).find((card) => card.item.id === 3)!;
    const pose = cardPose(leaving, false, heights);
    expect(pose.opacity).toBe(0);
    expect(pose.y).toBeGreaterThan(0);
    expect(pose.z).toBeGreaterThan(cardPose(byId(2), false, heights).z);
  });

  it("fades a card pushed off the back further back still, under everything", () => {
    const pushed = reconcileCards(cards, [item(2), item(3), item(4)]).find((card) => card.item.id === 1)!;
    const pose = cardPose(pushed, false, heights);
    expect(pose).toMatchObject({ opacity: 0, z: 0, y: -3 * NOTICE_PEEK });
  });
});
