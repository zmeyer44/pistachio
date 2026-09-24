/**
 * Dedicated integrations from the Mac's side (D29): the consent flow over
 * the loopback listener with PKCE, the grant sealed under the Space key and
 * filed as ciphertext, tokens minted for a run, a dead grant flagged, and
 * a disconnect that revokes first. Control and the provider are fakes; the
 * consent page is "opened" by a stand-in that follows the redirect itself.
 */

import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection, IntegrationProvider, IntegrationProviderConfig } from "@pistachio/protocol";
import { deriveSpaceKeys, fromBase64, fromUtf8, integrationConnectionSealAad, open } from "@pistachio/sync-protocol";
import type { ControlClient } from "../src/main/account/control-client";
import { IntegrationService } from "../src/main/account/integration-service";

const SECRET = new Uint8Array(32).fill(7);
const CLIENT: IntegrationProviderConfig = { id: "gmail", clientId: "client-1.apps.googleusercontent.com", clientSecret: "installed" };
// An operator may register one Google client and list it for both providers.
const CALENDAR_CLIENT: IntegrationProviderConfig = { ...CLIENT, id: "google_calendar" };

/** Control as the service sees it: one Space's connections in memory, every call recorded. */
function fakeControl(initial: IntegrationConnection[] = [], clients: IntegrationProviderConfig[] = [CLIENT]) {
  const rows = new Map(initial.map((row) => [row.id, row]));
  const calls: string[] = [];
  const control = {
    listIntegrationProviders: vi.fn(async () => {
      calls.push("providers");
      return clients;
    }),
    listIntegrations: vi.fn(async (spaceId: string) => {
      calls.push(`list ${spaceId}`);
      return [...rows.values()].filter((row) => row.spaceId === spaceId);
    }),
    putIntegration: vi.fn(async (spaceId: string, id: string, input: { provider: IntegrationProvider; accountLabel: string; access: IntegrationConnection["access"]; scopes: string[]; sealedPayload: string }) => {
      calls.push(`put ${id} ${input.access}`);
      // Control's rules: a tombstone is never overwritten or swept aside.
      for (const [key, row] of rows) {
        if (row.spaceId !== spaceId || row.provider !== input.provider) continue;
        if (row.status === "revoke_pending") throw new Error("control: 409 revoke_pending");
        if (key !== id) rows.delete(key);
      }
      const existing = rows.get(id);
      const row: IntegrationConnection = {
        id,
        spaceId,
        provider: input.provider,
        accountLabel: input.accountLabel,
        access: input.access,
        scopes: input.scopes,
        status: "connected",
        sealedPayload: input.sealedPayload,
        createdAt: existing?.createdAt ?? "2026-09-06T12:00:00.000Z",
        updatedAt: `2026-09-06T12:00:0${String(calls.length % 10)}.000Z`,
        lastUsedAt: existing?.lastUsedAt ?? null,
      };
      rows.set(id, row);
      return row;
    }),
    setIntegrationStatus: vi.fn(async (_spaceId: string, id: string, status: "reconnect_required") => {
      calls.push(`status ${id} ${status}`);
      const row = rows.get(id);
      if (row === undefined || row.status !== "connected") throw new Error("control: 404 not_found");
      rows.set(id, { ...row, status });
    }),
    markIntegrationUsed: vi.fn(async (_spaceId: string, id: string) => {
      calls.push(`used ${id}`);
    }),
    deleteIntegration: vi.fn(async (_spaceId: string, id: string) => {
      calls.push(`delete ${id}`);
      rows.delete(id);
    }),
  };
  return { control: control as unknown as ControlClient, rows, calls };
}

interface FakeProviderOptions {
  /** What the token endpoint answers a refresh with. */
  refresh?: () => Response;
  /** Whether the code exchange returns a refresh token. */
  refreshToken?: string | null;
  scope?: string;
}

/** Google, as far as the service can tell: the token endpoint, the revoke endpoint, the Gmail profile, and the primary calendar. */
function fakeProvider(options: FakeProviderOptions = {}) {
  const seen: Array<{ url: string; params: URLSearchParams | null; token: string | null }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const params = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
    seen.push({ url, params, token: headers.get("authorization")?.replace(/^Bearer /u, "") ?? null });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url === "https://oauth2.googleapis.com/token") {
      if (params?.get("grant_type") === "refresh_token") return options.refresh?.() ?? json({ access_token: "at-refreshed", expires_in: 3600 });
      return json({
        access_token: "at-first",
        expires_in: 3599,
        scope: options.scope ?? "https://www.googleapis.com/auth/gmail.modify",
        ...(options.refreshToken === null ? {} : { refresh_token: options.refreshToken ?? "rt-1" }),
      });
    }
    if (url === "https://oauth2.googleapis.com/revoke") return new Response("", { status: 200 });
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") return json({ emailAddress: "alex@example.com", messagesTotal: 1, threadsTotal: 1 });
    if (url === "https://www.googleapis.com/calendar/v3/calendars/primary") return json({ id: "alex@example.com", summary: "alex@example.com", timeZone: "America/Los_Angeles" });
    return json({ error: { message: `no route ${url}` } }, 404);
  });
  return { fetchImpl, seen };
}

