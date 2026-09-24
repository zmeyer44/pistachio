/**
 * The renderer: what rebuilds the mirrored document in the person's browser
 * (docs/web-browser-design.md §16.4).
 *
 * It takes the recorder's snapshots and patches — already rewritten by the
 * host so every asset is a `pa-asset:` token — and maintains a live copy in
 * a document of the pane's own: the main frame in a sandboxed `iframe`,
 * each child frame in an `iframe` nested inside it. Nothing the page wrote
 * ever executes here: CSP permits only the trusted controller script, the document
 * cannot access shell storage or origin networks, and this file refuses on top of
 * that — every `script`, `object`, `base` and `meta` becomes an inert
 * `template`, every `on*` attribute and `javascript:` URL is dropped, and
 * every URL that is not a token, a `data:` or a fragment is discarded.
 *
 * Assets arrive on their own schedule. A token that has no bytes yet leaves
 * the attribute unset (no broken-image icon for something that is on its
 * way) and a stylesheet with a `data:,` placeholder; the renderer remembers
 * who wanted what, and fills each in the moment `resolveAsset` says the
 * bytes are here. A CSS asset is text with tokens of its own, so its object
 * URL is rebuilt when a dependency lands, and whoever imported it follows.
 *
 * Like the recorder, this is ONE self-contained function so a Chromium test
 * can stringify it into a page. The web app imports it as a module.
 */

import type { MirrorNode, MirrorOp, MirrorServerMessage } from "./protocol.js";

export type MirrorSnapshotMessage = Extract<MirrorServerMessage, { k: "snapshot" }>;
export type MirrorPatchMessage = Extract<MirrorServerMessage, { k: "patch" }>;

export interface MirrorRendererOptions {
  /** The main frame's document: the sandboxed iframe's `contentDocument`. */
  document: Document;
  /** Whether a `focus` op may move the person's focus (only when the pane is active). */
  mayFocus?: () => boolean;
  mediaOrigin?: string;
  /** Told when a document is (re)built, so listeners can be attached. */
  onDocument?: (frame: string, document: Document) => void;
  /** A hook for a value the page set on a control the person is editing; return false to keep the local one. */
  mayApplyValue?: (frame: string, id: number, element: Element) => boolean;
  /** A hook for a scroll the page set on an element the person just scrolled; return false to keep the local one. */
  mayApplyScroll?: (frame: string, id: number, element: Element | Document) => boolean;
}

export interface MirrorRenderer {
  applySnapshot(message: MirrorSnapshotMessage): "ok" | "held";
  /** `gap` means seq skipped; `stale` means an older epoch; the caller asks for a resync on `gap`. */
  applyPatch(message: MirrorPatchMessage): "ok" | "gap" | "stale" | "unknown";
  frameGone(frame: string): void;
  resolveAsset(id: string, url: string, type: string, text: string | null): void;
  assetMissing(id: string): void;
  needsStylesheet(id: string): boolean;
  /** Ids the renderer is still waiting for. */
  pendingAssets(): string[];
  idOf(node: Node): { frame: string; id: number } | null;
  nodeOf(frame: string, id: number): Node | null;
  frameOf(document: Document): string | null;
  documentOf(frame: string): Document | null;
  position(frame: string): { epoch: number; seq: number } | null;
  dispose(): void;
}

/** The content security policy every mirrored document carries. */
export const MIRROR_DOCUMENT_CSP =
  "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src blob: data:; frame-src about: blob: data:; form-action 'none'; base-uri 'none'";

