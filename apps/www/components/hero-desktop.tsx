import { WALLPAPER } from "./hero-browser/tour-protocol";

/**
 * The hero's desktop: a wallpaper with Pistachio's window on it, the way the
 * app looks on a Mac — except the window is the real shell, running in this
 * page over an in-memory host (app/hero-browser), so every tab, favorite and
 * address in it works.
 *
 * The window itself is not drawn here. It is the page's one live browser
 * (components/live-browser.tsx), which sits on this desk's slot at the top
 * of the page and flies down to "Core features" as the page scrolls. The
 * slot is the window's shape and is capped at the shell's design width;
 * below that the window scales down to fit it.
 */
export function HeroDesktop() {
  return (
    <div className="w-full px-4 desk:px-6">
      <div
        data-testid="hero-desk"
        data-tour-desk=""
        className="hero-desk relative w-full overflow-hidden rounded-2xl"
        style={{ backgroundImage: `url("${WALLPAPER.src}")` }}
      >
        <div data-tour-slot="hero" className="hero-window-slot mx-auto aspect-[5/3]" />
      </div>
    </div>
  );
}
