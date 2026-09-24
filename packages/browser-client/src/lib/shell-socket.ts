"use client";

/**
 * The shell socket, in a browser tab (docs/web-browser-design.md §5, §7).
 *
 * One WebSocket carries everything the desktop's preload carries over Electron
 * IPC: an RPC envelope over the `ShellApi` method names, the two snapshot
 * channels, per-pane screencast frames, and input. `WsShellApi` is the object
 * `setShellApi()` is handed, so the shared shell (`@pistachio/shell-ui`) runs
 * unchanged over it — it never learns which transport it is on.
 *
 * NOTHING HERE IS WRITTEN OUT BY HAND. The methods come from
 * `SHELL_METHOD_NAMES` and the subscriptions from `SHELL_EVENT_CHANNELS`, both
 * held to the `ShellApi` interface by the compiler in `shell-contracts/ipc`.
 * A member added to the contract therefore arrives here already implemented,
 * and a member this host cannot answer comes back as the host's own
 * `unsupported` reply rather than as an undefined function — which is the
 * difference between a disabled affordance and a crash inside the chrome.
 *
 * Authentication is the live view's stack, unchanged (§8.5 of
 * cloud-sync-design.md): a one-minute, one-redemption ticket in the URL
 * because no WebSocket client can set a header, then proof of the Space key
 * before the host sends a byte of state. A fresh ticket for every dial,
 * reconnects included, so a session re-claimed on another worker is followed
 * there.
 */

import {
  SHELL_EVENT_CHANNELS,
  type ShellApi,
  type ShellEventMember,
  type ShellMethodName,
  type ShellRunSnapshot,
  type ShellSnapshot,
  type ShellTabsSnapshot,
} from "@pistachio/shell-contracts/ipc";
import type {
  BrowserControlCommand,
  BrowserControlsSnapshot,
  BrowserDownload,
} from "@pistachio/shell-contracts/browser-controls";
import type { OnboardingCompletion } from "@pistachio/shell-contracts/onboarding";
import {
  decodeShellServerFrame,
  DOWNLOAD_KEY_HEADER,
  encodeShellClientFrame,
  SHELL_REPLY_CODE,
  SOCKET_EVENT_CHANNELS,
  SOCKET_METHOD_NAMES,
  type ShellClientFrame,
  type ShellControl,
  type LinkedState,
  type LinkedCursor,
  type ShellErrorCode,
  type ShellReplyErrorCode,
  type ShellServerFrame,
  type SocketMethodName,
  type StreamShellApi,
} from "@pistachio/shell-contracts/socket";
import type { LiveFrame } from "@pistachio/live-view";
import {
  assetFailureSchema, type AssetFailure,
  AssetAssembler,
  type MirrorClientMessage,
  type MirrorServerMessage,
} from "@pistachio/dom-mirror";

/* --------------------------------- the URL -------------------------------- */

/**
 * `wss://<host>/v1/shell/<sessionId>?access_token=<ticket>` — the shell
 * socket's twin of `liveViewUrl`, and derived the same way: the scheme comes
 * from the public address, so a deployment terminating TLS in front of the
 * fleet gets `wss` and a loopback test gets `ws`.
 */
export function shellSocketUrl(cloudBrowserUrl: string, sessionId: string, ticket: string): string {
  const base = cloudBrowserUrl.trim().replace(/\/+$/u, "");
  const scheme = base.replace(/^https:/iu, "wss:").replace(/^http:/iu, "ws:");
  return `${scheme}/v1/shell/${encodeURIComponent(sessionId)}?access_token=${encodeURIComponent(ticket)}`;
}

/* -------------------------------- failures -------------------------------- */

/** A call the host refused, carrying the code so a caller can tell why. */
export class ShellCallError extends Error {
  readonly code: ShellReplyErrorCode;
  readonly method: SocketMethodName;

  constructor(method: SocketMethodName, code: ShellReplyErrorCode, message: string) {
    super(message === "" ? describeShellReplyCode(code) : message);
    this.name = "ShellCallError";
    this.code = code;
    this.method = method;
    // The shared shell reads this back through `shellReplyCodeOf` to tell an
    // affordance this host cannot answer from one that failed (W12).
    Object.defineProperty(this, SHELL_REPLY_CODE, { value: code, enumerable: false });
  }
}

/** Why the socket itself ended, if it ended for a reason the host named. */
export class ShellSocketError extends Error {
  readonly code: ShellErrorCode | "unreachable";

  constructor(code: ShellErrorCode | "unreachable", message: string) {
    super(message === "" ? describeShellSocketCode(code) : message);
    this.name = "ShellSocketError";
    this.code = code;
  }
}

function describeShellReplyCode(code: ShellReplyErrorCode): string {
  switch (code) {
    case "unsupported":
      return "The cloud browser cannot do that yet.";
    case "invalid_args":
      return "That request was not something the cloud browser could act on.";
    case "not_found":
      return "That is no longer there.";
    case "ended":
      return "This browser session has ended.";
    default:
      return "The cloud browser could not do that.";
  }
}

