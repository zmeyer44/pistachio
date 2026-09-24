import * as React from "react";
import { cn } from "../../lib/cn";

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The glyph (macOS) or word (elsewhere) each modifier prop renders as. */
const MODIFIERS = {
  meta: MAC ? "⌘" : "Ctrl",
  ctrl: MAC ? "⌃" : "Ctrl",
  alt: MAC ? "⌥" : "Alt",
  shift: MAC ? "⇧" : "Shift",
} as const;

const GLYPHS = new Set(["⌘", "⌃", "⌥", "⇧"]);
const WORDS = new Set(["Ctrl", "Alt", "Shift", "Cmd", "Meta"]);

/**
 * A formatted shortcut as its keys: "⌘⇧R" (macOS) splits at each modifier
 * glyph, "Ctrl+Shift+R" at each plus; anything else ("esc", "/") is one key.
 */
function keysOf(label: string): string[] {
  const glyphs: string[] = [];
  let rest = label;
  while (rest.length > 1 && GLYPHS.has(rest.charAt(0))) {
    glyphs.push(rest.charAt(0));
    rest = rest.slice(1);
  }
  if (glyphs.length > 0) return [...glyphs, rest];
  const parts = label.split("+");
  if (parts.length > 1 && parts.slice(0, -1).every((part) => WORDS.has(part)) && parts.at(-1) !== "") return parts;
  return [label];
}

interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  /** For dense surfaces: menu rows, command items, table cells. */
  small?: boolean;
}

/**
 * Geist Keyboard Input: one key cap for a whole shortcut. Modifiers come as
 * props (⌘ turns into Ctrl off macOS), the key as children; a formatted
 * label such as a shortcut hint ("⌘⇧R", "Ctrl+Shift+R") splits the same way.
 */
function Kbd({ meta, shift, alt, ctrl, small = false, className, children, ...props }: KbdProps) {
  const keys = [
    ...(meta ? [MODIFIERS.meta] : []),
    ...(ctrl && !(meta && !MAC) ? [MODIFIERS.ctrl] : []),
    ...(alt ? [MODIFIERS.alt] : []),
    ...(shift ? [MODIFIERS.shift] : []),
  ];
  const content: React.ReactNode[] = typeof children === "string" ? keysOf(children) : children === undefined ? [] : [children];
  const all = [...keys, ...content];
  const words = !MAC && all.length > 1;
  return (
    <kbd
      data-geist-kbd=""
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center bg-background-100 py-0 font-sans leading-[1.7em] shadow-border",
        small ? "h-5 min-h-5 min-w-5 rounded-xs px-1 text-xs text-gray-900" : "min-h-6 min-w-6 rounded-xs px-1.5 text-sm text-gray-1000",
        className,
      )}
      {...props}
    >
      {all.map((key, index) => (
        <React.Fragment key={index}>
          {words && index > 0 ? <span aria-hidden="true">+</span> : null}
          <span className={cn(typeof key === "string" && GLYPHS.has(key) && "inline-block min-w-[1em] text-center")}>{key}</span>
        </React.Fragment>
      ))}
    </kbd>
  );
}

export { Kbd };
