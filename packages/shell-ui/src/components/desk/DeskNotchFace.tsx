import { Sparkles } from "lucide-react";
import { Kbd } from "../ui/kbd";

/**
 * The idle Bar's face: the mark, what the Bar is for, and the key that opens
 * it. DeskBar's own (the idle notch the shell draws), and the notch view's
 * over a live page (NotchApp), so the two are one face.
 */
export function DeskNotchFace({ ref, label, shortcut }: { ref?: React.Ref<HTMLSpanElement>; label: string; shortcut: string | null }) {
  return (
    <span ref={ref} className="desk-bar-pill-content">
      <Sparkles aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
      {shortcut === null ? null : (
        <Kbd small className="desk-bar-pill-key">
          {shortcut}
        </Kbd>
      )}
    </span>
  );
}
