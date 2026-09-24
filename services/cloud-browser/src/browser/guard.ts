/**
 * The per-page network guard (docs/cloud-sync-design.md §8.1): one CDP
 * session per page that is the single owner of interception and
 * authentication. It answers the egress gateway's proxy challenge with the
 * session's current credential (read fresh on every challenge, so rotation
 * never recreates a context), cancels every other challenge — an origin's
 * 401 must never see the egress credential — and runs the SSRF policy on
 * every request. No `page.route`, no context credentials.
 *
 * One request the CDP interception cannot see is a WebSocket handshake; with
 * direct egress the guard blocks those in the page instead
 * (`WEBSOCKET_BLOCK_SCRIPT`).
 */

import { PageMediaProxy } from "./media-proxy.js";
import type { CDPSession, Page } from "playwright-core";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import type { BrowserNetworkPolicy } from "./network-policy.js";

export interface GuardCredential {
  username: string;
  password: string;
}

export interface GuardGateway {
  host: string;
  port: number;
}

export interface NetworkGuardOptions {
  policy: BrowserNetworkPolicy;
  /** The egress gateway whose challenges are answered; null cancels every proxy challenge. */
  gateway: () => GuardGateway | null;
  /** The session's current credential, re-read on every challenge. */
  credential: () => GuardCredential | null;
  /** A second consecutive proxy challenge for one request: the credential is stale. */
  onCredentialRejected?: () => void;
  /** A response carried `set-cookie` (the header only triggers a jar diff). */
  onSetCookie?: () => void;
  log?: Logger;
}

export interface GuardStats {
  requestsAllowed: number;
  requestsBlocked: number;
  proxyChallengesAnswered: number;
  proxyChallengesCancelled: number;
  serverChallengesCancelled: number;
  credentialRejections: number;
}

export interface PageNetworkGuard {
  readonly session: CDPSession;
  readonly stats: GuardStats;
  readonly media?: PageMediaProxy;
  detach(): Promise<void>;
}

interface AuthRequiredEvent {
  requestId: string;
  authChallenge: { source?: "Server" | "Proxy"; origin: string; scheme: string; realm: string };
}

interface RequestPausedEvent {
  requestId: string;
  request: { url: string };
}

interface ExtraInfoEvent {
  headers: Record<string, string>;
}

/**
 * Chromium hands a WebSocket handshake to the network service without ever
 * offering it to `Fetch` interception — patterns matching `ws:`/`wss:` (or
 * `*`) pause nothing, and `Network.setBlockedURLs` does not cover them
 * either — so `assertAllowed` never sees one. Behind the egress gateway that
 * is harmless: the handshake is a CONNECT the gateway vets like every other
 * target. With direct egress (dev laptops and the test suites) nothing else
 * is left, so the guard refuses to construct a WebSocket at all rather than
 * leave the page a way to reach an address its HTTP requests are refused.
 *
 * The script runs in every document of the page, the one already loaded
 * included. A dedicated worker builds its own global from Chromium's
 * bindings and keeps the real constructor; that is the known limit of a
 * document-side block.
 */
const WEBSOCKET_BLOCK_SCRIPT = `(() => {
  const blocked = function WebSocket() {
    throw new DOMException("browser network policy blocks WebSocket connections", "SecurityError");
  };
  Object.defineProperties(blocked, {
    CONNECTING: { value: 0 },
    OPEN: { value: 1 },
    CLOSING: { value: 2 },
    CLOSED: { value: 3 },
  });
  Object.defineProperty(globalThis, "WebSocket", { value: blocked, writable: false, configurable: false });
})();`;

/** Bound on the per-request challenge ledger; entries are never otherwise reclaimed. */
const MAX_TRACKED_CHALLENGES = 1_000;

