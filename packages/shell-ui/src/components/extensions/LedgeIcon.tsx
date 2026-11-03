import { useState, type CSSProperties } from "react";
import type { ExtensionInfo } from "@pistachio/shell-contracts/extensions";
import { cn } from "../../lib/cn";
import { hueOf, ledgeDotOf, ledgeTitle, monogramOf } from "../../lib/extensions/ledge";

/**
 * An extension's mark: its icon (`iconUrl`: `crx://` for a Chrome one,
 * `pistachio-ext://` for ours), or — with none, or one that will not load —
 * its monogram on a hue of its own, the same every time (its id's).
 */
export function ExtensionMark({ extension, className }: { extension: Pick<ExtensionInfo, "id" | "name" | "iconUrl">; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const url = extension.iconUrl;
  if (url !== null && broken !== url)
    return <img className={cn("extension-mark", className)} src={url} alt="" draggable={false} onError={() => setBroken(url)} />;
  return (
    <span className={cn("extension-mark extension-monogram", className)} style={{ "--extension-hue": String(hueOf(extension.id)) } as CSSProperties} aria-hidden="true">
      {monogramOf(extension.name)}
    </span>
  );
}

/**
 * One extension on the Ledge (docs/extensions.md §2): its mark in a 28px
 * target (24 in the rail's column), its badge as a small pill at the
 * top-trailing corner, dimmed to 35% where it is off in this Profile, an
 * amber dot when it needs the person and a red one when one of their own is
 * broken. The Ledge owns what a press does (a click, a carry, a right-click,
 * the keys): this is only what it looks like and how it is found.
 */
export function LedgeIcon({
  extension,
  open,
  tabIndex,
  carried,
  dropBefore,
  offset,
  onClick,
  onContextMenu,
  onPointerDown,
  onFocus,
}: {
  extension: ExtensionInfo;
  /** Its panel is open beside the sidebar. */
  open: boolean;
  tabIndex: number;
  /** Carried along the Ledge to a new place. */
  carried: boolean;
  /** The carried one would land just before it. */
  dropBefore: boolean;
  /** How far the carried one follows the pointer, px. */
  offset: number;
  onClick: (el: HTMLButtonElement) => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onFocus: () => void;
}) {
  const dot = ledgeDotOf(extension);
  const title = ledgeTitle(extension);
  const badge = extension.badge === null || extension.badge === "" ? null : extension.badge;
  return (
    <button
      type="button"
      data-ledge-item=""
      data-ledge-id={extension.id}
      data-testid="ledge-icon"
      data-extension-id={extension.id}
      data-off={extension.enabledHere ? undefined : ""}
      data-dot={dot ?? undefined}
      data-drafting={extension.drafting === true ? "" : undefined}
      data-open={open ? "" : undefined}
      data-carried={carried ? "" : undefined}
      data-drop-before={dropBefore ? "" : undefined}
      aria-label={title}
      aria-pressed={extension.hasPanel ? open : undefined}
      title={title}
      tabIndex={tabIndex}
      className="ledge-icon"
      style={carried ? { translate: `${String(offset)}px 0` } : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={onPointerDown}
      onFocus={onFocus}
      onClick={(event) => onClick(event.currentTarget)}
      onContextMenu={onContextMenu}
    >
      <ExtensionMark extension={extension} className="ledge-mark" />
      {badge === null ? null : (
        <span className="ledge-badge" data-testid="ledge-badge">
          {badge.length > 4 ? badge.slice(0, 4) : badge}
        </span>
      )}
      {dot === null ? null : <span className="ledge-dot" data-tone={dot} aria-hidden="true" />}
    </button>
  );
}
