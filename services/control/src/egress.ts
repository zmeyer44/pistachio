/**
 * Egress provider and credential minting (docs/cloud-sync-design.md §7.6).
 *
 * Credential v1: `username = 'pe1.<userId>.<deviceId>.<credentialId>.<exp>'`
 * (three lowercase uuids and decimal unix seconds; exactly five dot-separated
 * fields), `password = base64url(HMAC-SHA256(key, utf8(username)))` without
 * padding (43 chars) with `key = Buffer.from(secretHex, 'hex')` (32 bytes).
 * The username format itself lives in `@pistachio/egress-policy`, which both
 * control and the gateway already depend on, so the minting and parsing sides
 * cannot drift; only the HMAC (which needs `node:crypto`) is per-service.
 *
 * Gateway secret: `EGRESS_PROVIDER=static` uses control's
 * `EGRESS_TOKEN_SECRET` literally; `fly` derives a per-user secret with
 * HKDF-SHA256(ikm = bytes(EGRESS_TOKEN_SECRET), salt = '', info =
 * 'pistachio-egress/' + userId, 32) as lowercase hex.
 */

import { createHmac, hkdfSync } from "node:crypto";

import {
  CREDENTIAL_PREFIX,
  credentialUsername,
  isCredentialSecretHex,
} from "@pistachio/egress-policy";

export { CREDENTIAL_PREFIX, credentialUsername };
export const CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;

export type EgressProviderKind = "static" | "fly";

export interface ProvisionedGateway {
  host: string;
  port: number;
  egressIp: string | null;
  region: string | null;
}

export interface EgressProvider {
  readonly kind: EgressProviderKind;
  provision(userId: string, region: string | null): Promise<ProvisionedGateway>;
  destroy(userId: string): Promise<void>;
}

export class EgressProviderError extends Error {
  constructor(
    readonly reason: string,
    message = reason,
  ) {
    super(message);
  }
}

