import { useEffect, type CSSProperties } from "react";
import { tabSwitcherIndex } from "@pistachio/shell-contracts/tab-switcher";
import { cn } from "../lib/cn";
import { displayHost } from "../lib/url";
import { useAppStore } from "../store";
import { TabMark } from "./Favicon";
import { shellApi } from "../api";

type SwitcherStyle = CSSProperties & {
  "--tab-switcher-count": number;
  "--tab-switcher-width": string;
};

/**
 * Control–Tab's transient MRU palette. Main owns the order and screenshots;
 * this shell owns only the held-key selection and the visual transition.
 */
export function TabSwitcher() {
  const open = useAppStore((state) => state.overlay === "tab-switcher");
  const previews = useAppStore((state) => state.tabSwitcherPreviews);
  const offset = useAppStore((state) => state.tabSwitcherOffset);
  const loading = useAppStore((state) => state.tabSwitcherLoading);
  const finish = useAppStore((state) => state.finishTabSwitcher);
  const setIndex = useAppStore((state) => state.setTabSwitcherIndex);

  useEffect(
    () =>
      shellApi().onTabSwitcherInput((input) => {
        const state = useAppStore.getState();
        if (input.type === "step") void state.stepTabSwitcher(input.reverse);
        else void state.finishTabSwitcher(input.type === "commit");
      }),
    [],
  );

  if (!open) return null;

  const itemCount = loading ? 5 : previews.length;
  const selected = tabSwitcherIndex(offset, previews.length);
  const style: SwitcherStyle = {
    "--tab-switcher-count": itemCount,
    "--tab-switcher-width": `${Math.min(1120, 44 + itemCount * 210)}px`,
  };

  return (
    <div
      className="tab-switcher-stage no-drag fixed inset-0 z-80 grid place-items-center px-7"
      data-testid="tab-switcher"
      onPointerDown={() => void finish(false)}
    >
      <div
        role="dialog"
        aria-label="Recent tabs"
        aria-live="polite"
        className="tab-switcher-panel"
        style={style}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div role="listbox" aria-label="Five most recently visited tabs" className="tab-switcher-grid">
          {loading
            ? Array.from({ length: 5 }, (_, index) => <TabPreviewSkeleton key={index} />)
            : previews.map((preview, index) => {
                const active = index === selected;
                const host = displayHost(preview.tab.url) || preview.tab.title;
                return (
                  <button
                    key={preview.tab.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    aria-label={preview.tab.title || host}
                    data-testid="tab-switcher-option"
                    data-tab-id={preview.tab.id}
                    className={cn("tab-switcher-option", active && "is-selected")}
                    // The pointer reports many moves over one card; only a
                    // change of selection is worth a store write.
                    onPointerMove={() => {
                      if (index !== selected) setIndex(index);
                    }}
                    onClick={() => void finish(true, preview.tab.id)}
                  >
                    <span className="tab-switcher-thumbnail">
                      {preview.dataUrl === null ? (
                        <span className="tab-switcher-fallback" aria-hidden="true">
                          <TabMark tab={preview.tab} />
                          <span>{host}</span>
                        </span>
                      ) : (
                        <img src={preview.dataUrl} alt="" draggable={false} />
                      )}
                    </span>
                    <span className="tab-switcher-label">
                      <TabMark tab={preview.tab} />
                      <span>{preview.tab.title || host}</span>
                    </span>
                  </button>
                );
              })}
        </div>
      </div>
    </div>
  );
}

function TabPreviewSkeleton() {
  return (
    <div className="tab-switcher-option tab-switcher-skeleton" aria-hidden="true">
      <span className="tab-switcher-thumbnail" />
      <span className="tab-switcher-label">
        <span className="size-4 rounded-sm bg-alpha-200" />
        <span className="h-3 w-3/5 rounded-full bg-alpha-200" />
      </span>
    </div>
  );
}
