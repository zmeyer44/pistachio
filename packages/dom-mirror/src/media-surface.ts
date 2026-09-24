import type { createEncodedMediaSurface, EncodedMediaSurface } from "./media-source-surface.js";
import type { MediaBatch, MediaAction, MediaState, MirrorClientMessage } from "./protocol.js";
export interface MediaSurface {
  state(epoch: number, items: MediaState[]): void;
  data(epoch: number, batch: MediaBatch): void;
  ack(id: number, rev: number, ok: boolean): void;
  native(target: Element | null): boolean;
  reset(): void;
}
/** Stringified into the trusted opaque surface; no imported runtime values. */
export function createMediaSurface(encodedFactory: typeof createEncodedMediaSurface, options: {
  origin: string;
  node(id: number): Node | null;
  epoch(): number;
  send(message: MirrorClientMessage): void;
  status(count: number): void;
  fail(): void;
  commands?: boolean;
  blocked?(value: boolean): void;
  enableLabel?: string;
}): MediaSurface {
  type Player = { element: HTMLMediaElement; state: MediaState; pending: number; pendingAt: number; epoch: number; encoded: EncodedMediaSurface | null; off(): void };
  const players = new Map<number, Player>();
  const blocked = new Set<HTMLMediaElement>();
  const starting = new WeakSet<HTMLMediaElement>();
  let revision = 0;
  let button: HTMLButtonElement | null = null;
  const report = (): void => options.status([...players.values()].filter(player => player.element.readyState >= 2).length);
  const play = (element: HTMLMediaElement): void => {
    if (starting.has(element)) return;
    starting.add(element);
    void element.play().then(() => { blocked.delete(element); if (!blocked.size) { button?.remove(); button = null; options.blocked?.(false); } }).catch(() => {
      if (!element.isConnected) return;
      blocked.add(element); options.blocked?.(true);
      if (button) return;
      button = document.createElement("button");
      button.textContent = options.enableLabel ?? "Enable audio & video";
      button.setAttribute("data-pa-enable-media", "");
      button.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;background:#fff;color:#111;border:1px solid #888;border-radius:8px;font:14px system-ui;cursor:pointer";
      button.onclick = () => { for (const media of blocked) play(media); };
      document.body.appendChild(button);
    }).finally(() => starting.delete(element));
  };
  const sync = (player: Player): void => {
    if (player.pending) return;
    const { element, state } = player;
    player.encoded?.duration(state.duration);
    element.muted = state.muted; element.volume = state.volume; element.playbackRate = state.rate;
    if (element.readyState && Math.abs(element.currentTime - state.time) > 0.75) element.currentTime = state.time;
    if (state.paused) { element.pause(); blocked.delete(element); if (!blocked.size) { button?.remove(); button = null; options.blocked?.(false); } }
    else if (element.paused) play(element);
  };
  const release = (id: number): void => {
    const player = players.get(id);
    if (!player) return;
    player.off(); player.encoded?.close(); blocked.delete(player.element); player.element.pause();
    player.element.removeAttribute("src"); player.element.load(); players.delete(id);
  };
  return {
    data: (epoch, batch) => {
      if (epoch !== options.epoch()) return;
      if (batch.failed) { options.fail(); return; }
      for (const player of players.values()) if (player.state.mse && player.state.source === batch.source) player.encoded?.append(batch.chunks);
    },
    native: target => target instanceof HTMLMediaElement && target.controls,
    ack: (id, rev, ok) => {
      const player = players.get(id);
      if (!player || player.pending !== rev) return;
      player.pending = 0;
      if (!ok) { sync(player); }
    },
    state: (epoch, items) => {
      if (epoch !== options.epoch()) return;
      const live = new Set(items.map(item => item.id));
      for (const id of players.keys()) if (!live.has(id)) release(id);
      for (const state of items) {
        if (state.unsupported) { options.fail(); continue; }
        const element = options.node(state.id);
        if (!(element instanceof HTMLMediaElement) || !element.isConnected) continue;
        const source = state.mse ? null : new URL(state.source, options.origin);
        if (source && (source.origin !== options.origin || !/^\/v1\/shell\/[^/]+\/media\/[A-Za-z0-9_-]+$/u.test(source.pathname))) { options.fail(); continue; }
        let player = players.get(state.id);
        if (!player || player.element !== element || player.state.source !== state.source) {
          release(state.id);
          const command = (value: MediaAction): void => {
            if (options.commands === false) return;
            const rev = ++revision;
            player!.pending = rev; player!.pendingAt = Date.now();
            options.send({ k: "media", frame: "main", epoch, id: state.id, rev, command: value });
          };
          const playback = (): void => {
            if (element.paused === player!.state.paused) return;
            command({ action: element.paused ? "pause" : "play" });
          };
          const seek = (): void => { if (Math.abs(element.currentTime - player!.state.time) > 0.05) command({ action: "seek", value: element.currentTime }); };
          const volume = (): void => {
            if (element.muted !== player!.state.muted) command({ action: "muted", value: element.muted });
            if (element.volume !== player!.state.volume) command({ action: "volume", value: element.volume });
          };
          const rate = (): void => { if (element.playbackRate !== player!.state.rate) command({ action: "rate", value: Math.max(0.25, Math.min(4, element.playbackRate)) }); };
          const ready = (): void => { sync(player!); report(); };
          const error = (): void => options.fail();
          const handlers = { play: playback, pause: playback, seeking: seek, volumechange: volume, ratechange: rate, loadedmetadata: ready, loadeddata: ready, error };
          const encoded = state.mse ? encodedFactory(options.fail) : null;
          if (state.mse && !encoded) { options.fail(); continue; }
          player = { element, state, epoch, encoded, pending: 0, pendingAt: 0, off: () => { for (const [name, handler] of Object.entries(handlers)) element.removeEventListener(name, handler); } };
          for (const [name, handler] of Object.entries(handlers)) element.addEventListener(name, handler);
          players.set(state.id, player);
          element.crossOrigin = "anonymous"; element.preload = "auto";
          element.setAttribute("playsinline", "");
          element.disableRemotePlayback = true;
          element.src = encoded?.url ?? source!.href;
        }
        if (player.pending && Date.now() - player.pendingAt > 3000) player.pending = 0;
        if (!player.pending) player.state = state;
        sync(player);
      }
      report();
    },
    reset: () => { for (const id of players.keys()) release(id); blocked.clear(); button?.remove(); button = null; options.blocked?.(false); report(); },
  };
}
