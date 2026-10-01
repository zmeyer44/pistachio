import type { ReactNode } from "react";

/** A picture's or a PDF's zoom, floating at the foot of its window: the percentage, and the steps beside it. */
export function ZoomBar({
  label,
  labelTitle,
  onLabel,
  actions,
  extra,
}: {
  label: string;
  labelTitle: string;
  onLabel: () => void;
  actions: ReadonlyArray<{ label: string; icon: ReactNode; pressed?: boolean; onClick: () => void }>;
  extra?: ReactNode;
}) {
  const [first, ...rest] = actions;
  return (
    <div className="desk-zoom-bar" data-testid="desk-zoom-bar">
      {extra}
      {first === undefined ? null : <ZoomButton {...first} />}
      <button type="button" className="desk-zoom-label" title={labelTitle} onMouseDown={(event) => event.preventDefault()} onClick={onLabel}>
        {label}
      </button>
      {rest.map((action) => (
        <ZoomButton key={action.label} {...action} />
      ))}
    </div>
  );
}

function ZoomButton({ label, icon, pressed, onClick }: { label: string; icon: ReactNode; pressed?: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={pressed} className="desk-zoom-button" onMouseDown={(event) => event.preventDefault()} onClick={onClick}>
      {icon}
    </button>
  );
}