export async function installNetworkGuard(page: Page, options: NetworkGuardOptions): Promise<PageNetworkGuard> {
  const log = options.log ?? silentLogger;
  const session = await page.context().newCDPSession(page);
  if (page.isClosed()) {
    await session.detach().catch(() => undefined);
    throw new Error("browser page closed while installing its network guard");
  }
  const stats: GuardStats = {
    requestsAllowed: 0,
    requestsBlocked: 0,
    proxyChallengesAnswered: 0,
    proxyChallengesCancelled: 0,
    serverChallengesCancelled: 0,
    credentialRejections: 0,
  };
  const challenges = new Map<string, number>();
  const media = new PageMediaProxy(page, options);

  const cancel = async (requestId: string): Promise<void> => {
    await session
      .send("Fetch.continueWithAuth", { requestId, authChallengeResponse: { response: "CancelAuth" } })
      .catch(() => undefined);
  };

  const onAuthRequired = (event: AuthRequiredEvent): void => {
    void (async () => {
      const challenge = event.authChallenge;
      if (challenge.source !== "Proxy" || !gatewayMatches(challenge.origin, options.gateway())) {
        if (challenge.source === "Proxy") stats.proxyChallengesCancelled += 1;
        else stats.serverChallengesCancelled += 1;
        await cancel(event.requestId);
        return;
      }
      const attempts = (challenges.get(event.requestId) ?? 0) + 1;
      if (challenges.size >= MAX_TRACKED_CHALLENGES) {
        const oldest = challenges.keys().next().value;
        if (oldest !== undefined) challenges.delete(oldest);
      }
      challenges.set(event.requestId, attempts);
      const credential = options.credential();
      if (attempts >= 2 || credential === null) {
        stats.proxyChallengesCancelled += 1;
        if (attempts >= 2) {
          stats.credentialRejections += 1;
          options.onCredentialRejected?.();
        }
        await cancel(event.requestId);
        return;
      }
      stats.proxyChallengesAnswered += 1;
      await session
        .send("Fetch.continueWithAuth", {
          requestId: event.requestId,
          authChallengeResponse: {
            response: "ProvideCredentials",
            username: credential.username,
            password: credential.password,
          },
        })
        .catch(() => undefined);
    })();
  };

  const onRequestPaused = (event: RequestPausedEvent): void => {
    void (async () => {
      try {
        await options.policy.assertAllowed(event.request.url);
        stats.requestsAllowed += 1;
        await session.send("Fetch.continueRequest", { requestId: event.requestId });
      } catch (error) {
        stats.requestsBlocked += 1;
        log.warn("request blocked", { reason: errorMessage(error) });
        await session
          .send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" })
          .catch(() => undefined);
      }
    })();
  };

  const onExtraInfo = (event: ExtraInfoEvent): void => {
    for (const name of Object.keys(event.headers)) {
      if (name.toLowerCase() === "set-cookie") {
        options.onSetCookie?.();
        return;
      }
    }
  };

  session.on("Fetch.authRequired", onAuthRequired);
  session.on("Fetch.requestPaused", onRequestPaused);
  session.on("Network.responseReceivedExtraInfo", onExtraInfo);

  const detach = async (): Promise<void> => {
    media.close();
    session.off("Fetch.authRequired", onAuthRequired);
    session.off("Fetch.requestPaused", onRequestPaused);
    session.off("Network.responseReceivedExtraInfo", onExtraInfo);
    await session.detach().catch(() => undefined);
  };

  try {
    await session.send("Network.enable");
    await session.send("Network.setBypassServiceWorker", { bypass: true });
    if (options.gateway() === null) {
      // No gateway vets this session's targets, so the page may not open a
      // WebSocket the request guard cannot see. `Page.enable` is what makes
      // the document script run on every later document, not just this one.
      await session.send("Page.enable");
      await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: WEBSOCKET_BLOCK_SCRIPT,
        runImmediately: true,
      });
    }
    await session.send("Fetch.enable", {
      handleAuthRequests: true,
      patterns: [
        { urlPattern: "http://*", requestStage: "Request" },
        { urlPattern: "https://*", requestStage: "Request" },
      ],
    });
  } catch (error) {
    await detach();
    throw error;
  }
  return { session, stats, media, detach };
}

/** Whether a challenge's origin names the gateway host:port (default ports resolved). */
export function gatewayMatches(origin: string, gateway: GuardGateway | null): boolean {
  if (gateway === null) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = unbracket(url.hostname).toLowerCase();
  const port = url.port === "" ? defaultPort(url.protocol) : Number.parseInt(url.port, 10);
  return host === unbracket(gateway.host).toLowerCase() && port === gateway.port;
}

function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function defaultPort(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}