function describeShellSocketCode(code: ShellErrorCode | "unreachable"): string {
  switch (code) {
    case "unauthorized":
      return "The cloud browser would not accept this browser.";
    case "not_found":
      return "That browser session is not one of yours.";
    case "ended":
      return "This browser session has ended.";
    case "space_key_required":
      return "This browser holds no key for this Space, so it cannot open its tabs.";
    case "lease_lost":
      return "The worker holding this session let go of it. Reload to pick it up again.";
    default:
      return "The cloud browser could not be reached.";
  }
}

/**
 * The one sentence to show for anything this module throws — a refused call, a
 * closed socket, or an ordinary refusal from control on the way to one. The
 * shell's own `safeAction` wrappers already put `error.message` on screen, so
 * everything above is written to read as a sentence; this is for the page
 * around the shell, which holds errors of its own.
 */
export function describeShellError(cause: unknown): string {
  if (cause instanceof ShellCallError || cause instanceof ShellSocketError) return cause.message;
  // A ControlError's message is already the plain sentence for its code.
  if (cause instanceof Error) return cause.message;
  return "The cloud browser could not be reached.";
}

/** One pointer or key event, exactly as `{t:'input'}` carries it. */
export type ShellInputEvent = Extract<ShellClientFrame, { t: "input" }>["event"];

/* -------------------------------- the state ------------------------------- */

export type ShellSocketPhase =
  /** No socket yet, or one being dialled. */
  | "connecting"
  /** Proved and ready: the shell is live. */
  | "open"
  /** Dropped, and being redialled with a fresh ticket. */
  | "reconnecting"
  /** Over for a reason; nothing will be retried. */
  | "closed";

export interface ShellSocketStatus {
  phase: ShellSocketPhase;
  /** Why it is closed, when it is. */
  error: string | null;
  /** The code the host named, for the page to branch on (`revoked`, `ended`…). */
  code: ShellErrorCode | "unreachable" | null;
}

/** How a pane last described itself; replayed on every (re)connect. */
interface PaneState {
  width: number;
  height: number;
  dpr: number;
  visible: boolean;
  /** How this pane wants the tab painted (§16); absent means pixels. */
  renderer?: "pixels" | "dom";
  hybridMedia?: boolean;
}

/** One brokered asset the mirror pulled, reassembled from its chunks. */
export interface MirrorAsset {
  id: string;
  type: string;
  bytes: Uint8Array;
}

export interface ShellSocketOptions {
  sessionId: string;
  surfaceUrl?: (kind: "audio" | "mirror", origin: string) => string;
  /** This browser's keys for the session's Space; the host challenges for them. */
  prove(nonce: string): Promise<string>;
  /** A device token, re-minted if it is about to expire — never put in the URL. */
  ticket(): Promise<{ url: string; ticket: string }>;
  /**
   * What "switch Space" means on this transport (§6.3). A session belongs to
   * ONE Space, so the host answers `switchSpace` with `unsupported`: the move
   * is the viewer's, not the host's — open or resume the other Space's session
   * and swap sockets. The page supplies that, and the member is installed over
   * the generic RPC so the shell's own Space switcher just works.
   */
  switchSpace?: (spaceId: string) => Promise<void>;
  /**
   * Members this browser answers ITSELF rather than asking the host
   * (§14). The walkthrough's three model calls are the only ones: control's
   * `/v1/ai/*` proxy is device-bearer and refuses a `cloud` device, so a
   * session host has no model to reach — while this tab, a `platform: "web"`
   * device, does. Installed over the generic RPC exactly as `switchSpace`
   * is, so the shared shell never learns which side answered.
   */
  local?: Partial<ShellApi>;
  /**
   * Run after the HOST's own `completeOnboarding` succeeded, before the
   * shell is told it worked. The host renames the Space in the sealed
   * record; this callback records account onboarding completion in control
   * and updates its plaintext Space label (§14).
   */
  afterCompleteOnboarding?: (input: OnboardingCompletion) => Promise<void>;
}

/** §7: 1 s between dials, five attempts. */
const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECTS = 5;
/** A lost lease is not a dead session: the next worker may claim it (§6.4). */
const LEASE_RETRY_DELAY_MS = 2_000;
const CLOSE_REVOKED = 4003;
const CLOSE_SPACE_KEY_REQUIRED = 4004;
const CLOSE_LEASE_LOST = 4005;
/** A call that never comes back would leave the chrome waiting forever. */
const CALL_TIMEOUT_MS = 30_000;

const SNAPSHOT_CHANNEL = channelOf("onSnapshot");
const RUN_CHANNEL = channelOf("onRun");
const CONTROLS_CHANNEL = channelOf("onBrowserControlsChanged");

/**
 * This browser's own position, or null when it cannot or will not say. The
 * refusal is the person's browser refusing, which is exactly the answer the
 * site should get.
 */
async function currentPosition(): Promise<{ latitude: number; longitude: number; accuracy: number } | null> {
  if (typeof navigator === "undefined" || navigator.geolocation === undefined) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : 100,
        }),
      () => resolve(null),
      { timeout: 10_000, maximumAge: 60_000 },
    );
  });
}