/**
 * The consent page, played by a function: it reads the redirect URI and
 * state off the URL Google would have shown and follows the redirect back
 * to the loopback the way the person's click would.
 */
function consentOpener(outcome: "approve" | "deny" | "wrong-state" | "never" = "approve") {
  const opened: string[] = [];
  const closed = vi.fn();
  const spaces: string[] = [];
  const openConsent = vi.fn(async (url: string, spaceId: string) => {
    opened.push(url);
    spaces.push(spaceId);
    const consent = new URL(url);
    const redirect = new URL(consent.searchParams.get("redirect_uri") ?? "");
    const state = consent.searchParams.get("state") ?? "";
    if (outcome === "approve") {
      redirect.searchParams.set("code", "code-1");
      redirect.searchParams.set("state", state);
    } else if (outcome === "deny") {
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("state", state);
    } else if (outcome === "wrong-state") {
      redirect.searchParams.set("code", "code-1");
      redirect.searchParams.set("state", "someone-else");
    }
    if (outcome !== "never") void fetch(redirect).then((response) => response.text());
    return closed;
  });
  return { openConsent, opened, spaces, closed };
}

function service(options: { control: ControlClient; fetchImpl: ReturnType<typeof fakeProvider>["fetchImpl"]; openConsent: ReturnType<typeof consentOpener>["openConsent"]; enrolled?: boolean; consentTimeoutMs?: number }) {
  return new IntegrationService({
    control: () => options.control,
    enrolled: () => options.enrolled ?? true,
    spaceSecret: (spaceId) => (spaceId === "work" ? SECRET : null),
    openConsent: options.openConsent,
    fetch: options.fetchImpl,
    now: () => new Date("2026-09-06T12:00:00Z"),
    ...(options.consentTimeoutMs === undefined ? {} : { consentTimeoutMs: options.consentTimeoutMs }),
  });
}

