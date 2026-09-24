/** The trusted controller runs in an opaque-origin sandbox. Only the parent
 * that transfers the first MessagePort can drive it; site scripts never run. */
import { createEncodedMediaSurface } from "./media-source-surface.js";
import { createMediaSurface } from "./media-surface.js";
import { createMirrorRenderer, MIRROR_DOCUMENT_CSP, type MirrorRenderer } from "./renderer.js";
import type { MirrorClientMessage, MirrorServerMessage, UnsuitableReason, AssetFailure } from "./protocol.js";

export type SurfaceToHost = { kind: "asset-status"; count: number; failure?: AssetFailure } | { kind: "editor"; epoch: number; id: number; point?: { fx: number; fy: number; modifiers: number } } | { kind: "media"; count: number } | { kind: "ready" } | { kind: "snapshot-received" } | { kind: "painted" } | { kind: "fallback"; reason: UnsuitableReason; detail?: string }
  | { kind: "input"; message: MirrorClientMessage };
export type HostToSurface = { kind: "state"; human: boolean; active: boolean }
  | { kind: "mirror"; message: MirrorServerMessage }
  | { kind: "asset"; id: string; type: string; bytes: Uint8Array };

/** Self-contained, like the recorder: no captured module values. */
export function installMirrorSurface(factory: typeof createMirrorRenderer, mediaFactory: typeof createMediaSurface, encodedFactory: typeof createEncodedMediaSurface, mediaOrigin = ""): void {
  let port: MessagePort | null = null;
  let view: MirrorRenderer | null = null;
  let human = false;
  let active = false;
  let applying = false;
  let editorPending = false;
  let recovering = false;
  let revision = 0;
  let scrollFrame = 0;
  let moveFrame = 0;
  let move: PointerEvent | null = null;
  let held: Extract<MirrorClientMessage, { k: "pointer" }> | null = null;
  const edits = new Map<number, { rev: number; value: string }>();
  const changedFields = new Set<number>();
  const scrolls = new Map<number, { rev: number; x: number; y: number }>();
  const dirtyScrolls = new Map<number, Element | Document>();
  const remoteScrolls = new Map<number, { x: number; y: number }>();
  const requested = new Set<string>();
  const failedAssets = new Map<string, AssetFailure>();
  const assetStatus = (): void => emit({ kind: "asset-status", count: failedAssets.size, failure: [...failedAssets.values()].at(-1) });
  const urls = new Set<string>();
  const emit = (message: SurfaceToHost): void => port?.postMessage(message);
  const send = (message: MirrorClientMessage): void => emit({ kind: "input", message });
  const release = (): void => {
    if (held) send({ ...held, type: "mouseReleased" });
    held = null;
  };
  const epoch = (): number => view?.position("main")?.epoch ?? 0;
  let mediaCount = 0;
  const media = mediaFactory(encodedFactory, { origin: mediaOrigin, epoch, node: id => view?.nodeOf("main", id) ?? null, send,
    status: count => { if (mediaCount !== count) { mediaCount = count; emit({ kind: "media", count }); } },
    fail: () => emit({ kind: "fallback", reason: "video" }) });
  const modifiers = (event: MouseEvent | KeyboardEvent): number => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  const targetOf = (event: Event): Element | null => {
    for (const node of event.composedPath()) if (node instanceof Element && view?.idOf(node)) return node;
    return null;
  };
  const editorOf = (event: Event): Element | null => {
    for (const node of event.composedPath()) if (node instanceof Element && node.hasAttribute("data-pa-editor")) {
      return node.getAttribute("data-pa-editor") === "true" ? node : null;
    }
    return null;
  };
  const beginEditor = (event: Event): boolean => {
    if (event instanceof MouseEvent && event.button !== 0) return false;
    const editor = editorOf(event);
    const id = editor ? view?.idOf(editor)?.id : undefined;
    if (!human || !active || !epoch() || id === undefined) return false;
    event.preventDefault();
    if (editorPending) return true;
    editorPending = true;
    release();
    const box = editor!.getBoundingClientRect();
    const point = event instanceof MouseEvent && box.width > 0 && box.height > 0
      ? { fx: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), fy: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)), modifiers: modifiers(event) } : undefined;
    emit({ kind: "editor", epoch: epoch(), id, ...(point ? { point } : {}) });
    return true;
  };
  document.addEventListener("focusin", event => { if (!applying) beginEditor(event); }, true);
  const fieldOf = (element: Element | null): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null => {
    if (!element) return null;
    if (element.localName === "textarea" || element.localName === "select") return element as HTMLTextAreaElement;
    if (element.localName === "input" && !["checkbox", "radio", "file", "submit", "button", "reset", "image"].includes((element as HTMLInputElement).type)) return element as HTMLInputElement;
    return null;
  };
  const requestAssets = (): void => {
    const ids = view?.pendingAssets().filter(id => !requested.has(id)) ?? [];
    for (let at = 0; at < ids.length; at += 256) {
      const batch = ids.slice(at, at + 256);
      batch.forEach(id => requested.add(id));
      send({ k: "need", ids: batch, transport: "http" });
    }
  };
  const reset = (): void => {
    release();
    cancelAnimationFrame(moveFrame); cancelAnimationFrame(scrollFrame);
    moveFrame = 0; scrollFrame = 0; move = null;
    media.reset();
    view?.dispose();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear(); requested.clear(); edits.clear(); scrolls.clear(); dirtyScrolls.clear(); remoteScrolls.clear();
    changedFields.clear(); failedAssets.clear(); assetStatus();
  };
  const readonly = (): void => {
    document.documentElement.inert = !human;
    if (!human) (document.activeElement as HTMLElement | null)?.blur?.();
  };
  const receive = (event: MessageEvent<HostToSurface>): void => {
    const data = event.data;
    if (data.kind === "state") {
      const changed = human !== data.human;
      human = data.human; active = data.active;
      readonly();
      if (changed && view) { edits.clear(); scrolls.clear(); send({ k: "resync" }); }
      return;
    }
    if (data.kind === "asset") {
      if (!requested.has(data.id) || !view) return;
      const css = data.type === "text/css" ? new TextDecoder().decode(data.bytes) : null;
      const url = css === null ? URL.createObjectURL(new Blob([data.bytes as BlobPart], { type: data.type })) : "";
      if (url) urls.add(url);
      view.resolveAsset(data.id, url, data.type, css);
      if (failedAssets.delete(data.id)) assetStatus();
      requestAssets(); return;
    }
    if (data.kind !== "mirror") return;
    const message = data.message;
    applying = true;
    try {
      if (message.k === "snapshot") {
        emit({ kind: "snapshot-received" });
        reset(); recovering = false;
        view = factory({ document, mediaOrigin, mayFocus: () => active && human && !editorPending,
          mayApplyValue: (_frame, id, element) => !edits.has(id) && !(element.localName === "input" && (element as HTMLInputElement).type === "password"),
          mayApplyScroll: (_frame, id) => !scrolls.has(id) });
        view.applySnapshot(message); readonly(); requestAssets();
        send({ k: "ack", frame: message.frame, epoch: message.epoch, seq: message.seq });
        emit({ kind: "painted" });
      } else if (message.k === "patch") {
        for (const op of message.ops) if (op.o === "scroll" && !scrolls.has(op.id)) remoteScrolls.set(op.id, { x: op.x, y: op.y });
        const result = view?.applyPatch(message) ?? "unknown";
        if (result === "gap" || result === "unknown") {
          if (!recovering) { recovering = true; send({ k: "resync" }); }
        } else if (result === "ok") { requestAssets(); send({ k: "ack", frame: message.frame, epoch: message.epoch, seq: message.seq }); }
      } else if (message.k === "media") media.state(message.epoch, message.items);
      else if (message.k === "mediaData") media.data(message.epoch, message.batch);
      else if (message.k === "mediaAck") { if (message.epoch === epoch()) media.ack(message.id, message.rev, message.ok); }
      else if (message.k === "edited") {
        if (message.epoch !== epoch() || edits.get(message.id)?.rev !== message.rev) return;
        const field = fieldOf(view?.nodeOf("main", message.id) as Element | null);
        if (field && field.value !== message.v) {
          const start = "selectionStart" in field ? field.selectionStart : null;
          const end = "selectionEnd" in field ? field.selectionEnd : null;
          field.value = message.v;
          if (start !== null && end !== null && "setSelectionRange" in field) {
            try { field.setSelectionRange(start, end); } catch { /* non-text input */ }
          }
        }
        edits.delete(message.id);
      } else if (message.k === "scrolled") {
        if (message.epoch === epoch() && scrolls.get(message.id)?.rev === message.rev) scrolls.delete(message.id);
      } else if (message.k === "assetMissing") {
        if (!view || !requested.has(message.id) || !view.pendingAssets().includes(message.id)) return;
        const failure = message.failure ?? { reason: "unknown" };
        // A source-side failure is already present in the real page. Pixels
        // cannot restore it. Only a required sheet lost by our transport merits fallback.
        const critical = failure.reason !== "source-http" && failure.reason !== "source-network" && view.needsStylesheet(message.id);
        view.assetMissing(message.id);
        failedAssets.set(message.id, failure); assetStatus();
        if (critical) emit({ kind: "fallback", reason: "asset", detail: `asset-${failure.reason}` });
      } else if (message.k === "unsuitable") emit({ kind: "fallback", reason: message.reason, detail: message.detail });
      else if (message.k === "stopped") { reset(); view = null; }
    } finally { applying = false; }
  };
  // Only this parent can hand us a port, and only once. No general window-message API remains.
  const connect = (event: MessageEvent): void => {
    if (port || event.source !== parent || event.data !== "pistachio:mirror-connect" || !event.ports[0]) return;
    window.removeEventListener("message", connect);
    port = event.ports[0];
    port.onmessage = event => {
      try { receive(event); }
      catch {
        // Report renderer exceptions immediately. Otherwise no "painted" arrives
        // and the parent misdiagnoses a local DOM error as a cloud timeout.
        const data = event.data as HostToSurface;
        const phase = data.kind === "asset" ? "asset" : data.kind === "mirror" && data.message.k === "patch" ? "patch" : "snapshot";
        emit({ kind: "fallback", reason: "error", detail: `surface-${phase}` });
      }
    };
    port.start(); emit({ kind: "ready" });
  };
  window.addEventListener("message", connect);

  const pointer = (event: PointerEvent, type: "mousePressed" | "mouseReleased" | "mouseMoved"): void => {
    if (!human || !epoch()) return;
    const target = targetOf(event);
    if (media.native(target)) return;
    if (!target || target.closest("select")) { if (type === "mouseReleased") release(); return; }
    const id = view!.idOf(target)!.id;
    const box = target.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const button = event.button === 0 ? "left" : event.button === 1 ? "middle" : event.button === 2 ? "right" : "none";
    const message: Extract<MirrorClientMessage, { k: "pointer" }> = { k: "pointer", frame: "main", epoch: epoch(), id, type,
      fx: Math.max(-1, Math.min(2, (event.clientX - box.left) / box.width)), fy: Math.max(-1, Math.min(2, (event.clientY - box.top) / box.height)),
      x: event.clientX, y: event.clientY, button, clickCount: Math.min(8, type === "mouseMoved" ? 0 : Math.max(1, event.detail)), modifiers: modifiers(event) };
    if (type === "mousePressed") held = message;
    if (type === "mouseReleased") held = null;
    send(message);
  };
  document.addEventListener("pointerdown", event => { if (!beginEditor(event)) pointer(event, "mousePressed"); }, true);
  document.addEventListener("pointerup", event => pointer(event, "mouseReleased"), true);
  document.addEventListener("pointercancel", release, true);
  document.addEventListener("pointerout", event => { if (event.relatedTarget === null) release(); }, true);
  window.addEventListener("blur", release);
  document.addEventListener("pointermove", event => {
    move = event;
    if (!moveFrame) moveFrame = requestAnimationFrame(() => { moveFrame = 0; if (move) pointer(move, "mouseMoved"); });
  }, true);
  const key = (event: KeyboardEvent, type: "keyDown" | "keyUp"): void => {
    if (!human || !epoch() || event.isComposing) return;
    const target = targetOf(event);
    const field = fieldOf(target);
    if (media.native(target)) return;
    // Native selection, editing, clipboard, IME and focus traversal are local.
    if (event.key === "Tab") return;
    if (field && (event.key !== "Enter" || field.localName === "textarea" || field.localName === "select")) return;
    if ((event.metaKey || event.ctrlKey) && ["a", "c", "v", "x"].includes(event.key.toLowerCase())) return;
    if (event.key === "Enter") event.preventDefault();
    const text = event.key.length === 1 ? event.key : event.key === "Enter" ? "\r" : undefined;
    send({ k: "key", frame: "main", epoch: epoch(), id: target ? view!.idOf(target)!.id : null,
      event: { kind: "key", type, key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: modifiers(event),
        ...(type === "keyDown" && !event.metaKey && !event.ctrlKey && text !== undefined ? { text } : {}) } });
  };
  document.addEventListener("keydown", event => key(event, "keyDown"), true);
  document.addEventListener("keyup", event => key(event, "keyUp"), true);
  const edit = (event: Event, commit: boolean): void => {
    if (!human || applying || !epoch()) return;
    const field = fieldOf(targetOf(event));
    if (!field) return;
    const id = view!.idOf(field)!.id;
    if (commit) { if (!changedFields.delete(id)) return; }
    else if (field.localName !== "select") changedFields.add(id);
    const rev = ++revision;
    edits.set(id, { rev, value: field.value });
    send({ k: "edit", frame: "main", epoch: epoch(), id, rev, v: field.value,
      s: "selectionStart" in field ? field.selectionStart : null, e: "selectionEnd" in field ? field.selectionEnd : null,
      ...(commit ? { commit: true } : {}) });
  };
  document.addEventListener("input", event => edit(event, false), true);
  document.addEventListener("focusout", event => edit(event, true), true);
  document.addEventListener("scroll", event => {
    if (!human || applying || !epoch()) return;
    const target = event.target === document ? document : targetOf(event);
    if (!target) return;
    const id = view!.idOf(target)?.id;
    if (id === undefined) return;
    dirtyScrolls.set(id, target);
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      for (const [id, target] of dirtyScrolls) {
        const element = target === document ? document.scrollingElement : target as Element;
        if (!element) continue;
        const x = element.scrollLeft, y = element.scrollTop;
        const remote = remoteScrolls.get(id);
        remoteScrolls.delete(id);
        if (remote?.x === x && remote.y === y) continue;
        const last = scrolls.get(id);
        if (last?.x === x && last.y === y) continue;
        const rev = ++revision; scrolls.set(id, { rev, x, y });
        send({ k: "scroll", frame: "main", epoch: epoch(), id, rev, x, y });
      }
      dirtyScrolls.clear();
    });
  }, true);
  document.addEventListener("click", event => {
    const target = targetOf(event);
    // Cloud input owns activation and navigation; the local document only edits fields.
    if (!human || target?.closest("a, area, button, input[type=submit], input[type=image], input[type=file]")) event.preventDefault();
  }, true);
  document.addEventListener("auxclick", event => event.preventDefault(), true);
  document.addEventListener("submit", event => event.preventDefault(), true);
  document.addEventListener("contextmenu", event => event.preventDefault(), true);
  window.addEventListener("pagehide", () => { reset(); port?.close(); });
}

export function mirrorSurfaceSource(nonce: string, mediaOrigin = ""): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(nonce)) throw new Error("Invalid renderer nonce");
  const script = `(()=>{const __name=(f)=>f;(${installMirrorSurface.toString()})(${createMirrorRenderer.toString()},${createMediaSurface.toString()},${createEncodedMediaSurface.toString()},${JSON.stringify(mediaOrigin ? new URL(mediaOrigin).origin : "")});})();`.replace(/<\/script/giu, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MIRROR_DOCUMENT_CSP.replace("media-src blob: data:", `media-src blob: data: ${mediaOrigin ? new URL(mediaOrigin).origin : ""}`)}; script-src 'nonce-${nonce}'"><script nonce="${nonce}">${script}</script></head><body></body></html>`;
}
