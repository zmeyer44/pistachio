/**
 * Dedicated integrations from this Mac's side (docs/cloud-sync-design.md
 * D29): connect an account through the provider's consent page, keep the
 * grant sealed under the Space key on control, and bind it as the tool
 * hosts a local run takes.
 *
 * The consent flow is the installed-app shape: a loopback listener on
 * 127.0.0.1 takes the provider's redirect, the consent page opens as a tab
 * of this browser, and the code is exchanged here with PKCE. The refresh
 * token is sealed before it leaves the machine; control files ciphertext.
 * Access tokens are minted on demand for a run and never stored.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  INTEGRATION_CATALOG,
  integrationAccessLevel,
  integrationScopesCover,
  type IntegrationAccess,
  type IntegrationConnection,
  type IntegrationConnectionPayload,
  type IntegrationProvider,
  type IntegrationProviderConfig,
} from "@pistachio/protocol";
import {
  GmailClient,
  GoogleCalendarClient,
  INTEGRATIONS,
  OAuthError,
  authorizationUrl,
  createPkce,
  createState,
  eventView,
  exchangeAuthorizationCode,
  integrationHostsFor,
  messageView,
  readAuthorizationCallback,
  revokeToken,
  sweepPendingRevocations,
  type CalendarEventResource,
  type FetchLike,
  type IntegrationToolHost,
} from "@pistachio/agent-runtime/integrations";
import {
  deriveSpaceKeys,
  fromBase64,
  fromUtf8,
  integrationConnectionSealAad,
  open,
  seal,
  toBase64,
  utf8,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import type { CalendarAgenda, CalendarAgendaEvent, IntegrationConnectionInfo, IntegrationProviderInfo } from "@pistachio/shell-contracts/ipc";
import type { ControlClient } from "./control-client";

export interface IntegrationServiceDeps {
  control: () => ControlClient;
  /** Whether this Mac is enrolled: without an account there is nothing to connect to. */
  enrolled: () => boolean;
  /** The Space root secret this Mac holds, or null when it has none for the Space. */
  spaceSecret: (spaceId: string) => Uint8Array | null;
  /** Show the consent page in the Space's own session; answers a closer, called once the connection is filed or the flow has failed. */
  openConsent: (url: string, spaceId: string) => Promise<() => void>;
  fetch?: FetchLike;
  now?: () => Date;
  /** How long the person has to finish the consent page. */
  consentTimeoutMs?: number;
  /** The loopback port; 0 (the default) takes any free one. */
  loopbackPort?: number;
}

export const DEFAULT_CONSENT_TIMEOUT_MS = 5 * 60_000;
const PROVIDER_CACHE_MS = 60_000;
const CALLBACK_PATH = "/oauth/callback";
/** The longest window the schedule may ask for: it draws a day, and a week leaves room to grow. */
export const MAX_AGENDA_WINDOW_MS = 7 * 86_400_000;
/** How many of the person's calendars one schedule reads. */
export const MAX_AGENDA_CALENDARS = 8;
const MAX_AGENDA_EVENTS_PER_CALENDAR = 50;
/** How many inbox conversations the daily brief looks at. */
export const MAX_DIGEST_MESSAGES = 20;

/** One inbox message as the daily brief sees it: headers and Gmail's snippet, never the body. */
export interface MailDigestMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  date: string | null;
  unread: boolean;
  labels: string[];
  webUrl: string;
}

export interface MailDigest {
  status: CalendarAgenda["status"];
  connectable: boolean;
  accountLabel: string | null;
  messages: MailDigestMessage[];
}

/** One meeting is one line, on however many calendars it sits; an occurrence of a series is its own. */
function agendaKey(resource: CalendarEventResource): string {
  return `${resource.iCalUID ?? resource.id}@${resource.start?.dateTime ?? resource.start?.date ?? ""}`;
}

