import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class names, letting later Tailwind utilities win.
 *
 * The dashboard's copy of this extends tailwind-merge with the marketing type
 * scale (`text-14`, `text-24`, …); this app has no marketing tokens, so the
 * stock merge is the whole of it.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
