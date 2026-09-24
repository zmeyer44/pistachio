/**
 * Builds and retires user and space sessions for the runner
 * (docs/cloud-sync-design.md §8.1): the proxy-configured `BrowserContext`
 * per `(userId, spaceId)`, its guarded backend, capture, and applier; the
 * per-run egress credential; and the 10-minute idle close after the last
 * run for a Space ends.
 */

import { WsTransport, type DeviceRegistryVerifier, type HubTransport, type TransportEvents } from "@pistachio/sync-engine";
import type { ArtifactRecord, SpaceKeys } from "@pistachio/sync-protocol";
import { PlaywrightBrowserBackend } from "../backend/playwright-backend.js";
import { installNetworkGuard } from "../browser/guard.js";
import type { BrowserNetworkPolicy } from "../browser/network-policy.js";
import type { PlaywrightBrowserRuntime } from "../browser/runtime.js";
import { ControlError, isDeviceRejection, type ControlClient, type EgressGateway } from "../control-client.js";
import { DeviceUnavailableError, type DeviceIdentityService } from "../identity/provision.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import { PlaywrightCookieApplier } from "./applier.js";
import { browserContextIdFor, CdpCookieJar, PlaywrightCookieCapture } from "./capture.js";
import {
  spaceHolderKey,
  UserSession,
  type SpaceBrowserParts,
  type SpaceHolder,
  type SpaceSession,
} from "./session.js";

/** Contexts close this long after the last run for their Space ends. */
export const DEFAULT_SESSION_IDLE_MS = 10 * 60_000;

export class EgressUnavailableError extends Error {
  constructor() {
    super("no egress gateway is provisioned for this user");
    this.name = "EgressUnavailableError";
  }
}

export type TransportFactory = (hubUrl: string, deviceId: string, events: TransportEvents) => HubTransport;

export interface SessionManagerOptions {
  runtime: PlaywrightBrowserRuntime;
  identity: DeviceIdentityService;
  control: ControlClient;
  policy: BrowserNetworkPolicy;
  artifactWebUrl?: string;
  /** The hub closed a user's socket with 4003. */
  onRevoked: (userId: string) => void;
  transportFactory?: TransportFactory;
  /** The proxy URL scheme for the gateway (`https` in production; `http` for the dev gateway). */
  egressScheme?: "https" | "http";
  /**
   * `gateway` (default): every context proxies through the user's gateway and
   * a user without one cannot run (fail closed, D13). `direct`: no proxy at
   * all — development without a gateway and the local test suites; requires
   * a runtime launched with `proxyMode: 'direct'`.
   */
  egressMode?: "gateway" | "direct";
  sessionIdleMs?: number;
  renewIntervalMs?: number;
  hydrationTimeoutMs?: number;
  now?: () => number;
  log?: Logger;
}

