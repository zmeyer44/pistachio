/**
 * The colours at a desk page's two top corners (BrowserController.deskPageCorners),
 * read from the page's own styles in an isolated world: what lies just inside
 * each corner on its topmost row, up to the first background that is not
 * see-through, or the page's canvas. Read, not captured: a capture of a rect
 * of the page sizes its capture to the rect, and a page captured so before it
 * was masked kept its masked layout through its own fullscreen.
 */

/** Watchtower's capture runs in 991, smart find's in 992, the app icon's in 993. */
export const PAGE_CORNERS_WORLD = 994;

/** A computed background colour the shell may paint: any CSS colour function, nothing else. */
const CSS_COLOUR = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^;{}()]*\)$/;

export function pageCornersScript(inset: number): string {
  const x = Math.max(0, Math.round(inset));
  return `(() => {
  const clear = (colour) => colour === "transparent" || /^rgba\\([^)]*,\\s*0(?:\\.0+)?\\)$/.test(colour) || /\\/\\s*0(?:\\.0+)?\\)$/.test(colour);
  const canvas = () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark") && matchMedia("(prefers-color-scheme: dark)").matches;
    return dark ? "rgb(18 18 18)" : "rgb(255 255 255)";
  };
  const at = (x) => {
    for (let element = document.elementFromPoint(x, 1); element !== null; element = element.parentElement) {
      const colour = getComputedStyle(element).backgroundColor;
      if (!clear(colour)) return colour;
    }
    return canvas();
  };
  return { left: at(${String(x)}), right: at(innerWidth - 1 - ${String(x)}) };
})()`;
}

/** The script's answer, if it is two colours the shell may paint. */
export function pageCorners(value: unknown): { left: string; right: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const { left, right } = value as Record<string, unknown>;
  return typeof left === "string" && typeof right === "string" && CSS_COLOUR.test(left) && CSS_COLOUR.test(right) ? { left, right } : null;
}
