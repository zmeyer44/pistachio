import { useEffect, useMemo, useRef } from "react";
import { JSONUIProvider, Renderer, useStateStore } from "@json-render/react";
import type { Spec } from "@json-render/core";
import { validateReportSpec } from "@pistachio/reports/validate";
import { isTickPath, tickPath } from "@pistachio/shell-contracts/reports";
import { tickChanges } from "../../lib/reports";
import { reportHandlers, reportRegistry } from "./registry";

export interface ReportViewProps {
  spec: Spec;
  /** Changes identity only when the report itself does, so a saved tick does not remount the page. */
  revision: string;
  /**
   * Ticks that are decided elsewhere — the home page's to-dos — by source key.
   * They win over the spec's own when the report mounts AND whenever they
   * change while it is mounted; a `false` here unticks.
   */
  ticks?: Record<string, boolean>;
  onTick?: (changes: { path: string; value: boolean }[]) => void;
}

/**
 * Draws a report. The spec crossed a process boundary and may have sat on
 * disk, so it is checked against the catalog again here: nothing that is not
 * a catalog component with catalog props reaches React.
 */
export function ReportView({ spec, revision, ticks, onTick }: ReportViewProps) {
  const checked = useMemo(() => validateReportSpec(spec), [spec]);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  // Keyed the way the page's state is: a tick lives at the one plain segment `tickPath` makes of its source key.
  const decided = useMemo(() => Object.fromEntries(Object.entries(ticks ?? {}).map(([key, value]) => [tickPath(key).slice("/ticks/".length), value])), [ticks]);

  // Read once per revision: after that the page's own state is the truth, kept in step by `TickSync`.
  const initialState = useMemo(() => {
    const state = (checked.ok ? (checked.spec.state ?? {}) : {}) as { ticks?: Record<string, boolean> };
    return { ...state, ticks: { ...state.ticks, ...decided } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, checked.ok]);

  // Where what is decided elsewhere already disagrees with what the report has on file, the page opens
  // showing the decided value — and no state ever "changes", so nothing would file it. File it here.
  useEffect(() => {
    if (!checked.ok) return;
    const filed = ((checked.spec.state ?? {}) as { ticks?: Record<string, unknown> }).ticks ?? {};
    // `tickChanges` returns only real disagreements: an open to-do that was never ticked is not one.
    const corrections = tickChanges(filed, decided).map((change) => ({ path: `/ticks/${change.key}`, value: change.value }));
    if (corrections.length > 0) onTickRef.current?.(corrections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, checked.ok]);

  const handlers = useMemo(
    () =>
      reportHandlers(
        () => undefined,
        () => initialState,
      ),
    [initialState],
  );

  if (!checked.ok)
    return (
      <p data-testid="report-invalid" className="mx-auto max-w-[640px] px-4 py-16 text-center text-[14px] text-gray-800">
        This report could not be shown because it does not match what Pistachio knows how to draw. Refresh to make a new one.
      </p>
    );

  return (
    <JSONUIProvider
      key={revision}
      registry={reportRegistry}
      initialState={initialState}
      handlers={handlers}
      onStateChange={(changes) => {
        const kept = changes.flatMap((change) => (isTickPath(change.path) ? [{ path: change.path, value: change.value === true }] : []));
        if (kept.length > 0) onTickRef.current?.(kept);
      }}
    >
      <TickSync decided={decided} />
      <Renderer spec={checked.spec} registry={reportRegistry} />
    </JSONUIProvider>
  );
}

/**
 * Keeps the mounted report's ticks agreeing with what is decided elsewhere.
 * It writes through the page's own state, so a correction is filed with the
 * brief like any other tick.
 */
function TickSync({ decided }: { decided: Record<string, boolean> }) {
  const { getSnapshot, set } = useStateStore();
  useEffect(() => {
    const current = ((getSnapshot() as { ticks?: Record<string, unknown> }).ticks ?? {}) as Record<string, unknown>;
    for (const change of tickChanges(current, decided)) set(`/ticks/${change.key}`, change.value);
  }, [decided, getSnapshot, set]);
  return null;
}
