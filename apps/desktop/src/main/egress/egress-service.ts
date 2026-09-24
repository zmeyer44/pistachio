/**
 * EgressService — the `egress:*` IPC surface (docs/cloud-sync-design.md
 * §10.3, D13). Applies the shared @pistachio/egress-policy rules to every
 * Space session whose policy is `identity` via `session.setProxy`, holds the
 * gateway credential from `GET /egress` in memory only (D20), answers the
 * gateway's proxy challenges, probes gateway health, and fails closed when
 * the gateway is unreachable.
 *
 * Fail-closed mechanics: an identity Space's proxy rules name the gateway
 * and nothing after it. When the gateway is down, Chromium cannot open the
 * tunnel and the request fails at the network stack. The one-click "browse
 * direct for now" override is in-memory only, logged, and resets the moment
 * the health probe comes back up — deliberately not sticky.
 *
 * QUIC: a CONNECT proxy tunnels TCP only; Chromium would race HTTP/3 over UDP
 * straight past it. main/index.ts appends `--disable-quic` before app ready
 * whenever spaces.json has an identity Space; a Space switched to identity
 * mid-run browses direct until the next launch and says so
 * (`restartRequired`).
 */

import { proxyConfigFor, type GatewayState, type NetworkContext, type SpaceEgressConfig } from "@pistachio/egress-policy";
import type { EgressStatus } from "@pistachio/shell-contracts/ipc";
import type { SpaceEgressPolicy } from "@pistachio/shell-contracts/spaces";
import type { SpaceStore } from "../space-store";
import type { ControlClient, ControlEgressCredential, ControlEgressGateway } from "../account/control-client";
import {
  buildSpaceEgressConfig,
  credentialIsLive,
  credentialRefreshDelayMs,
  gatewayEndpoint,
  healthProbeUrl,
  matchesProxyChallenge,
  mayProxyThisRun,
  parseEgressUrlPin,
  proxyServerFor,
  shouldResetOverrides,
  spaceEgressStatusFor,
  type GatewayEndpoint,
  type ProxyChallengeInfo,
} from "./egress-state";

export const HEALTH_PROBE_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;
/** Re-read `GET /egress` on this schedule even while the credential is fresh. */
const CREDENTIAL_REFETCH_MS = 12 * 60 * 60 * 1000;
/** A rejected credential triggers one refresh; another within this window does not. */
const CHALLENGE_REFRESH_COOLDOWN_MS = 30_000;
/** Never re-read `GET /egress` faster than this, whatever expiry control answers with. */
const MIN_REFRESH_INTERVAL_MS = 60_000;
/**
 * Where an identity Space points while no gateway is known at all: a proxy
 * nothing listens on, so its traffic is refused rather than sent direct.
 */
const FAIL_CLOSED_ENDPOINT: GatewayEndpoint = { scheme: "https", host: "127.0.0.1", port: 9 };

/** What the gateway's proxy challenge is answered with, and who may be asked. */
export interface ProxyCredential {
  username: string;
  password: string;
  host: string;
  port: number;
}

/** The subset of Electron's Session the service drives, so tests can stand in. */
export interface ProxySession {
  setProxy(config: { mode?: "fixed_servers" | "direct"; proxyRules?: string; proxyBypassRules?: string }): Promise<void>;
  clearAuthCache(): Promise<void>;
}

export interface EgressServiceDeps {
  spaces: SpaceStore;
  /** The enrolled control client, or null while there is none: nothing is fetched then. */
  control(): ControlClient | null;
  /** Whether `--disable-quic` was appended before app ready. */
  quicDisabledAtStartup: boolean;
  /** `PISTACHIO_EGRESS_URL`: a dev gateway pin for the probe (and, when http, the proxy rule). */
  egressUrlPin?: string | undefined;
  publish(status: EgressStatus): void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface SessionEntry {
  session: ProxySession;
  spaceId: string;
}

export class EgressService {
  readonly #deps: EgressServiceDeps;
  readonly #pin: GatewayEndpoint | null;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  /** partition → its session, so a rotation or health change re-applies everywhere. */
  readonly #sessions = new Map<string, SessionEntry>();
  /** Space ids with an active "browse direct for now" (in-memory by design). */
  readonly #overrides = new Set<string>();
  #enabled = false;
  #gateway: ControlEgressGateway | null = null;
  /** In memory only; never written anywhere (D20). */
  #credential: ControlEgressCredential | null = null;
  #health: "up" | "down" | "unknown" = "unknown";
  #probeTimer: NodeJS.Timeout | null = null;
  #refreshTimer: NodeJS.Timeout | null = null;
  #refetchTimer: NodeJS.Timeout | null = null;
  #refreshInFlight: Promise<boolean> | null = null;
  #lastChallengeRefreshMs = Number.NEGATIVE_INFINITY;
  #offSpaces: (() => void) | null = null;

