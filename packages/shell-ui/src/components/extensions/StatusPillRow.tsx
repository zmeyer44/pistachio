import { forwardRef, type CSSProperties } from "react";
import type { DeskNotchPill } from "@pistachio/shell-contracts/desk";
import { ExtensionMark } from "./LedgeIcon";

/**
 * The extensions' live pills' row as it is drawn (docs/extensions.md §5,
 * `ui.setStatus`) — in the shell's DOM (StatusPills), and in main's notch
 * view over a live page (NotchApp) — the same in both, so the one is where
 * the other was: each its mark, its text, its actions. Its own module, free
 * of the shell's stores, for the notch view's small chunk.
 */
export const StatusPillRow = forwardRef<
  HTMLDivElement,
  {
    pills: readonly DeskNotchPill[];
    onAction: (id: string, action: string) => void;
    className: string;
    style?: CSSProperties;
    shown?: boolean;
    raised?: boolean;
  }
>(function StatusPillRow({ pills, onAction, className, style, shown, raised }, ref) {
  return (
    <div ref={ref} data-testid="extension-status-pills" data-shown={shown === true ? "" : undefined} data-raised={raised === true ? "" : undefined} className={className} style={style}>
      {pills.map((pill) => (
        <div key={pill.id} role="status" aria-label={`${pill.name}: ${pill.text}`} data-testid="extension-status-pill" data-extension-id={pill.id} className="extension-status-pill">
          <ExtensionMark extension={pill} />
          <span className="extension-status-text">{pill.text}</span>
          {pill.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              data-testid="extension-status-action"
              data-action={action.id}
              className="extension-status-action"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onAction(pill.id, action.id)}
            >
              {action.title}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
});