function channelOf(member: ShellEventMember): string {
  const entry = SHELL_EVENT_CHANNELS.find((candidate) => candidate.member === member);
  if (entry === undefined) throw new Error(`no channel for ${member}`);
  return entry.channel;
}

/**
 * The two members whose contract is `void`: they are traffic, not state, and a
 * promise nobody holds would surface a refusal as an unhandled rejection.
 */
const VOID_METHODS = new Set<ShellMethodName>(["openBookmarksPage", "sendLiveInput"]);

/*
 * THERE IS NO FALLBACK TABLE HERE ANY MORE.
 *
 * S4 softened three `unsupported` replies into neutral answers, because
 * `initialize()` in `@pistachio/shell-ui` awaited `getGlance`, `getMedia` and
 * `getBrowserControls` with no `.catch` and one rejection left the shell on
 * "Opening secure Space…" forever. Two things changed in S6: the host answers
 * all three (§11), and the store now catches every non-essential getter
 * itself — which is where that belongs, since the desktop can lose a getter
 * too. So every refusal now reaches the caller as the host's own error,
 * carrying the host's own reason, which is what puts a disabled affordance
 * and a sentence on screen instead of a lie about what happened (W12).
 */


type Listener = (payload: never) => void;

/**
 * Declaration merging, deliberately, and the only place in this app that does
 * it: the class's `ShellApi` members are installed in the constructor from the
 * contract's own lists (§5), and this interface is what tells the compiler the
 * instance really is a `ShellApi`. An `implements` clause cannot say it,
 * because not one of the hundred-odd members is written out — which is the
 * whole point, since a hand-kept list is exactly what silently loses a method
 * when the contract grows one. The two lint rules below both object to the
 * shape rather than to anything it does, so they are answered here once.
 */
/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging -- see above */
export interface WsShellApi extends ShellApi, StreamShellApi {}

