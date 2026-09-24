/** One cloud document, shared by its viewers. Epochs fence both patches and
 * input; the input queue rechecks authority immediately before dispatch. */
import type { CDPSession, Frame, Page } from "playwright-core";
import { mediaBatchSchema, mediaStateSchema, collectAssetIds, collectOpAssetIds, mirrorClientMessageSchema, recorderReportSchema, rewriteNode, rewriteOp,
  type MirrorClientMessage, type MirrorNode, type MirrorOp, type MirrorServerMessage, type RecorderControl } from "@pistachio/dom-mirror";
import { silentLogger, type Logger } from "../../logger.js";
import type { AssetBroker } from "./asset-broker.js";
import type { PageMediaProxy } from "../../browser/media-proxy.js";

export interface MirrorViewer { send(message: MirrorServerMessage): void; hybridMedia?: boolean; mediaOnly?: boolean; canSendMedia?(): boolean; }
export interface TabMirrorOptions { page: Page; session: CDPSession; tabId: string; broker: AssetBroker; control: string; ready?: () => Promise<void>; log?: Logger; media?: PageMediaProxy; }
export class TabMirror {
  readonly tabId: string;
  readonly #page: Page;
  readonly #session: CDPSession;
  readonly #broker: AssetBroker;
  readonly #control: string;
  readonly #ready: () => Promise<void>;
  readonly #log: Logger;
  readonly #viewers = new Set<MirrorViewer>();
  readonly #acks = new Map<MirrorViewer, number>();
  readonly #revisions = new WeakMap<MirrorViewer, Map<string, number>>();
  readonly #mediaCursors = new WeakMap<MirrorViewer, Map<string, { ids: string; seq: number }>>();
  readonly #assetIds = new Set<string>();
  readonly #tags = new Map<number, string>();
  readonly #sheetBases = new Map<number, string>();
  readonly #blobs = new Set<string>();
  readonly #deferredAssets = new Set<string>();
  readonly #offAvailable: () => void;
  readonly #media: PageMediaProxy | undefined;
  #mediaTimer: ReturnType<typeof setTimeout> | undefined;
  #mediaBusy = false;
  #epoch = 0;
  #seq = 0;
  #documentId = "";
  #scope = "";
  #base = "";
  #disposed = false;
  #snapshots: Promise<void> = Promise.resolve();
  #inputs: Promise<void> = Promise.resolve();
  #queued = 0;
  #navigationRevision = 0;
  readonly #onNavigation = (frame: Frame): void => {
    if (frame !== this.#page.mainFrame()) return;
    const revision = ++this.#navigationRevision;
    // Playwright also emits this for history.replaceState/pushState. A SPA
    // route update does not replace the recorder or require a new snapshot.
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1_000); timer.unref(); });
    const identity = this.#page.evaluate(control => {
      return (globalThis as unknown as Record<string, RecorderControl>)[control]?.documentId;
    }, this.#control).catch(() => undefined);
    // A wedged old execution context cannot suppress the bounded startup path.
    void Promise.race([identity, deadline]).then(documentId => {
      if (this.#disposed || revision !== this.#navigationRevision) return;
      if (documentId && documentId === this.#documentId) return;
      this.#documentId = "";
      this.#broadcast({ k: "stopped" });
      if (this.#viewers.size > 0) void this.#snapshot("navigation");
    }).finally(() => clearTimeout(timer));
  };
  readonly #onLoaded = (): void => { if (this.#viewers.size > 0 && this.#documentId === "") void this.#snapshot("loaded"); };

  constructor(options: TabMirrorOptions) {
    this.tabId = options.tabId; this.#page = options.page; this.#session = options.session;
    this.#broker = options.broker; this.#control = options.control;
    this.#ready = options.ready ?? (() => Promise.resolve());
    this.#log = options.log ?? silentLogger;
    this.#media = options.media;
    this.#offAvailable = this.#broker.onAvailable(id => {
      if (this.#deferredAssets.has(id) && this.allowsAsset(id)) this.#broadcast({ k: "assetReady", id });
    });
    this.#page.on("framenavigated", this.#onNavigation);
    this.#page.on("domcontentloaded", this.#onLoaded);
  }
  get idle(): boolean { return this.#viewers.size === 0; }
  get session(): CDPSession { return this.#session; }
  assetIds(): ReadonlySet<string> { return this.#assetIds; }
  allowsAsset(id: string): boolean { return this.#broker.belongsTo(id, this.#scope); }
  assetDiagnostic(id: string) { return this.#broker.diagnostic(id); }
  async asset(id: string): Promise<Awaited<ReturnType<AssetBroker["bytesFor"]>> | "deferred"> {
    if (!this.allowsAsset(id)) return null;
    if (this.#broker.unrequested(id)) {
      this.#deferredAssets.add(id);
      return "deferred";
    }
    // Subscribe before waiting so completion cannot race the HTTP response.
    this.#deferredAssets.add(id);
    const url = this.#broker.urlOf(id);
    if (url?.startsWith("blob:") && !this.#blobs.has(url)) {
      this.#blobs.add(url);
      await this.#page.evaluate(async ([control, epoch, url]) => {
        const api = (globalThis as unknown as Record<string, RecorderControl>)[control as string];
        if (api?.epoch === epoch) await api.extractBlob(url as string);
      }, [this.#control, this.#epoch, url] as const).catch(() => undefined);
    }
    return this.#broker.bytesFor(id);
  }
  onReport(payload: unknown): void {
    const parsed = recorderReportSchema.safeParse(payload);
    if (!parsed.success || this.#disposed) return;
    const report = parsed.data;
    if (report.documentId !== this.#documentId || report.epoch !== this.#epoch) return;
    if (report.kind === "patch") this.#patch(report.ops);
    else if (report.kind === "unsuitable") {
      this.#log.info("DOM mirror unsuitable", { tabId: this.tabId, epoch: this.#epoch, reason: report.reason });
      this.#broadcast({ k: "unsuitable", reason: report.reason });
    }
    else if (report.kind === "blob" && report.url.startsWith("blob:")) {
      this.#broker.provideBlob(report.url, report.type, Buffer.from(report.base64, "base64"), this.#scope);
    }
  }
  async attach(viewer: MirrorViewer): Promise<void> { this.#viewers.add(viewer); await this.#snapshot("attach"); }
  detach(viewer: MirrorViewer): void {
    this.#viewers.delete(viewer); this.#acks.delete(viewer); this.#revisions.delete(viewer); this.#mediaCursors.delete(viewer);
    if (this.idle) { clearTimeout(this.#mediaTimer); this.#mediaTimer = undefined; }
  }

  async openMedia(id: number, epoch: number, source: string, range: string, signal: AbortSignal): Promise<Awaited<ReturnType<PageMediaProxy["open"]>>> {
    if (!this.#media || this.#disposed || this.idle || this.#epoch !== epoch || !this.#documentId) throw new Error("Media document is gone");
    const current = await this.#page.evaluate(([control, epoch, id]) => {
      const api = (globalThis as unknown as Record<string, RecorderControl>)[control as string];
      return api?.epoch === epoch ? api.mediaState().find(item => item.id === id) : null;
    }, [this.#control, epoch, id] as const);
    if (!current || current.source !== source || current.unsupported || this.#epoch !== epoch) throw new Error("Media source changed");
    if (!this.#media.has(source)) {
      await this.#page.evaluate(([control, epoch, id]) => {
        const api = (globalThis as unknown as Record<string, RecorderControl>)[control as string];
        if (api?.epoch === epoch) api.prepareMedia(id as number);
      }, [this.#control, epoch, id] as const);
      await this.#media.waitFor(source, signal);
      if (this.#epoch !== epoch || !this.#documentId || this.#disposed) throw new Error("Media document changed");
    }
    return this.#media.open(source, range, signal);
  }

  #scheduleMedia(): void {
    if (this.#disposed || this.idle || this.#mediaTimer || this.#mediaBusy) return;
    this.#mediaTimer = setTimeout(() => { this.#mediaTimer = undefined; void this.#pollMedia(); }, 250);
    this.#mediaTimer.unref();
  }
  async #pollMedia(): Promise<void> {
    if (this.#disposed || this.idle || !this.#documentId) { this.#scheduleMedia(); return; }
    const epoch = this.#epoch;
    this.#mediaBusy = true;
    try {
      const raw = await this.#page.evaluate(([control, epoch]) => {
        const api = (globalThis as unknown as Record<string, RecorderControl>)[control as string];
        return api?.epoch === epoch ? api.mediaState() : null;
      }, [this.#control, epoch] as const);
      const parsed = mediaStateSchema.array().max(32).safeParse(raw);
      if (!parsed.success || epoch !== this.#epoch || !this.#documentId || this.#disposed) return;
      const items = parsed.data;
      for (const viewer of this.#viewers) {
        if (viewer.hybridMedia) {
          viewer.send({ k: "media", frame: "main", epoch, items });
          const cursors = this.#mediaCursors.get(viewer) ?? new Map<string, { ids: string; seq: number }>();
          this.#mediaCursors.set(viewer, cursors);
          const sources = new Set(items.filter(item => item.mse && !item.unsupported).map(item => item.source));
          for (const source of cursors.keys()) if (!sources.has(source)) cursors.delete(source);
          for (const source of sources) {
            if (viewer.canSendMedia?.() === false) break;
            const ids = items.filter(item => item.source === source).map(item => item.id).sort((a, b) => a - b).join(",");
            const cursor = cursors.get(source);
            const after = cursor?.ids === ids ? cursor.seq : 0;
            const rawBatch = await this.#page.evaluate(({ control, epoch, source, after }) => {
              const api = (globalThis as unknown as Record<string, RecorderControl>)[control];
              return api?.epoch === epoch ? api.mediaData(source, after) : null;
            }, { control: this.#control, epoch, source, after });
            if (epoch !== this.#epoch || !this.#viewers.has(viewer) || !this.#documentId) return;
            const batch = mediaBatchSchema.safeParse(rawBatch);
            if (!batch.success || batch.data.source !== source || viewer.canSendMedia?.() === false) continue;
            if (batch.data.chunks.length || batch.data.failed) viewer.send({ k: "mediaData", frame: "main", epoch, batch: batch.data });
            const last = batch.data.chunks.at(-1);
            if (last) cursors.set(source, { ids, seq: last.seq });
          }
        }
        else if (items.some(item => item.kind === "video" && item.visible)) viewer.send({ k: "unsuitable", reason: "video" });
      }
    } catch { /* Navigation or suspension invalidates this poll. */ }
    finally { this.#mediaBusy = false; this.#scheduleMedia(); }
  }

  #snapshot(trigger = "resync"): Promise<void> {
    // Fence immediately, including an in-flight snapshot from the old document.
    // Coalesce load/navigation/resync requests instead of serializing obsolete trees.
    const epoch = ++this.#epoch;
    this.#documentId = "";
    const current = (): boolean => !this.#disposed && !this.idle && epoch === this.#epoch;
    const run = async (): Promise<void> => {
      if (!current()) return;
      const started = Date.now();
      let hostname: string | undefined;
      try { hostname = new URL(this.#page.url()).hostname; } catch { /* no document URL yet */ }
      let stage = "instrument";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Error("Mirror startup deadline");
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(expired), 8_000); });
      // Bound the whole startup, not each retry. A stalled evaluate must not
      // hold every future navigation/resync behind an unresolved promise.
      const wait = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline]);
      this.#log.info("DOM mirror startup", { tabId: this.tabId, hostname, epoch, trigger, domViewers: [...this.#viewers].filter(viewer => !viewer.mediaOnly).length, audioViewers: [...this.#viewers].filter(viewer => viewer.mediaOnly).length });
      try {
        await wait(this.#ready());
        if (!current()) return;
        stage = "record";
        const record = (mediaOnly: boolean): Promise<unknown> => wait(this.#page.evaluate(([control, epoch, mediaOnly]) => {
          const api = (globalThis as unknown as Record<string, RecorderControl>)[control as string];
          // An old timed-out evaluation may only reach the page after a newer one.
          return api && api.epoch <= epoch ? api.start(epoch as number, mediaOnly as boolean) : undefined;
        }, [this.#control, epoch, mediaOnly] as const));
        let raw: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!current()) return;
          try {
            raw = await record([...this.#viewers].every(viewer => viewer.mediaOnly));
            if (raw !== undefined) break;
          } catch (error) {
            // A navigation can destroy the execution context AFTER DOMContentLoaded
            // has already fired. Retry here rather than relying on another event.
            const transient = error instanceof Error && /execution context was destroyed|cannot find context|most likely because of a navigation/iu.test(error.message);
            if (!transient || attempt === 2) throw error;
          }
          if (!current()) return;
          if (attempt < 2) await wait(new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1))));
        }
        if (!current()) return;
        stage = "validate";
        let parsed = recorderReportSchema.safeParse(raw);
        if (!parsed.success) throw new Error("Invalid recorder snapshot");
        if (parsed.data.kind === "unsuitable") {
          this.#log.info("DOM mirror unsuitable", { tabId: this.tabId, hostname, epoch, reason: parsed.data.reason });
          this.#broadcast({ k: "unsuitable", reason: parsed.data.reason });
          // Suitability applies to page rendering, not its independent audio lane.
          stage = "record";
          raw = await record(true);
          if (!current()) return;
          stage = "validate";
          parsed = recorderReportSchema.safeParse(raw);
          if (!parsed.success) throw new Error("Invalid audio snapshot");
        }
        const report = parsed.data;
        if (report.kind !== "snapshot" || report.documentId === undefined) throw new Error("Missing recorder document");
        stage = "rewrite";
        this.#base = report.base;
        this.#scope = this.#broker.scopeFor(this.#page); this.#seq = 0;
        this.#assetIds.clear(); this.#tags.clear(); this.#sheetBases.clear(); this.#blobs.clear(); this.#deferredAssets.clear();
        this.#index(report.root);
        const root = rewriteNode(report.root, this.#base, this.#broker.resolver(this.#scope));
        for (const id of collectAssetIds(root)) this.#assetIds.add(id);
        for (const viewer of this.#viewers) { this.#acks.set(viewer, 0); this.#revisions.delete(viewer); this.#mediaCursors.delete(viewer); }
        this.#documentId = report.documentId;
        stage = "send";
        this.#broadcast({ k: "snapshot", frame: "main", epoch, seq: 0, url: report.url, title: report.title, root,
          focus: report.focus, width: report.width, height: report.height });
        this.#log.info("DOM mirror snapshot sent", { tabId: this.tabId, hostname, epoch, nodes: report.nodes, elapsedMs: Date.now() - started });
        this.#scheduleMedia();
      } catch (error) {
        if (!current()) return;
        this.#documentId = "";
        // Never log exception text: the page can put private content in it.
        this.#log.warn("DOM mirror startup failed", { tabId: this.tabId, hostname, epoch, stage, timeout: error === expired, elapsedMs: Date.now() - started });
        this.#broadcast({ k: "unsuitable", reason: "error", detail: `startup-${stage}` });
      } finally { clearTimeout(timer); }
    };
    this.#snapshots = this.#snapshots.then(run, run);
    return this.#snapshots;
  }
  #index(node: MirrorNode): void {
    if (node.t === "e") {
      this.#tags.set(node.id, node.tag);
      if (node.tag === "link" && node.a?.["href"]) {
        try { this.#sheetBases.set(node.id, new URL(node.a["href"], this.#base).href); } catch { /* malformed URL */ }
      }
      for (const child of [...(node.c ?? []), ...(node.sh ?? [])]) this.#index(child);
    } else if (node.t === "doc") for (const child of node.c) this.#index(child);
  }
  #patch(ops: MirrorOp[]): void {
    const rewritten = ops.map(op => {
      if (op.o === "add") this.#index(op.n);
      if (op.o === "shadow") for (const node of op.c) this.#index(node);
      if (op.o === "attr" && op.k === "href" && op.v && this.#tags.get(op.id) === "link") {
        try { this.#sheetBases.set(op.id, new URL(op.v, this.#base).href); } catch { /* invalid URL */ }
      }
      const base = op.o === "css" ? this.#sheetBases.get(op.id) ?? this.#base : this.#base;
      return rewriteOp(op, base, this.#broker.resolver(this.#scope), id => this.#tags.get(id) ?? null);
    });
    for (const op of rewritten) for (const id of collectOpAssetIds(op)) this.#assetIds.add(id);
    this.#seq += 1;
    for (const viewer of this.#viewers) {
      if (viewer.mediaOnly) continue;
      if (this.#seq - (this.#acks.get(viewer) ?? 0) > 256) {
        viewer.send({ k: "unsuitable", reason: "too_large", detail: "Viewer cannot keep up with document changes" });
        this.detach(viewer);
      } else viewer.send({ k: "patch", frame: "main", epoch: this.#epoch, seq: this.#seq, ops: rewritten });
    }
  }
  #broadcast(message: MirrorServerMessage): void {
    for (const viewer of this.#viewers) {
      if (viewer.mediaOnly && message.k !== "snapshot" && message.k !== "stopped") continue;
      // Audio viewers receive only an epoch boundary, never page text or assets.
      viewer.send(viewer.mediaOnly && message.k === "snapshot"
        ? { ...message, root: { t: "doc", id: 1, c: [] }, title: "Audio playback", url: "about:blank", focus: null } : message);
    }
  }

  handle(message: MirrorClientMessage, viewer?: MirrorViewer, mayAct: () => boolean = () => true): Promise<void> {
    const parsed = mirrorClientMessageSchema.safeParse(message);
    if (!parsed.success || this.#disposed) return Promise.resolve();
    const value = parsed.data;
    if (value.k === "resync") return this.#snapshot();
    if (value.k === "ack") {
      if (viewer && value.frame === "main" && value.epoch === this.#epoch && value.seq <= this.#seq) {
        this.#acks.set(viewer, Math.max(this.#acks.get(viewer) ?? 0, value.seq));
      }
      return Promise.resolve();
    }
    if (!("epoch" in value) || value.frame !== "main" || value.epoch !== this.#epoch || this.#documentId === "" || this.#queued >= 256) return Promise.resolve();
    const epoch = this.#epoch;
    const valid = (): boolean => !this.#disposed && this.#documentId !== "" && epoch === this.#epoch && (!viewer || this.#viewers.has(viewer)) && mayAct();
    const run = async (): Promise<void> => {
      try {
        if (!valid()) return;
        const control = this.#control;
        if (value.k === "focusEditor") {
          const ok = await this.#page.evaluate(([control, epoch, id]) => {
            const api = (globalThis as unknown as Record<string, RecorderControl>)[control as string];
            return api?.epoch === epoch && api.focusEditor(id as number);
          }, [control, epoch, value.id] as const);
          // Preserve the user's click/caret position and native editor handlers.
          // The focus event may reflow the composer, so read its new box first.
          if (ok && value.point && valid()) {
            const rect = await this.#page.evaluate(([control, epoch, id]) => {
              const api = (globalThis as unknown as Record<string, RecorderControl>)[control as string];
              return api?.epoch === epoch ? api.rect(id as number) : null;
            }, [control, epoch, value.id] as const);
            if (!rect || !valid()) return;
            const point = { x: rect.x + value.point.fx * rect.w, y: rect.y + value.point.fy * rect.h, button: "left" as const, clickCount: 1, modifiers: value.point.modifiers };
            await this.#session.send("Input.dispatchMouseEvent", { ...point, type: "mousePressed" });
            await this.#session.send("Input.dispatchMouseEvent", { ...point, type: "mouseReleased" });
          }
          if (valid()) viewer?.send({ k: "editorFocused", epoch, id: value.id, ok });
        } else if (value.k === "pointer") {
          if (value.id === null) return;
          const rect = await this.#page.evaluate(([control, epoch, id]) => {
            const api = (globalThis as unknown as Record<string, RecorderControl>)[control as string];
            return api?.epoch === epoch ? api.rect(id as number) : null;
          }, [control, epoch, value.id] as const);
          if (!rect || rect.w <= 0 || rect.h <= 0 || !valid()) return;
          await this.#session.send("Input.dispatchMouseEvent", { type: value.type, x: rect.x + value.fx * rect.w, y: rect.y + value.fy * rect.h,
            button: ["left", "middle", "right"].includes(value.button) ? value.button : "none", clickCount: value.clickCount, modifiers: value.modifiers });
        } else if (value.k === "key") {
          if (value.id !== null) {
            const focused = await this.#page.evaluate(([control, epoch, id]) => {
              const api = (globalThis as unknown as Record<string, RecorderControl>)[control as string];
              return api?.epoch === epoch && api.focus(id as number);
            }, [control, epoch, value.id] as const);
            if (!focused) return;
          }
          if (!valid()) return;
          const { kind: _kind, ...event } = value.event;
          await this.#session.send("Input.dispatchKeyEvent", { ...event, ...(event.text === undefined ? {} : { unmodifiedText: event.text }),
            ...(event.windowsVirtualKeyCode === undefined ? {} : { nativeVirtualKeyCode: event.windowsVirtualKeyCode }) });
        } else if (value.k === "media") {
          const revisions = viewer ? this.#revisions.get(viewer) ?? new Map<string, number>() : new Map<string, number>();
          const key = `media:${value.id}`;
          if (viewer && value.rev <= (revisions.get(key) ?? -1)) return;
          if (viewer) this.#revisions.set(viewer, revisions);
          revisions.set(key, value.rev);
          const ok = await this.#page.evaluate(async ([control, epoch, id, command]) => {
            const api = (globalThis as unknown as Record<string, RecorderControl>)[control as string];
            return api?.epoch === epoch ? api.mediaAction(id as number, command as Extract<MirrorClientMessage, { k: "media" }>["command"]) : false;
          }, [this.#control, epoch, value.id, value.command] as const);
          if (valid() && viewer) viewer.send({ k: "mediaAck", frame: "main", epoch, id: value.id, rev: value.rev, ok });
        } else if (value.k === "edit" || value.k === "scroll") {
          const revisions = viewer ? this.#revisions.get(viewer) ?? new Map<string, number>() : new Map<string, number>();
          const key = `${value.k}:${value.id}`;
          if (viewer && value.rev <= (revisions.get(key) ?? -1)) return;
          if (viewer) this.#revisions.set(viewer, revisions);
          revisions.set(key, value.rev);
          if (!valid()) return;
          const result = await this.#page.evaluate(async ({ control, epoch, value }) => {
            const api = (globalThis as unknown as Record<string, RecorderControl>)[control];
            if (api?.epoch !== epoch) return null;
            const ok = value.k === "edit" ? api.setValue(value.id, value.v, value.s, value.e, value.commit) : api.scrollTo(value.id, value.x, value.y);
            if (!ok) return null;
            await api.settle();
            return value.k === "edit" ? api.value(value.id) : "";
          }, { control, epoch, value });
          if (result === null || !valid() || !viewer) return;
          viewer.send(value.k === "edit"
            ? { k: "edited", frame: "main", epoch, seq: this.#seq, id: value.id, rev: value.rev, v: result }
            : { k: "scrolled", frame: "main", epoch, id: value.id, rev: value.rev });
        }
      } catch { /* Detached targets, a navigation, or a closed CDP session invalidate this input. */ }
      finally { this.#queued -= 1; }
    };
    this.#queued += 1;
    this.#inputs = this.#inputs.then(run, run);
    return this.#inputs;
  }
  dispose(): void {
    this.#disposed = true; this.#viewers.clear(); this.#acks.clear();
    clearTimeout(this.#mediaTimer); this.#mediaTimer = undefined;
    this.#offAvailable(); this.#deferredAssets.clear();
    this.#page.off("framenavigated", this.#onNavigation); this.#page.off("domcontentloaded", this.#onLoaded);
    void this.#page.evaluate(([control, epoch]) => {
      (globalThis as unknown as Record<string, RecorderControl>)[control as string]?.stop(epoch as number);
    }, [this.#control, this.#epoch] as const).catch(() => undefined);
  }
}
