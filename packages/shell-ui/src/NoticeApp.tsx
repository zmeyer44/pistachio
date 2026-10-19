/**
 * The notice stack over the page: a utility chrome view of its own
 * (main/chrome-view.ts, id "notice"), because the tab views sit above the
 * shell page and a card drawn there would never be seen — and because a
 * notice in the chrome went wherever the chrome went, out of sight with a
 * hidden compact sidebar. Main feeds it the shell's live notices and parks
 * it in the browser surface, at the edge or corner Settings → Appearance
 * names (main/notice-layer.ts); the clicks
 * go back the same way, to the store that owns the notices. It tells main
 * where its cards are drawn, with the size of the view that was measured
 * in: what of the window the stack covers, which a live share's outlines go
 * under (docs/live-share.md §6.3).
 */

import { useCallback, useEffect, useState } from "react";
import { EMPTY_NOTICE_STACK, type NoticeEvent, type NoticeStackState } from "@pistachio/shell-contracts/notice";
import { nativeApi } from "./api";
import { NoticeStack } from "./components/NoticeStack";
import type { NoticeBox } from "./lib/notices";

export function NoticeApp() {
  const [stack, setStack] = useState<NoticeStackState>(EMPTY_NOTICE_STACK);

  useEffect(() => {
    const api = nativeApi();
    if (api === null) return;
    let active = true;
    let heard = false;
    void api.getNotices().then((next) => {
      // A change that arrived while this was in flight is the newer word.
      if (active && !heard) setStack(next);
    });
    const off = api.onNotices((next) => {
      heard = true;
      setStack(next);
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  const onEvent = useCallback((event: NoticeEvent) => nativeApi()?.sendNoticeEvent(event), []);
  const onMeasure = useCallback((height: number) => nativeApi()?.resizeNoticeView(height), []);
  const onFootprint = useCallback(
    (box: NoticeBox | null) =>
      nativeApi()?.setNoticeFootprint(box === null ? null : { box: { x: box.x, y: box.y, width: box.w, height: box.h }, view: { width: window.innerWidth, height: window.innerHeight } }),
    [],
  );

  return (
    <div className="notice-layer" data-surface="native">
      <NoticeStack items={stack.items} position={stack.position} onEvent={onEvent} onMeasure={onMeasure} onFootprint={onFootprint} />
    </div>
  );
}