export function integrationConnectionInfo(connection: IntegrationConnection): IntegrationConnectionInfo {
  return {
    id: connection.id,
    spaceId: connection.spaceId,
    provider: connection.provider,
    accountLabel: connection.accountLabel,
    access: connection.access,
    scopes: connection.scopes,
    status: connection.status,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    lastUsedAt: connection.lastUsedAt,
  };
}

/** The page the loopback answers with, so the tab says what happened before it closes. */
function callbackPage(title: string, body: string): string {
  const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:15px -apple-system,system-ui,sans-serif;color:#1f1f1c;background:#f8f8f3;display:grid;place-items:center;height:100vh;margin:0}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#6c6c67}</style></head><body><main><h1>${escape(title)}</h1><p>${escape(body)}</p></main></body></html>`;
}

class ConsentCancelled extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ConsentCancelled";
  }
}

export class IntegrationService {
  readonly #deps: IntegrationServiceDeps;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  #providers: { at: number; list: IntegrationProviderConfig[] } | null = null;
  /** The consent flow in progress, if any: a new one cancels it. */
  #flow: { cancel: (reason: string) => void } | null = null;
  /** Hosts already bound for a Space, keyed by connection id and version, so a second run reuses the minted token. */
  readonly #hosts = new Map<string, { key: string; host: IntegrationToolHost }>();

  constructor(deps: IntegrationServiceDeps) {
    this.#deps = deps;
    this.#fetch = deps.fetch ?? fetch;
    this.#now = deps.now ?? ((): Date => new Date());
  }

