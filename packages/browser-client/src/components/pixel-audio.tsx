"use client";

import { useEffect, useRef, useState } from "react";
import { audioSurfaceSource, type AudioSurfaceReport } from "@pistachio/dom-mirror";
import type { WsShellApi } from "../lib/shell-socket";

/** Audio has its own lifetime while the page is painted by the pixel feed. */
export function PixelAudio({ api, tabId, onReady, onMediaChange }: {
  api: WsShellApi; tabId: string; onReady(ready: boolean): void; onMediaChange?(count: number): void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [blocked, setBlocked] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const element = iframe.current;
    if (!element) return;
    let port: MessagePort | null = null;
    let ready = false;
    let disposed = false;
    const boot = () => {
      if (disposed) return;
      ready = false; onReady(false); port?.close();
      const channel = new MessageChannel(); port = channel.port1;
      port.onmessage = (event: MessageEvent<AudioSurfaceReport>) => {
        if (disposed || port !== channel.port1) return;
        if (event.data.kind === "ready") { ready = true; onReady(true); }
        else if (event.data.kind === "audio") {
          setBlocked(event.data.blocked); setUnavailable(event.data.unavailable);
          onMediaChange?.(event.data.count);
        }
      };
      port.start(); element.contentWindow?.postMessage("pistachio:audio-connect", "*", [channel.port2]);
    };
    const off = api.onMirror(tabId, message => { if (ready) port?.postMessage(message); });
    element.addEventListener("load", boot);
    const url = api.surfaceUrl("audio");
    if (url) element.src = url;
    else element.srcdoc = audioSurfaceSource(crypto.randomUUID(), api.mediaOrigin());
    return () => { disposed = true; ready = false; off(); element.removeEventListener("load", boot); port?.close(); onReady(false); onMediaChange?.(0); };
  }, [api, tabId, onReady, onMediaChange]);
  return <>
    <iframe ref={iframe} title="Pixel fallback audio" sandbox="allow-scripts" allow="autoplay"
      data-pixel-audio={tabId} tabIndex={blocked ? 0 : -1} aria-hidden={!blocked}
      className={blocked ? "absolute bottom-0 left-1/2 z-20 h-20 w-72 -translate-x-1/2 border-0" : "pointer-events-none absolute size-px opacity-0"} />
    {unavailable ? <p role="status" className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-background-100 px-3 py-2 text-label-12 text-gray-900 shadow-modal">Audio is unavailable for this player.</p> : null}
  </>;
}
