import { describe, expect, it } from "vitest";
import type { DragSample } from "@pistachio/shell-contracts/chrome";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import { DeskPipPress, type PipMouse } from "../src/main/desk-pip-press";

/** The pip view at its box, its events at window points (the screen's are the window's plus SCREEN), the samples recorded. */
function setup(options: { screen?: boolean } = {}) {
  const SCREEN = { x: 400, y: 200 };
  let bounds: ContentBounds | null = { x: 100, y: 500, width: 320, height: 180 };
  const sent: DragSample[] = [];
  const press = new DeskPipPress(() => bounds, (sample) => sent.push(sample));
  const event = (type: string, at: { x: number; y: number }, button = "left"): PipMouse => {
    const local = { x: at.x - (bounds?.x ?? 0), y: at.y - (bounds?.y ?? 0) };
    return options.screen === false ? { type, button, ...local } : { type, button, ...local, globalX: at.x + SCREEN.x, globalY: at.y + SCREEN.y };
  };
  return {
    press,
    sent,
    mouse: (type: string, at: { x: number; y: number }, button?: string) => press.mouse(event(type, at, button)),
    /** The player follows the pointer: the view moves under it (the shell's held box, applied by main). */
    moveView: (to: { x: number; y: number }) => {
      if (bounds !== null) bounds = { ...bounds, ...to };
    },
    hideView: () => {
      bounds = null;
    },
  };
}

describe("DeskPipPress", () => {
  it("relays a grabbed press's moves and release, at window points, as the view moves under it", () => {
    const { press, sent, mouse, moveView } = setup();
    mouse("mouseDown", { x: 260, y: 590 });
    expect(press.grabbed).toBe(false);
    expect(press.grab({ x: 260, y: 590 })).toBe(true);
    expect(press.grabbed).toBe(true);
    mouse("mouseMove", { x: 300, y: 560 });
    moveView({ x: 140, y: 470 });
    mouse("mouseMove", { x: 340, y: 530 });
    moveView({ x: 180, y: 440 });
    mouse("mouseUp", { x: 340, y: 530 });
    expect(press.grabbed).toBe(false);
    expect(sent).toEqual([
      { x: 300, y: 560, phase: "move" },
      { x: 340, y: 530, phase: "move" },
      { x: 340, y: 530, phase: "up" },
    ]);
    // Over: the view's later moves are its own.
    mouse("mouseMove", { x: 400, y: 400 });
    expect(sent).toHaveLength(3);
  });

  it("measures from the view's box when the events carry no screen point", () => {
    const { press, sent, mouse, moveView } = setup({ screen: false });
    mouse("mouseDown", { x: 260, y: 590 });
    press.grab({ x: 260, y: 590 });
    moveView({ x: 140, y: 470 });
    mouse("mouseMove", { x: 300, y: 560 });
    mouse("mouseUp", { x: 310, y: 550 });
    expect(sent).toEqual([
      { x: 300, y: 560, phase: "move" },
      { x: 310, y: 550, phase: "up" },
    ]);
  });

  it("keeps the moves of a press it was not told is a grab (a control's) to the view", () => {
    const { sent, mouse } = setup();
    mouse("mouseDown", { x: 260, y: 590 });
    mouse("mouseMove", { x: 300, y: 560 });
    mouse("mouseUp", { x: 300, y: 560 });
    mouse("mouseMove", { x: 320, y: 560 });
    expect(sent).toEqual([]);
  });

  it("refuses a grab whose release came first, so the shell never waits on it", () => {
    const { press, sent, mouse } = setup();
    mouse("mouseDown", { x: 260, y: 590 });
    mouse("mouseUp", { x: 260, y: 590 });
    expect(press.grab({ x: 260, y: 590 })).toBe(false);
    mouse("mouseMove", { x: 300, y: 560 });
    expect(sent).toEqual([]);
    // And with no press at all.
    expect(setup().press.grab({ x: 0, y: 0 })).toBe(false);
  });

  it("follows the left button only", () => {
    const { press, sent, mouse } = setup();
    mouse("mouseDown", { x: 260, y: 590 });
    press.grab({ x: 260, y: 590 });
    mouse("mouseDown", { x: 260, y: 590 }, "right");
    mouse("mouseUp", { x: 260, y: 590 }, "right");
    mouse("mouseMove", { x: 300, y: 560 });
    expect(sent).toEqual([{ x: 300, y: 560, phase: "move" }]);
  });

  it("stops relaying once the shell's move is over, however it ended", () => {
    const { press, sent, mouse } = setup();
    mouse("mouseDown", { x: 260, y: 590 });
    press.grab({ x: 260, y: 590 });
    press.end();
    mouse("mouseMove", { x: 300, y: 560 });
    mouse("mouseUp", { x: 300, y: 560 });
    expect(sent).toEqual([]);
  });

  it("cancels a grab when the press is lost, or a new one comes before its release was heard", () => {
    const { press, sent, mouse } = setup();
    mouse("mouseDown", { x: 260, y: 590 });
    press.grab({ x: 260, y: 590 });
    press.cancel();
    expect(sent).toEqual([{ x: 0, y: 0, phase: "cancel" }]);
    mouse("mouseMove", { x: 300, y: 560 });
    expect(sent).toHaveLength(1);
    // Nothing held: nothing to cancel.
    press.cancel();
    expect(sent).toHaveLength(1);

    mouse("mouseDown", { x: 260, y: 590 });
    press.grab({ x: 260, y: 590 });
    mouse("mouseDown", { x: 270, y: 600 });
    expect(sent).toEqual([
      { x: 0, y: 0, phase: "cancel" },
      { x: 0, y: 0, phase: "cancel" },
    ]);
    expect(press.grab({ x: 270, y: 600 })).toBe(true);
  });

  it("ends a grab released with no point to be had as a cancel, the player where it last was", () => {
    const { press, sent, mouse, hideView } = setup({ screen: false });
    mouse("mouseDown", { x: 260, y: 590 });
    press.grab({ x: 260, y: 590 });
    hideView();
    mouse("mouseMove", { x: 300, y: 560 });
    mouse("mouseUp", { x: 300, y: 560 });
    expect(sent).toEqual([{ x: 0, y: 0, phase: "cancel" }]);
  });
});
