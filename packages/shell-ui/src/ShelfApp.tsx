/**
 * The desk's parked windows over a live page (docs/desk.md, "The foot"): a
 * utility chrome view of its own (main/chrome-view.ts, id "shelf"), because
 * a tab's view paints over everything the shell draws — the parked windows'
 * frames too — and the windows under the shelf are to keep their whole
 * pages, not to be cut short of it. The shell says where the parked windows
 * stand and what each shows (DeskSurface → main) while a live page is under
 * them; each is drawn here as the shell draws it at rest — its frame, its
 * title bar dimmed as a window not in use, the picture of its page — and
 * cut off at the desk's foot by the view's own edge. The pointer onto one
 * raises it, as onto its frame (DeskEngine.hoverMini); once it has risen,
 * over the page, the shell draws it, and this view goes.
 */

import { useEffect, useState } from "react";
import type { DeskShelfFrame } from "@pistachio/shell-contracts/desk";
import { nativeApi } from "./api";
import { Favicon } from "./components/Favicon";

export function ShelfApp() {
  const [frame, setFrame] = useState<DeskShelfFrame | null>(null);

  useEffect(() => {
    const api = nativeApi();
    if (api === null) return;
    let active = true;
    let heard = false;
    void api.getDeskShelf().then((next) => {
      // A change that arrived while this was in flight is the newer word.
      if (active && !heard) setFrame(next);
    });
    const off = api.onDeskShelf((next) => {
      heard = true;
      setFrame(next);
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  if (frame === null) return null;
  const { insets } = frame;
  return (
    <div className="desk-shelf-view">
      {frame.windows.map((window) => (
        <div
          key={window.tabId}
          role="group"
          aria-label={window.title}
          data-testid="desk-shelf-window"
          data-tab-id={window.tabId}
          className="desk-shelf-window"
          style={{ left: window.x, top: frame.pad, width: window.width, height: window.height }}
          onPointerEnter={() => nativeApi()?.sendDeskShelfInput({ tabId: window.tabId, over: true })}
          onPointerLeave={() => nativeApi()?.sendDeskShelfInput({ tabId: window.tabId, over: false })}
        >
          <div className="desk-shelf-window-bar" style={{ height: insets.top }}>
            <Favicon src={window.faviconUrl} seed={window.host || window.title} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate font-medium text-gray-1000">{window.title}</span>
            {window.host !== "" && window.host !== window.title ? <span className="desk-window-host min-w-0 shrink-[2] truncate">{window.host}</span> : null}
          </div>
          <div className="desk-shelf-window-page" style={{ top: insets.top, left: insets.left, right: insets.right }}>
            {window.still === null ? null : <img src={window.still} alt="" draggable={false} />}
          </div>
        </div>
      ))}
    </div>
  );
}