export class WsShellApi {
  /* eslint-enable @typescript-eslint/no-unsafe-declaration-merging */
  private readonly options: ShellSocketOptions;
  private socket: WebSocket | null = null;
  private disposed = false;
  private attempts = 0;
  private leaseRetried = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 0;
  /** Calls in flight, by envelope id. */
  private readonly pending = new Map<
    string,
    { method: SocketMethodName; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly frameListeners = new Map<string, Set<(frame: LiveFrame) => void>>();
  /** Per-tab DOM mirror message listeners (§16); like frames, they bypass the store. */
  private readonly mirrorListeners = new Map<string, Set<(message: MirrorServerMessage) => void>>();
  /** Per-tab brokered-asset listeners: the reassembled bytes as they complete. */
  private readonly assetListeners = new Map<string, Set<(asset: MirrorAsset) => void>>();
  private readonly assembler = new AssetAssembler();
  private readonly assetRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly assetJobs = new Map<string, AbortController>();
  private readonly assetAgain = new Set<string>();
  private assetQueue: Array<{ tabId: string; id: string; controller: AbortController; attempts: number; retryMs?: number }> = [];
  private assetTransfers = 0;
  private readonly controlListeners = new Set<(control: ShellControl) => void>();
  /** Told after every reconnect, so the shell can re-read what it holds. */
  private readonly reconnectListeners = new Set<() => void>();
  private readonly statusListeners = new Set<(status: ShellSocketStatus) => void>();
  private readonly panes = new Map<string, PaneState>();
  /** Resolved the first time the host says `ready`; rejected if it never can. */
  private opened: { resolve: () => void; reject: (error: Error) => void } | null = null;

  /** Where the fleet answers, remembered from the last ticket: download URLs are relative to it. */
  private cloudBrowserUrl = "";
  /**
   * This viewer's own download key, from the `ready` frame (§11). A minted
   * download URL is bound to it and the HTTP route wants it back in
   * `DOWNLOAD_KEY_HEADER`, so a URL that leaves this tab opens nothing.
   */
  private downloadKey = "";
  /** Site prompts waiting on an answer that are asking for a position. */
  private readonly geolocationRequests = new Set<string>();

  /** Who may act in the session's tabs right now (W7). The pane reads this. */
  viewerId = "";
  linked: LinkedState = { enabled: false, generation: 0, controller: null, viewers: [] };
  private readonly linkedListeners = new Set<(state: LinkedState) => void>();
  private readonly cursorListeners = new Set<(cursor: LinkedCursor) => void>();
  onLinked(listener: (state: LinkedState) => void): () => void {
    this.linkedListeners.add(listener);
    return () => this.linkedListeners.delete(listener);
  }
  onCursor(listener: (cursor: LinkedCursor) => void): () => void {
    this.cursorListeners.add(listener);
    return () => this.cursorListeners.delete(listener);
  }
  link(action: "enable" | "disable" | "take-control"): void {
    this.send({ t: "link", action, generation: this.linked.generation });
  }
  get following(): boolean { return this.linked.enabled && this.linked.controller !== this.viewerId; }
  private setLinked(state: LinkedState): void {
    const changedDriver = this.linked.controller !== state.controller || this.linked.generation !== state.generation;
    this.linked = state;
    if (changedDriver && state.controller === this.viewerId) {
      for (const [tabId, pane] of this.panes) this.send({ t: "pane", tabId, ...pane });
    }
    for (const listener of this.linkedListeners) listener(state);
  }
  control: ShellControl = { holder: "human", generation: 0 };
  status: ShellSocketStatus = { phase: "connecting", error: null, code: null };

  constructor(options: ShellSocketOptions) {
    this.options = options;
    const target = this as unknown as Record<string, unknown>;
    for (const method of SOCKET_METHOD_NAMES) {
      const isVoid = (VOID_METHODS as ReadonlySet<string>).has(method);
      target[method] = (...args: unknown[]): unknown => {
        const answer = this.call(method, args);
        if (!isVoid) return answer;
        answer.catch(() => undefined);
        return undefined;
      };
    }
    for (const { member, channel } of SOCKET_EVENT_CHANNELS) {
      target[member] = (listener: Listener): (() => void) => this.subscribe(channel, listener);
    }
    const switchSpace = options.switchSpace;
    if (switchSpace !== undefined) {
      target["switchSpace"] = (spaceId: string): Promise<void> => switchSpace(spaceId);
    }
    for (const [member, answer] of Object.entries(options.local ?? {})) {
      if (typeof answer === "function") target[member] = answer;
    }

    // The walkthrough's completion is the host's — memories, the shelf, the
    // welcome tabs, the sealed Space record — followed by account completion
    // and the Space label in control. The wizard stays open if either the host
    // or the required account completion write fails.
    const afterComplete = options.afterCompleteOnboarding;
    if (afterComplete !== undefined) {
      const hostComplete = target["completeOnboarding"] as (input: OnboardingCompletion) => Promise<void>;
      let appliedInput: string | null = null;
      target["completeOnboarding"] = async (input: OnboardingCompletion): Promise<void> => {
        const serialized = JSON.stringify(input);
        // Retrying a failed account write must not repeat memories, favorites,
        // and welcome tabs that the host already applied successfully.
        if (appliedInput !== serialized) {
          await hostComplete(input);
          appliedInput = serialized;
        }
        await afterComplete(input);
        appliedInput = null;
      };
    }

    // Two of the site-controls commands mean something different in a browser
    // tab than they do on a Mac, and this is the one place that knows it.
    const hostControl = target["browserControl"] as (command: BrowserControlCommand) => Promise<void>;
    target["browserControl"] = async (command: BrowserControlCommand): Promise<void> => {
      // "Open" a cloud download by fetching it into THIS browser. The bytes
      // never cross the socket (§11): the host mints a one-use, sixty-second
      // URL bound to this viewer, and the browser fetches it.
      if (command.type === "openDownload" || command.type === "showDownload") {
        await this.fetchDownload(command.downloadId);
        return;
      }
      // A site asking where you are is answered by YOUR browser, not by a
      // worker in a datacentre. The position is fetched here, the moment the
      // person allows it, and emulated for the page (§11).
      if (
        command.type === "resolvePermission" &&
        command.decision !== "block" &&
        this.geolocationRequests.has(command.requestId)
      ) {
        const position = await currentPosition();
        if (position !== null) await this.setGeolocation("", position).catch(() => undefined);
      }
      return hostControl(command);
    };

    // Which pending prompts are about a position, so the branch above knows.
    this.subscribe(CONTROLS_CHANNEL, ((snapshot: BrowserControlsSnapshot) => {
      this.geolocationRequests.clear();
      for (const pending of snapshot.pendingPermissions) {
        if (pending.permission === "geolocation") this.geolocationRequests.add(pending.id);
      }
    }) as Listener);
  }

  /* ------------------------------ the socket ------------------------------ */

  /**
   * Mint a ticket, dial, prove the Space key, and resolve when the host says
   * `ready`. Everything after the first `ready` is the reconnect path, which
   * runs on its own and reports through `onStatus`.
   */
  connect(): Promise<void> {
    const opened = new Promise<void>((resolve, reject) => {
      this.opened = { resolve, reject };
    });
    void this.dial();
    return opened;
  }

  /** Let go for good. Nothing is retried after this. */
  close(): void {
    this.disposed = true;
    this.cancelAllAssets();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "closed");
    this.failPending(new ShellSocketError("ended", "This browser closed the session's socket."));
  }

