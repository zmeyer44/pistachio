/**
 * What the landing page and its hero frame say to each other about the
 * feature tour. The page decides which step of "Core features" the window
 * is sitting beside and posts it; the frame (./tour.tsx) plays that step on
 * the live shell. Kept free of the shell so the page can import it without
 * pulling the whole browser into its own bundle.
 */

/** The window's size as the shell lays it out; the page scales it to fit its slots. */
export const DESIGN_W = 1200;
export const DESIGN_H = 720;

/** The desk's wallpaper (public/img), drawn behind the window and under its glass. */
export const WALLPAPER = { src: "/img/hero-wallpaper-pistachio.jpg", width: 1586, height: 992 };

/** One per step in lib/site-data.ts `steps`, in the same order. */
export const TOUR_SCENES = ["agent", "glance", "split", "reader", "media"] as const;

export type TourScene = (typeof TOUR_SCENES)[number];

export const TOUR_MESSAGE = "pistachio:tour";

/**
 * Page → frame: the scene to play, or null for the hero, where the window is
 * the visitor's to click around in.
 */
export interface TourMessage {
  type: typeof TOUR_MESSAGE;
  scene: TourScene | null;
}

/**
 * Page → frame: the visitor has taken the window (clicked the shield the
 * page keeps over it during the tour, so the wheel scrolls the page and not
 * the panes). The scene stops where it is; the next scene starts it again.
 */
export const TOUR_HAND_OVER = "pistachio:tour-hand-over";

/** Frame → page: the shell has painted its first frame, so the page can show it over the skeleton. */
export const TOUR_PAINTED = "pistachio:tour-painted";

/** Frame → page: the director is listening, so the page should say where it is. */
export const TOUR_READY = "pistachio:tour-ready";

export function isTourMessage(value: unknown): value is TourMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<TourMessage>;
  return message.type === TOUR_MESSAGE && (message.scene === null || TOUR_SCENES.includes(message.scene as TourScene));
}
