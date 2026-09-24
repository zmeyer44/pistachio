import { useEffect, useState, type RefObject } from "react";
import type { LinkedCursor } from "@pistachio/shell-contracts/socket";
import type { WsShellApi } from "../lib/shell-socket";

export function useLinked(api: WsShellApi) {
  const [state, setState] = useState(api.linked);
  useEffect(() => { setState(api.linked); return api.onLinked(setState); }, [api]);
  return state;
}

export function LinkedControls({ api }: { api: WsShellApi }) {
  const state = useLinked(api);
  const following = state.enabled && state.controller !== api.viewerId;
  return <div role="group" aria-label="Linked devices" data-testid="linked-controls" style={{ position: "fixed", bottom: 16, right: 16, zIndex: 100, height: "auto", maxWidth: "calc(100vw - 32px)" }} className="flex items-center gap-3 rounded-lg border border-gray-400 bg-background-100 px-3 py-2 text-copy-13 text-gray-1000 shadow-modal">
    <span role="status">{following ? "Following your other device" : state.enabled ? "You’re controlling linked devices" : `${state.viewers.length} connected ${state.viewers.length === 1 ? "view" : "views"}`}</span>
    <button className="rounded px-2 py-1 hover:bg-gray-200 focus-visible:outline-2" onClick={() => api.link(following ? "take-control" : state.enabled ? "disable" : "enable")}>
      {following ? "Take control" : state.enabled ? "Unlink devices" : "Link devices"}
    </button>
  </div>;
}

export function RemoteCursor({ api, tabId, image }: { api: WsShellApi; tabId: string; image: RefObject<HTMLImageElement | null> }) {
  const [cursor, setCursor] = useState<LinkedCursor>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.onCursor(next => {
      clearTimeout(timer);
      setCursor(next?.tabId === tabId ? next : null);
      timer = setTimeout(() => setCursor(null), 2500);
    });
    return () => { off(); clearTimeout(timer); };
  }, [api, tabId]);
  const element = image.current;
  if (!cursor || !element || !api.following) return null;
  const rect = element.getBoundingClientRect();
  const parent = element.parentElement?.getBoundingClientRect();
  if (!parent) return null;
  return <svg aria-hidden="true" data-testid="linked-cursor" width="22" height="26" viewBox="0 0 22 26" style={{ position: "absolute", pointerEvents: "none", zIndex: 20, left: rect.left - parent.left + cursor.x * rect.width, top: rect.top - parent.top + cursor.y * rect.height }}>
    <path d="M2 2v20l5-5 4 8 4-2-4-8h8Z" fill="#2563eb" stroke="white" strokeWidth="2" />
  </svg>;
}
