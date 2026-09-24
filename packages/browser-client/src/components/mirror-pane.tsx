"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot } from "lucide-react";
import { mirrorSurfaceSource, mirrorClientMessageSchema, type HostToSurface, type SurfaceToHost, type UnsuitableReason, type AssetFailure } from "@pistachio/dom-mirror";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { PaneWaiting, useShellControl } from "./streamed-pane";
import { PaneContextMenu } from "./stream-capabilities";
import type { WsShellApi } from "../lib/shell-socket";

/** The iframe has an opaque origin: it cannot access shell DOM, storage or
 * credentials. Its only connection is a private MessagePort owned here. */
export function MirrorPane({ active, api, tab, onFallback, onMediaChange, onEditor, onAssetStatus }: {
  onMediaChange: (count: number) => void;
  onAssetStatus: (status: { count: number; failure?: AssetFailure }) => void;
  onEditor: (request: { epoch: number; id: number; point?: { fx: number; fy: number; modifiers: number } }) => void;
  active: boolean; api: WsShellApi; tab: BrowserTabInfo; onFallback: (reason: UnsuitableReason | "timeout", detail?: string) => void;
}): ReactNode {
  const control = useShellControl(api);
  const human = control.holder === "human";
  const surface = useRef<HTMLDivElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const state = useRef({ human, active });
  state.current = { human, active };
  const [painted, setPainted] = useState(false);
  const [interaction, setInteraction] = useState(0);
  const menuPoint = useRef<{ x: number; y: number } | null>(null);
  const tabId = tab.id;

  useEffect(() => {
    port.current?.postMessage({ kind: "state", human, active } satisfies HostToSurface);
  }, [human, active]);

  useEffect(() => {
    const element = iframe.current;
    if (!element) return;
    let disposed = false;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stage: "surface" | "snapshot" | "paint" = "surface";
    let didPaint = false;
    let connectedOnce = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const armWatchdog = (): void => {
      clearTimeout(watchdog); clearTimeout(retry);
      retry = setTimeout(() => {
        if (disposed || didPaint || !ready || stage !== "snapshot") return;
        // The cloud may have sent its snapshot before a reconnecting surface
        // could receive it. Request one replacement; keep the original deadline.
        console.debug("[mirror] Retrying a missing initial snapshot");
        api.mirror(tabId, { k: "resync" });
      }, 3_000);
      watchdog = setTimeout(() => { if (!disposed) onFallback("timeout", `timeout-${stage}`); }, 15_000);
    };
    armWatchdog();
    const post = (message: HostToSurface): void => { if (!disposed && ready) port.current?.postMessage(message); };
    const report = (): void => {
      if (!ready || disposed) return;
      const box = surface.current?.getBoundingClientRect();
      if (!box || box.width < 1 || box.height < 1) return;
      api.pane(tabId, { width: Math.round(box.width), height: Math.round(box.height), dpr: window.devicePixelRatio, visible: true, renderer: "dom", hybridMedia: true });
    };
    const boot = (): void => {
      if (disposed) return;
      if (connectedOnce) { stage = "surface"; didPaint = false; setPainted(false); armWatchdog(); }
      ready = false;
      port.current?.close();
      const channel = new MessageChannel();
      port.current = channel.port1;
      channel.port1.onmessage = (event: MessageEvent<SurfaceToHost>): void => {
        if (disposed || port.current !== channel.port1) return;
        const message = event.data;
        if (message.kind === "ready") {
          ready = true; stage = "snapshot";
          post({ kind: "state", ...state.current });
          report();
          // An iframe reboot loses its document while pane geometry stays the
          // same. The socket memoizes that geometry, so request a fresh tree.
          if (connectedOnce) api.mirror(tabId, { k: "resync" });
          connectedOnce = true;
        } else if (message.kind === "snapshot-received") stage = "paint";
        else if (message.kind === "painted") {
          didPaint = true; clearTimeout(watchdog); clearTimeout(retry); setPainted(true);
        } else if (message.kind === "asset-status") onAssetStatus(message);
        else if (message.kind === "media") onMediaChange(message.count);
        else if (message.kind === "editor") onEditor(message);
        else if (message.kind === "fallback") onFallback(message.reason, message.detail);
        else if (message.kind === "input") {
          const parsed = mirrorClientMessageSchema.safeParse(message.message);
          if (parsed.success) {
            if (parsed.data.k === "pointer" && parsed.data.type === "mousePressed") {
              setInteraction(value => value + 1);
              const box = element.getBoundingClientRect();
              menuPoint.current = { x: box.left + parsed.data.x, y: box.top + parsed.data.y };
            }
            api.mirror(tabId, parsed.data);
          }
        }
      };
      channel.port1.start();
      // An opaque origin requires '*'. The port is sent only to this iframe's
      // WindowProxy; replies arrive on that port, never on window messages.
      element.contentWindow?.postMessage("pistachio:mirror-connect", "*", [channel.port2]);
    };
    const offMirror = api.onMirror(tabId, message => {
      if (message.k === "stopped") {
        stage = "snapshot";
        if (didPaint) { didPaint = false; setPainted(false); armWatchdog(); }
      }
      post({ kind: "mirror", message });
    });
    const offAsset = api.onAsset(tabId, asset => post({ kind: "asset", ...asset }));
    const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(report, 100); });
    if (surface.current) observer.observe(surface.current);
    element.addEventListener("load", boot);
    const url = api.surfaceUrl("mirror");
    if (url) element.src = url;
    else element.srcdoc = mirrorSurfaceSource(crypto.randomUUID(), api.mediaOrigin());
    return () => {
      disposed = true;
      clearTimeout(timer); clearTimeout(watchdog); clearTimeout(retry); observer.disconnect();
      element.removeEventListener("load", boot);
      offMirror(); offAsset(); port.current?.close(); port.current = null;
      api.releasePane(tabId);
    };
  }, [api, tabId, onFallback, onMediaChange, onEditor, onAssetStatus]);

  return (
    <div ref={surface} role="region" aria-label={`${tab.title.trim() || "Untitled page"} — ${tab.url}`}
      aria-busy={!painted} data-testid={`mirror-pane-${tabId}`} data-mirror-pane={tabId}
      data-control={control.holder} data-painted={painted ? "1" : "0"}
      className="absolute inset-0 overflow-hidden bg-background-100">
      <iframe ref={iframe} title={tab.title || "The page in this tab"} sandbox="allow-scripts"
        className={`size-full border-0${human ? "" : " pointer-events-none"}`} />
      <PaneContextMenu api={api} tabId={tabId} surface={surface} anchor={menuPoint} interaction={interaction} />
      {painted ? null : <PaneWaiting tab={tab} testId="mirror-pane-waiting" className="absolute inset-0" />}
      {human ? null : <div className="pa-pane-veil" role="status" aria-live="polite" data-testid="mirror-pane-veil">
        <p className="flex items-center gap-2 rounded-md bg-background-100 px-3 py-2 text-copy-13 text-gray-1000 shadow-modal">
          <Bot className="size-4 shrink-0 text-blue-900" aria-hidden="true" />The agent is working in this tab. Take control to type or click.
        </p>
      </div>}
    </div>
  );
}
