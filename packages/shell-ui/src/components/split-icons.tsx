import type { SVGProps } from "react";

// Drawn to lucide's grid (24px viewBox, 2px round stroke) so it sits beside
// lucide-react icons; built on lucide's Columns2 split frame.

/**
 * Leave split view: the Columns2 frame with its right pane opened up and an
 * arrow carrying that pane out, while the left pane stays shut.
 */
export function SplitExit(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...props}
    >
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" />
      <path d="M12 3v18" />
      <path d="M12 3h7a2 2 0 0 1 2 2v2" />
      <path d="M12 21h7a2 2 0 0 0 2-2v-2" />
      <path d="M15 12h7" />
      <path d="m19 9 3 3-3 3" />
    </svg>
  );
}
