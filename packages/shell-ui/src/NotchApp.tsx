/**
 * The desk's idle nub over a live page (docs/desk.md, "The foot"): a
 * utility chrome view of its own (main/chrome-view.ts, id "notch"), because
 * a tab's view paints over everything the shell draws, and the nub is to lie
 * over the windows' pages in the desk's trailing foot corner, not to cut
 * them short. The shell says where it is and what it shows while a live page
 * is under it (DeskBar → main); the view is the box the nub may fill, its
 * bottom-right corner the desk's, cut to the nub's outline. The pointer on it
 * and a press go back to the shell's Bar, which swells the nub and opens its
 * menu as if the pointer were on it.
 *
 * The menu is drawn here too (2026-11-17; DeskNotchFrame.menu): the nub let
 * go of the corner, a button of its own, and its three droplets, over the
 * page — which stays live and its own under them. Until then the menu was a
 * cover: the page under it gave way to its still, this view went, and a press
 * on that picture was a press on the window (dragged, it carried the window
 * off). It is the shell's own nub drawn again (DeskNub, with its own
 * NubMotion) in the view's box, which the shell grows to the droplets' fan
 * while they are out: a droplet pressed here is the shell's pressed
 * (`{ menu }`), the pointer onto one opens the shell's tooltip beside it
 * (`{ hover }`), and a press in the box beside them is a press elsewhere
 * (`away`), which puts the menu away as one on the page does. What the menu
 * opens — the pill, the conversations — is a cover still, and once it has
 * made the page under it a still, this view goes.
 *
 * The swell is drawn here too, read off the same clock as the shell's own
 * (DeskNotchFrame.swelling, NubMotion's `follow`): the view's box holds the
 * nub swelled, so it only changes its outline as it swells, never its box.
 *
 * Elsewhere the nub is a hole down to the shell's ground; here a page lies
 * under it, so the view paints that ground itself (shell.css .desk-notch-view):
 * the theme's gradient laid over the shell's ground box (`frame.ground`) as
 * the shell lays it, its grain tiled from the same corner, and cut to the
 * nub's outline. With the desktop glass on, the glass under that is a
 * stand-in grey — and over the view, where main can lay it (main/desk-glass.ts),
 * the window's own glass, cut to the nub, with the nub drawn again on it. That
 * nub is this same page painted offscreen (`picture`, main's "notch-picture"),
 * at the display's rate: the nub with no stand-in, and below it its outline
 * alone, opaque, which the glass is cut to — the nub and the glass's cut in one
 * frame, so they move as one. The stand-in under them is what shows until the
 * picture's first frame, and if the glass steps aside.
 *
 * While extensions' live pills stand (docs/extensions.md §5, `ui.setStatus`),
 * the nub is drawn out along the foot by their width (its lane, geometry's
 * nubOutline; DeskNotchFrame.lane, read off the same clock as the swell) and
 * the view is that much wider, its corner still the desk's: the pills lie in
 * the lane here as the shell lays them in its own hole (StatusPillRow, at the
 * width the shell measured), and a press on one of their actions goes back
 * to the shell as the pill's own (`{ status }`). So a page under them never
 * gives way to them: they are the notch's, not a cover.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DeskNotchFrame, DeskNotchInput } from "@pistachio/shell-contracts/desk";
import { nativeApi } from "./api";
import { DeskNub, NUB_BOX, NubPillClose, NubPillSide } from "./components/desk/DeskNub";
import type { NubMotion } from "./components/desk/nub-motion";
import { StatusPillRow } from "./components/extensions/StatusPillRow";
import { NUB_LANE_FOOT, NUB_LANE_INSET, nubOutline, type NotchShape } from "./lib/desk/geometry";

/** The pointer moving on the view says it is there at most this often. */
const ENTER_REPEAT_MS = 100;
/**
 * A word about the menu older than this (ms) is where the menu already is: longer than its droplets take out of the
 * nub or back into it. The view come up over a menu that has been out a while draws it out, at once.
 */
const MENU_SETTLED_MS = 600;

/** The view has no pill: nothing for the nub's motion to grow one out of. */
const NO_PILL = (): null => null;