  constructor(deps: EgressServiceDeps) {
    this.#deps = deps;
    this.#pin = parseEgressUrlPin(deps.egressUrlPin);
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#now = deps.now ?? (() => Date.now());
  }

  /** Enrolled: fetch the credential, probe the gateway, follow Space changes. */
  start(): void {
    if (this.#enabled) return;
    this.#enabled = true;
    void this.refreshCredential();
    void this.#probe();
    this.#probeTimer = setInterval(() => void this.#probe(), HEALTH_PROBE_MS);
    this.#probeTimer.unref();
    this.#refetchTimer = setInterval(() => void this.refreshCredential(), CREDENTIAL_REFETCH_MS);
    this.#refetchTimer.unref();
    // Space policy can change under us (Settings, a `space:` doc from
    // another device): re-apply and republish rather than trust the last apply.
    this.#offSpaces = this.#deps.spaces.onChange(() => {
      void this.#reapplyAll();
      this.#publish();
    });
    this.#publish();
  }

  /** Signed out or revoked: forget the credential, route everything direct, stop probing. */
  stop(): void {
    if (this.#probeTimer !== null) clearInterval(this.#probeTimer);
    if (this.#refetchTimer !== null) clearInterval(this.#refetchTimer);
    if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
    this.#probeTimer = null;
    this.#refetchTimer = null;
    this.#refreshTimer = null;
    this.#offSpaces?.();
    this.#offSpaces = null;
    this.#enabled = false;
    this.#credential = null;
    this.#gateway = null;
    this.#health = "unknown";
    this.#overrides.clear();
    void this.#reapplyAll();
    this.#publish();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Where the gateway is reached: the dev pin when set, else the provisioned gateway over https. */
  gatewayEndpoint(): GatewayEndpoint | null {
    return gatewayEndpoint(this.#gateway, this.#pin);
  }

  status(): EgressStatus {
    const endpoint = this.gatewayEndpoint();
    const gateway = this.#gateway;
    return {
      enabled: this.#enabled,
      gateway:
        gateway !== null
          ? { host: gateway.host, port: gateway.port, egressIp: gateway.egressIp, region: gateway.region, state: gateway.state }
          : endpoint !== null
            ? { host: endpoint.host, port: endpoint.port, egressIp: null, region: null, state: "pinned" }
            : null,
      health: this.#health,
      credentialExpiresAt: this.#liveCredential()?.expiresAt ?? null,
      quicDisabledAtStartup: this.#deps.quicDisabledAtStartup,
      spaces: this.#deps.spaces
        .all()
        .map((space) =>
          spaceEgressStatusFor(this.#configFor(space.id, space.egressPolicy), this.#gatewayState(), this.#deps.quicDisabledAtStartup),
        ),
    };
  }

  /** The credential an identity Space's proxied read presents, or null when it browses direct. */
  proxyCredentialFor(spaceId: string): ProxyCredential | null {
    if (!this.#enabled || !this.#proxiedNow(spaceId)) return null;
    const endpoint = this.gatewayEndpoint();
    const credential = this.#liveCredential();
    if (endpoint === null || credential === null) return null;
    return { username: credential.username, password: credential.password, host: endpoint.host, port: endpoint.port };
  }

  /**
   * Register a Space session (its partition is the registry key) and apply
   * its proxy rules. BrowserController calls this through
   * `prepareSpaceSession` before it creates the first view on the session.
   */
  async applyProxy(session: ProxySession, spaceId: string, partition = `space:${spaceId}`): Promise<void> {
    this.#sessions.set(partition, { session, spaceId });
    await this.#apply(session, spaceId);
  }

  /** A session went away (the agent partition of a finished run). */
  forgetSession(partition: string): void {
    this.#sessions.delete(partition);
  }

  /**
   * The `app.on('login')` body (§10.3). Only the gateway's own proxy
   * challenge is answered, and only with the egress credential; an origin's
   * 401 and any other proxy are left to Chromium's default (cancel). A
   * challenge after a rejected credential (`firstAuthAttempt === false`)
   * refreshes once and answers with the refreshed credential, once: a
   * further rejection inside the cooldown is cancelled rather than answered
   * again, so a credential the gateway refuses can never loop.
   */
  handleLogin(
    event: { preventDefault(): void },
    details: { firstAuthAttempt: boolean },
    authInfo: ProxyChallengeInfo,
    callback: (username?: string, password?: string) => void,
  ): void {
    if (!matchesProxyChallenge(authInfo, this.gatewayEndpoint())) return;
    event.preventDefault();
    const answer = (): void => {
      const credential = this.#liveCredential();
      if (credential === null) callback();
      else callback(credential.username, credential.password);
    };
    if (details.firstAuthAttempt === false) {
      const refreshedRecently =
        this.#now() - this.#lastChallengeRefreshMs < CHALLENGE_REFRESH_COOLDOWN_MS;
      if (refreshedRecently && this.#refreshInFlight === null) {
        callback();
        return;
      }
      void this.#refreshAfterChallenge().then(answer, answer);
      return;
    }
    answer();
  }

  /** `GET /egress` now; single-flight. Answers whether a credential is held afterwards. */
  refreshCredential(): Promise<boolean> {
    if (this.#refreshInFlight !== null) return this.#refreshInFlight;
    const attempt = this.#refreshOnce().finally(() => {
      if (this.#refreshInFlight === attempt) this.#refreshInFlight = null;
    });
    this.#refreshInFlight = attempt;
    return attempt;
  }

  async setSpacePolicy(spaceId: string, policy: SpaceEgressPolicy): Promise<EgressStatus> {
    if (this.#deps.spaces.setEgressPolicy(spaceId, policy) === null) throw new Error("unknown Space");
    if (policy === "direct") this.#overrides.delete(spaceId);
    await this.#reapplyAll();
    this.#publish();
    return this.status();
  }

  /** The explicit escape hatch while the gateway is down; logged, and gone when it returns. */
  async browseDirect(spaceId: string): Promise<EgressStatus> {
    const space = this.#deps.spaces.get(spaceId);
    if (space === null) throw new Error("unknown Space");
    if (space.egressPolicy === "identity") {
      console.warn(`[egress] browsing direct for now in Space ${spaceId} at the person's request (gateway ${this.#health})`);
      this.#overrides.add(spaceId);
      await this.#reapplyAll();
    }
    this.#publish();
    return this.status();
  }

  /* -------------------------------- internals -------------------------------- */

  #liveCredential(): ControlEgressCredential | null {
    const credential = this.#credential;
    if (credential === null || !credentialIsLive(credential.expiresAt, this.#now())) return null;
    return credential;
  }

  #gatewayState(): GatewayState {
    return this.#health === "up" ? "up" : "down";
  }

  #configFor(spaceId: string, policy: SpaceEgressPolicy): SpaceEgressConfig {
    return buildSpaceEgressConfig(spaceId, policy, this.#overrides.has(spaceId));
  }

  #net(): NetworkContext {
    // Corporate-VPN route detection is not implemented; reported as absent.
    return { gateway: this.#gatewayState(), vpnRoutes: [], vpnActive: false };
  }

  /** Whether the Space's traffic goes through the gateway right now. */
  #proxiedNow(spaceId: string): boolean {
    const space = this.#deps.spaces.get(spaceId);
    if (space === null || space.egressPolicy !== "identity") return false;
    if (!mayProxyThisRun(this.#deps.quicDisabledAtStartup)) return false;
    return !(this.#health === "down" && this.#overrides.has(spaceId));
  }

  async #apply(session: ProxySession, spaceId: string): Promise<void> {
    const space = this.#deps.spaces.get(spaceId);
    const policy = space?.egressPolicy ?? "direct";
    const config = this.#configFor(spaceId, policy);
    try {
      if (!this.#enabled || policy === "direct" || !this.#proxiedNow(spaceId)) {
        // Direct, restart-required, or browsing direct by override: the plain
        // network. proxyConfigFor's direct shape is what setProxy takes.
        await session.setProxy(proxyConfigFor({ ...config, policy: "direct" }, FAIL_CLOSED_ENDPOINT, this.#net()));
        return;
      }
      const endpoint = this.gatewayEndpoint() ?? FAIL_CLOSED_ENDPOINT;
      const chromium = proxyConfigFor(config, { host: endpoint.host, port: endpoint.port }, this.#net());
      await session.setProxy({
        mode: chromium.mode,
        // A dev pin runs the gateway as plain HTTP; production is https (§14).
        proxyRules: endpoint.scheme === "https" ? chromium.proxyRules : proxyServerFor(endpoint),
        proxyBypassRules: chromium.proxyBypassRules,
      });
    } catch (error) {
      console.error(`[egress] setProxy failed for Space ${spaceId}`, error);
    }
  }

  async #reapplyAll(): Promise<void> {
    for (const entry of this.#sessions.values()) await this.#apply(entry.session, entry.spaceId);
  }

  async #refreshOnce(): Promise<boolean> {
    const control = this.#deps.control();
    if (control === null || !this.#enabled) return false;
    let out;
    try {
      out = await control.egress();
    } catch (error) {
      console.error("[egress] GET /egress failed", error);
      this.#scheduleRefresh(5 * 60 * 1000);
      return this.#liveCredential() !== null;
    }
    const previous = this.#gateway;
    const previousCredentialId = this.#credential?.credentialId ?? null;
    this.#gateway = out.gateway;
    this.#credential = out.credential;
    const credential = this.#liveCredential();
    this.#scheduleRefresh(
      credential === null
        ? 5 * 60 * 1000
        : Math.max(MIN_REFRESH_INTERVAL_MS, credentialRefreshDelayMs(credential.expiresAt, this.#now())),
    );
    const gatewayChanged =
      previous === null || out.gateway === null || previous.host !== out.gateway.host || previous.port !== out.gateway.port;
    if (gatewayChanged) await this.#reapplyAll();
    if (credential !== null && credential.credentialId !== previousCredentialId && previousCredentialId !== null) {
      // Rotation: Chromium keeps the old proxy credential in the session's
      // auth cache and would retry with it first. Drop it so the next
      // challenge is answered with the fresh one.
      for (const entry of this.#sessions.values()) {
        if (this.#proxiedNow(entry.spaceId)) await entry.session.clearAuthCache().catch(() => undefined);
      }
    }
    this.#publish();
    return credential !== null;
  }

  #scheduleRefresh(delayMs: number): void {
    if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.refreshCredential();
    }, delayMs);
    this.#refreshTimer.unref();
  }

  /** A rejected credential: refresh once, not once per retried request. */
  #refreshAfterChallenge(): Promise<boolean> {
    const now = this.#now();
    if (now - this.#lastChallengeRefreshMs < CHALLENGE_REFRESH_COOLDOWN_MS) {
      return this.#refreshInFlight ?? Promise.resolve(this.#liveCredential() !== null);
    }
    this.#lastChallengeRefreshMs = now;
    return this.refreshCredential();
  }

  async #probe(): Promise<void> {
    const next = await this.#probeGateway();
    if (next === this.#health) return;
    const previous = this.#health;
    if (previous !== "unknown" && shouldResetOverrides(previous, next)) this.#overrides.clear();
    this.#health = next;
    await this.#reapplyAll();
    this.#publish();
  }

  async #probeGateway(): Promise<"up" | "down"> {
    const endpoint = this.gatewayEndpoint();
    if (endpoint === null || !this.#enabled) return "down";
    try {
      const response = await this.#fetch(healthProbeUrl(endpoint), {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return response.ok ? "up" : "down";
    } catch {
      return "down";
    }
  }

  #publish(): void {
    this.#deps.publish(this.status());
  }
}