export class SessionManager {
  readonly users = new Map<string, UserSession>();
  readonly #options: SessionManagerOptions;
  readonly #log: Logger;
  readonly #transportFactory: TransportFactory;
  readonly #pendingUsers = new Map<string, Promise<UserSession>>();
  /** Bumped by `closeUser`; a creation that started earlier is discarded. */
  readonly #closeGeneration = new Map<string, number>();
  readonly #idleTimers = new Map<string, NodeJS.Timeout>();
  readonly #credentialRefreshes = new Map<string, Promise<void>>();
  #closed = false;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
    this.#log = options.log ?? silentLogger;
    this.#transportFactory =
      options.transportFactory ?? ((hubUrl, deviceId, events): HubTransport => new WsTransport(hubUrl, deviceId, "cloud", events));
  }

  userFor(userId: string): UserSession | null {
    return this.users.get(userId) ?? null;
  }

  /**
   * The space session for one holder (§6.2): the user's hub session, an
   * egress credential for that holder, the Space's context. Counts the holder
   * as active, so the context stays open while a run OR a person's browser
   * session is using it.
   *
   * A run acting inside a session that already has a credential reuses it
   * rather than minting a second — the pages are the same pages, and control
   * revokes a credential by the id that minted it.
   */
  async acquire(userId: string, spaceId: string, holder: SpaceHolder): Promise<SpaceSession> {
    if (this.#closed) throw new Error("session manager closed");
    const user = await this.#user(userId);
    let minted = false;
    if (this.#options.egressMode === "direct") {
      // No proxy in this mode: a gateway credential would never be presented.
    } else if (user.gateway !== null) {
      if (holder.kind === "run" && user.hasCredentialFor(spaceId)) {
        // The session's credential is already on the wire for these pages.
      } else {
        let credential;
        try {
          credential = await this.#options.control.egressCredential(
            userId,
            user.deviceId,
            holder.kind === "run" ? { runId: holder.runId } : { sessionId: holder.sessionId },
          );
        } catch (error) {
          // 404: not the user's live cloud device; 503: control has no egress secret or provider.
          if (error instanceof ControlError && (error.status === 404 || error.status === 503)) throw new EgressUnavailableError();
          throw error;
        }
        user.setCredential(holder, credential);
        minted = true;
      }
    } else {
      throw new EgressUnavailableError();
    }
    this.#cancelIdle(userId, spaceId);
    let session;
    try {
      session = await user.space(spaceId);
    } catch (error) {
      // The holder never started: its credential must not outlive it.
      if (minted) user.dropCredential(holder);
      throw error;
    }
    session.holderStarted(holder);
    return session;
  }

  /** The holder is done: drop its credential, release its leases, start the idle clock. */
  release(userId: string, spaceId: string, holder: SpaceHolder): void {
    const user = this.users.get(userId);
    user?.dropCredential(holder);
    const session = user?.spaces.get(spaceId);
    if (session === undefined) return;
    session.holderEnded(holder);
    if (session.holderCount > 0 || this.#closed) return;
    const key = `${userId}/${spaceId}`;
    this.#cancelIdle(userId, spaceId);
    const timer = setTimeout(() => {
      this.#idleTimers.delete(key);
      void this.#closeIdle(userId, spaceId);
    }, this.#options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS);
    timer.unref();
    this.#idleTimers.set(key, timer);
  }

  /** Revocation: close every context and the transport for the user, discard credentials. */
  async closeUser(userId: string): Promise<void> {
    for (const key of [...this.#idleTimers.keys()]) {
      if (key.startsWith(`${userId}/`)) {
        clearTimeout(this.#idleTimers.get(key));
        this.#idleTimers.delete(key);
      }
    }
    // Never await an in-flight `#createUser` here. Revocation teardown calls
    // this while holding the identity service's per-user chain, and creation
    // needs that same chain (`identityFor`/`tokenFor`), so waiting on it would
    // deadlock the teardown that is trying to stop it. Bumping the generation
    // makes that creation discard itself when it lands.
    this.#closeGeneration.set(userId, (this.#closeGeneration.get(userId) ?? 0) + 1);
    const user = this.users.get(userId);
    if (user === undefined) return;
    this.users.delete(userId);
    await user.close();
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const userId of [...this.users.keys()]) await this.closeUser(userId);
  }

  /* ------------------------------ internals ------------------------------ */

  #user(userId: string): Promise<UserSession> {
    const existing = this.users.get(userId);
    if (existing !== undefined && !existing.closed) return Promise.resolve(existing);
    const pending = this.#pendingUsers.get(userId);
    if (pending !== undefined) return pending;
    const creation = this.#createUser(userId).finally(() => {
      if (this.#pendingUsers.get(userId) === creation) this.#pendingUsers.delete(userId);
    });
    this.#pendingUsers.set(userId, creation);
    return creation;
  }

  async #createUser(userId: string): Promise<UserSession> {
    const generation = this.#closeGeneration.get(userId) ?? 0;
    const identityService = this.#options.identity;
    const identity = await identityService.identityFor(userId);
    if (identity === null) throw new DeviceUnavailableError("cloud_device_missing");
    const token = await identityService.tokenFor(userId);
    let me;
    try {
      me = await this.#options.control.me(token);
    } catch (error) {
      if (isDeviceRejection(error)) {
        await identityService.revoke(userId);
        throw new DeviceUnavailableError("cloud_device_missing");
      }
      throw error;
    }
    const gateway: EgressGateway | null =
      this.#options.egressMode === "direct" || me.egress === null ? null : { host: me.egress.host, port: me.egress.port };
    if (this.#options.egressMode === "direct" && me.egress !== null) {
      this.#log.warn("egress mode is direct: the user's gateway is ignored", { userId });
    }
    const user = new UserSession({
      userId,
      deviceId: identity.deviceId,
      signer: { deviceId: identity.deviceId, privateKey: identity.signingPrivateKey },
      gateway,
      transportFactory: (events) => this.#transportFactory(me.hubUrl, identity.deviceId, events),
      getToken: () => identityService.tokenFor(userId).catch(() => null),
      keysFor: (spaceId) => identityService.spaceKeysFor(userId, spaceId),
      verifierFor: (refresh): Promise<DeviceRegistryVerifier> => identityService.verifierFor(userId, { refresh }),
      ...(this.#options.artifactWebUrl === undefined ? {} : { artifactWebUrl: this.#options.artifactWebUrl }),
      onArtifactChanged: (artifact) => {
        void this.#refreshPublicArtifact(userId, artifact);
      },
      createSpaceBrowser: (spaceId, session, keys) => this.#createSpaceBrowser(session, spaceId, keys),
      onRevoked: () => this.#options.onRevoked(userId),
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      ...(this.#options.renewIntervalMs === undefined ? {} : { renewIntervalMs: this.#options.renewIntervalMs }),
      ...(this.#options.hydrationTimeoutMs === undefined ? {} : { hydrationTimeoutMs: this.#options.hydrationTimeoutMs }),
      log: this.#log,
    });
    if ((this.#closeGeneration.get(userId) ?? 0) !== generation) {
      // Revoked or closed while this session was being built.
      await user.close();
      throw new DeviceUnavailableError("cloud_device_missing");
    }
    this.users.set(userId, user);
    return user;
  }

  async #createSpaceBrowser(user: UserSession, spaceId: string, keys: SpaceKeys): Promise<SpaceBrowserParts> {
    const runtime = this.#options.runtime;
    const browser = await runtime.browser();
    const scheme = this.#options.egressScheme ?? "https";
    if (runtime.proxyMode === "per-context" && user.gateway === null) throw new EgressUnavailableError();
    if (runtime.proxyMode === "direct" && user.gateway !== null) {
      throw new Error("the browser was launched without a per-context proxy; a gateway cannot be applied");
    }
    const context = await browser.newContext({
      ...(user.gateway === null
        ? {}
        : { proxy: { server: `${scheme}://${user.gateway.host}:${String(user.gateway.port)}`, bypass: "<-loopback>" } }),
      serviceWorkers: "block",
      // A person's session downloads files (docs/web-browser-design.md §11);
      // the host is what decides where they land and how long they live, and
      // a context that refuses them would make that decision for it.
      acceptDownloads: true,
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: false,
    });
    try {
      const probe = await context.newPage();
      const browserContextId = await browserContextIdFor(probe);
      await probe.close();
      const jar = new CdpCookieJar(await runtime.cdp(), browserContextId);
      const capture = new PlaywrightCookieCapture({
        spaceId,
        jar,
        idKey: keys.idKey,
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
        log: this.#log,
      });
      const applier = new PlaywrightCookieApplier({ store: context, jar, capture, spaceId, idKey: keys.idKey });
      const policy = this.#options.policy;
      const tabListeners = new Set<() => void>();
      const backend = await PlaywrightBrowserBackend.attach({
        context,
        spaceId,
        policy,
        installGuard: (page) =>
          installNetworkGuard(page, {
            policy,
            gateway: () => user.gateway,
            credential: () => {
              const credential = user.credentialForSpace(spaceId);
              return credential === null ? null : { username: credential.username, password: credential.password };
            },
            onCredentialRejected: () => this.#refreshCredential(user, spaceId),
            onSetCookie: () => capture.scheduleDiff(),
            log: this.#log,
          }),
        onAction: () => capture.scheduleDiff(),
        onTabsChanged: () => {
          for (const listener of [...tabListeners]) listener();
        },
        log: this.#log,
      });
      return {
        browser: {
          backend,
          capture,
          onTabsChanged: (listener) => {
            tabListeners.add(listener);
            return () => tabListeners.delete(listener);
          },
          close: () => context.close(),
        },
        applier,
      };
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  async #refreshPublicArtifact(userId: string, artifact: ArtifactRecord): Promise<void> {
    try {
      const hosted = await this.#options.control.artifactPublishing(userId, artifact.id);
      // An absent/private row is the privacy boundary: its HTML never leaves
      // the encrypted workspace. Public rows opt into plaintext snapshots.
      if (hosted?.visibility !== "public") return;
      await this.#options.control.putArtifactRevision(userId, artifact.id, {
        revision: artifact.revision,
        html: artifact.html,
      });
    } catch (error) {
      this.#log.warn("public artifact refresh failed", { userId, artifactId: artifact.id, error: errorMessage(error) });
    }
  }

  /**
   * A stale credential was rejected twice: mint a fresh one for the run whose
   * pages presented it — the Space's newest live run — single-flight per run.
   * Credentials are revoked by run id, so refreshing another run's would hand
   * the Space a credential that its own revocation cannot cut.
   */
  #refreshCredential(user: UserSession, spaceId: string): void {
    const holder = user.credentialHolderFor(spaceId);
    if (holder === null || user.closed) return;
    const holderKey = spaceHolderKey(holder);
    const key = `${user.userId}/${holderKey}`;
    if (this.#credentialRefreshes.has(key)) return;
    const refresh = this.#options.control
      .egressCredential(
        user.userId,
        user.deviceId,
        holder.kind === "run" ? { runId: holder.runId } : { sessionId: holder.sessionId },
      )
      .then((credential) => {
        // The holder may have gone while the mint was in flight.
        if (!user.closed && user.spaces.get(spaceId)?.holders.has(holderKey) === true) {
          user.setCredential(holder, credential);
        }
      })
      .catch((error: unknown) => {
        this.#log.warn("egress credential refresh failed", { userId: user.userId, holder: holderKey, error: errorMessage(error) });
      })
      .finally(() => {
        this.#credentialRefreshes.delete(key);
      });
    this.#credentialRefreshes.set(key, refresh);
  }

  #cancelIdle(userId: string, spaceId: string): void {
    const key = `${userId}/${spaceId}`;
    const timer = this.#idleTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#idleTimers.delete(key);
  }

  async #closeIdle(userId: string, spaceId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user === undefined) return;
    const session = user.spaces.get(spaceId);
    if (session === undefined || session.holderCount > 0) return;
    await user.closeSpace(spaceId);
    if (user.spaces.size === 0) {
      this.users.delete(userId);
      await user.close();
    }
  }
}
