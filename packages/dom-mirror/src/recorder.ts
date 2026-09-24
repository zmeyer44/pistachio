/**
 * The recorder: what runs INSIDE the cloud page (docs/web-browser-design.md §16.2).
 *
 * It serializes the document once and then reports what changed — nodes,
 * attributes, text, form values, scroll positions, stylesheets, shadow
 * roots, canvases — through one binding the host exposed under a random
 * name. It runs the page's results, never the page's scripts: the renderer
 * on the other end rebuilds the document from these reports without a line
 * of the site's JavaScript.
 *
 * `MutationObserver` is the spine and not the whole skeleton. A field's
 * `value` is a property, not an attribute; a stylesheet a framework builds
 * with `insertRule` never shows in the `<style>` element's text; a scroll
 * position is not a mutation at all; a closed shadow root is only ever seen
 * by the hand that attached it; a canvas is pixels. Each of those has its
 * own hook below, installed when the document is created (before the site's
 * scripts run) so nothing is missed, and armed only when a viewer is
 * actually mirroring.
 *
 * THE WHOLE FILE IS ONE FUNCTION whose source is stringified into the page
 * (`mirrorRecorderSource`). It may not reference anything outside itself:
 * no imports, no module-level helpers. Types are fine — they compile away.
 * The host talks to it through the control object it installs under
 * `config.control`: `start()` returns the snapshot, `stop()` disarms,
 * `rect(id)` locates a node for a click, `setValue` applies an edit,
 * `focus`/`scrollTo` do what they say, and `idOf(node)` answers the parent
 * of a child frame.
 */

import { installMediaSourceRecorder, type MediaSourceRecorder } from "./media-recorder.js";
import type { MediaBatch, MediaState, MediaAction, MirrorNode, MirrorOp, RecorderReport, UnsuitableReason } from "./protocol.js";

export interface RecorderConfig {
  /** The hidden global the host drives (`start`, `stop`, `rect`, …). */
  control: string;
  /** The binding the host exposed; called with one `RecorderReport`. */
  binding: string;
}

/** What `start()` returns to the host, and what the control object exposes. */
export interface RecorderControl {
  start(epoch?: number, mediaOnly?: boolean): Extract<RecorderReport, { kind: "snapshot" }> | { kind: "unsuitable"; reason: UnsuitableReason; detail?: string };
  stop(epoch?: number): void;
  readonly epoch: number;
  readonly documentId: string;
  settle(): Promise<void>;
  value(id: number): string | null;
  recording(): boolean;
  rect(id: number): { x: number; y: number; w: number; h: number } | null;
  idOf(node: Node): number | null;
  activeId(): number | null;
  mediaState(): MediaState[];
  mediaData(source: string, after: number): MediaBatch | null;
  prepareMedia(id: number): boolean;
  mediaAction(id: number, command: MediaAction): Promise<boolean>;
  focus(id: number): boolean;
  focusEditor(id: number): boolean;
  setValue(id: number, value: string, start: number | null, end: number | null, commit?: boolean): boolean;
  scrollTo(id: number, x: number, y: number): boolean;
  /** Fetch a `blob:` URL the page holds and report its bytes; false when it cannot. */
  extractBlob(url: string): Promise<boolean>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function installMirrorRecorder(config: RecorderConfig, mediaFactory: () => MediaSourceRecorder = installMediaSourceRecorder): void {
  const win = globalThis as any;
  if (Object.getOwnPropertyDescriptor(win, config.control) !== undefined) return;

  const mediaSources = mediaFactory();
  const DOC_ID = 1;
  const MAX_NODES = 150_000;
  const MAX_OPS = 20_000;
  const MAX_STRING = 4 * 1024 * 1024;
  const FLUSH_GAP_MS = 16;
  const CANVAS_POLL_MS = 500;
  const SUITABILITY_POLL_MS = 2000;
  const MAX_CANVAS_SIDE = 4096;

  const doc = win.document as Document;
  const documentId = Array.from(win.crypto.getRandomValues(new Uint32Array(4))).join("-");
  let currentEpoch = 0;
  let reportChain: Promise<unknown> = Promise.resolve();

  /* ------------------------------ identities ------------------------------ */

  const ids = new WeakMap<Node, number>();
  const nodes = new Map<number, Node>();
  let nextId = DOC_ID + 1;
  ids.set(doc, DOC_ID);

  const idOf = (node: Node): number | null => ids.get(node) ?? null;
  const isLive = (node: Node): boolean => {
    const id = ids.get(node);
    return id !== undefined && nodes.get(id) === node;
  };
  const assign = (node: Node): number => {
    let id = ids.get(node);
    if (id === undefined) {
      id = nextId;
      nextId += 1;
      ids.set(node, id);
    }
    nodes.set(id, node);
    return id;
  };
  const forget = (node: Node): void => {
    const id = ids.get(node);
    if (id !== undefined && nodes.get(id) === node) nodes.delete(id);
    const root = shadowOf(node);
    if (root !== null) forgetSubtree(root);
    forgetSubtree(node);
  };
  const forgetSubtree = (node: Node): void => {
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      const id = ids.get(child);
      if (id !== undefined && nodes.get(id) === child) nodes.delete(id);
      const root = shadowOf(child);
      if (root !== null) forgetSubtree(root);
      forgetSubtree(child);
    }
  };

