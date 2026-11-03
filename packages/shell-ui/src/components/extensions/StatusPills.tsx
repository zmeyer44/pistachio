import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { DESK_NOTCH_PILL_ACTIONS_MAX, DESK_NOTCH_PILLS_MAX, type DeskNotchPill } from "@pistachio/shell-contracts/desk";
import { extensionsRequest, useExtensions, useExtensionsState } from "../../lib/extensions/use-extensions";
import { DESK_GAP, NUB_LANE_FOOT, NUB_LANE_INSET } from "../../lib/desk/geometry";
import { StatusPillRow } from "./StatusPillRow";

/**
 * Every extension's live pill on this Profile (`pistachio.ui.setStatus`,
 * docs/extensions.md §5), first the rightmost, as the shell and main's notch
 * view both draw them — each within what the notch view is sent.
 */
/**
 * Whether an extension's pill is drawn: one it set, and the extension on — here, or recording or watching a window
 * (`captures`: a capture follows its window across a Profile switch, and its Stop must too). One off keeps no live word.
 */
export function hasLivePill(extension: { statusPill: unknown; enabled: boolean; enabledHere: boolean; captures?: string[] }): boolean {
  return extension.statusPill !== null && extension.enabled && (extension.enabledHere || (extension.captures?.length ?? 0) > 0);
}

export function useStatusPills(): DeskNotchPill[] {
  useExtensionsState((state) => state.loaded);
  const extensions = useExtensions(useShallow((state) => state.snapshot.extensions.filter(hasLivePill)));
  return useMemo(
    () =>
      extensions.slice(0, DESK_NOTCH_PILLS_MAX).flatMap((extension) => {
        const pill = extension.statusPill;
        if (pill === null) return [];
        return [
          {
            id: extension.id,
            name: extension.name.slice(0, 200),
            iconUrl: extension.iconUrl !== null && extension.iconUrl.length <= 2048 ? extension.iconUrl : null,
            text: pill.text.slice(0, 400),
            actions: pill.actions
              .filter((action) => action.id.length > 0 && action.id.length <= 64)
              .slice(0, DESK_NOTCH_PILL_ACTIONS_MAX)
              .map((action) => ({ id: action.id, title: action.title.slice(0, 64) })),
          },
        ];
      }),
    [extensions],
  );
}

/** A press on a pill's action: the extension's (`statusAction`, main's), from the shell's row or the notch view's. */
export function sendStatusAction(id: string, action: string): void {
  void extensionsRequest({ type: "statusAction", id, action });
}

/** Where the row lies in the nub's lane, from the Bar's lane (which stands DESK_GAP in from the desk's edges). */
const LANE_PLACE = { "--status-lane-right": `${String(NUB_LANE_INSET - DESK_GAP)}px`, "--status-lane-foot": `${String(NUB_LANE_FOOT)}px` } as CSSProperties;

/**
 * The extensions' live pills beside the Bar's nub, in the shell's DOM — never
 * a tab's pixels, so never in a recording of one. They lie in the nub's lane
 * (geometry's nubOutline: the nub drawn out along the desk's foot by their
 * width, which DeskBar asks of the nub from `onWidth`), a hole down to the
 * ground as the nub is, so no page under them gives way — over a live page
 * main's notch view draws them, the same row (StatusPillRow). While the Bar's
 * pill or menu is out (`raised`) they stand left of the Bar's pill, inside
 * its cover, and show once the pages there have given way (`shown`). Hidden
 * with the Bar while the desk is captured (the Bar's lane goes, and these
 * with it).
 */
export function StatusPills({ pills, raised, shown, onWidth }: { pills: readonly DeskNotchPill[]; raised: boolean; shown: boolean; onWidth: (width: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const up = pills.length > 0;
  // Their row's width, which the nub is drawn out by (and the notch view's row is laid at).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!up || el === null) {
      onWidth(0);
      return;
    }
    const measure = (): void => onWidth(Math.ceil(el.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [up, onWidth]);
  useLayoutEffect(() => () => onWidth(0), [onWidth]);

  if (!up) return null;
  return <StatusPillRow ref={ref} pills={pills} onAction={sendStatusAction} className="extension-status-pills" style={LANE_PLACE} shown={shown} raised={raised} />;
}