describe("connecting", () => {
  it("runs the consent page over the loopback with PKCE, seals the grant under the Space key, and files it", async () => {
    const control = fakeControl();
    const provider = fakeProvider();
    const consent = consentOpener();
    const integrations = service({ control: control.control, fetchImpl: provider.fetchImpl, openConsent: consent.openConsent });

    const info = await integrations.connect("work", "gmail", "write");
    expect(info).toMatchObject({ spaceId: "work", provider: "gmail", accountLabel: "alex@example.com", access: "write", status: "connected", scopes: ["https://www.googleapis.com/auth/gmail.modify"] });
    expect(info).not.toHaveProperty("sealedPayload");

    // The consent page asked for the level's scopes, PKCE, and a loopback redirect.
    const opened = new URL(consent.opened[0]!);
    expect(opened.origin + opened.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(opened.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");
    expect(opened.searchParams.get("code_challenge_method")).toBe("S256");
    expect(opened.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/u);
    expect(opened.searchParams.get("access_type")).toBe("offline");
    // In the Space being connected — its cookies are the account meant.
    expect(consent.spaces).toEqual(["work"]);
    expect(consent.closed).toHaveBeenCalledTimes(1);

    // The exchange carried the code and the verifier; the profile call used the fresh access token.
    const exchange = provider.seen.find((entry) => entry.params?.get("grant_type") === "authorization_code");
    expect(exchange?.params?.get("code")).toBe("code-1");
    expect(exchange?.params?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/u);
    expect(exchange?.params?.get("redirect_uri")).toBe(opened.searchParams.get("redirect_uri"));
    expect(provider.seen.find((entry) => entry.url.endsWith("/profile"))?.token).toBe("at-first");

    // What control holds opens only with the Space key, under the connection's own AAD.
    const row = [...control.rows.values()][0]!;
    const keys = await deriveSpaceKeys("work", SECRET);
    const plaintext = JSON.parse(fromUtf8(await open(keys.sealKey, fromBase64(row.sealedPayload), integrationConnectionSealAad("work", row.id))));
    expect(plaintext).toEqual({ version: 1, refreshToken: "rt-1" });
    await expect(open(keys.sealKey, fromBase64(row.sealedPayload), integrationConnectionSealAad("work", "other-id"))).rejects.toBeDefined();
  });

  it("hands the person back to Settings only once the connection is filed, so the list it opens on has it", async () => {
    const control = fakeControl();
    const consent = consentOpener();
    // What Settings does the moment the closer brings it back: list the Space's connections.
    let listedOnReturn: Promise<IntegrationConnection[]> | null = null;
    consent.closed.mockImplementation(() => {
      listedOnReturn = control.control.listIntegrations("work");
    });
    const integrations = service({ control: control.control, fetchImpl: fakeProvider().fetchImpl, openConsent: consent.openConsent });

    const info = await integrations.connect("work", "gmail", "write");
    expect(consent.closed).toHaveBeenCalledTimes(1);
    expect((await listedOnReturn!).map((row) => row.id)).toEqual([info.id]);
  });

  it("tells the person when the page was cancelled, came back wrong, or granted too little", async () => {
    const control = fakeControl();
    const provider = fakeProvider();
    const cancelled = consentOpener("deny");
    const denied = service({ control: control.control, fetchImpl: provider.fetchImpl, openConsent: cancelled.openConsent });
    await expect(denied.connect("work", "gmail", "read")).rejects.toThrow("The sign-in was cancelled.");
    expect(cancelled.closed).toHaveBeenCalledTimes(1);

    const forged = service({ control: control.control, fetchImpl: provider.fetchImpl, openConsent: consentOpener("wrong-state").openConsent });
    await expect(forged.connect("work", "gmail", "read")).rejects.toThrow("did not come back from the page Pistachio opened");

    const narrow = fakeProvider({ scope: "https://www.googleapis.com/auth/gmail.readonly" });
    const underGranted = consentOpener();
    const short = service({ control: control.control, fetchImpl: narrow.fetchImpl, openConsent: underGranted.openConsent });
    await expect(short.connect("work", "gmail", "send")).rejects.toThrow("granted less than “Read, draft, and send” needs");
    expect(underGranted.closed).toHaveBeenCalledTimes(1);
    // The half-grant was revoked rather than left dangling at Google.
    expect(narrow.seen.some((entry) => entry.url === "https://oauth2.googleapis.com/revoke" && entry.params?.get("token") === "rt-1")).toBe(true);

    const noRefresh = fakeProvider({ refreshToken: null });
    const fleeting = service({ control: control.control, fetchImpl: noRefresh.fetchImpl, openConsent: consentOpener().openConsent });
    await expect(fleeting.connect("work", "gmail", "read")).rejects.toThrow("did not issue a lasting grant");

    expect(control.rows.size).toBe(0);
  });

  it("abandons a consent page nobody finishes, and refuses a Space this Mac has no key for", async () => {
    const control = fakeControl();
    const provider = fakeProvider();
    const stalled = service({ control: control.control, fetchImpl: provider.fetchImpl, openConsent: consentOpener("never").openConsent, consentTimeoutMs: 20 });
    await expect(stalled.connect("work", "gmail", "read")).rejects.toThrow("took too long");
    const keyless = service({ control: control.control, fetchImpl: provider.fetchImpl, openConsent: consentOpener().openConsent });
    await expect(keyless.connect("personal", "gmail", "read")).rejects.toThrow("holds no key for that Space");
  });

  it("connects Google Calendar beside Gmail in one Space: its own scopes, its own row, the account read off the primary calendar", async () => {
    const control = fakeControl([], [CLIENT, CALENDAR_CLIENT]);
    const mail = service({ control: control.control, fetchImpl: fakeProvider().fetchImpl, openConsent: consentOpener().openConsent });
    const gmail = await mail.connect("work", "gmail", "write");

    const provider = fakeProvider({ scope: "https://www.googleapis.com/auth/calendar", refreshToken: "rt-calendar" });
    const consent = consentOpener();
    const integrations = service({ control: control.control, fetchImpl: provider.fetchImpl, openConsent: consent.openConsent });
    const info = await integrations.connect("work", "google_calendar", "send");
    expect(info).toMatchObject({ provider: "google_calendar", accountLabel: "alex@example.com", access: "send", status: "connected", scopes: ["https://www.googleapis.com/auth/calendar"] });

    // The consent page asked for the calendar and nothing else — no mail
    // scope, and no `include_granted_scopes` to fold the earlier mail grant in.
    const asked = new URL(consent.opened[0]!);
    expect(asked.searchParams.get("scope")?.split(" ")).toEqual([
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.calendars.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events",
    ]);
    expect(asked.searchParams.get("access_type")).toBe("offline");
    expect(asked.searchParams.has("include_granted_scopes")).toBe(false);
    expect(provider.seen.find((entry) => entry.url.includes("/calendars/primary"))?.token).toBe("at-first");
    expect(provider.seen.some((entry) => entry.url.includes("gmail.googleapis.com"))).toBe(false);

    // Two rows, one per provider, each sealed under its own id.
    expect([...control.rows.values()].map((row) => row.provider).sort()).toEqual(["gmail", "google_calendar"]);
    expect(info.id).not.toBe(gmail.id);
    const row = control.rows.get(info.id)!;
    const keys = await deriveSpaceKeys("work", SECRET);
    const opened = JSON.parse(fromUtf8(await open(keys.sealKey, fromBase64(row.sealedPayload), integrationConnectionSealAad("work", info.id)))) as { refreshToken: string };
    expect(opened.refreshToken).toBe("rt-calendar");

    // A run binds both, each naming its own provider and level.
    const hosts = await integrations.hostsFor("work");
    expect(hosts.map((host) => `${host.provider}:${host.access}`).sort()).toEqual(["gmail:write", "google_calendar:send"]);
  });

  it("refuses a calendar grant that came back narrower than the level asked for", async () => {
    const control = fakeControl([], [CALENDAR_CLIENT]);
    // The person unticked a box on Google's page: read-only came back for a level that edits.
    const provider = fakeProvider({ scope: "https://www.googleapis.com/auth/calendar.readonly" });
    const integrations = service({ control: control.control, fetchImpl: provider.fetchImpl, openConsent: consentOpener().openConsent });
    await expect(integrations.connect("work", "google_calendar", "write")).rejects.toThrow();
    expect(control.rows.size).toBe(0);
    expect(provider.seen.some((entry) => entry.url === "https://oauth2.googleapis.com/revoke")).toBe(true);
  });
});

describe("a connected account", () => {
  async function connected(options: FakeProviderOptions = {}) {
    const control = fakeControl();
    const provider = fakeProvider(options);
    const consent = consentOpener();
    const integrations = service({ control: control.control, fetchImpl: provider.fetchImpl, openConsent: consent.openConsent });
    const info = await integrations.connect("work", "gmail", "write");
    return { control, provider, consent, integrations, info };
  }

  it("binds a tool host that mints tokens from the sealed grant and stamps use", async () => {
    const { control, provider, integrations, info } = await connected();
    const hosts = await integrations.hostsFor("work");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ provider: "gmail", accountLabel: "alex@example.com", access: "write" });
    expect(await hosts[0]!.accessToken()).toBe("at-refreshed");
    const refresh = provider.seen.find((entry) => entry.params?.get("grant_type") === "refresh_token");
    expect(refresh?.params?.get("refresh_token")).toBe("rt-1");
    hosts[0]!.used?.();
    await vi.waitFor(() => expect(control.calls).toContain(`used ${info.id}`));
    // A second run reuses the bound host — and its minted token — rather than opening the grant again.
    const again = await integrations.hostsFor("work");
    expect(again[0]).toBe(hosts[0]);
    expect(await again[0]!.accessToken()).toBe("at-refreshed");
    expect(provider.seen.filter((entry) => entry.params?.get("grant_type") === "refresh_token")).toHaveLength(1);
    // Nothing for a Space with no key, and nothing when this Mac has no account.
    expect(await integrations.hostsFor("personal")).toEqual([]);
    const signedOut = service({ control: control.control, fetchImpl: provider.fetchImpl, openConsent: consentOpener().openConsent, enrolled: false });
    expect(await signedOut.hostsFor("work")).toEqual([]);
    expect(await signedOut.list("work")).toEqual([]);
  });

  it("flags a grant the provider revoked by exact id, so Settings can ask for a reconnect", async () => {
    const { control, integrations, info } = await connected({
      refresh: () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    });
    const [host] = await integrations.hostsFor("work");
    await expect(host!.accessToken()).rejects.toThrow("needs to be connected again in Settings → Integrations");
    await vi.waitFor(() => expect(control.calls).toContain(`status ${info.id} reconnect_required`));
    expect(control.calls.filter((call) => call.startsWith("put "))).toHaveLength(1);
    expect((await integrations.list("work"))[0]?.status).toBe("reconnect_required");
    expect(await integrations.hostsFor("work")).toEqual([]);
  });

  it("does not flag a connection when the operator's client, not the grant, is what the provider refused", async () => {
    const { control, integrations } = await connected({
      refresh: () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
    });
    const [host] = await integrations.hostsFor("work");
    await expect(host!.accessToken()).rejects.toThrow("invalid_client");
    expect(control.calls.some((call) => call.startsWith("status "))).toBe(false);
    expect((await integrations.list("work"))[0]?.status).toBe("connected");
  });

  it("finishes a disconnect the web app asked for: revokes the tombstone it can open and drops the row", async () => {
    const { control, provider, integrations, info } = await connected();
    // The web app tombstoned it while this Mac was away.
    control.rows.set(info.id, { ...control.rows.get(info.id)!, status: "revoke_pending" });
    expect(await integrations.list("work")).toEqual([]);
    const revoke = provider.seen.find((entry) => entry.url === "https://oauth2.googleapis.com/revoke");
    expect(revoke?.params?.get("token")).toBe("rt-1");
    expect(control.calls.at(-1)).toBe(`delete ${info.id}`);
    // And a connect while a tombstone stands revokes it first, so control lets the new grant in.
    const again = await integrations.connect("work", "gmail", "read");
    control.rows.set(again.id, { ...control.rows.get(again.id)!, status: "revoke_pending" });
    const third = await integrations.connect("work", "gmail", "read");
    expect(third.id).not.toBe(again.id);
    expect([...control.rows.keys()]).toEqual([third.id]);
    expect(provider.seen.filter((entry) => entry.url === "https://oauth2.googleapis.com/revoke")).toHaveLength(2);
  });

  it("stops a run in progress when the account is disconnected elsewhere", async () => {
    let clock = Date.parse("2026-09-06T12:00:00Z");
    const control = fakeControl();
    const provider = fakeProvider();
    const consent = consentOpener();
    const integrations = new IntegrationService({
      control: () => control.control,
      enrolled: () => true,
      spaceSecret: (spaceId) => (spaceId === "work" ? SECRET : null),
      openConsent: consent.openConsent,
      fetch: provider.fetchImpl,
      now: () => new Date(clock),
    });
    const info = await integrations.connect("work", "gmail", "write");
    const [host] = await integrations.hostsFor("work");
    expect(await host!.accessToken()).toBe("at-refreshed");
    control.rows.set(info.id, { ...control.rows.get(info.id)!, status: "revoke_pending" });
    clock += 31_000;
    await expect(host!.accessToken()).rejects.toThrow("was disconnected in Settings → Integrations");
    await vi.waitFor(() => expect(control.calls).toContain(`delete ${info.id}`));
    expect(provider.seen.some((entry) => entry.url === "https://oauth2.googleapis.com/revoke" && entry.params?.get("token") === "rt-1")).toBe(true);
    expect(await integrations.hostsFor("work")).toEqual([]);
  });

  it("changes the level in place when the grant covers it, and re-consents when it does not", async () => {
    const { control, consent, integrations, info } = await connected();
    const raised = await integrations.setAccess("work", info.id, "send");
    expect(raised).toMatchObject({ id: info.id, access: "send" });
    expect(consent.openConsent).toHaveBeenCalledTimes(1);
    const lowered = await integrations.setAccess("work", info.id, "read");
    expect(lowered).toMatchObject({ id: info.id, access: "read" });

    // A read-only grant asked to send needs Google's consent page again; the new grant replaces the row.
    const narrow = fakeProvider({ scope: "https://www.googleapis.com/auth/gmail.readonly" });
    const readOnly = service({ control: control.control, fetchImpl: narrow.fetchImpl, openConsent: consentOpener().openConsent });
    const reconnected = await readOnly.connect("work", "gmail", "read");
    expect(reconnected.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    const wide = fakeProvider();
    const opener = consentOpener();
    const upgrading = service({ control: control.control, fetchImpl: wide.fetchImpl, openConsent: opener.openConsent });
    const upgraded = await upgrading.setAccess("work", reconnected.id, "send");
    expect(opener.openConsent).toHaveBeenCalledTimes(1);
    expect(new URL(opener.opened[0]!).searchParams.get("login_hint")).toBe("alex@example.com");
    expect(upgraded.id).not.toBe(reconnected.id);
    expect(upgraded.access).toBe("send");
    expect([...control.rows.keys()]).toEqual([upgraded.id]);
  });

  it("revokes the grant at the provider before forgetting it", async () => {
    const { control, provider, integrations, info } = await connected();
    await integrations.disconnect("work", info.id);
    const revoke = provider.seen.find((entry) => entry.url === "https://oauth2.googleapis.com/revoke");
    expect(revoke?.params?.get("token")).toBe("rt-1");
    expect(control.calls.at(-1)).toBe(`delete ${info.id}`);
    expect(await integrations.list("work")).toEqual([]);
    await expect(integrations.disconnect("work", info.id)).rejects.toThrow("no longer there");
  });

  it("lists the catalog with availability, and connections without their ciphertext", async () => {
    const { integrations } = await connected();
    const providers = await integrations.providers();
    expect(providers).toEqual([
      expect.objectContaining({ id: "gmail", name: "Gmail", available: true, accessLevels: [expect.objectContaining({ id: "read" }), expect.objectContaining({ id: "write" }), expect.objectContaining({ id: "send" })] }),
      // The operator registered a client for Gmail only: the calendar is in
      // the catalog, and the page says this server cannot connect it.
      expect.objectContaining({ id: "google_calendar", name: "Google Calendar", available: false, accessLevels: [expect.objectContaining({ id: "read" }), expect.objectContaining({ id: "write" }), expect.objectContaining({ id: "send" })] }),
    ]);
    const listed = await integrations.list("work");
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("sealedPayload");
  });
});

describe("the home page's schedule", () => {
  const FROM = "2026-09-21T07:00:00.000Z";
  const TO = "2026-09-22T07:00:00.000Z";
  const timed = (id: string, hour: string, extra: Record<string, unknown> = {}) => ({
    id,
    iCalUID: `${id}@google.com`,
    status: "confirmed",
    summary: id,
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
    start: { dateTime: `2026-09-21T${hour}:00:00-07:00` },
    end: { dateTime: `2026-09-21T${hour}:30:00-07:00` },
    ...extra,
  });

  /** Google with a calendar list and events behind the token endpoint the other tests use. */
  function calendarProvider(options: { listFails?: boolean; eventsFail?: boolean } = {}) {
    const base = fakeProvider({ scope: "https://www.googleapis.com/auth/calendar" });
    const reads: Array<{ path: string; query: URLSearchParams; token: string | null }> = [];
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/calendar/v3/calendars/primary" || !parsed.pathname.startsWith("/calendar/v3/")) return base.fetchImpl(url, init);
      const path = decodeURIComponent(parsed.pathname.replace("/calendar/v3", ""));
      reads.push({ path, query: parsed.searchParams, token: new Headers(init?.headers).get("authorization")?.replace(/^Bearer /u, "") ?? null });
      if (path === "/users/me/calendarList") {
        if (options.listFails === true) return json({ error: { message: "backend error" } }, 500);
        return json({
          items: [
            { id: "team@group.calendar.google.com", summary: "Team", selected: true },
            { id: "alex@example.com", summary: "alex@example.com", primary: true, selected: true },
            { id: "holidays@group.v.calendar.google.com", summary: "Holidays" },
            { id: "old@group.calendar.google.com", summary: "Old", selected: true, hidden: true },
          ],
        });
      }
      if (options.eventsFail === true) return json({ error: { message: "backend error" } }, 500);
      if (path === "/calendars/alex@example.com/events" || path === "/calendars/primary/events") {
        return json({
          items: [
            timed("standup", "09", { hangoutLink: "https://meet.google.com/abc-defg-hij", attendees: [{ email: "alex@example.com", self: true, responseStatus: "accepted" }, { email: "kim@example.com" }], description: "secret agenda" }),
            timed("skipped", "11", { attendees: [{ email: "alex@example.com", self: true, responseStatus: "declined" }] }),
            timed("called-off", "13", { status: "cancelled" }),
            { id: "offsite", iCalUID: "offsite@google.com", status: "confirmed", summary: "Offsite", htmlLink: "https://www.google.com/calendar/event?eid=offsite", start: { date: "2026-09-21" }, end: { date: "2026-09-22" } },
          ],
        });
      }
      if (path === "/calendars/team@group.calendar.google.com/events") {
        // The standup again, as the team calendar's copy, and one of the team's own.
        return json({
          items: [
            timed("standup-team-copy", "09", { iCalUID: "standup@google.com" }),
            timed("demo", "15", { location: "Room 4" }),
            // On this copy Google's `self` is the team calendar. It declined; alex did not — still alex's day.
            timed("planning", "16", { attendees: [{ email: "team@group.calendar.google.com", self: true, responseStatus: "declined" }, { email: "alex@example.com", responseStatus: "accepted" }] }),
            // And the other way round: alex declined, whatever the calendar's own entry says.
            timed("social", "17", { attendees: [{ email: "team@group.calendar.google.com", self: true, responseStatus: "accepted" }, { email: "ALEX@example.com", responseStatus: "declined" }] }),
          ],
        });
      }
      return json({ error: { message: `no route ${path}` } }, 404);
    });
    return { fetchImpl: fetchImpl as unknown as ReturnType<typeof fakeProvider>["fetchImpl"], reads, seen: base.seen };
  }

  async function withCalendar(options: Parameters<typeof calendarProvider>[0] = {}) {
    const control = fakeControl([], [CALENDAR_CLIENT]);
    const provider = calendarProvider(options);
    const integrations = service({ control: control.control, fetchImpl: provider.fetchImpl, openConsent: consentOpener().openConsent });
    const info = await integrations.connect("work", "google_calendar", "read");
    return { control, provider, integrations, info };
  }

  it("reads the calendars the person keeps ticked, once each, and hands back titles, times, and links — nothing else", async () => {
    const { control, provider, integrations } = await withCalendar();
    const agenda = await integrations.calendarAgenda("work", FROM, TO);
    expect(agenda.status).toBe("ok");
    expect(agenda.accountLabel).toBe("alex@example.com");
    // Declined and cancelled are not the person's day; the standup on two calendars is one line, from their own.
    // “Declined” means the account declined — not the owner of a shared calendar the event was read from.
    expect(agenda.events.map((event) => event.id)).toEqual([
      "alex@example.com:standup",
      "alex@example.com:offsite",
      "team@group.calendar.google.com:demo",
      "team@group.calendar.google.com:planning",
    ]);
    expect(agenda.events[0]).toEqual({
      id: "alex@example.com:standup",
      title: "standup",
      start: "2026-09-21T09:00:00-07:00",
      end: "2026-09-21T09:30:00-07:00",
      allDay: false,
      location: "",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      webUrl: "https://www.google.com/calendar/event?eid=standup",
    });
    expect(agenda.events[1]).toMatchObject({ allDay: true, start: "2026-09-21", end: "2026-09-22" });
    expect(JSON.stringify(agenda)).not.toMatch(/secret agenda|kim@example\.com|at-first|at-refreshed|rt-1/u);

    // The person's own calendar first, the unticked and the hidden not at all, each over exactly the window asked for.
    expect(provider.reads.map((read) => read.path)).toEqual(["/users/me/calendarList", "/calendars/alex@example.com/events", "/calendars/team@group.calendar.google.com/events"]);
    expect(Object.fromEntries(provider.reads[1]!.query)).toEqual({ timeMin: FROM, timeMax: TO, singleEvents: "true", orderBy: "startTime", maxResults: "50" });
    expect(provider.reads.every((read) => read.token !== null)).toBe(true);
    // Looking at the day is not the agent working: the connection's last use is untouched.
    expect(control.calls.filter((call) => call.startsWith("used"))).toEqual([]);
  });

  it("falls back to the person's own calendar when the list cannot be read, and says unreachable when nothing can", async () => {
    const partial = await withCalendar({ listFails: true });
    const agenda = await partial.integrations.calendarAgenda("work", FROM, TO);
    expect(agenda.status).toBe("ok");
    expect(partial.provider.reads.map((read) => read.path)).toEqual(["/users/me/calendarList", "/calendars/primary/events"]);
    expect(agenda.events.map((event) => event.id)).toEqual(["primary:standup", "primary:offsite"]);

    const down = await withCalendar({ eventsFail: true });
    await expect(down.integrations.calendarAgenda("work", FROM, TO)).resolves.toEqual({ status: "unreachable", connectable: false, accountLabel: "alex@example.com", events: [] });
  });

  it("says why there is nothing to show without touching Google: no calendar, a disconnect under way, a dead grant, no account", async () => {
    const mailOnly = fakeControl();
    const mail = service({ control: mailOnly.control, fetchImpl: fakeProvider().fetchImpl, openConsent: consentOpener().openConsent });
    await mail.connect("work", "gmail", "read");
    // This server registered a client for Gmail only: there is no calendar, and no way to connect one.
    await expect(mail.calendarAgenda("work", FROM, TO)).resolves.toEqual({ status: "not_connected", connectable: false, accountLabel: null, events: [] });
    // One that offers Google Calendar: the home page may invite the person to connect.
    const offered = service({ control: fakeControl([], [CLIENT, CALENDAR_CLIENT]).control, fetchImpl: fakeProvider().fetchImpl, openConsent: consentOpener().openConsent });
    await expect(offered.calendarAgenda("work", FROM, TO)).resolves.toEqual({ status: "not_connected", connectable: true, accountLabel: null, events: [] });

    const { control, integrations, info, provider: google } = await withCalendar();
    control.rows.set(info.id, { ...control.rows.get(info.id)!, status: "reconnect_required" });
    await expect(integrations.calendarAgenda("work", FROM, TO)).resolves.toEqual({ status: "reconnect_required", connectable: false, accountLabel: "alex@example.com", events: [] });
    // While a disconnect is under way control refuses a new grant, so there is nothing to invite the person to.
    control.rows.set(info.id, { ...control.rows.get(info.id)!, status: "revoke_pending" });
    await expect(integrations.calendarAgenda("work", FROM, TO)).resolves.toMatchObject({ status: "not_connected", connectable: false });
    expect(google.reads).toEqual([]);

    const signedOut = service({ control: control.control, fetchImpl: google.fetchImpl, openConsent: consentOpener().openConsent, enrolled: false });
    await expect(signedOut.calendarAgenda("work", FROM, TO)).resolves.toMatchObject({ status: "not_connected", connectable: false });
  });

  it("refuses a window that is not one: unparseable, backwards, or longer than a week", async () => {
    const { integrations, provider } = await withCalendar();
    await expect(integrations.calendarAgenda("work", "today", TO)).rejects.toThrow(/needs a window/u);
    await expect(integrations.calendarAgenda("work", TO, FROM)).rejects.toThrow(/needs a window/u);
    await expect(integrations.calendarAgenda("work", FROM, "2026-10-21T07:00:00.000Z")).rejects.toThrow(/at most a week/u);
    expect(provider.reads).toEqual([]);
  });
});

