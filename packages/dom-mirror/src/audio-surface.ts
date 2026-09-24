import { createEncodedMediaSurface } from "./media-source-surface.js";
import { createMediaSurface } from "./media-surface.js";
import type { MirrorServerMessage } from "./protocol.js";

export type AudioSurfaceReport = { kind: "ready" } | { kind: "audio"; count: number; blocked: boolean; unavailable: boolean };

/** An opaque, media-only receiver. Page markup and scripts never run here. */
function installAudioSurface(factory: typeof createMediaSurface, encoded: typeof createEncodedMediaSurface, origin: string): void {
  let port: MessagePort | null = null;
  let epoch = 0;
  let count = 0;
  let blocked = false;
  let unavailable = false;
  const nodes = new Map<number, HTMLAudioElement>();
  const report = (): void => port?.postMessage({ kind: "audio", count, blocked, unavailable } satisfies AudioSurfaceReport);
  const media = factory(encoded, { origin, epoch: () => epoch, node: id => nodes.get(id) ?? null,
    commands: false, send: () => undefined, enableLabel: "Enable audio",
    status: value => { count = value; report(); }, blocked: value => { blocked = value; report(); },
    fail: () => { unavailable = true; report(); },
  });
  const reset = (): void => { media.reset(); for (const node of nodes.values()) node.remove(); nodes.clear(); unavailable = false; report(); };
  const receive = (event: MessageEvent<MirrorServerMessage>): void => {
    const message = event.data;
    if (message.k === "snapshot") { reset(); epoch = message.epoch; }
    else if (message.k === "stopped") { reset(); epoch = 0; }
    else if (message.k === "media" && message.epoch === epoch) {
      const live = new Set(message.items.map(item => item.id));
      for (const [id, node] of nodes) if (!live.has(id)) { node.remove(); nodes.delete(id); }
      for (const item of message.items) if (!nodes.has(item.id)) {
        const node = document.createElement("audio"); node.hidden = true;
        nodes.set(item.id, node); document.body.appendChild(node);
      }
      media.state(epoch, message.items);
    } else if (message.k === "mediaData" && message.epoch === epoch) media.data(epoch, message.batch);
  };
  const connect = (event: MessageEvent): void => {
    if (port || event.source !== parent || event.data !== "pistachio:audio-connect" || !event.ports[0]) return;
    window.removeEventListener("message", connect);
    port = event.ports[0]; port.onmessage = receive; port.start(); port.postMessage({ kind: "ready" } satisfies AudioSurfaceReport);
  };
  window.addEventListener("message", connect);
  window.addEventListener("pagehide", () => { reset(); port?.close(); });
}

export function audioSurfaceSource(nonce: string, mediaOrigin: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(nonce)) throw new Error("Invalid audio nonce");
  const origin = new URL(mediaOrigin).origin;
  const script = `(()=>{const __name=(f)=>f;(${installAudioSurface.toString()})(${createMediaSurface.toString()},${createEncodedMediaSurface.toString()},${JSON.stringify(origin)});})();`.replace(/<\/script/giu, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src blob: ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><script nonce="${nonce}">${script}</script></head><body></body></html>`;
}
