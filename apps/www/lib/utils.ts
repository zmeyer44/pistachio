import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Our type scale uses numeric names (text-14, text-16, ...). tailwind-merge
 * only knows its own font-size scale, so without this it treats them as text
 * *colours* and drops a real colour class that appears alongside them.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "10",
            "12",
            "14",
            "16",
            "20",
            "24",
            "28",
            "32",
            "40",
            "48",
            "88",
          ],
        },
      ],
    },
  },
});

/** Merge conditional class names, letting later Tailwind utilities win. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