export function NotchApp({ picture = false, buttons = false, fan = false }: { picture?: boolean; buttons?: boolean; fan?: boolean }) {
  const [frame, setFrame] = useState<DeskNotchFrame | null>(null);
  const saidEnter = useRef(Number.NEGATIVE_INFINITY);
  const rootRef = useRef<HTMLDivElement>(null);
  const maskRef = useRef<HTMLDivElement>(null);
  const nubRef = useRef<HTMLDivElement>(null);
  const faceRef = useRef<HTMLButtonElement>(null);
  const motionRef = useRef<NubMotion | null>(null);
  /** The frame as it is now, for what the nub's motion asks as it moves: the box its outline is drawn in, the desk's corner. */
  const now = useRef(frame);
  now.current = frame;

  useEffect(() => {
    const api = nativeApi();
    if (api === null) return;
    let active = true;
    let heard = false;
    void api.getDeskNotch().then((next) => {
      // A change that arrived while this was in flight is the newer word.
      if (active && !heard) setFrame(next);
    });
    const off = api.onDeskNotch((next) => {
      heard = true;
      setFrame(next);
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  // What of the nub is in the corner, as its motion draws it (swelling, settling, letting go of the corner for its
  // menu and coming back): the view's ground is cut to it — and the picture's outline, the glass's cut, in the same
  // frame. None of it there (the nub stands free, its menu out), nothing of the ground is left.
  const cut = useCallback((corner: NotchShape | null, lane: number): void => {
    const at = now.current;
    const root = rootRef.current;
    if (at === null || root === null) return;
    const clip = corner === null ? "inset(100%)" : `path("${nubOutline(corner, at.bounds.width, at.bounds.height, at.corner, 0, 0, lane)}")`;
    root.style.clipPath = clip;
    if (maskRef.current !== null) maskRef.current.style.clipPath = clip;
  }, []);
  const corner = useCallback((): number => now.current?.corner ?? 0, []);

  // The nub as the shell has it: its swell and its lane read off the shell's clock, and drawn again as the view's box
  // or the desk's corner changes (the outline is drawn from the box's corner).
  useLayoutEffect(() => {
    const motion = motionRef.current;
    if (frame === null || motion === null) return;
    motion.follow(frame.swelling, frame.lane);
    motion.refresh();
  }, [frame]);
  // Its menu out or in, on the view's own clock from the shell's word — one older than the menu's motion is where the
  // menu already is (the view come up over a menu that was out, or the picture's, which keeps its last word while the
  // view is away).
  const up = frame !== null;
  const menuOpen = frame?.menu.open ?? false;
  const menuAt = frame?.menu.at ?? 0;
  useLayoutEffect(() => {
    const motion = motionRef.current;
    if (!up || motion === null) return;
    const settled = Date.now() - menuAt > MENU_SETTLED_MS;
    if (menuOpen) motion.openMenu(settled);
    else motion.closeMenu(settled);
  }, [up, menuOpen, menuAt]);
  // The Bar's pill on its way out of this nub, drawn by the prompt's view beside this one (DeskNotchFrame's `pill`):
  // this nub's side of it — the droplet it came out of gone from the fan, the bridge to its end — on the view's own
  // clock from the shell's word, as the menu is. (After the menu's, so a menu just let out does not bring that droplet back.)
  const pillWay = frame?.pill ?? null;
  const pillAt = pillWay?.at ?? 0;
  const pillNow = useRef(pillWay);
  pillNow.current = pillWay;
  useLayoutEffect(() => {
    const motion = motionRef.current;
    if (!up || motion === null) return;
    motion.mirrorPill(pillNow.current);
  }, [up, pillAt]);

  if (frame === null) return null;
  const send = (input: DeskNotchInput): void => nativeApi()?.sendDeskNotchInput(input);
  // Hidden under the pointer (once what the nub opens has made the page under it a still), the view never hears it
  // go, and shown again its page has the pointer there still: the coming it then reports may be no one's (the shell
  // checks the OS's pointer), and a real one, onto a button its page thinks is under the pointer already, would go
  // unsaid. So a move on it says so too.
  const enter = (): void => {
    const at = performance.now();
    if (at - saidEnter.current < ENTER_REPEAT_MS) return;
    saidEnter.current = at;
    send("enter");
  };
  const leave = (): void => {
    saidEnter.current = Number.NEGATIVE_INFINITY;
    send("leave");
  };
  const { bounds, ground } = frame;
  const px = (value: number): string => `${value.toFixed(1)}px`;
  // The pill's buttons above the nub, in the view of their own (main's "notch-buttons"; DeskNotchFrame's `column`):
  // where the shell lays them — the nub's box, its corner the desk's, which lies below this view's foot by as far as
  // the view stops short of it. A press is the shell's, and the pointer onto one opens the shell's tooltip.
  if (buttons) {
    const column = frame.column ?? null;
    if (column === null) return null;
    const { close, side } = frame.buttons;
    const foot = bounds.y + bounds.height - (column.y + column.height);
    return (
      <div className="desk-notch-view-buttons" data-testid="desk-notch-buttons" style={{ width: NUB_BOX.w, height: NUB_BOX.h, bottom: -foot }}>
        <NubPillClose shown={close} onClose={() => send({ bar: "close" })} onHover={(on) => send({ hover: on ? "close" : null })} />
        <NubPillSide shown={side} onSide={() => send({ bar: "side" })} onHover={(on) => send({ hover: on ? "side" : null })} />
      </div>
    );
  }
  // The nub itself, as the shell draws its own (DeskNub): its face and mark, moved with the swell; its menu, let out
  // of it. No tooltips here — none could reach past the view's box: the pointer onto a droplet is said, and the
  // shell's own says what it is.
  const nub = (
    <DeskNub
      nubRef={nubRef}
      faceRef={faceRef}
      motionRef={motionRef}
      pill={NO_PILL}
      onShape={cut}
      corner={corner}
      label={{ text: frame.label, shortcut: frame.shortcut }}
      acting={frame.acting}
      floating={frame.floating}
      menuOpen={menuOpen}
      chatsOpen={false}
      hovered={false}
      onItemHover={picture ? undefined : (droplet) => send({ hover: droplet })}
      onFaceEnter={enter}
      onFaceLeave={leave}
      onFace={() => send("press")}
      onPrompt={() => send({ menu: "prompt" })}
      onMic={() => send({ menu: "mic" })}
      onChats={() => send({ menu: "chats" })}
    />
  );
  // The extensions' pills in the lane, where the shell lays them, at the width it measured; an action pressed is the
  // shell's to send on.
  const pills =
    frame.pills.length === 0 ? null : (
      <StatusPillRow
        pills={frame.pills}
        onAction={(id, action) => nativeApi()?.sendDeskNotchInput({ status: { id, action } })}
        onRow={(row) => nativeApi()?.sendDeskNotchInput({ row })}
        className="desk-notch-view-pills"
        style={{ right: NUB_LANE_INSET, bottom: NUB_LANE_FOOT, width: frame.pillsWidth }}
      />
    );
  const groundStyle = {
    // The shell's ground box, where it lies from this view's corner.
    "--desk-notch-ground-x": px(ground.x - bounds.x),
    "--desk-notch-ground-y": px(ground.y - bounds.y),
    "--desk-notch-ground-w": px(ground.width),
    "--desk-notch-ground-h": px(ground.height),
    // The nub's own box, in the corner: the rest is its lane, the column above it, and its droplets' fan.
    "--desk-notch-nub": px(frame.nub),
    // The desk's corner, which what the nub paints is clipped to (.desk-nub-paint).
    "--desk-window-radius": px(frame.corner),
  } as React.CSSProperties;
  if (!picture) {
    // The nub's own view while the menu's view has the nub (DeskNotchFrame's `fanDraws`): it draws none of it — the
    // menu's view lies over this one and draws the same nub, and two of them would lay its shadow twice in this box.
    const away = !fan && frame.fanDraws === true ? ({ opacity: 0 } as const) : null;
    return (
      <>
        {/* The view's box beside the droplets, while they are out: a press there is a press elsewhere. */}
        <div className="desk-notch-view-away" data-testid="desk-notch-away" data-open={menuOpen ? "" : undefined} onPointerDown={() => send("away")} />
        <div ref={rootRef} className="desk-notch-view tab-group-tone" data-group-color={frame.color} data-away={away === null ? undefined : ""} style={{ ...groundStyle, ...away }}>
          <button
            type="button"
            className="desk-notch-view-hit"
            data-testid="desk-notch-view"
            aria-label={frame.shortcut === null ? frame.label : `${frame.label} (${frame.shortcut})`}
            onPointerEnter={enter}
            onPointerMove={enter}
            onPointerLeave={leave}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => send("press")}
          />
          {pills}
        </div>
        {/* Over the ground, not in it: the nub out of the corner and its droplets are past the ground's cut. */}
        <div className="desk-notch-view-nub tab-group-tone" data-group-color={frame.color} style={{ width: NUB_BOX.w, height: NUB_BOX.h, ...groundStyle, ...away }}>
          {nub}
        </div>
        {/* (The pill's buttons above the nub are a view of their own: `buttons`, above.) */}
      </>
    );
  }
  // Offscreen, twice the view's height: the nub over its outline (main/desk-glass.ts splits them). The nub is in the
  // ground here, cut with it: what of it is in the corner is what lies on the glass — its mark, and the fill that comes
  // in over it as it lets go for its menu — and the rest of it is the view's own page's, beside the glass.
  return (
    <div className="desk-notch-picture" style={{ "--desk-notch-w": px(bounds.width), "--desk-notch-h": px(bounds.height) } as React.CSSProperties}>
      <div ref={rootRef} className="desk-notch-view tab-group-tone" data-group-color={frame.color} data-picture="" style={groundStyle}>
        {nub}
        {pills}
      </div>
      <div ref={maskRef} className="desk-notch-view-mask" data-testid="desk-notch-picture-mask" />
    </div>
  );
}