describe("the daily brief's look at the inbox", () => {
  const header = (name: string, value: string) => ({ name, value });
  const message = (id: string, threadId: string, from: string, subject: string, labelIds: string[]) => ({
    id,
    threadId,
    labelIds,
    snippet: `${subject} — opening words`,
    internalDate: "1790000000000",
    payload: { headers: [header("From", from), header("Subject", subject), header("Date", "Mon, 21 Sep 2026 08:12:00 -0400")], body: { data: "c2VjcmV0IGJvZHk" } },
  });

  function mailProvider(options: { listFails?: boolean } = {}) {
    const base = fakeProvider();
    const reads: Array<{ path: string; query: URLSearchParams }> = [];
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      if (!parsed.pathname.startsWith("/gmail/v1/users/me/messages")) return base.fetchImpl(url, init);
      reads.push({ path: parsed.pathname.replace("/gmail/v1/users/me", ""), query: parsed.searchParams });
      if (parsed.pathname.endsWith("/messages")) {
        if (options.listFails === true) return json({ error: { message: "backend error" } }, 500);
        return json({ messages: [{ id: "m2", threadId: "t1" }, { id: "m1", threadId: "t1" }, { id: "m3", threadId: "t3" }], resultSizeEstimate: 3 });
      }
      const id = parsed.pathname.split("/").at(-1);
      if (id === "m2") return json(message("m2", "t1", "Dana Whitfield <dana@example.com>", "Re: Q4 budget", ["INBOX", "UNREAD", "IMPORTANT"]));
      if (id === "m1") return json(message("m1", "t1", "Dana Whitfield <dana@example.com>", "Q4 budget", ["INBOX"]));
      return json(message("m3", "t3", "Shoes Weekly <news@shoes.example>", "40% off", ["INBOX", "CATEGORY_PROMOTIONS"]));
    });
    return { fetchImpl: fetchImpl as unknown as ReturnType<typeof fakeProvider>["fetchImpl"], reads };
  }

  it("reads the newest inbox conversations as headers and snippets — one row a thread, never a body — without stamping use", async () => {
    const control = fakeControl();
    const provider = mailProvider();
    const integrations = service({ control: control.control, fetchImpl: provider.fetchImpl, openConsent: consentOpener().openConsent });
    await integrations.connect("work", "gmail", "read");
    const digest = await integrations.mailDigest("work");
    expect(digest).toMatchObject({ status: "ok", accountLabel: "alex@example.com" });
    expect(digest.messages.map((entry) => entry.id)).toEqual(["m2", "m3"]);
    expect(digest.messages[0]).toMatchObject({ threadId: "t1", from: "Dana Whitfield <dana@example.com>", subject: "Re: Q4 budget", unread: true });
    expect(digest.messages[0]?.labels).toContain("IMPORTANT");
    expect(JSON.stringify(digest)).not.toContain("secret body");
    expect(Object.keys(digest.messages[0] ?? {}).sort()).toEqual(["date", "from", "id", "labels", "snippet", "subject", "threadId", "unread", "webUrl"]);
    // The inbox of the last two days, metadata only.
    expect(provider.reads[0]?.query.get("q")).toBe("in:inbox newer_than:2d -in:chats");
    expect(provider.reads.slice(1).every((read) => read.query.get("format") === "metadata")).toBe(true);
    expect(control.calls.some((call) => call.startsWith("used "))).toBe(false);
  });

  it("says why there is no mail without touching Google, and unreachable when Gmail is", async () => {
    const control = fakeControl();
    const none = service({ control: control.control, fetchImpl: mailProvider().fetchImpl, openConsent: consentOpener().openConsent });
    await expect(none.mailDigest("work")).resolves.toEqual({ status: "not_connected", connectable: true, accountLabel: null, messages: [] });
    const signedOut = service({ control: control.control, fetchImpl: mailProvider().fetchImpl, openConsent: consentOpener().openConsent, enrolled: false });
    await expect(signedOut.mailDigest("work")).resolves.toEqual({ status: "not_connected", connectable: false, accountLabel: null, messages: [] });

    const down = mailProvider({ listFails: true });
    const integrations = service({ control: fakeControl().control, fetchImpl: down.fetchImpl, openConsent: consentOpener().openConsent });
    await integrations.connect("work", "gmail", "read");
    await expect(integrations.mailDigest("work")).resolves.toEqual({ status: "unreachable", connectable: false, accountLabel: "alex@example.com", messages: [] });
  });
});