  onStatus(listener: (status: ShellSocketStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onControl(listener: (control: ShellControl) => void): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  /**
   * One tab's screencast. Frames never go through the store: a base64 JPEG
   * several times a second would repaint the whole chrome with every one, so a
   * pane subscribes here and holds the current frame in its own state.
   */
  onFrame(tabId: string, listener: (frame: LiveFrame) => void): () => void {
    const set = this.frameListeners.get(tabId) ?? new Set();
    set.add(listener);
    this.frameListeners.set(tabId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.frameListeners.delete(tabId);
    };
  }

  /**
   * One tab's DOM mirror stream (§16): snapshots, patches, and the small
   * out-of-band notes (a page cannot be mirrored, an asset is missing). Like
   * frames, mirror messages never travel through the store — a `MirrorPane`
   * subscribes here and drives a renderer of its own.
   */
  surfaceUrl(kind: "audio" | "mirror"): string | undefined {
    return this.options.surfaceUrl?.(kind, this.mediaOrigin());
  }

  mediaOrigin(): string { return this.cloudBrowserUrl ? new URL(this.cloudBrowserUrl).origin : ""; }

  onMirror(tabId: string, listener: (message: MirrorServerMessage) => void): () => void {
    const set = this.mirrorListeners.get(tabId) ?? new Set();
    set.add(listener);
    this.mirrorListeners.set(tabId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.mirrorListeners.delete(tabId);
    };
  }

  /** A tab's brokered assets as they finish arriving, for the pane to fill in. */
  onAsset(tabId: string, listener: (asset: MirrorAsset) => void): () => void {
    const set = this.assetListeners.get(tabId) ?? new Set();
    set.add(listener);
    this.assetListeners.set(tabId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.assetListeners.delete(tabId);
    };
  }

  /**
   * Send one mirror message to the host (§16): a click that names a node, an
   * edit, a scroll, a resync. Fenced by the control generation exactly as
   * `input` is, and dropped while the agent holds the wheel — except the
   * bookkeeping messages (`need`, `ack`, `attach`, `detach`), which are not
   * acts and go whoever holds control.
   */
  mirror(tabId: string, message: MirrorClientMessage): void {
    const act = message.k !== "need" && message.k !== "resync" && message.k !== "ack" && message.k !== "attach" && message.k !== "detach";
    if (act && this.control.holder !== "human") return;
    this.send({ t: "mirror", tabId, generation: this.control.generation, viewGeneration: this.linked.generation, msg: message });
  }

  private cancelAssets(tabId: string): void {
    this.assembler.forget(tabId);
    for (const [key, timer] of this.assetRetryTimers) if (key.startsWith(`${tabId}:`)) { clearTimeout(timer); this.assetRetryTimers.delete(key); }
    for (const [key, controller] of this.assetJobs) {
      if (key.startsWith(`${tabId}:`)) { controller.abort(); this.assetJobs.delete(key); }
    }
    for (const key of this.assetAgain) if (key.startsWith(`${tabId}:`)) this.assetAgain.delete(key);
    this.assetQueue = this.assetQueue.filter(job => job.tabId !== tabId);
  }

  private queueAsset(tabId: string, id: string): void {
    const key = `${tabId}:${id}`;
    // Availability can arrive while a deferred HTTP response is still in flight.
    if (this.assetJobs.has(key)) { this.assetAgain.add(key); return; }
    if (this.assetJobs.size >= 512) {
      for (const listener of this.mirrorListeners.get(tabId) ?? []) listener({ k: "assetMissing", id, failure: { reason: "queue" } });
      return;
    }
    const controller = new AbortController();
    this.assetJobs.set(key, controller);
    this.assetQueue.push({ tabId, id, controller, attempts: 0 });
    this.pumpAssets();
  }
  private pumpAssets(): void {
    while (this.assetTransfers < 4 && this.assetQueue.length) {
      const job = this.assetQueue.shift()!;
      this.assetTransfers += 1;
      void this.fetchAsset(job).finally(() => {
        this.assetTransfers -= 1;
        const key = `${job.tabId}:${job.id}`;
        if (this.assetJobs.get(key) === job.controller) {
          const again = this.assetAgain.delete(key);
          if (!job.controller.signal.aborted && (again || job.retryMs !== undefined)) {
            const timer = setTimeout(() => {
              this.assetRetryTimers.delete(key);
              if (this.assetJobs.get(key) !== job.controller || job.controller.signal.aborted) return;
              job.retryMs = undefined; this.assetQueue.push(job); this.pumpAssets();
            }, again ? 0 : job.retryMs);
            this.assetRetryTimers.set(key, timer);
          } else this.assetJobs.delete(key);
        }
        this.pumpAssets();
      });
    }
  }
  private async fetchAsset(job: { tabId: string; id: string; controller: AbortController; attempts: number; retryMs?: number }): Promise<void> {
    const { tabId, id, controller } = job;
    job.attempts += 1;
    let timedOut = false;
    let failure: AssetFailure = { reason: "transport" };
    // Abort only this transfer on timeout; retain the job's navigation fence for retries.
    const transfer = new AbortController();
    const abort = (): void => transfer.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; transfer.abort(); }, 15_000);
    try {
      const url = `${this.cloudBrowserUrl.replace(/\/+$/u, "")}/v1/shell/${encodeURIComponent(this.options.sessionId)}/assets/${encodeURIComponent(tabId)}/${encodeURIComponent(id)}`;
      const response = await fetch(url, { headers: { [DOWNLOAD_KEY_HEADER]: this.downloadKey }, cache: "no-store", signal: transfer.signal });
      if (response.status === 204) return;
      if (response.status === 202 || response.status === 410) {
        const parsed = assetFailureSchema.safeParse(await response.json());
        failure = parsed.success ? parsed.data : { reason: "transport", status: response.status };
        if (response.status === 202) {
          if (job.attempts < 8) { job.retryMs = Math.min(4_000, 500 * 2 ** (job.attempts - 1)); return; }
          failure = { ...failure, reason: "timeout" };
        }
        throw new Error("Asset not delivered");
      }
      if (!response.ok) { failure = { reason: "transport", status: response.status }; throw new Error("Asset unavailable"); }
      if (Number(response.headers.get("content-length") ?? 0) > 12 * 1024 * 1024) { failure = { reason: "too-large" }; throw new Error("Asset too large"); }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 12 * 1024 * 1024) { failure = { reason: "too-large" }; throw new Error("Asset too large"); }
      if (controller.signal.aborted) return;
      const type = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
      for (const listener of this.assetListeners.get(tabId) ?? []) listener({ id, type, bytes });
    } catch {
      if (controller.signal.aborted) return;
      if (timedOut) failure = { reason: "timeout" };
      if ((failure.reason === "transport" || timedOut) && job.attempts < 3) { job.retryMs = 500 * 2 ** (job.attempts - 1); return; }
      console.debug("[mirror] Asset unavailable", { tabId, id, attempts: job.attempts, ...failure });
      for (const listener of this.mirrorListeners.get(tabId) ?? []) listener({ k: "assetMissing", id, failure });
    } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); }
  }

  /** A binary asset frame arrived: reassemble it and, when whole, hand it out. */
  private onAssetChunk(data: ArrayBuffer): void {
    const asset = this.assembler.receive(data);
    if (asset === null) return;
    const set = this.assetListeners.get(asset.tabId);
    if (set === undefined) return;
    const built: MirrorAsset = { id: asset.id, type: asset.type, bytes: asset.bytes };
    for (const listener of set) listener(built);
  }

  /**
   * Tell the host how big this pane is, in CSS pixels and at its device pixel
   * ratio, and whether it is on screen at all. `visible: false` stops the
   * tab's screencast. The last value per tab is remembered and replayed after
   * a reconnect, so a pane that never re-rendered still gets its picture back.
   */
  pane(tabId: string, state: PaneState): void {
    const previous = this.panes.get(tabId);
    if (
      previous !== undefined &&
      previous.width === state.width &&
      previous.height === state.height &&
      previous.dpr === state.dpr &&
      previous.visible === state.visible &&
      previous.renderer === state.renderer &&
      previous.hybridMedia === state.hybridMedia
    ) {
      return;
    }
    this.panes.set(tabId, state);
    this.send({ t: "pane", tabId, ...state });
  }

  /** A pane that is gone: stop its screencast and forget it. */
  releasePane(tabId: string): void {
    const previous = this.panes.get(tabId);
    this.panes.delete(tabId);
    this.frameListeners.delete(tabId);
    this.mirrorListeners.delete(tabId);
    this.assetListeners.delete(tabId);
    this.cancelAssets(tabId);
    if (previous !== undefined && previous.visible) {
      this.send({ t: "pane", tabId, width: previous.width, height: previous.height, dpr: previous.dpr, visible: false });
    }
  }

  /**
   * Forward one event under the generation it was issued in (W7). The host
   * drops anything from an older generation, and anything at all while the
   * agent holds control; dropping it here too keeps a stray pointer move off
   * the wire entirely.
   */
  input(tabId: string, event: ShellInputEvent | null): void {
    if (event === null || this.control.holder !== "human") return;
    this.send({ t: "input", tabId, generation: this.control.generation, viewGeneration: this.linked.generation, event });
  }

  /* -------------------------------- the RPC ------------------------------- */

  /**
   * One `ShellApi` call as a `{t:'call'}` envelope. Every generated method
   * above lands here; the host validates arity and shape per method and
   * answers an unknown or unimplemented one with `unsupported` rather than
   * closing the socket.
   */
  call(method: SocketMethodName, args: unknown[]): Promise<unknown> {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ShellSocketError("unreachable", "The cloud browser is not connected."));
    }
    this.nextId += 1;
    const id = String(this.nextId);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ShellCallError(method, "failed", "The cloud browser did not answer in time."));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject, timer });
      socket.send(encodeShellClientFrame({ t: "call", id, method, args, viewGeneration: this.linked.generation }));
    });
  }

  /**
   * A socket that dropped and came back. The gap swallowed every event in
   * between, and the snapshot is only part of what the shell holds — devices,
   * sync, egress, cloud, channels, the account and which members this host
   * refuses all arrived as one-time answers — so the shell re-reads them all
   * (`useAppStore.resync()`), rather than this transport guessing which ones
   * mattered.
   */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  /** One `on*` member: register, and answer with the unsubscribe. */
  subscribe(channel: string, listener: Listener): () => void {
    const set = this.listeners.get(channel) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(channel, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(channel);
    };
  }

  /* ------------------------------- internals ------------------------------ */

  private setStatus(phase: ShellSocketPhase, error: string | null, code: ShellSocketStatus["code"]): void {
    this.status = { phase, error, code };
    for (const listener of this.statusListeners) listener(this.status);
  }

  private setControl(control: ShellControl): void {
    this.control = control;
    for (const listener of this.controlListeners) listener(control);
  }

  private send(frame: ShellClientFrame): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeShellClientFrame(frame));
  }

  private emit(channel: string, payload: unknown): void {
    const set = this.listeners.get(channel);
    if (set === undefined) return;
    for (const listener of set) (listener as unknown as (value: unknown) => void)(payload);
  }

  private failPending(error: Error): void {
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  /** Over for good: report it, wake anyone waiting on the first connect. */
  private finish(code: ShellErrorCode | "unreachable", message?: string): void {
    this.cancelAllAssets();
    const error = new ShellSocketError(code, message ?? "");
    this.setStatus("closed", error.message, code);
    this.failPending(error);
    this.opened?.reject(error);
    this.opened = null;
  }

  private cancelAllAssets(): void {
    for (const controller of this.assetJobs.values()) controller.abort();
    this.assetJobs.clear();
    for (const timer of this.assetRetryTimers.values()) clearTimeout(timer);
    this.assetRetryTimers.clear();
    this.assetAgain.clear();
    this.assetQueue = [];
  }

  private async dial(): Promise<void> {
    if (this.disposed) return;
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting", null, null);

    let ticket: { url: string; ticket: string };
    try {
      ticket = await this.options.ticket();
    } catch (cause: unknown) {
      if (this.disposed) return;
      if (cause instanceof ShellSocketError && cause.code === "unauthorized") { this.finish("unauthorized", cause.message); return; }
      // `session_ended` and `no_cloud_browser` are states of the session, not
      // dropped connections; neither is worth another dial.
      const ended = typeof cause === "object" && cause !== null && "code" in cause && (cause.code === "session_ended" || cause.code === "not_found");
      if (ended) this.finish("ended", describeShellError(cause));
      else this.retry(describeShellError(cause));
      return;
    }
    if (this.disposed) return;

    let socket: WebSocket;
    try {
      this.cloudBrowserUrl = ticket.url;
      socket = new WebSocket(shellSocketUrl(ticket.url, this.options.sessionId, ticket.ticket));
    } catch (cause: unknown) {
      this.retry(describeShellError(cause));
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    /** Set when the host said why it is closing: not a drop, do not redial. */
    let named: ShellErrorCode | null = null;

    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.disposed || this.socket !== socket) return;
      // Asset bytes ride binary frames beside the JSON ones (§16.3).
      if (typeof event.data !== "string") {
        if (event.data instanceof ArrayBuffer) this.onAssetChunk(event.data);
        return;
      }
      const frame = decodeShellServerFrame(event.data);
      if (frame === null) return;
      if (frame.t === "error") named = frame.code;
      this.onFrameReceived(socket, frame);
    });

    socket.addEventListener("close", (event: CloseEvent) => {
      if (this.disposed || this.socket !== socket) return;
      this.socket = null;
      this.failPending(new ShellSocketError("unreachable", "The cloud browser disconnected."));
      if (event.code === CLOSE_REVOKED) {
        this.finish("unauthorized", "This browser is no longer allowed to open this session — its key was revoked.");
        return;
      }
      if (event.code === CLOSE_SPACE_KEY_REQUIRED) {
        this.finish("space_key_required");
        return;
      }
      if (event.code === CLOSE_LEASE_LOST) {
        // The worker let go. One more dial, a beat later: the session is
        // claimed on demand, so the ticket's next redemption may find a
        // worker that has picked it up (§6.4).
        if (this.leaseRetried) {
          this.finish("lease_lost");
          return;
        }
        this.leaseRetried = true;
        this.setStatus("reconnecting", null, null);
        this.timer = setTimeout(() => void this.dial(), LEASE_RETRY_DELAY_MS);
        return;
      }
      if (named !== null) {
        this.finish(named);
        return;
      }
      // Everything else is a drop, and a refused upgrade looks like one: a
      // worker that no longer holds the session answers the upgrade `409`
      // rather than relaying it (§6.4), and the cure is the same — dial again
      // with a fresh ticket, which the next redemption routes wherever the
      // session has gone.
      this.retry("The cloud browser disconnected.");
    });

    // The close that follows carries the code; nothing to decide here.
    socket.addEventListener("error", () => undefined);
  }

  private retry(message: string): void {
    if (this.disposed) return;
    if (this.attempts >= MAX_RECONNECTS) {
      this.finish("unreachable", message);
      return;
    }
    this.attempts += 1;
    this.setStatus("reconnecting", null, null);
    this.timer = setTimeout(() => void this.dial(), RECONNECT_DELAY_MS);
  }

  private onFrameReceived(socket: WebSocket, frame: ShellServerFrame): void {
    switch (frame.t) {
      case "linked": this.setLinked(frame.state); return;
      case "cursor": for (const listener of this.cursorListeners) listener(frame.cursor); return;
      case "challenge":
        void this.prove(socket, frame.nonce);
        return;
      case "ready": {
        const first = this.opened !== null;
        this.attempts = 0;
        this.leaseRetried = false;
        this.downloadKey = frame.downloadKey ?? "";
        this.viewerId = frame.viewerId ?? "";
        if (frame.linked) this.setLinked(frame.linked);
        this.setControl(frame.control);
        this.setStatus("open", null, null);
        this.opened?.resolve();
        this.opened = null;
        // Every pane described itself to a socket that is gone; say it again
        // so the screencasts come back at the size they were.
        for (const [tabId, pane] of this.panes) {
          this.send({ t: "pane", tabId, ...pane });
        }
        // A reconnect missed every event in between. The host is the only
        // source of the snapshot, so ask for it whole and re-emit it on the
        // two channels the store folds back together (§6.3).
        if (!first) void this.resync();
        return;
      }
      case "reply": {
        const call = this.pending.get(frame.id);
        if (call === undefined) return;
        this.pending.delete(frame.id);
        clearTimeout(call.timer);
        if (frame.ok) {
          call.resolve(frame.result);
          return;
        }
        call.reject(new ShellCallError(call.method, frame.error.code, frame.error.message));
        return;
      }
      case "event":
        this.emit(frame.channel, frame.payload);
        return;
      case "frame": {
        const set = this.frameListeners.get(frame.tabId);
        if (set === undefined) return;
        for (const listener of set) listener(frame);
        return;
      }
      case "mirror": {
        if (frame.msg.k === "assetReady") { this.queueAsset(frame.tabId, frame.msg.id); return; }
        if (frame.msg.k === "snapshot" || frame.msg.k === "stopped") this.cancelAssets(frame.tabId);
        const set = this.mirrorListeners.get(frame.tabId);
        if (set === undefined) return;
        for (const listener of set) listener(frame.msg);
        return;
      }
      case "control":
        this.setControl({ holder: frame.holder, generation: frame.generation });
        return;
      case "error":
        // The host closes the socket next; the close handler reads the code.
        this.setStatus(this.status.phase, frame.message, frame.code);
        return;
    }
  }

  /**
   * Fetch one finished download into this browser and hand it to the person.
   *
   * NOT `window.open`. The minted URL names the download; what proves WHO is
   * asking is this viewer's key, and a key belongs in a header — a URL
   * reaches the browser's history, `performance.getEntries()`, and every
   * proxy in between, and this one is handed to the person's own browser.
   * Only a fetch can carry a header, so the bytes arrive here as a blob and
   * a same-origin object URL is what the download attribute is given.
   *
   * The name comes from the session's own download list rather than from the
   * response, because `content-disposition` is not a header a cross-origin
   * fetch may read unless the host exposes it, and a file called `download`
   * is a worse answer than one round trip.
   */
  private async fetchDownload(downloadId: string): Promise<void> {
    if (this.downloadKey === "") {
      throw new ShellCallError("downloadUrl", "unsupported", "This cloud browser cannot hand a download to this tab.");
    }
    const answer = await this.downloadUrl(downloadId);
    const href = this.cloudBrowserUrl === "" ? answer.url : new URL(answer.url, this.cloudBrowserUrl).toString();
    const named = await this.getDownloads().catch((): BrowserDownload[] => []);
    const fileName = named.find((download) => download.id === downloadId)?.fileName ?? "download";
    const response = await fetch(href, {
      headers: { [DOWNLOAD_KEY_HEADER]: this.downloadKey },
      credentials: "omit",
      cache: "no-store",
    }).catch(() => null);
    if (response === null || !response.ok) {
      throw new ShellCallError(
        "downloadUrl",
        "failed",
        "That download could not be fetched; the link is good for one use and a minute.",
      );
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Long enough for the browser to have taken the bytes, short enough that
    // a session's downloads are not held in memory for the tab's lifetime.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }

  /** Answer the host's challenge: the nonce sealed under the Space key. */
  private async prove(socket: WebSocket, nonce: string): Promise<void> {
    let proof: string;
    try {
      proof = await this.options.prove(nonce);
    } catch {
      this.finish("space_key_required", "This browser could not answer the cloud browser's challenge.");
      socket.close(1000, "proof failed");
      return;
    }
    if (this.disposed || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeShellClientFrame({ t: "auth", proof }));
  }

  /** Catch the store up after a gap in the event stream. */
  private async resync(): Promise<void> {
    // A shell is attached: it re-reads the whole of what a first load reads,
    // which includes the snapshot. Doing that here as well would be a second
    // `getSnapshot` for the same reconnect.
    if (this.reconnectListeners.size > 0) {
      for (const listener of this.reconnectListeners) listener();
      return;
    }
    let snapshot: ShellSnapshot;
    try {
      snapshot = (await this.call("getSnapshot", [])) as ShellSnapshot;
    } catch {
      // The socket went again, or the host cannot answer. The next `ready`
      // tries once more; nothing here is worth tearing the page down for.
      return;
    }
    const { run, threads, ...tabs } = snapshot;
    this.emit(SNAPSHOT_CHANNEL, tabs satisfies ShellTabsSnapshot);
    this.emit(RUN_CHANNEL, { run, threads } satisfies ShellRunSnapshot);
  }
}