/** The document the pane's iframe starts from, before the first snapshot. */
export function mirrorDocumentSource(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MIRROR_DOCUMENT_CSP}"></head><body></body></html>`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function createMirrorRenderer(options: MirrorRendererOptions): MirrorRenderer {
  const CSP =
    "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src blob: data:; frame-src about: blob: data:; form-action 'none'; base-uri 'none'".replace("media-src blob: data:", `media-src blob: data: ${options.mediaOrigin ? new URL(options.mediaOrigin).origin : ""}`);
  const TOKEN = "pa-asset:";
  const TOKEN_RE = /pa-asset:([A-Za-z0-9_-]+)/gu;
  const PLACEHOLDER = "data:,";
  const BLOCKED = new Set(["script", "object", "embed", "applet", "base", "meta", "frameset", "portal", "fencedframe", "noscript"]);
  const URL_ATTRIBUTES = new Set(["src", "href", "poster", "xlink:href", "data", "action", "formaction", "ping", "srcset", "background", "cite", "longdesc", "usemap", "manifest", "profile", "codebase"]);
  const KEEP_PLAIN_HREF = new Set(["a", "area", "use", "link"]);

  interface FrameView {
    token: string;
    doc: Document;
    epoch: number;
    seq: number;
    nodes: Map<number, Node>;
    ids: WeakMap<Node, number>;
    /** The `iframe` element in the parent view this frame renders into. */
    host: { frame: string; id: number } | null;
    /** Stylesheet text with tokens, per style element, for re-rendering. */
    sheets: Map<Node, string>;
    adopted: Map<Node, string[]>;
  }

  const views = new Map<string, FrameView>();
  const byDocument = new WeakMap<Document, string>();
  /** Child snapshots whose host iframe is not there yet, keyed `parent:id`. */
  const held = new Map<string, MirrorSnapshotMessage>();

  interface Asset {
    url: string | null;
    type: string;
    /** For CSS assets: the text with tokens, so the URL can be rebuilt. */
    text: string | null;
    missing: boolean;
  }
  const assets = new Map<string, Asset>();
  const linkedSheets = new Map<Element, string>();
  /** Who is waiting on each asset: attributes, sheets, and other assets. */
  const waiters = new Map<string, Set<() => void>>();

  const waitFor = (id: string, fill: () => void): void => {
    const set = waiters.get(id) ?? new Set();
    set.add(fill);
    waiters.set(id, set);
  };

  const assetUrl = (id: string): string | null => assets.get(id)?.url ?? null;

  /** Replace every token in a text by its URL, or a placeholder; registers a re-render for the missing ones. */
  const renderText = (text: string, again: () => void): string => {
    return text.replace(TOKEN_RE, (_match, id: string) => {
      const url = assetUrl(id);
      if (url !== null) return url;
      if (assets.get(id)?.missing === true) return PLACEHOLDER;
      waitFor(id, again);
      return PLACEHOLDER;
    });
  };

  /* ------------------------------- documents ------------------------------ */

  const newView = (token: string, doc: Document, host: FrameView["host"]): FrameView => {
    const view: FrameView = { token, doc, epoch: 0, seq: 0, nodes: new Map(), ids: new WeakMap(), host, sheets: new Map(), adopted: new Map() };
    views.set(token, view);
    byDocument.set(doc, token);
    return view;
  };

  /** Empty a document down to its CSP, ready for a snapshot. */
  const resetDocument = (doc: Document): void => {
    const html = doc.documentElement;
    if (html === null) return;
    for (const name of [...html.getAttributeNames()]) html.removeAttribute(name);
    let head = doc.head;
    if (head === null) {
      head = doc.createElement("head");
      html.prepend(head);
    }
    for (const name of [...head.getAttributeNames()]) head.removeAttribute(name);
    for (const child of [...head.childNodes]) {
      const keep =
        child.nodeType === 1 &&
        (child as Element).localName === "meta" &&
        ((child as Element).getAttribute("http-equiv") ?? "").toLowerCase() === "content-security-policy";
      const charset = child.nodeType === 1 && (child as Element).hasAttribute("charset");
      if (!keep && !charset) head.removeChild(child);
    }
    if (head.querySelector('meta[http-equiv="Content-Security-Policy" i]') === null) {
      const meta = doc.createElement("meta");
      meta.setAttribute("http-equiv", "Content-Security-Policy");
      meta.setAttribute("content", CSP);
      head.prepend(meta);
    }
    let body = doc.body;
    if (body === null) {
      body = doc.createElement("body");
      html.append(body);
    }
    for (const name of [...body.getAttributeNames()]) body.removeAttribute(name);
    body.replaceChildren();
    for (const child of [...html.childNodes]) if (child !== head && child !== body) html.removeChild(child);
    try {
      (doc as any).adoptedStyleSheets = [];
    } catch {
      /* an old engine */
    }
  };

  /* ------------------------------- building ------------------------------- */

  const SVG = "http://www.w3.org/2000/svg";
  const MATHML = "http://www.w3.org/1998/Math/MathML";

  const isSafeUrl = (value: string): boolean => {
    const lower = value.trim().toLowerCase();
    if (lower.startsWith("javascript:") || lower.startsWith("vbscript:")) return false;
    return true;
  };

  /**
   * Set one attribute the safe way. Tokens are resolved (or registered for
   * later), URL attributes that name anything but a token, a `data:`, or a
   * fragment are dropped, and handler attributes never land.
   */
  const setAttribute = (view: FrameView, element: Element, name: string, value: string): void => {
    const lower = name.toLowerCase();
    if (lower === "contenteditable") {
      // Keep source metadata for focus handoff without enabling local edits.
      element.setAttribute("data-pa-editor", ["", "true", "plaintext-only"].includes(value.toLowerCase()) ? "true" : "false");
      element.setAttribute("contenteditable", "false");
      if (element.getAttribute("data-pa-editor") === "true" && !element.hasAttribute("tabindex")) element.setAttribute("tabindex", "0");
      return;
    }
    if (lower === "data-pa-editor") return;
    if (lower.startsWith("on") || lower === "srcdoc" || lower === "formaction" || lower === "ping" || lower === "action") return;
    if (lower === "sandbox" || lower === "allow" || lower === "csp") return;
    if (["video", "audio", "source"].includes(element.localName) && ["src", "autoplay"].includes(lower)) return;
    if (!isSafeUrl(value)) return;
    if (lower === "href" && element.localName === "link") {
      if (value.startsWith(TOKEN)) linkedSheets.set(element, value.slice(TOKEN.length));
      else linkedSheets.delete(element);
    }
    if (URL_ATTRIBUTES.has(lower)) {
      const tag = element.localName;
      if (lower === "srcset") {
        const rendered = renderText(value, () => setAttribute(view, element, name, value));
        if (rendered.includes(PLACEHOLDER)) return;
        element.setAttribute(name, rendered);
        return;
      }
      if (value.startsWith(TOKEN)) {
        const id = value.slice(TOKEN.length);
        const url = assetUrl(id);
        if (url === null) {
          if (assets.get(id)?.missing !== true) waitFor(id, () => setAttribute(view, element, name, value));
          return;
        }
        element.setAttribute(name, url);
        return;
      }
      const trimmed = value.trim();
      if (trimmed.startsWith("#") || trimmed.toLowerCase().startsWith("data:")) {
        element.setAttribute(name, value);
        return;
      }
      // A plain URL: fine on a link the person can see and we never follow;
      // dropped on anything that would fetch it.
      if (lower === "href" && (tag === "a" || tag === "area")) { element.setAttribute(name, "#"); return; }
      if (lower === "href" && KEEP_PLAIN_HREF.has(tag)) {
        element.setAttribute(name, value);
        return;
      }
      return;
    }
    if (lower === "style") {
      element.setAttribute("style", renderText(value, () => setAttribute(view, element, name, value)));
      return;
    }
    try {
      element.setAttribute(name, value);
    } catch {
      /* a name the DOM refuses (a page can write anything into innerHTML) */
    }
  };

  const applySheet = (view: FrameView, style: Element, css: string): void => {
    view.sheets.set(style, css);
    const render = (): void => {
      if (view.sheets.get(style) !== css) return;
      style.textContent = renderText(css, render);
    };
    render();
  };

  const applyAdopted = (view: FrameView, root: Document | ShadowRoot, sheets: string[]): void => {
    view.adopted.set(root, sheets);
    const render = (): void => {
      if (view.adopted.get(root) !== sheets) return;
      const win = view.doc.defaultView as any;
      if (win === null || typeof win.CSSStyleSheet !== "function") return;
      const built: CSSStyleSheet[] = [];
      for (const css of sheets) {
        try {
          const sheet = new win.CSSStyleSheet() as CSSStyleSheet;
          sheet.replaceSync(renderText(css, render));
          built.push(sheet);
        } catch {
          /* a sheet the engine refuses */
        }
      }
      try {
        (root as any).adoptedStyleSheets = built;
      } catch {
        /* not supported here */
      }
    };
    render();
  };

  const drawCanvas = (element: HTMLCanvasElement, dataUrl: string): void => {
    if (!dataUrl.startsWith("data:image/")) return;
    const win = element.ownerDocument.defaultView as any;
    if (win === null) return;
    const image = new win.Image() as HTMLImageElement;
    image.onload = () => {
      const context = element.getContext("2d");
      if (context === null) return;
      if (element.width !== image.naturalWidth) element.width = image.naturalWidth;
      if (element.height !== image.naturalHeight) element.height = image.naturalHeight;
      context.clearRect(0, 0, element.width, element.height);
      context.drawImage(image, 0, 0);
    };
    image.src = dataUrl;
  };

  /** Scroll positions only take once the node is laid out; they are applied after the batch. */
  let deferred: Array<() => void> = [];

  const build = (view: FrameView, node: MirrorNode): Node | null => {
    const doc = view.doc;
    switch (node.t) {
      case "t": {
        const text = doc.createTextNode(node.s);
        register(view, node.id, text);
        return text;
      }
      case "cd":
      case "c": {
        // CDATA only exists in XML documents; a comment carries the same nothing.
        const comment = doc.createComment("");
        register(view, node.id, comment);
        return comment;
      }
      case "d":
      case "doc":
        return null;
      case "e":
        return buildElement(view, node);
    }
  };

  const buildElement = (view: FrameView, node: Extract<MirrorNode, { t: "e" }>): Element => {
    const doc = view.doc;
    const tag = node.tag.toLowerCase();
    let element: Element;
    if (BLOCKED.has(tag)) {
      element = doc.createElement("template");
      element.setAttribute("data-pa-blocked", tag);
      register(view, node.id, element);
      return element;
    }
    if (tag === "link") {
      // A stylesheet becomes a style element; any other link (icon, preload, prefetch) is inert.
      const rel = (node.a?.["rel"] ?? "").toLowerCase().split(/\s+/u);
      if (rel.includes("stylesheet") && node.css !== undefined) {
        element = doc.createElement("style");
        element.setAttribute("data-pa-link", "stylesheet");
        for (const name of ["id", "class", "title"]) { const value = node.a?.[name]; if (value !== undefined) element.setAttribute(name, value); }
        const media = node.a?.["media"];
        if (media !== undefined) element.setAttribute("media", media);
        register(view, node.id, element);
        applySheet(view, element, node.css);
        return element;
      }
      if (rel.includes("stylesheet")) {
        element = doc.createElement("link");
        element.setAttribute("rel", "stylesheet");
        for (const [name, value] of Object.entries(node.a ?? {})) {
          if (name !== "integrity" && name !== "crossorigin") setAttribute(view, element, name, value);
        }
        register(view, node.id, element);
        return element;
      }
      element = doc.createElement("template");
      element.setAttribute("data-pa-link", rel.join(" "));
      register(view, node.id, element);
      return element;
    }
    try {
      element =
        node.ns === "svg" ? doc.createElementNS(SVG, node.tag) : node.ns === "math" ? doc.createElementNS(MATHML, node.tag) : doc.createElement(node.tag);
    } catch {
      element = doc.createElement("span");
    }
    register(view, node.id, element);
    if (node.a !== undefined) {
      for (const [name, value] of Object.entries(node.a)) setAttribute(view, element, name, value);
    }
    if (tag === "iframe" || tag === "frame") {
      element.setAttribute("sandbox", "allow-same-origin");
      element.removeAttribute("src");
    }
    if (tag === "style") {
      applySheet(view, element, node.css ?? "");
      return element;
    }
    if (tag === "template") return element;
    if (node.sh !== undefined) {
      let root: ShadowRoot | null = null;
      try {
        root = element.attachShadow({ mode: "open" });
      } catch {
        root = null;
      }
      if (root !== null) {
        for (const child of node.sh) {
          const built = build(view, child);
          if (built !== null) root.appendChild(built);
        }
        if (node.shs !== undefined) applyAdopted(view, root, node.shs);
      }
    }
    if (node.c !== undefined) {
      for (const child of node.c) {
        const built = build(view, child);
        if (built !== null) element.appendChild(built);
      }
    }
    if (node.v !== undefined) setValue(element, node.v);
    if (node.ck !== undefined) (element as HTMLInputElement).checked = node.ck;
    if (node.cv !== undefined && tag === "canvas") drawCanvas(element as HTMLCanvasElement, node.cv);
    if (node.sc !== undefined) {
      const [x, y] = node.sc;
      deferred.push(() => element.scrollTo(x, y));
    }
    if (tag === "iframe") {
      // A child frame that arrived before its iframe did.
      const key = `${view.token}:${node.id}`;
      const waiting = held.get(key);
      if (waiting !== undefined) {
        held.delete(key);
        deferred.push(() => void applySnapshot(waiting));
      }
    }
    return element;
  };

  const setValue = (element: Element, value: string): void => {
    const tag = element.localName;
    if (tag === "input" || tag === "textarea" || tag === "select") (element as HTMLInputElement).value = value;
  };

  const register = (view: FrameView, id: number, node: Node): void => {
    const previous = view.nodes.get(id);
    if (previous !== undefined && previous !== node) unregister(view, previous);
    view.nodes.set(id, node);
    view.ids.set(node, id);
  };

  const unregister = (view: FrameView, node: Node): void => {
    const id = view.ids.get(node);
    if (id !== undefined && view.nodes.get(id) === node) view.nodes.delete(id);
    view.sheets.delete(node);
    if (node.nodeType === 1) {
      const element = node as Element;
      linkedSheets.delete(element);
      if (element.shadowRoot !== null) {
        view.adopted.delete(element.shadowRoot);
        for (const child of element.shadowRoot.childNodes) unregister(view, child);
      }
      if (element.localName === "iframe") {
        // Whatever child frame lived here is gone with it.
        for (const [token, child] of [...views]) {
          if (child.host !== null && child.host.frame === view.token && child.host.id === id) dropView(token);
        }
      }
    }
    for (const child of node.childNodes) unregister(view, child);
  };

  const dropView = (token: string): void => {
    const view = views.get(token);
    if (view === undefined) return;
    views.delete(token);
    for (const [child, childView] of [...views]) {
      if (childView.host !== null && childView.host.frame === token) dropView(child);
    }
  };

  const runDeferred = (): void => {
    const batch = deferred;
    deferred = [];
    for (const run of batch) {
      try {
        run();
      } catch {
        /* a node that went between the op and the layout */
      }
    }
  };

  /* ------------------------------- snapshots ------------------------------ */

  const applySnapshot = (message: MirrorSnapshotMessage): "ok" | "held" => {
    let doc: Document;
    let host: FrameView["host"] = null;
    if (message.host === undefined) {
      doc = options.document;
      // Children of the previous main document are all gone with it.
      for (const token of [...views.keys()]) dropView(token);
    } else {
      host = message.host;
      const parent = views.get(message.host.frame);
      const iframe = parent?.nodes.get(message.host.id);
      const childDoc = iframe?.nodeType === 1 && (iframe as Element).localName === "iframe" ? (iframe as HTMLIFrameElement).contentDocument : null;
      if (parent === undefined || childDoc === null || childDoc === undefined) {
        held.set(`${message.host.frame}:${message.host.id}`, message);
        return "held";
      }
      doc = childDoc;
      if (views.has(message.frame)) dropView(message.frame);
      // Another child that rendered into this same iframe earlier (a navigation) is superseded.
      for (const [token, other] of [...views]) {
        if (other.host !== null && other.host.frame === host.frame && other.host.id === host.id) dropView(token);
      }
    }
    resetDocument(doc);
    const view = newView(message.frame, doc, host);
    view.epoch = message.epoch;
    view.seq = message.seq;
    const root = message.root;
    if (root.t !== "doc") return "ok";
    view.nodes.set(root.id, doc);
    view.ids.set(doc, root.id);
    for (const child of root.c) {
      if (child.t === "e" && child.tag.toLowerCase() === "html") {
        const html = doc.documentElement;
        register(view, child.id, html);
        for (const [name, value] of Object.entries(child.a ?? {})) setAttribute(view, html, name, value);
        for (const part of child.c ?? []) {
          if (part.t === "e" && part.tag.toLowerCase() === "head") {
            const head = doc.head;
            register(view, part.id, head);
            for (const [name, value] of Object.entries(part.a ?? {})) setAttribute(view, head, name, value);
            for (const inner of part.c ?? []) {
              const built = build(view, inner);
              if (built !== null) head.appendChild(built);
            }
          } else if (part.t === "e" && part.tag.toLowerCase() === "body") {
            const body = doc.body;
            register(view, part.id, body);
            for (const [name, value] of Object.entries(part.a ?? {})) setAttribute(view, body, name, value);
            for (const inner of part.c ?? []) {
              const built = build(view, inner);
              if (built !== null) body.appendChild(built);
            }
          } else {
            const built = build(view, part);
            if (built !== null) html.appendChild(built);
          }
        }
        if (child.sc !== undefined) {
          const [x, y] = child.sc;
          deferred.push(() => html.scrollTo(x, y));
        }
      }
    }
    if (root.adopted !== undefined) applyAdopted(view, doc, root.adopted);
    if (root.sc !== undefined) {
      const [x, y] = root.sc;
      deferred.push(() => doc.defaultView?.scrollTo(x, y));
    }
    if (message.focus !== null) {
      const id = message.focus;
      deferred.push(() => focusNode(view, id));
    }
    runDeferred();
    options.onDocument?.(message.frame, doc);
    return "ok";
  };

  const focusNode = (view: FrameView, id: number | null): void => {
    if (options.mayFocus !== undefined && !options.mayFocus()) return;
    if (id === null) {
      const active = view.doc.activeElement as HTMLElement | null;
      active?.blur?.();
      return;
    }
    const node = view.nodes.get(id);
    if (node?.nodeType === 1 && "focus" in node) (node as HTMLElement).focus({ preventScroll: true });
  };

  /* -------------------------------- patches ------------------------------- */

  const applyOp = (view: FrameView, op: MirrorOp): void => {
    switch (op.o) {
      case "add": {
        const parent = view.nodes.get(op.p);
        if (parent === undefined) return;
        let container: Node = parent;
        if (parent.nodeType === 1 && (parent as Element).localName === "template") return;
        if (parent.nodeType === 1 && (parent as Element).localName === "style") return;
        // The recorder addresses a shadow tree's children by their host; the
        // renderer's shadow root is where they go.
        if (op.sh === true) {
          if (parent.nodeType !== 1) return;
          let root = (parent as Element).shadowRoot;
          if (root === null) {
            try {
              root = (parent as Element).attachShadow({ mode: "open" });
            } catch {
              return;
            }
          }
          container = root;
        }
        const existing = view.nodes.get(op.n.id);
        if (existing !== undefined) {
          unregister(view, existing);
          existing.parentNode?.removeChild(existing);
        }
        const built = build(view, op.n);
        if (built === null) return;
        const before = op.b === null ? null : (view.nodes.get(op.b) ?? null);
        if (before !== null && before.parentNode === container) container.insertBefore(built, before);
        else container.appendChild(built);
        return;
      }
      case "rm": {
        const node = view.nodes.get(op.id);
        if (node === undefined) return;
        if (node === view.doc.documentElement || node === view.doc.head || node === view.doc.body) return;
        unregister(view, node);
        node.parentNode?.removeChild(node);
        return;
      }
      case "attr": {
        const node = view.nodes.get(op.id);
        if (node === undefined || node.nodeType !== 1) return;
        let element = node as Element;
        if (element.localName === "template" && element.hasAttribute("data-pa-blocked")) return;
        if (op.k.toLowerCase() === "href" && element.localName === "style" && element.hasAttribute("data-pa-link")) {
          const replacement = view.doc.createElement("link");
          for (const name of ["id", "class", "title", "media"]) {
            const value = element.getAttribute(name);
            if (value !== null) replacement.setAttribute(name, value);
          }
          replacement.rel = "stylesheet";
          element.parentNode?.replaceChild(replacement, element);
          view.nodes.set(op.id, replacement); view.ids.set(replacement, op.id);
          element = replacement;
        }
        if (op.v === null) {
          if (element.localName === "iframe" && op.k.toLowerCase() === "sandbox") return;
          if (op.k.toLowerCase() === "contenteditable") element.removeAttribute("data-pa-editor");
          if (op.k.toLowerCase() === "href") linkedSheets.delete(element);
          element.removeAttribute(op.k);
          return;
        }
        if (element.localName === "iframe" && (op.k.toLowerCase() === "src" || op.k.toLowerCase() === "sandbox")) return;
        setAttribute(view, element, op.k, op.v);
        return;
      }
      case "txt": {
        const node = view.nodes.get(op.id);
        if (node === undefined || node.nodeType !== 3) return;
        node.nodeValue = op.s;
        return;
      }
      case "val": {
        const node = view.nodes.get(op.id);
        if (node === undefined || node.nodeType !== 1) return;
        if (options.mayApplyValue !== undefined && !options.mayApplyValue(view.token, op.id, node as Element)) return;
        setValue(node as Element, op.v);
        return;
      }
      case "chk": {
        const node = view.nodes.get(op.id);
        if (node === undefined || node.nodeType !== 1) return;
        (node as HTMLInputElement).checked = op.v;
        return;
      }
      case "scroll": {
        const node = view.nodes.get(op.id);
        if (node === undefined) return;
        if (node === view.doc) {
          if (options.mayApplyScroll !== undefined && !options.mayApplyScroll(view.token, op.id, view.doc)) return;
          view.doc.defaultView?.scrollTo(op.x, op.y);
          return;
        }
        if (node.nodeType !== 1) return;
        if (options.mayApplyScroll !== undefined && !options.mayApplyScroll(view.token, op.id, node as Element)) return;
        (node as Element).scrollTo(op.x, op.y);
        return;
      }
      case "css": {
        const node = view.nodes.get(op.id);
        if (node === undefined || node.nodeType !== 1) return;
        let style = node as Element;
        if (style.localName === "link" || (style.localName === "template" && style.hasAttribute("data-pa-link"))) {
          // A linked sheet the host fetched after the fact: the link becomes a style.
          const replacement = view.doc.createElement("style");
          replacement.setAttribute("data-pa-link", "stylesheet");
          for (const name of ["id", "class", "title", "media"]) {
            const value = style.getAttribute(name);
            if (value !== null) replacement.setAttribute(name, value);
          }
          style.parentNode?.replaceChild(replacement, style);
          view.nodes.set(op.id, replacement);
          view.ids.set(replacement, op.id);
          style = replacement;
        }
        if (style.localName !== "style") return;
        applySheet(view, style, op.s);
        return;
      }
      case "adopted": {
        if (op.id === 1) {
          applyAdopted(view, view.doc, op.s);
          return;
        }
        const node = view.nodes.get(op.id);
        const root = node !== undefined && node.nodeType === 1 ? (node as Element).shadowRoot : null;
        if (root !== null && root !== undefined) applyAdopted(view, root, op.s);
        return;
      }
      case "shadow": {
        const node = view.nodes.get(op.id);
        if (node === undefined || node.nodeType !== 1) return;
        const element = node as Element;
        let root = element.shadowRoot;
        if (root === null) {
          try {
            root = element.attachShadow({ mode: "open" });
          } catch {
            return;
          }
        } else {
          for (const child of [...root.childNodes]) unregister(view, child);
          root.replaceChildren();
        }
        for (const child of op.c) {
          const built = build(view, child);
          if (built !== null) root.appendChild(built);
        }
        if (op.s !== undefined) applyAdopted(view, root, op.s);
        return;
      }
      case "canvas": {
        const node = view.nodes.get(op.id);
        if (node?.nodeType === 1 && (node as Element).localName === "canvas") drawCanvas(node as HTMLCanvasElement, op.u);
        return;
      }
      case "focus":
        focusNode(view, op.id);
        return;
      case "title":
      case "url":
        return;
    }
  };

  const applyPatch = (message: MirrorPatchMessage): "ok" | "gap" | "stale" | "unknown" => {
    const view = views.get(message.frame);
    if (view === undefined) return "unknown";
    if (message.epoch < view.epoch) return "stale";
    if (message.epoch > view.epoch || message.seq !== view.seq + 1) return "gap";
    for (const op of message.ops) {
      try {
        applyOp(view, op);
      } catch {
        /* one op the engine refused; the next patch carries on */
      }
    }
    view.seq = message.seq;
    runDeferred();
    return "ok";
  };

  /* --------------------------------- assets ------------------------------- */

  const notify = (id: string): void => {
    const set = waiters.get(id);
    if (set === undefined) return;
    for (const fill of [...set]) {
      try {
        fill();
      } catch {
        /* a waiter whose node is gone */
      }
    }
  };

  const resolveAsset = (id: string, url: string, type: string, text: string | null): void => {
    if (text !== null) {
      // A stylesheet asset: its own URL is built from its rendered text, and
      // rebuilt when something it names arrives.
      const asset: Asset = { url: null, type, text, missing: false };
      assets.set(id, asset);
      const render = (): void => {
        if (assets.get(id) !== asset) return;
        const rendered = renderText(text, render);
        const win = options.document.defaultView as any;
        const BlobCtor = win?.Blob ?? Blob;
        const URLCtor = win?.URL ?? URL;
        if (asset.url !== null) URLCtor.revokeObjectURL(asset.url);
        asset.url = URLCtor.createObjectURL(new BlobCtor([rendered], { type: type === "" ? "text/css" : type }));
        notify(id);
      };
      render();
      return;
    }
    assets.set(id, { url, type, text: null, missing: false });
    notify(id);
  };

  const assetMissing = (id: string): void => {
    assets.set(id, { url: null, type: "", text: null, missing: true });
    notify(id);
  };

  const needsStylesheet = (id: string): boolean => {
    const seen = new Set<string>();
    const imports = (css: string): boolean => {
      for (const match of css.matchAll(/@import\s+(?:url\(\s*)?["']?pa-asset:([A-Za-z0-9_-]+)/giu)) {
        const dependency = match[1]!;
        if (dependency === id) return true;
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        const nested = assets.get(dependency)?.text;
        if (nested && imports(nested)) return true;
      }
      return false;
    };
    const activeSheet = (element: Element): boolean => element.isConnected && !element.hasAttribute("disabled")
      && (!element.getAttribute("media") || !!element.ownerDocument.defaultView?.matchMedia(element.getAttribute("media")!).matches);
    for (const [element, dependency] of linkedSheets) {
      if (!element.isConnected) { linkedSheets.delete(element); continue; }
      if (!activeSheet(element) || !(element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/u).includes("stylesheet")) continue;
      if (dependency === id) return true;
      const css = assets.get(dependency)?.text;
      if (css && imports(css)) return true;
    }
    for (const view of views.values()) {
      for (const [node, css] of view.sheets) if (activeSheet(node as Element) && imports(css)) return true;
      for (const [root, sheets] of view.adopted) if (root.isConnected && sheets.some(imports)) return true;
    }
    return false;
  };

  /* ---------------------------------- api --------------------------------- */

  return {
    applySnapshot,
    applyPatch,
    frameGone: (frame) => {
      const view = views.get(frame);
      if (view === undefined) return;
      dropView(frame);
      if (view.host !== null) resetDocument(view.doc);
    },
    resolveAsset,
    assetMissing,
    needsStylesheet,
    pendingAssets: () => [...waiters.keys()].filter((id) => assets.get(id)?.url == null && assets.get(id)?.missing !== true),
    idOf: (node) => {
      const doc = node.nodeType === 9 ? (node as Document) : node.ownerDocument;
      if (doc === null) return null;
      const token = byDocument.get(doc);
      if (token === undefined) return null;
      const view = views.get(token);
      if (view === undefined) return null;
      const id = view.ids.get(node);
      return id === undefined ? null : { frame: token, id };
    },
    nodeOf: (frame, id) => views.get(frame)?.nodes.get(id) ?? null,
    frameOf: (document) => {
      const token = byDocument.get(document);
      return token !== undefined && views.has(token) ? token : null;
    },
    documentOf: (frame) => views.get(frame)?.doc ?? null,
    position: (frame) => {
      const view = views.get(frame);
      return view === undefined ? null : { epoch: view.epoch, seq: view.seq };
    },
    dispose: () => {
      for (const asset of assets.values()) {
        if (asset.url !== null && asset.text !== null) {
          try {
            URL.revokeObjectURL(asset.url);
          } catch {
            /* already gone */
          }
        }
      }
      assets.clear(); linkedSheets.clear();
      waiters.clear();
      views.clear();
      held.clear();
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
