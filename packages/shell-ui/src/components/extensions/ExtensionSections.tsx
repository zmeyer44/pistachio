import { useMemo } from "react";
import { X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { ExtensionInfo, ExtensionRow, ExtensionSiteView } from "@pistachio/shell-contracts/extensions";
import { pressRow, removeShown } from "../../lib/extensions/actions";
import { removeRowsLabel, rowLabel, rowTone, sectionTitle, siteViewsFor } from "../../lib/extensions/shown";
import { useExtensions } from "../../lib/extensions/use-extensions";
import { ExtensionMark } from "./LedgeIcon";

const NO_SITES: readonly ExtensionSiteView[] = [];
const NO_OWNERS: ExtensionInfo[] = [];

/**
 * The extensions' sections of the sidebar (docs/primitives.md §4.5,
 * `pistachio.ui.sidebar.set`): at the foot of the card, over the Ledge, one
 * section an extension — its rows for the space the card shows, else the
 * ones it set for every space. Each is the shell's own drawing: a head with
 * the extension's mark, the title it gave (its name with none) and, on
 * hover, the × that takes the section off; then its rows — a mark, the
 * text, a quieter detail, a value in figures that line up, and its buttons,
 * which come up in the value's place while the pointer is on the row.
 * The extension's words lie only inside those; nothing of its is markup.
 *
 * A row with an id is pressed whole, and a button on its own: the press goes
 * to main (`press`), which wakes the extension with it as the person's act.
 * Main keeps the rows, so they are here with no worker running.
 */
export function ExtensionSections({ spaceId }: { spaceId: string | null }) {
  const sites = useExtensions((state) => state.snapshot.sites ?? NO_SITES);
  const views = useMemo(() => siteViewsFor(sites, "sidebar", spaceId), [sites, spaceId]);
  const owners = useExtensions(useShallow((state) => (views.length === 0 ? NO_OWNERS : state.snapshot.extensions.filter((extension) => views.some((view) => view.extensionId === extension.id)))));
  if (views.length === 0) return null;
  return (
    <div data-testid="extension-sections" className="extension-sections no-drag">
      {views.map((view) => (
        <Section key={view.extensionId} view={view} iconUrl={owners.find((owner) => owner.id === view.extensionId)?.iconUrl ?? null} />
      ))}
    </div>
  );
}

function Section({ view, iconUrl }: { view: ExtensionSiteView; iconUrl: string | null }) {
  const title = sectionTitle(view);
  const remove = removeRowsLabel("sidebar", view.extensionName);
  return (
    <section data-testid="extension-section" data-extension-id={view.extensionId} data-scope={view.spaceId ?? "*"} aria-label={title === view.extensionName ? title : `${title}, ${view.extensionName}`} className="extension-section">
      <div className="extension-section-head" title={view.extensionName}>
        <ExtensionMark extension={{ id: view.extensionId, name: view.extensionName, iconUrl }} className="extension-menu-mark" />
        <span data-testid="extension-section-title" className="extension-section-title">
          {title}
        </span>
        <button type="button" data-testid="extension-section-remove" aria-label={remove} title={remove} className="extension-section-remove" onClick={() => void removeShown(view.extensionId, "sidebar", view.spaceId)}>
          <X aria-hidden="true" />
        </button>
      </div>
      <ul className="extension-section-rows">
        {view.rows.map((row, index) => (
          <SectionRow key={index} view={view} row={row} />
        ))}
      </ul>
    </section>
  );
}

function SectionRow({ view, row }: { view: ExtensionSiteView; row: ExtensionRow }) {
  const label = rowLabel(view.extensionName, row);
  const body = (
    <>
      {row.mark === null ? null : (
        <span className="shown-row-mark" data-tone={rowTone(row.mark.tone)} data-dot={row.mark.glyph === null ? "" : undefined} aria-hidden="true">
          {row.mark.glyph}
        </span>
      )}
      <span className="extension-section-text">{row.text}</span>
      {row.detail === "" ? null : <span className="shown-row-detail">{row.detail}</span>}
      {row.value === "" ? null : <span className="shown-row-value">{row.value}</span>}
    </>
  );
  return (
    <li data-testid="extension-section-row" data-row={row.id ?? undefined} data-buttons={row.buttons.length > 0 ? "" : undefined} className="extension-section-row">
      {row.id === null ? (
        <span aria-label={label} className="extension-section-body">
          {body}
        </span>
      ) : (
        <button type="button" data-testid="extension-section-press" aria-label={label} className="extension-section-body" onClick={() => pressRow(view.extensionId, "sidebar", view.spaceId, row.id, null)}>
          {body}
        </button>
      )}
      {row.buttons.map((button) => (
        <button
          key={button.id}
          type="button"
          data-testid="extension-section-button"
          data-action={button.id}
          className="extension-status-action"
          onClick={() => pressRow(view.extensionId, "sidebar", view.spaceId, row.id, button.id)}
        >
          {button.title}
        </button>
      ))}
    </li>
  );
}
