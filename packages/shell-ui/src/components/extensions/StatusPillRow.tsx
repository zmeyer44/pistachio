import { forwardRef, type CSSProperties } from "react";
import { X } from "lucide-react";
import type { DeskNotchPill, DeskNotchRowPress } from "@pistachio/shell-contracts/desk";
import { ExtensionMark } from "./LedgeIcon";

/**
 * The extensions' live pills' row as it is drawn (docs/extensions.md §5,
 * `ui.setStatus`) — in the shell's DOM (StatusPills), and in main's notch
 * view over a live page (NotchApp) — the same in both, so the one is where
 * the other was: each its mark, its text, its actions. Its own module, free
 * of the shell's stores, for the notch view's small chunk.
 *
 * A band's rows lie in the same lane (docs/primitives.md §4.5,
 * `ui.band.set`), an extension's together as a group that reads in the
 * rows' own order, each a chip: the shell's own row — a mark, the text, a
 * quieter detail, a value in figures that line up, its buttons — with the
 * extension's words only inside it. The group is led by the extension's
 * mark, which on hover (and to the keyboard) is the × that takes its band
 * off: the same place, so the lane never changes width under the pointer.
 * A chip whose row has an id is pressed whole.
 */
export const StatusPillRow = forwardRef<
  HTMLDivElement,
  {
    pills: readonly DeskNotchPill[];
    onAction: (id: string, action: string) => void;
    /** A band's chip, one of its buttons, or its × was pressed. Without it, chips are drawn but press nothing. */
    onRow?: (press: DeskNotchRowPress) => void;
    className: string;
    style?: CSSProperties;
    shown?: boolean;
    raised?: boolean;
  }
>(function StatusPillRow({ pills, onAction, onRow, className, style, shown, raised }, ref) {
  return (
    <div ref={ref} data-testid="extension-status-pills" data-shown={shown === true ? "" : undefined} data-raised={raised === true ? "" : undefined} className={className} style={style}>
      {laneParts(pills).map((part) => ("pill" in part ? <Pill key={part.pill.id} pill={part.pill} onAction={onAction} /> : <Band key={`${part.band[0]!.id}\nband`} chips={part.band} onRow={onRow} />))}
    </div>
  );
});

type BandChip = DeskNotchPill & { row: NonNullable<DeskNotchPill["row"]> };

/** What lies in the lane, in order: each live pill, and each extension's band — its chips together, in the rows' order. */
export function laneParts(pills: readonly DeskNotchPill[]): ({ pill: DeskNotchPill } | { band: BandChip[] })[] {
  const parts: ({ pill: DeskNotchPill } | { band: BandChip[] })[] = [];
  for (const pill of pills) {
    if (pill.row === undefined) {
      parts.push({ pill });
      continue;
    }
    const last = parts[parts.length - 1];
    if (last !== undefined && "band" in last && last.band[0]?.id === pill.id) last.band.push(pill as BandChip);
    else parts.push({ band: [pill as BandChip] });
  }
  return parts;
}

function Pill({ pill, onAction }: { pill: DeskNotchPill; onAction: (id: string, action: string) => void }) {
  return (
    <div role="status" aria-label={`${pill.name}: ${pill.text}`} data-testid="extension-status-pill" data-extension-id={pill.id} className="extension-status-pill">
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
  );
}

/** What a chip says to a screen reader: whose it is, then the row. */
function chipLabel(pill: DeskNotchPill, row: NonNullable<DeskNotchPill["row"]>): string {
  return `${pill.name}: ${[pill.text, row.detail, row.value].filter((part) => part.trim() !== "").join(", ")}`;
}

/** One extension's band: its mark — the × on hover — and its chips. */
function Band({ chips, onRow }: { chips: readonly BandChip[]; onRow: ((press: DeskNotchRowPress) => void) | undefined }) {
  const first = chips[0]!;
  const remove = `Remove ${first.name}’s strip`;
  return (
    <div role="group" aria-label={first.name} data-testid="extension-band" data-extension-id={first.id} data-scope={first.row.scope ?? "*"} className="extension-band">
      <button
        type="button"
        data-testid="extension-band-remove"
        aria-label={remove}
        title={remove}
        className="extension-band-lead"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onRow?.({ id: first.id, scope: first.row.scope, row: null, button: null, remove: true })}
      >
        <ExtensionMark extension={first} />
        <X aria-hidden="true" />
      </button>
      {chips.map((chip) => (
        <Chip key={chip.row.index} pill={chip} row={chip.row} onRow={onRow} />
      ))}
    </div>
  );
}

function Chip({ pill, row, onRow }: { pill: DeskNotchPill; row: NonNullable<DeskNotchPill["row"]>; onRow: ((press: DeskNotchRowPress) => void) | undefined }) {
  const press = (button: string | null): void => onRow?.({ id: pill.id, scope: row.scope, row: row.id, button, remove: false });
  const body = (
    <>
      {row.mark === null ? null : (
        <span className="shown-row-mark" data-tone={row.mark.tone} data-dot={row.mark.glyph === null ? "" : undefined} aria-hidden="true">
          {row.mark.glyph}
        </span>
      )}
      <span className="extension-status-text">{pill.text}</span>
      {row.detail === "" ? null : <span className="shown-row-detail">{row.detail}</span>}
      {row.value === "" ? null : <span className="shown-row-value">{row.value}</span>}
    </>
  );
  return (
    <div data-testid="extension-band-row" data-extension-id={pill.id} data-row={row.id ?? undefined} data-scope={row.scope ?? "*"} className="extension-band-chip">
      {row.id === null ? (
        <span role="status" aria-label={chipLabel(pill, row)} className="extension-band-body">
          {body}
        </span>
      ) : (
        <button type="button" data-testid="extension-band-press" aria-label={chipLabel(pill, row)} className="extension-band-body" onMouseDown={(event) => event.preventDefault()} onClick={() => press(null)}>
          {body}
        </button>
      )}
      {pill.actions.map((action) => (
        <button
          key={action.id}
          type="button"
          data-testid="extension-band-button"
          data-action={action.id}
          className="extension-status-action"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => press(action.id)}
        >
          {action.title}
        </button>
      ))}
    </div>
  );
}
