/**
 * A terminal's colours (docs/terminal.md §2): its ground is the window's own
 * face (the Appearance's tinted background), its text the shell's ink, and
 * its sixteen ANSI colours GitHub's terminal palettes — tuned for reading
 * on a light ground and a dark one alike. Light or dark follows the shell's
 * scheme, and a terminal changes with it as the person changes Appearance.
 */

import type { ITheme } from "@xterm/xterm";

const DARK_ANSI = {
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
} as const;

const LIGHT_ANSI = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
} as const;

let probe: CanvasRenderingContext2D | null = null;

/**
 * A CSS colour — any the shell's tokens are written in (`color-mix`, oklch)
 * — as `#rrggbb`: the terminal's renderer takes only plain colours. Null
 * when it does not name one.
 */
export function resolveColor(css: string, within: HTMLElement = document.documentElement): string | null {
  const element = document.createElement("span");
  element.style.color = css;
  element.style.display = "none";
  within.append(element);
  const computed = getComputedStyle(element).color;
  element.remove();
  if (computed === "") return null;
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (probe === null) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = computed;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function schemeIsDark(root: HTMLElement = document.documentElement): boolean {
  return root.dataset["colorScheme"] === "dark";
}

/** The terminal's theme, from the shell's tokens as they stand now. */
export function terminalTheme(root: HTMLElement = document.documentElement): ITheme {
  const dark = schemeIsDark(root);
  const background = resolveColor("var(--color-background-100)", root) ?? (dark ? "#1f2124" : "#ffffff");
  const foreground = resolveColor("var(--color-gray-1000)", root) ?? (dark ? "#ededed" : "#171717");
  const accent = resolveColor("var(--theme-accent, var(--color-blue-700))", root) ?? "#0969da";
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    // (Eight-digit hex: the selection is laid over the text, not under it.)
    selectionBackground: `${accent}${dark ? "59" : "40"}`,
    selectionInactiveBackground: `${accent}${dark ? "33" : "26"}`,
    scrollbarSliderBackground: dark ? "#ffffff26" : "#0000001f",
    scrollbarSliderHoverBackground: dark ? "#ffffff40" : "#00000033",
    scrollbarSliderActiveBackground: dark ? "#ffffff59" : "#00000047",
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
  };
}