  /* -------------------------------- hooks -------------------------------- */

  /** Shadow roots by host, closed ones included: seen only at `attachShadow`. */
  const shadows = new WeakMap<Element, ShadowRoot>();
  const shadowOf = (node: Node): ShadowRoot | null =>
    node.nodeType === 1 ? (shadows.get(node as Element) ?? (node as Element).shadowRoot ?? null) : null;
  const canvasKinds = new WeakMap<HTMLCanvasElement, string>();
  // A viewer knows passwords it typed itself. Never edit a masked, prefilled
  // value as if the bullets were the original secret: use pixels in that case.
  let locallyEditedPasswords = new WeakMap<Element, string>();
  const dirtySheets = new Set<CSSStyleSheet>();
  const dirtyAdopted = new Set<Node>();
  let recording = false;

  const wrap = (proto: any, name: string, after: (self: any, args: unknown[], result: unknown) => void): void => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor === undefined || typeof descriptor.value !== "function") return;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(proto, name, {
      ...descriptor,
      value: function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this, args);
        try {
          after(this, args, result);
        } catch {
          /* the page's call must never fail because of the recorder */
        }
        return result;
      },
    });
  };
  const wrapSetter = (proto: any, name: string, after: (self: any) => void): void => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor === undefined || typeof descriptor.set !== "function") return;
    const set = descriptor.set;
    Object.defineProperty(proto, name, {
      ...descriptor,
      set: function (this: unknown, value: unknown) {
        set.call(this, value);
        try {
          after(this);
        } catch {
          /* as above */
        }
      },
    });
  };

  try {
    wrap(win.Element?.prototype, "attachShadow", (self: Element, _args, root) => {
      shadows.set(self, root as ShadowRoot);
      if (recording && isLive(self)) onShadowAttached(self, root as ShadowRoot);
    });
    for (const method of ["insertRule", "deleteRule", "replace", "replaceSync", "addRule", "removeRule"]) {
      wrap(win.CSSStyleSheet?.prototype, method, (self: CSSStyleSheet) => {
        if (recording) {
          dirtySheets.add(self);
          schedule();
        }
      });
    }
    // Grouping rules (`@media`, `@supports`) own their own insert/delete.
    for (const proto of [win.CSSGroupingRule?.prototype, win.CSSMediaRule?.prototype, win.CSSSupportsRule?.prototype]) {
      for (const method of ["insertRule", "deleteRule"]) {
        wrap(proto, method, (self: CSSRule) => {
          const sheet = self.parentStyleSheet;
          if (recording && sheet !== null) {
            dirtySheets.add(sheet);
            schedule();
          }
        });
      }
    }
    // `element.style.x = …` is an attribute mutation; `rule.style.x = …` is not.
    wrap(win.CSSStyleDeclaration?.prototype, "setProperty", (self: CSSStyleDeclaration) => noteDeclaration(self));
    wrap(win.CSSStyleDeclaration?.prototype, "removeProperty", (self: CSSStyleDeclaration) => noteDeclaration(self));
    wrapSetter(win.CSSStyleDeclaration?.prototype, "cssText", (self: CSSStyleDeclaration) => noteDeclaration(self));
    wrapSetter(win.HTMLInputElement?.prototype, "value", (self: Element) => noteValue(self));
    wrapSetter(win.HTMLInputElement?.prototype, "checked", (self: Element) => noteValue(self));
    wrapSetter(win.HTMLTextAreaElement?.prototype, "value", (self: Element) => noteValue(self));
    wrapSetter(win.HTMLSelectElement?.prototype, "value", (self: Element) => noteValue(self));
    wrapSetter(win.HTMLSelectElement?.prototype, "selectedIndex", (self: Element) => noteValue(self));
    wrapSetter(win.HTMLOptionElement?.prototype, "selected", (self: HTMLOptionElement) => {
      const select = self.closest("select");
      if (select !== null) noteValue(select);
    });
    wrapSetter(win.Document?.prototype, "adoptedStyleSheets", (self: Document) => noteAdopted(self));
    wrapSetter(win.ShadowRoot?.prototype, "adoptedStyleSheets", (self: ShadowRoot) => noteAdopted(self));
    wrap(win.HTMLCanvasElement?.prototype, "getContext", (self: HTMLCanvasElement, args) => {
      const kind = String(args[0] ?? "");
      if (!canvasKinds.has(self) || kind !== "2d") canvasKinds.set(self, kind);
    });
  } catch {
    /* a page that froze a prototype keeps its own counsel; the observers still run */
  }

  function noteDeclaration(declaration: CSSStyleDeclaration): void {
    if (!recording) return;
    const rule = (declaration as any).parentRule as CSSRule | null | undefined;
    if (rule != null && rule.parentStyleSheet !== null) {
      dirtySheets.add(rule.parentStyleSheet);
      schedule();
    }
    // An inline style's owner is caught by the attribute observer.
  }

  /* ------------------------------ serializing ----------------------------- */

  const bound = (value: string): string => (value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value);

  const sheetText = (sheet: CSSStyleSheet | null | undefined): string | null => {
    if (sheet == null) return null;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return null;
    }
    const parts: string[] = [];
    for (let at = 0; at < rules.length; at += 1) {
      const rule = rules[at];
      if (rule !== undefined) parts.push(rule.cssText);
    }
    return bound(parts.join("\n"));
  };

  const adoptedOf = (root: Document | ShadowRoot): string[] | undefined => {
    let sheets: CSSStyleSheet[];
    try {
      sheets = [...(root.adoptedStyleSheets ?? [])];
    } catch {
      return undefined;
    }
    if (sheets.length === 0) return undefined;
    return sheets.map((sheet) => sheetText(sheet) ?? "");
  };

  let counted = 0;
  class TooLarge extends Error {}

  const canvasData = (canvas: HTMLCanvasElement): string | null => {
    const kind = canvasKinds.get(canvas);
    if (kind !== undefined && kind !== "2d" && kind !== "bitmaprenderer") return null;
    if (canvas.width === 0 || canvas.height === 0) return null;
    if (canvas.width > MAX_CANVAS_SIDE || canvas.height > MAX_CANVAS_SIDE) return null;
    try {
      return canvas.toDataURL("image/webp", 0.6);
    } catch {
      return null;
    }
  };

  const serializeAttributes = (element: Element): Record<string, string> | undefined => {
    const attrs = element.attributes;
    if (attrs.length === 0) return undefined;
    const out: Record<string, string> = {};
    for (let at = 0; at < attrs.length; at += 1) {
      const attribute = attrs[at];
      if (attribute === undefined) continue;
      const name = attribute.name;
      if (name.startsWith("on") || name === "srcdoc") continue;
      out[name] = bound(attribute.value);
    }
    return out;
  };

  const serializeElement = (element: Element): MirrorNode => {
    counted += 1;
    if (counted > MAX_NODES) throw new TooLarge();
    const id = assign(element);
    const tag = element.localName;
    const out: any = { t: "e", id, tag };
    const namespace = element.namespaceURI;
    if (namespace === "http://www.w3.org/2000/svg") out.ns = "svg";
    else if (namespace === "http://www.w3.org/1998/Math/MathML") out.ns = "math";
    const attrs = serializeAttributes(element);
    if (attrs !== undefined) out.a = attrs;

    switch (tag) {
      case "script":
        out.a = undefined;
        return out;
      case "noscript":
      case "template":
        return out;
      case "style": {
        out.css = sheetText((element as HTMLStyleElement).sheet) ?? bound(element.textContent ?? "");
        return out;
      }
      case "link": {
        const rel = (element.getAttribute("rel") ?? "").toLowerCase();
        if (rel.split(/\s+/u).includes("stylesheet")) {
          const css = sheetText((element as HTMLLinkElement).sheet);
          if (css !== null) out.css = css;
        }
        return out;
      }
      case "iframe":
      case "frame":
        if (out.a !== undefined) {
          delete out.a["src"];
          delete out.a["srcdoc"];
        }
        return out;
      case "img": {
        const image = element as HTMLImageElement;
        const current = image.currentSrc;
        if (out.a === undefined) out.a = {};
        if (current !== "") out.a["src"] = bound(current);
        delete out.a["srcset"];
        delete out.a["sizes"];
        break;
      }
      case "source":
        if (out.a !== undefined) {
          delete out.a["srcset"];
          delete out.a["sizes"];
          delete out.a["src"];
        }
        break;
      case "video":
      case "audio":
        mediaElements.add(element as HTMLMediaElement);
        if (out.a !== undefined) {
          delete out.a["src"];
          delete out.a["autoplay"];
        }
        break;
      case "input": {
        const input = element as HTMLInputElement;
        const type = (input.getAttribute("type") ?? "text").toLowerCase();
        if (type === "checkbox" || type === "radio") out.ck = input.checked;
        else if (type === "password") out.v = "•".repeat(Math.min(input.value.length, 256));
        else if (type !== "file") {
          if (input.value !== (input.getAttribute("value") ?? "")) out.v = bound(input.value);
        }
        break;
      }
      case "textarea":
        out.v = bound((element as HTMLTextAreaElement).value);
        break;
      case "select":
        out.v = bound((element as HTMLSelectElement).value);
        break;
      case "canvas": {
        const data = canvasData(element as HTMLCanvasElement);
        if (data !== null) out.cv = data;
        canvases.add(element as HTMLCanvasElement);
        break;
      }
      default:
        break;
    }

    if (element.scrollLeft !== 0 || element.scrollTop !== 0) out.sc = [element.scrollLeft, element.scrollTop];

    const root = shadowOf(element);
    if (root !== null) {
      out.sh = serializeChildren(root);
      const adopted = adoptedOf(root);
      if (adopted !== undefined) out.shs = adopted;
      observeRoot(root);
    }
    const children = serializeChildren(element);
    if (children.length > 0) out.c = children;
    return out;
  };

  const serializeNode = (node: Node): MirrorNode | null => {
    switch (node.nodeType) {
      case 1:
        return serializeElement(node as Element);
      case 3: {
        const parent = node.parentNode;
        // A style element's text is its sheet; the element carries it.
        if (parent !== null && parent.nodeType === 1 && (parent as Element).localName === "style") return null;
        counted += 1;
        if (counted > MAX_NODES) throw new TooLarge();
        return { t: "t", id: assign(node), s: bound(node.nodeValue ?? "") };
      }
      case 4:
        counted += 1;
        return { t: "cd", id: assign(node), s: bound(node.nodeValue ?? "") };
      case 10:
        return { t: "d", id: assign(node), name: (node as DocumentType).name };
      default:
        return null;
    }
  };

  const serializeChildren = (parent: Node): MirrorNode[] => {
    const out: MirrorNode[] = [];
    for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
      const serialized = serializeNode(child);
      if (serialized !== null) out.push(serialized);
    }
    return out;
  };

  const serializeDocument = (): MirrorNode => {
    counted = 0;
    nodes.clear();
    nodes.set(DOC_ID, doc);
    const out: any = { t: "doc", id: DOC_ID, c: serializeChildren(doc) };
    const adopted = adoptedOf(doc);
    if (adopted !== undefined) out.adopted = adopted;
    const scrolling = doc.scrollingElement;
    if (scrolling !== null && (scrolling.scrollLeft !== 0 || scrolling.scrollTop !== 0)) {
      out.sc = [scrolling.scrollLeft, scrolling.scrollTop];
    }
    return out;
  };

  /* ------------------------------- reporting ------------------------------ */

  const send = (report: RecorderReport): void => {
    try {
      const binding = win[config.binding];
      if (typeof binding === "function") reportChain = Promise.all([reportChain, Promise.resolve(binding({ ...report, documentId, epoch: currentEpoch })).catch(() => undefined)]).then(() => undefined);
    } catch {
      /* the host went; the next start() will ask again */
    }
  };

  const deepActive = (): Element | null => {
    let active: Element | null = doc.activeElement;
    while (active !== null) {
      const root = shadowOf(active);
      if (root === null || root.activeElement === null) break;
      active = root.activeElement;
    }
    return active;
  };

  /* ------------------------------- observing ------------------------------ */

  const observers = new Map<Node, MutationObserver>();
  const canvases = new Set<HTMLCanvasElement>();
  const mediaElements = new Set<HTMLMediaElement>();
  const canvasLast = new WeakMap<HTMLCanvasElement, string>();
  const pendingValues = new Set<Element>();
  const pendingScrolls = new Map<Node, [number, number]>();
  let pendingFocus: { id: number | null } | null = null;
  const pendingRecords: MutationRecord[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFlush = 0;
  let canvasTimer: ReturnType<typeof setInterval> | null = null;
  let suitabilityTimer: ReturnType<typeof setInterval> | null = null;
  const reportedUnsuitable = new Set<string>();

  function observeRoot(root: Node): void {
    if (!recording || observers.has(root)) return;
    const observer = new MutationObserver((records) => {
      for (const record of records) pendingRecords.push(record);
      schedule();
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    observers.set(root, observer);
  }

  function schedule(): void {
    if (!recording || flushTimer !== null) return;
    const wait = Math.max(0, FLUSH_GAP_MS - (Date.now() - lastFlush));
    flushTimer = setTimeout(flush, wait);
  }

  function noteValue(element: Element): void {
    if (!recording) return;
    pendingValues.add(element);
    schedule();
  }

  function noteAdopted(root: Node): void {
    if (!recording) return;
    dirtyAdopted.add(root);
    schedule();
  }

  function onShadowAttached(host: Element, root: ShadowRoot): void {
    observeRoot(root);
    const hostId = idOf(host);
    if (hostId === null) return;
    try {
      counted = 0;
      const op: MirrorOp = { o: "shadow", id: hostId, c: serializeChildren(root) };
      const adopted = adoptedOf(root);
      if (adopted !== undefined) op.s = adopted;
      queue(op);
    } catch (error) {
      if (error instanceof TooLarge) unsuitable("too_large");
    }
  }

  let queued: MirrorOp[] = [];
  function queue(op: MirrorOp): void {
    queued.push(op);
    schedule();
  }

  const onInput = (event: Event): void => {
    const target = event.composedPath()[0];
    if (target instanceof Element) noteValue(target);
  };
  const onScroll = (event: Event): void => {
    if (!recording) return;
    const target = event.composedPath()[0];
    if (target === doc) {
      const scrolling = doc.scrollingElement;
      if (scrolling !== null) pendingScrolls.set(doc, [scrolling.scrollLeft, scrolling.scrollTop]);
    } else if (target instanceof Element) {
      pendingScrolls.set(target, [target.scrollLeft, target.scrollTop]);
    }
    schedule();
  };
  const onFocus = (): void => {
    if (!recording) return;
    const active = deepActive();
    if (active instanceof HTMLElement && active.isContentEditable) unsuitable("editor");
    pendingFocus = { id: active === null || active === doc.body ? null : idOf(active) };
    schedule();
  };

  function unsuitable(reason: UnsuitableReason, detail?: string): void {
    if (reportedUnsuitable.has(reason)) return;
    reportedUnsuitable.add(reason);
    send(detail === undefined ? { kind: "unsuitable", reason } : { kind: "unsuitable", reason, detail });
  }

  /** Whether an element takes up enough of the viewport to matter. */
  const covers = (element: Element, share: number): boolean => {
    // Geometry alone includes visibility:hidden and transparent media/ad
    // containers. Chromium also checks ancestors, including shadow hosts.
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const box = element.getBoundingClientRect();
    const width = win.innerWidth || 1;
    const height = win.innerHeight || 1;
    const visibleW = Math.max(0, Math.min(box.right, width) - Math.max(box.left, 0));
    const visibleH = Math.max(0, Math.min(box.bottom, height) - Math.max(box.top, 0));
    return (visibleW * visibleH) / (width * height) >= share;
  };

  function checkSuitability(): void {
    try {
      const elements = (selector: string): Element[] => [...observers.keys()].flatMap(root =>
        root === doc || root.isConnected ? [...(root as Document | ShadowRoot).querySelectorAll(selector)] : []);
      for (const frame of elements("iframe, frame")) {
        if (covers(frame, 0.001) && (frame.hasAttribute("srcdoc") || !["", "about:blank"].includes(frame.getAttribute("src") ?? ""))) { unsuitable("frame"); return; }
      }
      const active = deepActive();
      if (active instanceof HTMLElement && active.isContentEditable) { unsuitable("editor"); return; }
      for (const field of elements('input[type="password"]')) {
        const value = (field as HTMLInputElement).value;
        if (value && locallyEditedPasswords.get(field) !== value && covers(field, 0.001)) { unsuitable("password"); return; }
      }
      for (const canvas of canvases) {
        if (!canvas.isConnected) {
          canvases.delete(canvas);
          continue;
        }
        const kind = canvasKinds.get(canvas);
        if ((kind === "webgl" || kind === "webgl2" || kind === "webgpu") && covers(canvas, 0.001)) {
          unsuitable("webgl");
          return;
        }
      }
      for (const plugin of elements("embed, object")) {
        const type = (plugin.getAttribute("type") ?? "").toLowerCase();
        if (covers(plugin, 0.001)) {
          unsuitable("plugin", type);
          return;
        }
      }
    } catch {
      /* a detached element mid-walk; try again next tick */
    }
  }

  function pollCanvases(): void {
    if (!recording) return;
    for (const canvas of canvases) {
      if (!canvas.isConnected || !isLive(canvas)) {
        canvases.delete(canvas);
        continue;
      }
      if (!covers(canvas, 0)) continue;
      const box = canvas.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const data = canvasData(canvas);
      if (data === null || canvasLast.get(canvas) === data) continue;
      canvasLast.set(canvas, data);
      const id = idOf(canvas);
      if (id !== null) queue({ o: "canvas", id, u: data });
    }
  }

  /* -------------------------------- flushing ------------------------------ */

  function flush(): void {
    flushTimer = null;
    if (!recording) return;
    lastFlush = Date.now();
    const ops: MirrorOp[] = queued;
    queued = [];
    try {
      const records = pendingRecords.splice(0);
      for (const observer of observers.values()) records.push(...observer.takeRecords());
      applyRecords(records, ops);
      for (const element of pendingValues) {
        if (!isLive(element)) continue;
        const id = idOf(element);
        if (id === null) continue;
        const tag = element.localName;
        if (tag === "input") {
          const input = element as HTMLInputElement;
          const type = (input.getAttribute("type") ?? "text").toLowerCase();
          if (type === "checkbox" || type === "radio") ops.push({ o: "chk", id, v: input.checked });
          else if (type === "password") ops.push({ o: "val", id, v: "•".repeat(Math.min(input.value.length, 256)) });
          else if (type !== "file") ops.push({ o: "val", id, v: bound(input.value) });
        } else if (tag === "textarea" || tag === "select") {
          ops.push({ o: "val", id, v: bound((element as HTMLTextAreaElement).value) });
        }
      }
      pendingValues.clear();
      for (const [target, [x, y]] of pendingScrolls) {
        if (target === doc) ops.push({ o: "scroll", id: DOC_ID, x, y });
        else if (isLive(target)) {
          const id = idOf(target);
          if (id !== null) ops.push({ o: "scroll", id, x, y });
        }
      }
      pendingScrolls.clear();
      for (const sheet of dirtySheets) {
        const owner = sheet.ownerNode;
        if (owner !== null && isLive(owner)) {
          const id = idOf(owner);
          if (id !== null) ops.push({ o: "css", id, s: sheetText(sheet) ?? "" });
          continue;
        }
        // A constructed sheet: whoever adopted it re-sends the set.
        dirtyAdopted.add(doc);
        for (const root of observers.keys()) if (root !== doc) dirtyAdopted.add(root);
      }
      dirtySheets.clear();
      for (const root of dirtyAdopted) {
        if (root === doc) {
          ops.push({ o: "adopted", id: DOC_ID, s: adoptedOf(doc) ?? [] });
          continue;
        }
        const host = (root as ShadowRoot).host;
        if (host === undefined || !isLive(host)) continue;
        const id = idOf(host);
        if (id !== null) ops.push({ o: "adopted", id, s: adoptedOf(root as ShadowRoot) ?? [] });
      }
      dirtyAdopted.clear();
      if (pendingFocus !== null) {
        ops.push({ o: "focus", id: pendingFocus.id });
        pendingFocus = null;
      }
    } catch (error) {
      if (error instanceof TooLarge) {
        unsuitable("too_large");
        stop();
        return;
      }
      unsuitable("error", String(error).slice(0, 200));
      return;
    }
    if (ops.length === 0) return;
    for (let at = 0; at < ops.length; at += MAX_OPS) send({ kind: "patch", ops: ops.slice(at, at + MAX_OPS) });
  }

  /**
   * Fold a batch of mutation records into operations. Removals first, then
   * additions in the order they happened, each inserted before its nearest
   * live next sibling — which is what makes two siblings added in either
   * order land in the right one. A node that moved is a removal and an
   * addition. Attributes and text are read NOW, not from the record, so a
   * value that changed three times in one tick is sent once.
   */
  function applyRecords(records: MutationRecord[], ops: MirrorOp[]): void {
    if (records.length === 0) return;
    const removed = new Set<Node>();
    const added: Node[] = [];
    const addedSet = new Set<Node>();
    const attrs = new Map<Element, Set<string>>();
    const texts = new Set<Node>();
    const styles = new Set<Element>();
    for (const record of records) {
      if (record.type === "childList") {
        for (const node of record.removedNodes) removed.add(node);
        for (const node of record.addedNodes) {
          if (!addedSet.has(node)) {
            addedSet.add(node);
            added.push(node);
          }
        }
        const target = record.target;
        if (target.nodeType === 1 && (target as Element).localName === "style") styles.add(target as Element);
      } else if (record.type === "attributes") {
        const target = record.target as Element;
        const set = attrs.get(target) ?? new Set<string>();
        set.add(record.attributeName ?? "");
        attrs.set(target, set);
      } else if (record.type === "characterData") {
        const parent = record.target.parentNode;
        if (parent !== null && parent.nodeType === 1 && (parent as Element).localName === "style") styles.add(parent as Element);
        else texts.add(record.target);
      }
    }
    // Something added in this batch is reachable again only if it is
    // connected to a root we mirror; a moved node is live AND connected.
    const connected = (node: Node): boolean => {
      const root = node.getRootNode({ composed: false });
      return root === doc || (root instanceof ShadowRoot && observers.has(root));
    };
    for (const node of removed) {
      if (!isLive(node)) continue;
      const id = idOf(node);
      if (id === null) continue;
      // Still attached somewhere we mirror: it moved, and the addition below re-sends it.
      if (connected(node) && !addedSet.has(node)) continue;
      ops.push({ o: "rm", id });
      forget(node);
    }
    for (const node of added) {
      if (!connected(node)) continue;
      const parent = node.parentNode;
      if (parent === null) continue;
      const parentId = parent instanceof ShadowRoot ? idOf(parent.host) : idOf(parent);
      if (parentId === null) continue;
      if (parent instanceof ShadowRoot ? !isLive(parent.host) : !isLive(parent)) continue;
      // Under a parent that is itself new in this batch: serialized with it.
      let ancestor: Node | null = parent;
      let coveredByParent = false;
      while (ancestor !== null && ancestor !== doc) {
        if (addedSet.has(ancestor)) {
          coveredByParent = true;
          break;
        }
        ancestor = ancestor instanceof ShadowRoot ? ancestor.host : ancestor.parentNode;
      }
      if (coveredByParent) continue;
      if (isLive(node)) {
        // Moved: the renderer replaces the node it has under this id.
        ops.push({ o: "rm", id: idOf(node) as number });
        forget(node);
      }
      const serialized = serializeNode(node);
      if (serialized === null) continue;
      let before: number | null = null;
      for (let sibling = node.nextSibling; sibling !== null; sibling = sibling.nextSibling) {
        if (isLive(sibling)) {
          before = idOf(sibling);
          break;
        }
      }
      ops.push(parent instanceof ShadowRoot ? { o: "add", p: parentId, b: before, n: serialized, sh: true } : { o: "add", p: parentId, b: before, n: serialized });
    }
    for (const [element, names] of attrs) {
      if (!isLive(element)) continue;
      const id = idOf(element);
      if (id === null) continue;
      for (const name of names) {
        if (name === "" || name.startsWith("on") || name === "srcdoc") continue;
        if (element.localName === "img" && (name === "srcset" || name === "sizes" || name === "src")) {
          const current = (element as HTMLImageElement).currentSrc || element.getAttribute("src") || "";
          ops.push({ o: "attr", id, k: "src", v: current === "" ? null : bound(current) });
          continue;
        }
        const value = element.getAttribute(name);
        ops.push({ o: "attr", id, k: name, v: value === null ? null : bound(value) });
      }
      // A changed link may still expose the PREVIOUS sheet until load. Its
      // href patch loads the new captured response; onResourceLoad supplies
      // readable CSS only after the new sheet actually arrives.
    }
    for (const node of texts) {
      if (!isLive(node)) continue;
      const id = idOf(node);
      if (id !== null) ops.push({ o: "txt", id, s: bound(node.nodeValue ?? "") });
    }
    for (const element of styles) {
      if (!isLive(element)) continue;
      const id = idOf(element);
      if (id === null) continue;
      const sheet = (element as HTMLStyleElement).sheet;
      const css = sheetText(sheet);
      if (css !== null || element.localName === "style") ops.push({ o: "css", id, s: css ?? bound(element.textContent ?? "") });
    }
  }

  /* -------------------------------- control ------------------------------- */

  const onResourceLoad = (event: Event): void => {
    const element = event.target;
    if (!(element instanceof Element) || !isLive(element)) return;
    const id = idOf(element)!;
    if (element.localName === "img") {
      queued.push({ o: "attr", id, k: "src", v: (element as HTMLImageElement).currentSrc || element.getAttribute("src") });
      schedule();
    } else if (element.localName === "link") {
      const css = sheetText((element as HTMLLinkElement).sheet);
      if (css !== null) { queued.push({ o: "css", id, s: css }); schedule(); }
    }
  };

  function start(epoch = 0, mediaOnly = false): ReturnType<RecorderControl["start"]> {
    stop();
    locallyEditedPasswords = new WeakMap();
    currentEpoch = epoch;
    recording = !mediaOnly;
    reportedUnsuitable.clear();
    if (mediaOnly) return { kind: "snapshot", documentId, epoch, url: "about:blank", base: "about:blank", title: "Audio playback",
      root: { t: "doc", id: assign(doc), c: [] }, focus: null, width: win.innerWidth, height: win.innerHeight, nodes: 1 };
    let root: MirrorNode;
    try {
      root = serializeDocument();
    } catch (error) {
      recording = false;
      if (error instanceof TooLarge) return { kind: "unsuitable", reason: "too_large" };
      return { kind: "unsuitable", reason: "error", detail: String(error).slice(0, 200) };
    }
    observeRoot(doc);
    win.addEventListener("load", onResourceLoad, true);
    win.addEventListener("input", onInput, true);
    win.addEventListener("change", onInput, true);
    win.addEventListener("scroll", onScroll, true);
    win.addEventListener("focusin", onFocus, true);
    win.addEventListener("focusout", onFocus, true);
    canvasTimer = setInterval(pollCanvases, CANVAS_POLL_MS);
    suitabilityTimer = setInterval(checkSuitability, SUITABILITY_POLL_MS);
    checkSuitability();
    const reason = reportedUnsuitable.values().next().value;
    if (reason !== undefined) return { kind: "unsuitable", reason: reason as UnsuitableReason };
    const active = deepActive();
    return {
      kind: "snapshot",
      documentId,
      epoch: currentEpoch,
      // A data URL embeds the entire document, which is already in root.
      // Sending it again also exceeds the protocol's ordinary URL bound.
      url: String(doc.URL ?? "").startsWith("data:") ? "about:blank" : String(doc.URL ?? ""),
      base: String(doc.baseURI ?? doc.URL ?? "").startsWith("data:") ? "about:blank" : String(doc.baseURI ?? doc.URL ?? ""),
      title: String(doc.title ?? "").slice(0, 4096),
      root,
      focus: active === null || active === doc.body ? null : idOf(active),
      width: win.innerWidth,
      height: win.innerHeight,
      nodes: counted,
    };
  }

  function stop(epoch?: number): void {
    if (epoch !== undefined && epoch !== currentEpoch) return;
    if (!recording) return;
    recording = false;
    for (const observer of observers.values()) observer.disconnect();
    observers.clear();
    win.removeEventListener("load", onResourceLoad, true);
    win.removeEventListener("input", onInput, true);
    win.removeEventListener("change", onInput, true);
    win.removeEventListener("scroll", onScroll, true);
    win.removeEventListener("focusin", onFocus, true);
    win.removeEventListener("focusout", onFocus, true);
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    if (canvasTimer !== null) clearInterval(canvasTimer);
    canvasTimer = null;
    if (suitabilityTimer !== null) clearInterval(suitabilityTimer);
    suitabilityTimer = null;
    pendingRecords.length = 0;
    pendingValues.clear();
    pendingScrolls.clear();
    pendingFocus = null;
    queued = [];
    dirtySheets.clear();
    dirtyAdopted.clear();
  }

  const elementOf = (id: number): Element | null => {
    const node = nodes.get(id);
    return node !== undefined && node.nodeType === 1 && node.isConnected ? (node as Element) : null;
  };

  const control: RecorderControl = {
    get epoch() { return currentEpoch; },
    documentId,
    settle: async () => { await Promise.resolve(); flush(); await reportChain; },
    value: (id) => { const element = elementOf(id); return element !== null && "value" in element ? String((element as HTMLInputElement).value) : null; },
    start,
    stop,
    recording: () => recording,
    mediaState: () => {
      // Media remains discoverable even when DOM recording is unsuitable or stopped.
      // Traverse shadow roots too; no page markup needs to leave the cloud for audio.
      const visit = (root: Document | ShadowRoot): void => {
        for (const element of root.querySelectorAll("*")) {
          if (element instanceof HTMLMediaElement) { assign(element); mediaElements.add(element); }
          const shadow = shadowOf(element); if (shadow) visit(shadow);
        }
      };
      if (!recording) visit(doc);
      const items: MediaState[] = [];
      for (const element of mediaElements) {
        const id = idOf(element);
        if (!element.isConnected || !isLive(element) || id === null) { mediaElements.delete(element); if (id !== null) nodes.delete(id); continue; }
        if (items.length === 32) break;
        const source = element.currentSrc || element.src;
        if (!source && !element.srcObject) continue;
        const mse = mediaSources.source(source);
        const unsupported = !!element.mediaKeys || !!element.srcObject || !!mse?.failed || (source.startsWith("blob:") && !mse);
        if (unsupported && element.paused && !covers(element, 0.001)) continue;
        items.push({ id, source: mse?.id ?? source, kind: element.localName as "audio" | "video", visible: covers(element, 0.001), mse: !!mse,
          unsupported, paused: element.paused || element.ended,
          time: Number.isFinite(element.currentTime) ? element.currentTime : 0,
          duration: Number.isFinite(element.duration) ? element.duration : null,
          volume: element.volume, muted: element.muted, rate: element.playbackRate });
      }
      return items;
    },
    mediaData: (source, after) => mediaSources.read(source, after),
    prepareMedia: id => {
      const element = elementOf(id);
      if (!(element instanceof HTMLMediaElement)) return false;
      if (element.preload !== "none" || element.readyState > 0) return true;
      const restore = (): void => {
        element.removeEventListener("loadedmetadata", restore); element.removeEventListener("error", restore);
        if (element.preload === "metadata") element.preload = "none";
      };
      element.addEventListener("loadedmetadata", restore, { once: true }); element.addEventListener("error", restore, { once: true });
      element.preload = "metadata"; element.load();
      return true;
    },
    mediaAction: async (id, command) => {
      const element = elementOf(id);
      if (!element || !["video", "audio"].includes(element.localName)) return false;
      const media = element as HTMLMediaElement;
      try {
        if (command.action === "play") {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([media.play().then(() => true, () => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
          } finally { clearTimeout(timer); }
        }
        else if (command.action === "pause") media.pause();
        else if (command.action === "seek") media.currentTime = command.value;
        else if (command.action === "volume") media.volume = command.value;
        else if (command.action === "muted") media.muted = command.value;
        else if (command.action === "rate") media.playbackRate = command.value;
        return true;
      } catch { return false; }
    },
    rect: (id) => {
      const element = elementOf(id);
      if (element === null) return null;
      element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      const box = element.getBoundingClientRect();
      return { x: box.left, y: box.top, w: box.width, h: box.height };
    },
    idOf: (node) => (isLive(node) ? idOf(node) : null),
    activeId: () => {
      const active = deepActive();
      return active === null ? null : idOf(active);
    },
    focusEditor: (id) => {
      const element = elementOf(id);
      if (!(element instanceof HTMLElement) || !element.isContentEditable) return false;
      element.focus({ preventScroll: true });
      return deepActive() === element;
    },
    focus: (id) => {
      const element = elementOf(id);
      if (element === null) return false;
      try {
        (element as HTMLElement).focus({ preventScroll: true });
        return true;
      } catch {
        return false;
      }
    },
    setValue: (id, value, start, end, commit = false) => {
      const element = elementOf(id);
      if (element === null) return false;
      const tag = element.localName;
      let proto: any;
      if (tag === "input") proto = win.HTMLInputElement.prototype;
      else if (tag === "textarea") proto = win.HTMLTextAreaElement.prototype;
      else if (tag === "select") proto = win.HTMLSelectElement.prototype;
      else return false;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor === undefined || typeof descriptor.set !== "function") return false;
      if (commit && (element as HTMLInputElement).value === value) {
        element.dispatchEvent(new win.Event("change", { bubbles: true }));
        return true;
      }
      try {
        (element as HTMLElement).focus({ preventScroll: true });
      } catch {
        /* an unfocusable control still takes a value */
      }
      // The ORIGINAL setter, through our wrapper: a framework's own hook on
      // the prototype (React's tracker) is below ours and still fires.
      descriptor.set.call(element, value);
      if (tag === "input" && (element as HTMLInputElement).type === "password") locallyEditedPasswords.set(element, value);
      if (tag !== "select" && start !== null && end !== null) {
        try {
          (element as HTMLInputElement).setSelectionRange(start, end);
        } catch {
          /* a type that has no selection (number, email in some browsers) */
        }
      }
      const InputEventCtor = win.InputEvent ?? win.Event;
      element.dispatchEvent(new InputEventCtor("input", { bubbles: true, composed: true, inputType: "insertText" }));
      if (commit || tag === "select") element.dispatchEvent(new win.Event("change", { bubbles: true }));
      return true;
    },
    scrollTo: (id, x, y) => {
      if (id === DOC_ID) {
        win.scrollTo(x, y);
        return true;
      }
      const element = elementOf(id);
      if (element === null) return false;
      element.scrollTo(x, y);
      return true;
    },
    extractBlob: async (url) => {
      if (!url.startsWith("blob:")) return false;
      try {
        const response = await win.fetch(url);
        const blob: Blob = await response.blob();
        if (blob.size > 12 * 1024 * 1024) return false;
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new win.FileReader();
          reader.onerror = () => reject(new Error("read failed"));
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.readAsDataURL(blob);
        });
        send({ kind: "blob", url, type: blob.type, base64 });
        return true;
      } catch {
        return false;
      }
    },
  };

  Object.defineProperty(win, config.control, { value: control, enumerable: false, configurable: true, writable: false });
  // Playwright installs the binding as an enumerable global; hide it, as the
  // tab bridge does, so a page walking `window` does not find it.
  try {
    const at = Object.getOwnPropertyDescriptor(win, config.binding);
    if (at !== undefined && at.enumerable === true) Object.defineProperty(win, config.binding, { ...at, enumerable: false });
  } catch {
    /* a frozen window keeps its own counsel */
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The recorder as a script: installs itself in every document it runs in.
 *
 * The `__name` shim neutralizes esbuild's `keepNames` helper: the bundler
 * rewrites a named function to call `__name(...)`, which does not exist in the
 * page the source is injected into. Defining it as identity makes the
 * stringified function self-sufficient wherever it runs.
 */
export function mirrorRecorderSource(config: RecorderConfig): string {
  return `(()=>{const __name=(f)=>f;return (${installMirrorRecorder.toString()})(${JSON.stringify(config)},(${installMediaSourceRecorder.toString()}));})();`;
}
