import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  utilityProcess,
  type UtilityProcess,
  type WebContents,
} from "electron";
import {
  WATCHTOWER_CAPTURE_SCRIPT,
  WATCHTOWER_DIRTY_SCRIPT,
} from "@pistachio/watchtower/capture";
import {
  applyRegions,
  buildRegions,
  judgeLocally,
  rulesFrom,
  sane,
} from "@pistachio/watchtower/regions";
import { validateCapture } from "@pistachio/watchtower/wire";
import { rerank } from "@pistachio/agent-runtime/watchtower-rerank";
import {
  judgeRegions,
  WATCHTOWER_KEPT_ROLES,
} from "@pistachio/agent-runtime/watchtower-filter";
import { configuredIntentModel } from "../model-provider.js";
import {
  snapshotHtml,
  WATCHTOWER_DOCUMENT_CSP,
} from "@pistachio/watchtower/document";
import { fontResponse } from "../reader-store.js";
import {
  DEFAULT_WATCHTOWER_SETTINGS,
  watchtowerEligible,
  watchtowerRequestSchema,
  watchtowerUrl,
  type WatchtowerCapture,
  type WatchtowerRawCapture,
  type WatchtowerRegionRule,
  type WatchtowerRequest,
  type WatchtowerResponse,
  type WatchtowerSettings,
  type WatchtowerVisit,
} from "@pistachio/shell-contracts/watchtower";

export interface WatchtowerSource {
  id: string;
  spaceId: string;
  contents: WebContents;
  visible: boolean;
  /** The agent is driving this tab: what loads in it is not the person's reading. */
  agentDriven?: boolean;
}
/** A page is looked at again after this long, then less and less often. */
const RECAPTURE_MS = [30000, 60000, 120000, 300000] as const;
/** Less new text than this since the last capture is not a new state of the page. */
const RECAPTURE_MIN_CHARS = 400;
interface TabState {
  contents: WebContents;
  generation: number;
  visit: WatchtowerVisit | null;
  visibleSince: number;
  lastCapture: number;
  lastVisibleAt: number;
  recorded: boolean;
  suppressed: boolean;
  /** The agent loaded what is showing; it stays unrecorded until the person navigates. */
  agentLoaded: boolean;
  /** How many captures this visit has had; paces the next look. */
  captures: number;
  route: { firstAt: number; changedAt: number } | null;
  dispose(): void;
}
interface Reply {
  id?: number;
  value?: WatchtowerResponse;
  error?: string;
  code?: string;
  spaces?: string[];
  ready?: boolean;
  full?: boolean;
}

/** Bounded capture/RPC supervisor. No SQL, compression or page parsing on main. */
export class WatchtowerService {
  #worker: UtilityProcess | null = null;
  #exporter: UtilityProcess | null = null;
  #spaces = new Set<string>();
  #startupError = "";
  #ready = false;
  #full = false;
  #epoch = 0;
  #id = 0;
  #settings: WatchtowerSettings = { ...DEFAULT_WATCHTOWER_SETTINGS };
  #pending = new Map<
    number,
    {
      resolve(value: WatchtowerResponse): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout | undefined;
    }
  >();
  #tabs = new Map<string, TabState>();
  #busy = false;
  #policyChanges = 0;
  #timer: NodeJS.Timeout;
  #restart: NodeJS.Timeout | null = null;
  #failures = 0;
  #closed = false;
  #reranks = new Set<AbortController>();
  /** Layout verdicts per host, as the archive remembers them. */
  #rules = new Map<string, Map<string, WatchtowerRegionRule>>();
  /** Hosts the decision model failed on recently: not asked again for a minute. */
  #modelCooldown = new Map<string, number>();
  #judge: typeof judgeRegions = judgeRegions;
  #model: () => ReturnType<typeof configuredIntentModel> = configuredIntentModel;