  /** Every provider in the catalog, marked with whether this server offers it. */
  async providers(): Promise<IntegrationProviderInfo[]> {
    const configured = this.#deps.enrolled() ? await this.#providerConfigs().catch(() => []) : [];
    return Object.values(INTEGRATION_CATALOG).map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      available: configured.some((provider) => provider.id === entry.id),
      accessLevels: entry.accessLevels.map((level) => ({ id: level.id, label: level.label, note: level.note })),
    }));
  }

  /**
   * The Space's connections. Opening Settings is also when this Mac finishes
   * any disconnect the web app asked for: a tombstone it can open is revoked
   * at the provider and dropped before the list is shown.
   */
  async list(spaceId: string): Promise<IntegrationConnectionInfo[]> {
    if (!this.#deps.enrolled()) return [];
    const connections = await this.#sweep(spaceId, await this.#deps.control().listIntegrations(spaceId));
    return connections.map(integrationConnectionInfo);
  }

  /**
   * Connect an account at an access level: the consent page, the code
   * exchange, the account's name from the provider, the grant sealed and
   * filed. A connection already there for the provider is replaced.
   */
  async connect(spaceId: string, provider: IntegrationProvider, access: IntegrationAccess): Promise<IntegrationConnectionInfo> {
    const entry = INTEGRATION_CATALOG[provider];
    const level = integrationAccessLevel(provider, access);
    if (level === null) throw new Error(`${entry.name} does not offer that access level`);
    const client = (await this.#providerConfigs()).find((candidate) => candidate.id === provider);
    if (client === undefined) throw new Error(`${entry.name} is not available on this server`);
    const keys = await this.#spaceKeys(spaceId);
    // A tombstone for this provider is revoked first: control will not let
    // a new grant take the slot while an old one is still to be revoked.
    const current = await this.#sweep(spaceId, await this.#deps.control().listIntegrations(spaceId));
    const existing = current.find((connection) => connection.provider === provider);
    const { grant, close } = await this.#consent(entry, client, level.scopes, spaceId, existing?.accountLabel);
    // The closer brings Settings back, and Settings lists what control holds
    // the moment it opens: it runs once the grant is filed (or refused), not
    // when the redirect arrives, or the page comes back to "not connected".
    try {
      if (grant.refreshToken === null) {
        throw new Error(`${entry.name} did not issue a lasting grant. Remove Pistachio's access in your ${entry.name} account settings and connect again.`);
      }
      if (!integrationScopesCover(provider, grant.scopes, access)) {
        await revokeToken(entry, grant.refreshToken, this.#fetch);
        throw new Error(`${entry.name} granted less than “${level.label}” needs. Approve every permission on the consent page and try again.`);
      }
      const accountLabel = await INTEGRATIONS[provider].accountLabel(grant.accessToken, this.#fetch);
      const id = randomUUID();
      const payload: IntegrationConnectionPayload = { version: 1, refreshToken: grant.refreshToken };
      const sealedPayload = toBase64(await seal(keys.sealKey, utf8(JSON.stringify(payload)), integrationConnectionSealAad(spaceId, id)));
      const saved = await this.#deps.control().putIntegration(spaceId, id, {
        provider,
        accountLabel,
        access,
        scopes: grant.scopes,
        sealedPayload,
      });
      if (existing !== undefined) this.#hosts.delete(existing.id);
      return integrationConnectionInfo(saved);
    } finally {
      close();
    }
  }

  /**
   * Change how much a connection may do. Within what the grant already
   * covers it is a metadata change; beyond it, the consent page again.
   */
  async setAccess(spaceId: string, connectionId: string, access: IntegrationAccess): Promise<IntegrationConnectionInfo> {
    const connection = await this.#find(spaceId, connectionId);
    if (connection.status !== "connected" || !integrationScopesCover(connection.provider, connection.scopes, access)) {
      return this.connect(spaceId, connection.provider, access);
    }
    const saved = await this.#deps.control().putIntegration(spaceId, connectionId, {
      provider: connection.provider,
      accountLabel: connection.accountLabel,
      access,
      scopes: connection.scopes,
      sealedPayload: connection.sealedPayload,
    });
    this.#hosts.delete(connectionId);
    return integrationConnectionInfo(saved);
  }

  /** Tell the provider the grant is over (best effort), then forget it. */
  async disconnect(spaceId: string, connectionId: string): Promise<void> {
    const connection = await this.#find(spaceId, connectionId);
    const entry = INTEGRATION_CATALOG[connection.provider];
    try {
      const payload = await this.#openPayload(spaceId, connection);
      await revokeToken(entry, payload.refreshToken, this.#fetch);
    } catch {
      // A grant this Mac cannot open is still one the person can drop; the
      // provider's own settings page is where a lingering grant is revoked.
    }
    await this.#deps.control().deleteIntegration(spaceId, connectionId);
    this.#hosts.delete(connectionId);
  }

  /** Finish disconnects asked for elsewhere (the web app): revoke what this Mac can open, drop the rows. */
  async #sweep(spaceId: string, connections: IntegrationConnection[]): Promise<IntegrationConnection[]> {
    if (!connections.some((connection) => connection.status === "revoke_pending")) return connections;
    return sweepPendingRevocations({
      connections,
      openPayload: (connection) => this.#openPayload(spaceId, connection),
      fetch: this.#fetch,
      onRevoked: async (connection) => {
        this.#hosts.delete(connection.id);
        await this.#deps.control().deleteIntegration(spaceId, connection.id).catch(() => undefined);
      },
    });
  }

  /**
   * The tool hosts for a run in a Space: every usable connection, opened
   * with this Mac's Space key. Nothing when this Mac has no account, no key
   * for the Space, or control cannot be reached — the run then has no
   * integrations rather than no run.
   */
  async hostsFor(spaceId: string): Promise<IntegrationToolHost[]> {
    if (!this.#deps.enrolled()) return [];
    let connections: IntegrationConnection[];
    let providers: IntegrationProviderConfig[];
    try {
      [connections, providers] = await Promise.all([this.#deps.control().listIntegrations(spaceId), this.#providerConfigs()]);
    } catch {
      return [];
    }
    const fresh = connections.filter((connection) => {
      const cached = this.#hosts.get(connection.id);
      return cached === undefined || cached.key !== `${connection.updatedAt}:${connection.status}`;
    });
    const opened = await integrationHostsFor({
      connections: fresh,
      providers,
      openPayload: (connection) => this.#openPayload(spaceId, connection),
      fetch: this.#fetch,
      now: this.#now,
      // A disconnect made on the web reaches a run in progress here.
      refetch: async (connection) => {
        if (!this.#deps.enrolled()) return null;
        return (await this.#deps.control().listIntegrations(spaceId)).find((candidate) => candidate.id === connection.id) ?? null;
      },
      onRevoked: async (connection) => {
        this.#hosts.delete(connection.id);
        await this.#deps.control().deleteIntegration(spaceId, connection.id).catch(() => undefined);
      },
      onReconnectRequired: (connection) => {
        this.#hosts.delete(connection.id);
        // Exact id: a connection replaced while the refresh was in flight
        // answers 404 here, instead of coming back as a resurrected dead
        // grant the way an upsert would bring it.
        this.#deps.control().setIntegrationStatus(spaceId, connection.id, "reconnect_required").catch(() => undefined);
      },
      onUsed: (connection) => {
        this.#deps.control().markIntegrationUsed(spaceId, connection.id).catch(() => undefined);
      },
    });
    for (const host of opened) {
      const connection = fresh.find((candidate) => candidate.provider === host.provider);
      if (connection !== undefined) this.#hosts.set(connection.id, { key: `${connection.updatedAt}:${connection.status}`, host });
    }
    // Keep the listing's order, and only connections still usable now.
    const hosts: IntegrationToolHost[] = [];
    for (const connection of connections) {
      if (connection.status !== "connected") continue;
      const cached = this.#hosts.get(connection.id);
      if (cached !== undefined) hosts.push(cached.host);
    }
    return hosts;
  }

  /**
   * The Space's connected Google Calendar between two instants, for the
   * home page's schedule: the calendars the person keeps ticked in Google
   * Calendar, cancelled and declined events left out, a meeting that sits
   * on two of them listed once. The token stays here; what goes back is
   * titles, times, and links. This is the person looking at their own day,
   * not the agent working, so the connection's last use is not stamped.
   */
  async calendarAgenda(spaceId: string, from: string, to: string): Promise<CalendarAgenda> {
    const min = Date.parse(from);
    const max = Date.parse(to);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) throw new Error("the schedule needs a window: from before to, as ISO instants");
    if (max - min > MAX_AGENDA_WINDOW_MS) throw new Error("the schedule's window is at most a week");
    const readable = await this.#readable(spaceId, "google_calendar");
    if (!("host" in readable)) return { ...readable, events: [] };
    const { host, accountLabel } = readable;

    const client = new GoogleCalendarClient({ accessToken: (options) => host.accessToken(options), fetch: this.#fetch });
    const window = { timeMin: new Date(min).toISOString(), timeMax: new Date(max).toISOString(), query: "", maxResults: MAX_AGENDA_EVENTS_PER_CALENDAR };
    // The calendars shown in Google Calendar, the person's own first; if the
    // list cannot be read, their own calendar alone is still their day.
    const calendars = await client
      .listCalendars()
      .then((entries) =>
        entries
          .filter((entry) => entry.selected === true && entry.hidden !== true)
          .sort((a, b) => Number(b.primary === true) - Number(a.primary === true))
          .slice(0, MAX_AGENDA_CALENDARS)
          .map((entry) => entry.id),
      )
      .catch(() => [] as string[]);
    const pages = await Promise.allSettled((calendars.length === 0 ? ["primary"] : calendars).map(async (id) => ({ id, page: await client.listEvents(id, window) })));
    // A grant that died mid-read is flagged by the host itself; the next read says so.
    if (pages.every((page) => page.status === "rejected")) return { status: "unreachable", connectable: false, accountLabel, events: [] };

    const seen = new Set<string>();
    const events: CalendarAgendaEvent[] = [];
    for (const settled of pages) {
      if (settled.status === "rejected") continue;
      for (const resource of settled.value.page.events) {
        const key = agendaKey(resource);
        if (seen.has(key)) continue;
        seen.add(key);
        // The account, not the calendar's owner, is who may have declined: on a shared calendar Google's `self` is the owner.
        const view = eventView(resource, { account: accountLabel, calendarId: settled.value.id }, { maxDescriptionChars: 0 });
        if (view.status === "cancelled" || view.myResponse === "declined" || view.start === "") continue;
        events.push({ id: `${settled.value.id}:${view.id}`, title: view.title, start: view.start, end: view.end, allDay: view.allDay, location: view.location, meetingUrl: view.meetingUrl, webUrl: view.webUrl });
      }
    }
    return { status: "ok", connectable: false, accountLabel, events };
  }

  /**
   * A short look at the Space's Gmail inbox for the daily brief: the newest
   * inbox messages of the last day and a half, as sender, subject and
   * Gmail's own snippet. Never a body, never an attachment. Like the agenda
   * it is the person reading their own mail, so last use is not stamped.
   */
  async mailDigest(spaceId: string, limit = MAX_DIGEST_MESSAGES): Promise<MailDigest> {
    const readable = await this.#readable(spaceId, "gmail");
    if (!("host" in readable)) return { ...readable, messages: [] };
    const { host, accountLabel } = readable;
    const client = new GmailClient({ accessToken: (options) => host.accessToken(options), fetch: this.#fetch });
    try {
      const page = await client.listMessages({ query: "in:inbox newer_than:2d -in:chats", maxResults: Math.min(Math.max(1, limit), MAX_DIGEST_MESSAGES) });
      const settled = await Promise.allSettled(page.messages.map((entry) => client.getMessage(entry.id, "metadata")));
      const seen = new Set<string>();
      const messages: MailDigestMessage[] = [];
      for (const result of settled) {
        if (result.status === "rejected") continue;
        const view = messageView(result.value, { maxBodyChars: 0 });
        // One row per conversation: the list is newest first, so the first message seen is the latest word.
        if (seen.has(view.threadId)) continue;
        seen.add(view.threadId);
        messages.push({ id: view.id, threadId: view.threadId, from: view.from, subject: view.subject, snippet: view.snippet, date: view.date, unread: view.unread, labels: view.labels, webUrl: view.webUrl });
      }
      if (messages.length === 0 && page.messages.length > 0) return { status: "unreachable", connectable: false, accountLabel, messages: [] };
      return { status: "ok", connectable: false, accountLabel, messages };
    } catch {
      return { status: "unreachable", connectable: false, accountLabel, messages: [] };
    }
  }

  /**
   * The shared opening of every person-facing read: is there a connection
   * for this provider in this Space, and can it be used right now? Either
   * the state to report, or the bound host to read through.
   */
  async #readable(
    spaceId: string,
    provider: IntegrationProvider,
  ): Promise<{ status: CalendarAgenda["status"]; connectable: boolean; accountLabel: string | null } | { host: IntegrationToolHost; accountLabel: string }> {
    if (!this.#deps.enrolled()) return { status: "not_connected", connectable: false, accountLabel: null };
    let connection: IntegrationConnection | undefined;
    try {
      connection = (await this.#deps.control().listIntegrations(spaceId)).find((candidate) => candidate.provider === provider);
    } catch {
      return { status: "unreachable", connectable: false, accountLabel: null };
    }
    // A tombstone is a connection the person already asked to disconnect; control refuses a new grant until it is gone.
    if (connection?.status === "revoke_pending") return { status: "not_connected", connectable: false, accountLabel: null };
    if (connection === undefined) {
      const offered = (await this.#providerConfigs().catch(() => [])).some((config) => config.id === provider);
      return { status: "not_connected", connectable: offered, accountLabel: null };
    }
    const accountLabel = connection.accountLabel;
    if (connection.status === "reconnect_required") return { status: "reconnect_required", connectable: false, accountLabel };
    const host = (await this.hostsFor(spaceId)).find((candidate) => candidate.provider === provider);
    if (host === undefined) return { status: "unreachable", connectable: false, accountLabel };
    return { host, accountLabel };
  }

  /** Abandon a consent flow in progress — the window closed, the app is quitting. */
  cancel(reason = "The sign-in was cancelled."): void {
    this.#flow?.cancel(reason);
  }

  async #find(spaceId: string, connectionId: string): Promise<IntegrationConnection> {
    const connection = (await this.#deps.control().listIntegrations(spaceId)).find((candidate) => candidate.id === connectionId);
    if (connection === undefined) throw new Error("that connection is no longer there");
    return connection;
  }

  async #providerConfigs(): Promise<IntegrationProviderConfig[]> {
    const cached = this.#providers;
    if (cached !== null && this.#now().getTime() - cached.at < PROVIDER_CACHE_MS) return cached.list;
    const list = await this.#deps.control().listIntegrationProviders();
    this.#providers = { at: this.#now().getTime(), list };
    return list;
  }

  async #spaceKeys(spaceId: string): Promise<SpaceKeys> {
    const secret = this.#deps.spaceSecret(spaceId);
    if (secret === null) throw new Error("this Mac holds no key for that Space");
    return deriveSpaceKeys(spaceId, secret);
  }

  async #openPayload(spaceId: string, connection: IntegrationConnection): Promise<IntegrationConnectionPayload> {
    const keys = await this.#spaceKeys(spaceId);
    const plaintext = await open(keys.sealKey, fromBase64(connection.sealedPayload), integrationConnectionSealAad(spaceId, connection.id));
    return JSON.parse(fromUtf8(plaintext)) as IntegrationConnectionPayload;
  }

  /**
   * The consent page, start to finish: listen on the loopback, open the
   * page, wait for the redirect, exchange the code. One flow at a time —
   * starting another cancels the first — and the listener is closed on
   * every exit.
   */
  async #consent(
    entry: (typeof INTEGRATION_CATALOG)[IntegrationProvider],
    client: IntegrationProviderConfig,
    scopes: readonly string[],
    spaceId: string,
    loginHint: string | undefined,
  ) {
    this.#flow?.cancel("A newer sign-in replaced this one.");
    const pkce = createPkce();
    const state = createState();
    let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | null = null;
    const arrived = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }
      const callback = readAuthorizationCallback(url);
      const ok = callback.error === null && callback.code !== null && callback.state === state;
      response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(
        ok
          ? callbackPage(`${entry.name} is connecting`, "You can close this tab. Pistachio finishes in Settings → Integrations.")
          : callbackPage(`${entry.name} was not connected`, callback.error === "access_denied" ? "The sign-in was cancelled." : "The sign-in did not complete. Try again from Settings → Integrations."),
      );
      if (!ok) {
        settle?.reject(new ConsentCancelled(callback.error === "access_denied" ? "The sign-in was cancelled." : callback.state !== state ? "The sign-in did not come back from the page Pistachio opened." : `${entry.name} answered with an error (${callback.error ?? "no code"}).`));
        return;
      }
      settle?.resolve(callback.code as string);
    });
    server.unref();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#deps.loopbackPort ?? 0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${String(port)}${CALLBACK_PATH}`;
    const timer = setTimeout(() => settle?.reject(new ConsentCancelled("The sign-in took too long and was abandoned.")), this.#deps.consentTimeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS);
    timer.unref();
    this.#flow = { cancel: (reason) => settle?.reject(new ConsentCancelled(reason)) };
    let close: (() => void) | null = null;
    try {
      close = await this.#deps.openConsent(
        authorizationUrl(entry, {
          client,
          redirectUri,
          scopes,
          state,
          codeChallenge: pkce.challenge,
          ...(loginHint === undefined ? {} : { loginHint }),
        }),
        spaceId,
      );
      const code = await arrived;
      const grant = await exchangeAuthorizationCode(entry, { client, code, codeVerifier: pkce.verifier, redirectUri, requestedScopes: scopes }, this.#fetch, this.#now);
      // With a grant in hand the closer is the caller's: there is still the filing to do.
      return { grant, close };
    } catch (error: unknown) {
      close?.();
      if (error instanceof OAuthError) throw new Error(`${entry.name} refused the sign-in: ${error.message}`);
      throw error;
    } finally {
      clearTimeout(timer);
      this.#flow = null;
      server.close();
    }
  }
}
