import type { DragSample } from "@pistachio/shell-contracts/chrome";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";

/** What the press needs of Electron's MouseInputEvent, as `before-mouse-event` hands it over. */
export interface PipMouse {
  type: string;
  button?: string;
  /** On the pip view. */
  x: number;
  y: number;
  /** On the screen, when the event says (a synthetic one may not). */
  globalX?: number;
  globalY?: number;
}

type Point = { x: number; y: number };

/**
 * A press on the desk's floating player, followed for the shell to move the
 * player by (components/desk/DeskNowPlaying.tsx). The pip view hears the
 * press and says whether it is on the picture (a grab) or a control, but
 * the moves and the release that follow never reach the drag layer the
 * shell raises for the move: the OS gives them to the view the press began
 * on, whatever is raised over it since. So they are taken here, from the
 * pip view's own mouse events, and sent on the drag layer's channel, as a
 * grabbed desk page's are (browser-controller's #handleDeskMouse).
 *
 * The points are the window's. The view moves under the pointer as the
 * player follows it, so a point is the screen's plus the offset the grab
 * found between the two, which the view's moving does not change; an event
 * without a screen point falls back to the view's box.
 *
 * Pure of Electron (test/desk-pip-press.test.ts): main feeds it the view's
 * events and its box, and is handed the samples.
 */
export class DeskPipPress {
  readonly #bounds: () => ContentBounds | null;
  readonly #send: (sample: DragSample) => void;
  /** The left button down on the view: where on the screen, and the window's point less it once the shell moves the player by it. */
  #press: { screen: Point | null; offset: Point | null; grabbed: boolean } | null = null;

  constructor(bounds: () => ContentBounds | null, send: (sample: DragSample) => void) {
    this.#bounds = bounds;
    this.#send = send;
  }

  /** Whether the shell is moving the player by a press held now. */
  get grabbed(): boolean {
    return this.#press?.grabbed === true;
  }

  /** Every mouse event on the pip view, before its page sees it. */
  mouse(mouse: PipMouse): void {
    const left = (mouse.button ?? "left") === "left";
    const press = this.#press;
    switch (mouse.type) {
      case "mouseDown":
        if (!left) return;
        // A grab still held: its release went somewhere else, so the shell's move is over.
        this.cancel();
        this.#press = { screen: hasScreenPoint(mouse) ? { x: mouse.globalX, y: mouse.globalY } : null, offset: null, grabbed: false };
        return;
      case "mouseMove": {
        const point = press?.grabbed === true ? this.#point(mouse, press.offset) : null;
        if (point !== null) this.#send({ ...point, phase: "move" });
        return;
      }
      case "mouseUp": {
        if (!left || press === null) return;
        this.#press = null;
        if (!press.grabbed) return;
        // (With no point to be had, the player stays where it last was.)
        const point = this.#point(mouse, press.offset);
        this.#send(point === null ? { x: 0, y: 0, phase: "cancel" } : { ...point, phase: "up" });
        return;
      }
    }
  }

  /**
   * The pip view says the press is on the picture, at this point of the
   * window: whether the shell should move the player by it. Not once the
   * button is up — a click on the picture, its release heard before this —
   * or the shell would wait on a release that has come and gone.
   */
  grab(at: Point): boolean {
    const press = this.#press;
    if (press === null) return false;
    press.grabbed = true;
    press.offset = press.screen === null ? null : { x: at.x - press.screen.x, y: at.y - press.screen.y };
    return true;
  }

  /** The shell's move is over, however it ended: the rest of the press is the view's own. */
  end(): void {
    if (this.#press !== null) this.#press.grabbed = false;
  }

  /** The press is lost (the window went inactive under it): a grab ends where it last was. */
  cancel(): void {
    const grabbed = this.#press?.grabbed === true;
    this.#press = null;
    if (grabbed) this.#send({ x: 0, y: 0, phase: "cancel" });
  }

  #point(mouse: PipMouse, offset: Point | null): Point | null {
    if (offset !== null && hasScreenPoint(mouse)) return { x: mouse.globalX + offset.x, y: mouse.globalY + offset.y };
    const bounds = this.#bounds();
    return bounds === null ? null : { x: bounds.x + mouse.x, y: bounds.y + mouse.y };
  }
}

function hasScreenPoint(mouse: PipMouse): mouse is PipMouse & { globalX: number; globalY: number } {
  return typeof mouse.globalX === "number" && typeof mouse.globalY === "number" && (mouse.globalX !== 0 || mouse.globalY !== 0);
}