  constructor(
    private readonly directory: string,
    private readonly workerPath: string,
    private readonly sources: () => WatchtowerSource[],
  ) {
    this.spawn();
    this.#timer = setInterval(() => {
      void this.tick();
    }, 1000);
    this.#timer.unref();
  }
  settings(): WatchtowerSettings {
    return this.#settings;
  }
  agentAvailable(spaceId: string): boolean {
    return (
      this.#settings.agentAccess &&
      (this.#settings.enabled || this.#spaces.has(spaceId))
    );
  }
  private spawn(): void {
    if (this.#closed) return;
    const child = utilityProcess.fork(
      this.workerPath,
      [join(this.directory, "watchtower", "watchtower.db")],
      { serviceName: "Watchtower", stdio: "pipe" },
    );
    this.#worker = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#startupError = (this.#startupError + chunk.toString()).slice(-2000);
      console.error("[Watchtower]", chunk.toString().trim());
    });
    child.on("message", (reply: Reply) => {
      if (reply.spaces) this.#spaces = new Set(reply.spaces);
      if (typeof reply.full === "boolean") this.#full = reply.full;
      if (reply.ready) {
        this.#ready = true;
        this.#failures = 0;
        this.#startupError = "";
        void this.send({ type: "epoch" })
          .then(() => this.request("__startup__", { type: "status" }))
          .catch(() => {});
        return;
      }
      if (reply.id === undefined) return;
      const pending = this.#pending.get(reply.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(reply.id);
      if (reply.error)
        pending.reject(
          Object.assign(new Error(reply.error), { code: reply.code }),
        );
      else pending.resolve(reply.value as WatchtowerResponse);
    });
    child.once("exit", () => {
      if (this.#worker !== child) return;
      this.#ready = false;
      this.#worker = null;
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(new Error("Watchtower is restarting; browsing is unaffected."));
      }
      this.#pending.clear();
      this.invalidate();
      if (!this.#closed)
        this.#restart = setTimeout(
          () => this.spawn(),
          Math.min(30000, 1000 * 2 ** Math.min(++this.#failures, 5)),
        );
    });
  }
  private send(
    message: Record<string, unknown>,
    timeoutMs = 15000,
  ): Promise<WatchtowerResponse> {
    if (!this.#ready || !this.#worker)
      return Promise.reject(
        new Error(
          this.#startupError
            ? "Watchtower could not start. Check the application logs and try again."
            : "Watchtower is starting. Try again shortly.",
        ),
      );
    if (this.#pending.size >= 16)
      return Promise.reject(
        new Error("Watchtower is busy. Try again shortly."),
      );
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new Error("Watchtower timed out."));
            }, timeoutMs)
          : undefined;
      this.#pending.set(id, { resolve, reject, timer });
      this.#worker!.postMessage({ ...message, id, epoch: this.#epoch });
    });
  }
  private invalidate(suppress = false): void {
    this.#epoch++;
    this.#rules.clear();
    for (const controller of this.#reranks) controller.abort();
    for (const tab of this.#tabs.values()) {
      tab.suppressed ||= suppress;
      tab.generation++;
      tab.visit = null;
      tab.visibleSince = 0;
      tab.recorded = false;
      tab.route = null;
    }
  }
  async request(
    spaceId: string,
    value: WatchtowerRequest,
  ): Promise<WatchtowerResponse> {
    const request = watchtowerRequestSchema.parse(value);
    const changesPolicy =
      request.type === "settings" || request.type === "forget";
    if (changesPolicy) this.#policyChanges++;
    let result: WatchtowerResponse;
    try {
      if (changesPolicy) {
        this.#exporter?.kill();
        this.invalidate(request.type === "forget");
        await this.send({ type: "epoch" }, 0);
      }
      // A committed deletion cannot be canceled by an RPC deadline. Worker exit
      // still rejects the request; keep policy gating and reader invalidation active.
      result = await this.send(
        { type: "request", spaceId, request },
        changesPolicy ? 0 : 15000,
      );
      this.#settings = result.settings;
      this.#full = result.stats.full;
    } finally {
      if (changesPolicy) this.#policyChanges--;
    }
    if (
      request.type === "forget" ||
      (request.type === "settings" && request.patch.retentionDays !== undefined)
    ) {
      // Already-open saved readers are derived copies too. Reload under the
      // same Space authorization so forgotten observations disappear there.
      for (const source of this.sources()) {
        if (
          source.spaceId === spaceId &&
          !source.contents.isDestroyed() &&
          source.contents.getURL().startsWith("pistachio://watchtower/v/")
        )
          source.contents.reload();
      }
    }
    if (request.type === "search" && request.enhance && result.results) {
      result.rerankStatus = "disabled";
      if (this.#settings.remoteRerank) {
        const evaluator = configuredIntentModel();
        if (!evaluator) result.rerankStatus = "unconfigured";
        else {
          const controller = new AbortController();
          const epoch = this.#epoch;
          this.#reranks.add(controller);
          const timer = setTimeout(() => controller.abort(), 1500);
          try {
            result.results = await rerank(request.query, result.results, {
              signal: controller.signal,
              model: evaluator.model,
            });
            result.rerankStatus = "enhanced";
          } catch {
            result.rerankStatus = "unavailable";
          } finally {
            clearTimeout(timer);
            this.#reranks.delete(controller);
          }
          if (epoch !== this.#epoch)
            throw new Error("The archive changed. Search again.");
        }
      }
    }
    return result;
  }
  export(spaceId: string, directory: string): Promise<WatchtowerResponse> {
    if (!this.#ready || this.#closed)
      return Promise.reject(
        new Error("Watchtower is starting. Try again shortly."),
      );
    if (this.#exporter)
      return Promise.reject(new Error("An export is already running."));
    // Dedicated read-only process: no request deadline, no archive RPC queue blocking.
    const child = utilityProcess.fork(
      this.workerPath,
      [
        join(this.directory, "watchtower", "watchtower.db"),
        "export",
        spaceId,
        directory,
      ],
      { serviceName: "Watchtower export", stdio: "pipe" },
    );
    this.#exporter = child;
    child.stderr?.on("data", (chunk: Buffer) =>
      console.error("[Watchtower export]", chunk.toString().trim()),
    );
    return new Promise((resolve, reject) => {
      let completed = false;
      child.on("message", (reply: Reply) => {
        completed = true;
        if (reply.error) reject(new Error(reply.error));
        else resolve(reply.value as WatchtowerResponse);
      });
      child.once("exit", () => {
        if (this.#exporter === child) this.#exporter = null;
        if (!completed)
          reject(
            new Error(
              "Export stopped before completion. The destination may contain partial files.",
            ),
          );
      });
    });
  }

  respond(url: URL, spaceId: string): Promise<Response> | null {
    if (url.host !== "watchtower") return null;
    return (async () => {
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return new Response("Invalid saved page address.", { status: 404 });
      }
      // The app's own Geist files, from this same origin: the saved page's
      // policy lets nothing else load.
      const font = /^\/font\/(geist|geist-mono)\.woff2$/u.exec(pathname);
      if (font) return fontResponse(font[1] === "geist-mono");
      const match = /^\/v\/([a-z0-9:-]{1,160})(\/markdown)?$/iu.exec(pathname);
      if (!match?.[1])
        return new Response("Open Watchtower from the browser menu.", {
          status: 404,
        });
      try {
        const result = await this.request(spaceId, {
          type: "read",
          observationId: match[1],
        });
        if (!result.document)
          return new Response("Saved page unavailable.", { status: 404 });
        return new Response(
          match[2] ? result.document.markdown : snapshotHtml(result.document),
          {
            headers: {
              "content-type": match[2]
                ? "text/markdown; charset=utf-8"
                : "text/html; charset=utf-8",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "content-security-policy": WATCHTOWER_DOCUMENT_CSP,
            },
          },
        );
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "NOT_FOUND"
        )
          return new Response(
            "This saved visit has been forgotten or belongs to another Space.",
            { status: 404, headers: { "cache-control": "no-store" } },
          );
        return new Response(
          "<!doctype html><meta http-equiv=refresh content=3><title>Watchtower is getting ready</title><p>Watchtower is temporarily unavailable. Retrying shortly…</p>",
          {
            status: 503,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "retry-after": "3",
              "cache-control": "no-store",
              "content-security-policy": "default-src 'none'",
            },
          },
        );
      }
    })();
  }

  /** Registered before a tab loads, so even brief foreground navigations get a visit. */
  attach(id: string, contents: WebContents): void {
    if (this.#tabs.has(id)) return;
    const state: TabState = {
      contents,
      generation: 0,
      visit: null,
      visibleSince: 0,
      lastCapture: 0,
      lastVisibleAt: 0,
      recorded: false,
      suppressed: false,
      agentLoaded: false,
      captures: 0,
      route: null,
      dispose: () => {},
    };
    this.#tabs.set(id, state);
    const start = (details: {
      isMainFrame: boolean;
      isSameDocument?: boolean;
    }): void => {
      if (!details.isMainFrame || details.isSameDocument) return;
      // Invalidate an extraction immediately, but do not invent a new visit for
      // a canceled navigation, download or 204. Only a commit starts a visit.
      state.generation++;
    };
    const navigate = (): void => {
      state.suppressed = false;
      // A page the agent opened is not something the person visited, even
      // once the run ends and the tab is theirs again.
      state.agentLoaded =
        this.sources().find((item) => item.id === id)?.agentDriven === true;
      state.generation++;
      state.visit = null;
      state.recorded = false;
      state.visibleSince = 0;
      state.lastCapture = 0;
      state.captures = 0;
      state.route = null;
      this.begin(id, state);
    };
    const inPage = (
      _event: Electron.Event,
      _url: string,
      main: boolean,
    ): void => {
      if (!main || contents.isDestroyed()) return;
      if (
        state.visit &&
        routeUrl(contents.getURL()) === routeUrl(state.visit.url)
      ) {
        state.route = null;
        return;
      }
      const now = Date.now();
      state.route = { firstAt: state.route?.firstAt ?? now, changedAt: now };
    };
    const title = (): void => {
      this.updateTitle(state);
    };
    const destroyed = (): void => {
      state.generation++;
      this.#tabs.delete(id);
    };
    contents.on("did-start-navigation", start);
    contents.on("did-navigate", navigate);
    contents.on("did-navigate-in-page", inPage);
    contents.on("page-title-updated", title);
    contents.once("destroyed", destroyed);
    state.dispose = () => {
      if (contents.isDestroyed()) return;
      contents.removeListener("did-start-navigation", start);
      contents.removeListener("did-navigate", navigate);
      contents.removeListener("did-navigate-in-page", inPage);
      contents.removeListener("destroyed", destroyed);
      contents.removeListener("page-title-updated", title);
    };
  }
  private updateTitle(state: TabState): void {
    if (
      !state.visit ||
      !state.recorded ||
      state.contents.isDestroyed() ||
      state.route ||
      !watchtowerEligible(
        state.contents.getURL(),
        state.visit.spaceId,
        this.#settings,
      ) ||
      routeUrl(state.contents.getURL()) !== routeUrl(state.visit.url)
    )
      return;
    const title = state.contents.getTitle().slice(0, 500);
    if (!title || title === state.visit.title) return;
    const visit = { ...state.visit, title };
    state.visit = visit;
    void this.send({ type: "title", visit }).catch(() => {
      if (state.visit === visit) state.visit = { ...visit, title: "" };
    });
  }
  private begin(id: string, state: TabState): void {
    const source = this.sources().find((item) => item.id === id);
    if (
      this.#full ||
      this.#policyChanges > 0 ||
      state.suppressed ||
      state.agentLoaded ||
      !source ||
      !source.visible ||
      !this.#ready ||
      source.contents.isDestroyed()
    )
      return;
    const url = source.contents.getURL();
    if (!watchtowerEligible(url, source.spaceId, this.#settings)) return;
    if (!state.visit)
      state.visit = {
        id: randomUUID(),
        spaceId: source.spaceId,
        url,
        title: source.contents.getTitle(),
        at: Date.now(),
      };
    if (!state.recorded) {
      state.recorded = true;
      const generation = state.generation;
      void this.send({ type: "visit", visit: state.visit }).catch(() => {
        if (state.generation === generation) state.recorded = false;
      });
    }
  }
  private async tick(): Promise<void> {
    if (
      this.#full ||
      this.#policyChanges > 0 ||
      !this.#ready ||
      !this.#settings.enabled ||
      this.#settings.paused ||
      this.#closed
    )
      return;
    const sources = this.sources();
    const visible = new Set(
      sources.filter((source) => source.visible).map((source) => source.id),
    );
    for (const [id, state] of this.#tabs)
      if (!visible.has(id)) state.visibleSince = 0;
    for (const source of sources) {
      this.attach(source.id, source.contents);
      const state = this.#tabs.get(source.id)!;
      if (
        !source.visible ||
        source.contents.isDestroyed() ||
        !watchtowerEligible(
          source.contents.getURL(),
          source.spaceId,
          this.#settings,
        )
      )
        continue;
      if (state.lastVisibleAt && Date.now() - state.lastVisibleAt > 60000) {
        state.generation++;
        state.visit = null;
        state.recorded = false;
        state.lastCapture = 0;
        state.captures = 0;
      }
      state.lastVisibleAt = Date.now();
      if (!state.visibleSince) state.visibleSince = Date.now();
      if (state.route) {
        const now = Date.now();
        // Let a route settle, with a bounded wait on continuously mutating SPAs.
        if (
          now - state.route.changedAt < 500 &&
          now - state.route.firstAt < 5000
        )
          continue;
        state.route = null;
        state.suppressed = false;
        state.generation++;
        state.visit = null;
        state.recorded = false;
        state.lastCapture = 0;
        state.captures = 0;
        state.agentLoaded = source.agentDriven === true;
        // Preserve foreground dwell across same-document URL changes.
      }
      this.begin(source.id, state);
      this.updateTitle(state);
      if (!state.visibleSince) state.visibleSince = Date.now();
      if (
        this.#busy ||
        !state.visit ||
        !state.recorded ||
        Date.now() - state.visibleSince < 1000 ||
        Date.now() - state.lastCapture <
          RECAPTURE_MS[
            Math.min(Math.max(0, state.captures - 1), RECAPTURE_MS.length - 1)
          ]! ||
        (source.contents.isLoadingMainFrame() &&
          Date.now() - state.visibleSince < 5000)
      )
        continue;
      const visit = state.visit;
      const generation = state.generation;
      const epoch = this.#epoch;
      this.#busy = true;
      state.lastCapture = Date.now();
      try {
        // Looking again costs the page a full walk. One number says whether
        // it has gained enough text since the last capture to be worth it;
        // a ticking clock or a rotated ad never is.
        if (state.captures > 0) {
          const dirty: unknown = await source.contents
            .executeJavaScriptInIsolatedWorld(991, [
              { code: WATCHTOWER_DIRTY_SCRIPT },
            ])
            .catch(() => -1);
          if (
            typeof dirty === "number" &&
            dirty >= 0 &&
            dirty < RECAPTURE_MIN_CHARS
          )
            continue;
        }
        state.captures++;
        // Extraction yields in-page and is bounded. A late result can never cross a navigation/policy generation.
        let deadline: NodeJS.Timeout | undefined;
        const raw: unknown = await Promise.race([
          source.contents.executeJavaScriptInIsolatedWorld(991, [
            { code: WATCHTOWER_CAPTURE_SCRIPT },
          ]),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("Capture timed out")),
              6000,
            );
          }),
        ]).finally(() => {
          if (deadline) clearTimeout(deadline);
        });
        if (
          this.#closed ||
          epoch !== this.#epoch ||
          generation !== state.generation ||
          source.contents.isDestroyed() ||
          !this.sources().some(
            (item) => item.id === source.id && item.visible,
          ) ||
          routeUrl(source.contents.getURL()) !== routeUrl(visit.url)
        )
          continue;
        const page = validateCapture(raw);
        if (!page || routeUrl(page.url) !== routeUrl(visit.url)) continue;
        page.url = visit.url; // plain anchor changes remain part of the same page visit
        const capture = await this.filter(page);
        if (
          epoch !== this.#epoch ||
          generation !== state.generation ||
          source.contents.isDestroyed()
        )
          continue;
        await this.send({
          type: "ingest",
          visit,
          observationId: randomUUID(),
          at: Date.now(),
          capture,
        });
      } catch {
        /* Best effort: a renderer disappearing must not interrupt browsing. */
      } finally {
        this.#busy = false;
      }
    }
  }
  /**
   * Which regions of the page are worth keeping: remembered verdicts for
   * this site's layout, then decisive local evidence, then — for what is
   * still undecided, when the person allows it — the decision model, whose
   * confident answers are remembered so the same layout is not asked about
   * again. Failure of any step keeps the text.
   */
  private async filter(page: WatchtowerRawCapture): Promise<WatchtowerCapture> {
    const regions = buildRegions(page.blocks);
    const host = new URL(page.url).hostname.toLowerCase();
    let rules = this.#rules.get(host);
    if (!rules) {
      const stored = (await this.send({ type: "rules", host }).catch(
        () => null,
      )) as { rules?: WatchtowerRegionRule[] } | null;
      rules = new Map(
        (stored?.rules ?? []).map((rule) => [rule.signature, rule]),
      );
      if (this.#rules.size >= 100) this.#rules.clear();
      this.#rules.set(host, rules);
    }
    const verdicts = judgeLocally(regions, rules, page.kind);
    const keep = verdicts.map((verdict) => verdict.keep);
    const decisions: Parameters<typeof rulesFrom>[1] = verdicts.map(
      (verdict) =>
        verdict.decided && verdict.source === "local"
          ? { keep: verdict.keep, role: "local", source: "local" }
          : undefined,
    );
    const undecided = verdicts.flatMap((verdict, index) =>
      verdict.decided ? [] : [index],
    );
    const evaluator =
      undecided.length > 0 &&
      this.#settings.smartFilter &&
      (this.#modelCooldown.get(host) ?? 0) < Date.now()
        ? this.#model()
        : null;
    if (evaluator) {
      // Largest first: the model is asked about a bounded number of regions.
      undecided.sort((a, b) => regions[b]!.chars - regions[a]!.chars);
      try {
        const answers = await this.#judge(
          { host, title: page.title, kind: page.kind },
          undecided.map((index) => regions[index]!),
          { model: evaluator.model },
        );
        answers.forEach((answer, i) => {
          const index = undecided[i]!;
          // Doubt keeps text — and is remembered, so the same layout gets the
          // same answer on the next visit instead of another coin toss.
          keep[index] = answer ? WATCHTOWER_KEPT_ROLES.has(answer.role) : true;
          if (answer || i < answers.length)
            decisions[index] = {
              keep: keep[index]!,
              role: answer?.role ?? "undecided",
              source: "model",
            };
        });
      } catch {
        this.#modelCooldown.set(host, Date.now() + 60000);
      }
    }
    const learned = rulesFrom(regions, decisions).filter((rule) => {
      const known = rules.get(rule.signature);
      return !known || known.keep !== rule.keep || known.source !== rule.source;
    });
    if (learned.length) {
      for (const rule of learned) rules.set(rule.signature, rule);
      void this.send({ type: "learn", host, rules: learned }).catch(() => {});
    }
    return applyRegions(page, regions, sane(regions, keep));
  }
  /** Tests substitute a deterministic decision model. */
  useDecisionModel(
    model: () => ReturnType<typeof configuredIntentModel>,
    judge: typeof judgeRegions = judgeRegions,
  ): void {
    this.#model = model;
    this.#judge = judge;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    if (this.#restart) clearTimeout(this.#restart);
    this.invalidate();
    for (const state of this.#tabs.values()) state.dispose();
    this.#tabs.clear();
    this.#exporter?.kill();
    const child = this.#worker;
    if (child) {
      child.postMessage({ type: "shutdown", epoch: this.#epoch });
      const deadline = setTimeout(() => child.kill(), 2000);
      deadline.unref();
      child.once("exit", () => clearTimeout(deadline));
    }
  }
}

/** Ordinary document anchors are not routes; hash routers keep their path. */
function routeUrl(value: string): string | null {
  const normalized = watchtowerUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  if (!/^#(?:!|\/)/u.test(url.hash)) url.hash = "";
  return url.href;
}
