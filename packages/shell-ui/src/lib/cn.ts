import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Geist type roles declared as `text-*` utilities in styles.css — font sizes, not colors. */
const TYPE_ROLES = ["label-12", "label-13", "label-14", "copy-13", "copy-14", "heading-14", "heading-16", "heading-20", "heading-24"];

const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: TYPE_ROLES }] } },
});

/** Join class names (shadcn's `cn`): clsx for conditionals, tailwind-merge for conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