/** One shared gateway host for every user (`EGRESS_STATIC_HOST`/`PORT`). */
export class StaticEgressProvider implements EgressProvider {
  readonly kind = "static" as const;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly egressIp: string | null = null,
  ) {}

  provision(_userId: string, region: string | null): Promise<ProvisionedGateway> {
    return Promise.resolve({ host: this.host, port: this.port, egressIp: this.egressIp, region });
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

export interface FlyEgressConfig {
  apiToken: string;
  orgSlug: string;
  image: string;
  /** Master secret (hex); machine secrets get the per-user HKDF derivation. */
  tokenSecretHex: string;
  /** Control's own public origin, passed to the machine as `EGRESS_CONTROL_URL`. */
  controlUrl?: string;
  /** `EGRESS_GATEWAY_TOKEN`; without it the machine may not call control. */
  gatewayToken?: string;
  fetch?: typeof fetch;
  apiBase?: string;
  graphqlUrl?: string;
}

/**
 * The port a client dials. Fly's edge terminates TLS for `<app>.fly.dev` and
 * forwards the plaintext stream to the machine, so the gateway process itself
 * needs no certificate and every client keeps speaking `https` to it.
 */
export const FLY_GATEWAY_PORT = 443;
/** What the gateway process binds inside the machine (`DEFAULT_LISTEN`). */
export const FLY_GATEWAY_INTERNAL_PORT = 8443;

/**
 * Per-user Fly app `pa-eg-<userId>` running the egress image with app
 * secrets `EGRESS_TOKEN_SECRET` (per-user HKDF), `EGRESS_OWNER_USER_ID`, and —
 * when control knows its own public URL — `EGRESS_CONTROL_URL` plus
 * `EGRESS_GATEWAY_TOKEN`, without which the machine never polls revocations,
 * throttles, or reports usage. Nothing is shelled out: machines and app
 * lifecycle go through the Machines REST API; secrets and IPs go through
 * GraphQL, because neither secrets-with-values nor IP allocation ever made it
 * into the REST API. Throws `fly_not_configured` unless `FLY_API_TOKEN`,
 * `FLY_ORG_SLUG`, and `FLY_EGRESS_IMAGE` are all set.
 *
 * The identity IP is the app-scoped **static egress IPv4**
 * (`allocateEgressIpAddress`) — the exit address every proxied site sees, and
 * the whole point of D13. It is dedicated per app, and therefore per user.
 * The inbound anycast addresses (a free shared v4 and a dedicated v6) do a
 * different job: without them `<app>.fly.dev` does not resolve and every
 * client dies at DNS before the proxy handshake.
 *
 * Every step is an "ensure": provision is re-run from scratch when control
 * crashed between Fly and its own `egress_gateways` insert, so each call
 * tolerates the previous one's leftovers.
 */
export class FlyEgressProvider implements EgressProvider {
  readonly kind = "fly" as const;

  constructor(private readonly config: FlyEgressConfig | null) {}

  static fromEnv(
    env: Record<string, string | undefined>,
    options: { fetch?: typeof fetch } = {},
  ): FlyEgressProvider {
    const apiToken = env["FLY_API_TOKEN"];
    const orgSlug = env["FLY_ORG_SLUG"];
    const image = env["FLY_EGRESS_IMAGE"];
    const tokenSecretHex = env["EGRESS_TOKEN_SECRET"];
    if (!apiToken || !orgSlug || !image || !tokenSecretHex) return new FlyEgressProvider(null);
    // Both or neither: the gateway refuses to start with a control URL it has
    // no token for, so half a pair would break every provisioned machine.
    const controlUrl = env["CONTROL_PUBLIC_URL"];
    const gatewayToken = env["EGRESS_GATEWAY_TOKEN"];
    const control =
      controlUrl && gatewayToken ? { controlUrl, gatewayToken } : {};
    return new FlyEgressProvider({ apiToken, orgSlug, image, tokenSecretHex, ...control, ...options });
  }

  get configured(): boolean {
    return this.config !== null;
  }

  private appName(userId: string): string {
    return `pa-eg-${userId}`;
  }

  private async api(
    path: string,
    init: { method: string; body?: unknown; allowStatuses?: number[] },
  ): Promise<unknown> {
    const config = this.require();
    const doFetch = config.fetch ?? fetch;
    const base = config.apiBase ?? "https://api.machines.dev/v1";
    const res = await doFetch(`${base}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      if (init.allowStatuses?.includes(res.status)) return null;
      throw new EgressProviderError("fly_api_error", `fly ${path} → ${res.status} ${text}`);
    }
    return text.length === 0 ? null : (JSON.parse(text) as unknown);
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const config = this.require();
    const doFetch = config.fetch ?? fetch;
    const url = config.graphqlUrl ?? "https://api.fly.io/graphql";
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as {
      data?: T;
      errors?: Array<{ message: string }>;
    } | null;
    if (!res.ok || !body || body.errors?.length || body.data === undefined) {
      const detail = body?.errors?.map((e) => e.message).join("; ") ?? `status ${res.status}`;
      throw new EgressProviderError("fly_api_error", `fly graphql → ${detail}`);
    }
    return body.data;
  }

  private require(): FlyEgressConfig {
    if (this.config === null) {
      throw new EgressProviderError(
        "fly_not_configured",
        "FlyEgressProvider needs FLY_API_TOKEN, FLY_ORG_SLUG, FLY_EGRESS_IMAGE, EGRESS_TOKEN_SECRET",
      );
    }
    return this.config;
  }

  async provision(userId: string, region: string | null): Promise<ProvisionedGateway> {
    const config = this.require();
    const app = this.appName(userId);

    const existing = await this.api(`/apps/${app}`, { method: "GET", allowStatuses: [404] });
    if (existing === null) {
      await this.api("/apps", { method: "POST", body: { app_name: app, org_slug: config.orgSlug } });
    }

    // Secrets before the machine: a machine's environment is fixed at create,
    // so a gateway created first would boot without its verifier and refuse
    // to serve (services/egress startup contract).
    const secrets: Record<string, string> = {
      EGRESS_TOKEN_SECRET: gatewaySecretFor("fly", config.tokenSecretHex, userId),
      EGRESS_OWNER_USER_ID: userId,
    };
    if (config.controlUrl !== undefined && config.gatewayToken !== undefined) {
      secrets["EGRESS_CONTROL_URL"] = config.controlUrl;
      secrets["EGRESS_GATEWAY_TOKEN"] = config.gatewayToken;
    }
    await this.graphql(
      `mutation($input: SetSecretsInput!) { setSecrets(input: $input) { release { id } } }`,
      { input: { appId: app, secrets: Object.entries(secrets).map(([key, value]) => ({ key, value })) } },
    );

    const machine = await this.ensureMachine(app, region);

    // The static exit identity, allocated in the machine's region: machines
    // draw from their own region's egress pool, so a mismatch would leave the
    // IP allocated and unused. A fresh allocation takes minutes to bind to a
    // running machine; restarting makes it immediate, and a restart that
    // races the first boot is harmless (the IP binds on its own shortly).
    let egress = await this.egressV4(app);
    if (egress === null) {
      const allocated = await this.graphql<{ allocateEgressIpAddress: { v4: string } }>(
        `mutation($input: AllocateEgressIPAddressInput!) { allocateEgressIpAddress(input: $input) { v4 v6 } }`,
        { input: { appId: app, region: machine.region ?? region ?? undefined } },
      );
      egress = allocated.allocateEgressIpAddress.v4;
      if (machine.id !== undefined) {
        await this.api(`/apps/${app}/machines/${machine.id}/restart`, {
          method: "POST",
          allowStatuses: [404, 408, 412, 422],
        });
      }
    }

    await this.ensureInboundIps(app);

    return {
      host: `${app}.fly.dev`,
      port: FLY_GATEWAY_PORT,
      egressIp: egress,
      region: machine.region ?? region,
    };
  }

  private async ensureMachine(
    app: string,
    region: string | null,
  ): Promise<{ id?: string; region?: string }> {
    const machines = (await this.api(`/apps/${app}/machines`, { method: "GET" })) as
      | Array<{ id?: string; region?: string }>
      | null;
    if (machines?.[0] !== undefined) return machines[0];
    const body = {
      region: region ?? undefined,
      config: {
        image: this.require().image,
        // `handlers: ["tls"]` makes Fly's edge terminate TLS with the app's
        // automatic `<app>.fly.dev` certificate and hand the machine a
        // plaintext TCP stream, so the desktop and the cloud browser both
        // reach an `https://` proxy without control ever minting a cert.
        services: [
          {
            ports: [{ port: FLY_GATEWAY_PORT, handlers: ["tls"] }],
            protocol: "tcp",
            internal_port: FLY_GATEWAY_INTERNAL_PORT,
          },
        ],
        restart: { policy: "always" },
      },
    };
    // A freshly created app 404s machine creation for a moment while the
    // registration propagates to the machines platform — retry briefly
    // rather than failing the provision that triggered it.
    for (let attempt = 1; ; attempt++) {
      try {
        return (await this.api(`/apps/${app}/machines`, { method: "POST", body })) as {
          id?: string;
          region?: string;
        };
      } catch (err) {
        const retryable =
          err instanceof EgressProviderError && err.reason === "fly_api_error" && err.message.includes("→ 404");
        if (!retryable || attempt >= 6) throw err;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  /** The app's already-allocated static egress IPv4, if any. */
  private async egressV4(app: string): Promise<string | null> {
    const data = await this.graphql<{
      app: { egressIpAddresses: { nodes: Array<{ ip: string; version: number }> } } | null;
    }>(`query($name: String!) { app(name: $name) { egressIpAddresses { nodes { ip version } } } }`, {
      name: app,
    });
    return data.app?.egressIpAddresses.nodes.find((n) => n.version === 4)?.ip ?? null;
  }

  /** A shared inbound v4 (free) and a dedicated v6, so `<app>.fly.dev` resolves. */
  private async ensureInboundIps(app: string): Promise<void> {
    const data = await this.graphql<{
      app: { sharedIpAddress: string | null; ipAddresses: { nodes: Array<{ type: string }> } } | null;
    }>(`query($name: String!) { app(name: $name) { sharedIpAddress ipAddresses { nodes { type } } } }`, {
      name: app,
    });
    const types = new Set((data.app?.ipAddresses.nodes ?? []).map((n) => n.type.toLowerCase()));
    const wanted: string[] = [];
    if (!data.app?.sharedIpAddress && !types.has("v4") && !types.has("shared_v4")) wanted.push("shared_v4");
    if (!types.has("v6")) wanted.push("v6");
    for (const type of wanted) {
      await this.graphql(
        `mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address } } }`,
        { input: { appId: app, type } },
      );
    }
  }

  async destroy(userId: string): Promise<void> {
    this.require();
    // Deleting the app releases its machines and both IP kinds in one call —
    // the per-user blast radius the app-per-user layout buys. 404 means an
    // earlier destroy already won.
    await this.api(`/apps/${this.appName(userId)}`, { method: "DELETE", allowStatuses: [404] });
  }
}

/** The 64-hex gateway secret for a user under the configured provider. */
export function gatewaySecretFor(
  kind: EgressProviderKind,
  masterSecretHex: string,
  userId: string,
): string {
  if (kind === "static") return masterSecretHex;
  const derived = hkdfSync(
    "sha256",
    Buffer.from(masterSecretHex, "hex"),
    Buffer.alloc(0),
    `pistachio-egress/${userId}`,
    32,
  );
  return Buffer.from(derived).toString("hex");
}

export interface MintedCredential {
  username: string;
  password: string;
  /** ISO 8601. */
  expiresAt: string;
  credentialId: string;
}

/** `base64url(HMAC-SHA256(key, utf8(username)))` without padding (43 chars). */
export function credentialPassword(key: Buffer, username: string): string {
  return createHmac("sha256", key).update(username, "utf8").digest("base64url");
}

export function mintCredential(input: {
  secretHex: string;
  userId: string;
  deviceId: string;
  credentialId: string;
  expiresAtMs: number;
}): MintedCredential {
  if (!isCredentialSecretHex(input.secretHex)) throw new Error("egress secret must be 64 lowercase hex");
  const exp = Math.floor(input.expiresAtMs / 1000);
  const username = credentialUsername(input.userId, input.deviceId, input.credentialId, exp);
  return {
    username,
    password: credentialPassword(Buffer.from(input.secretHex, "hex"), username),
    expiresAt: new Date(exp * 1000).toISOString(),
    credentialId: input.credentialId,
  };
}

export interface EgressOptions {
  provider: EgressProvider | null;
  /** `EGRESS_TOKEN_SECRET` (64 hex); null disables credential minting. */
  tokenSecretHex: string | null;
}

export const EGRESS_DISABLED: EgressOptions = { provider: null, tokenSecretHex: null };

export class EgressConfigError extends Error {}

/** Resolve `EGRESS_PROVIDER`, `EGRESS_STATIC_HOST/PORT`, `EGRESS_TOKEN_SECRET`, `FLY_*`. */
export function egressFromEnv(env: Record<string, string | undefined>): EgressOptions {
  const secret = env["EGRESS_TOKEN_SECRET"];
  if (secret !== undefined && secret !== "" && !isCredentialSecretHex(secret)) {
    throw new EgressConfigError("EGRESS_TOKEN_SECRET must be 64 lowercase hex characters");
  }
  const tokenSecretHex = secret ? secret : null;
  const kind = env["EGRESS_PROVIDER"] ?? (env["EGRESS_STATIC_HOST"] ? "static" : undefined);
  if (kind === undefined) return { provider: null, tokenSecretHex };
  if (kind === "static") {
    const host = env["EGRESS_STATIC_HOST"];
    const port = Number(env["EGRESS_STATIC_PORT"] ?? "8443");
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new EgressConfigError("EGRESS_PROVIDER=static needs EGRESS_STATIC_HOST and a valid EGRESS_STATIC_PORT");
    }
    return { provider: new StaticEgressProvider(host, port), tokenSecretHex };
  }
  if (kind === "fly") return { provider: FlyEgressProvider.fromEnv(env), tokenSecretHex };
  throw new EgressConfigError(`unknown EGRESS_PROVIDER "${kind}" (expected static or fly)`);
}
