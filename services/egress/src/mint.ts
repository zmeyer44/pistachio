/**
 * Credential minting (docs/cloud-sync-design.md §7.6) — the issuing half of
 * `auth.ts`, for tests and operators. Control mints the same shape from its
 * own copy of the secret; keeping the two halves next to each other is what
 * stops them drifting apart.
 *
 *     EGRESS_TOKEN_SECRET=<64 hex> tsx src/mint.ts <userId> <deviceId> [ttlSeconds]
 */

import { randomUUID } from "node:crypto";

import { credentialUsername } from "@pistachio/egress-policy";

import { SharedSecretVerifier, parseCredentialUsername } from "./auth.js";
import { ENV, isEntrypoint } from "./config.js";

/** Default credential lifetime: 24 h (§7.6). */
export const CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;

export interface MintOptions {
  /** 64 lowercase hex characters — the gateway's `EGRESS_TOKEN_SECRET`. */
  readonly secretHex: string;
  readonly userId: string;
  readonly deviceId: string;
  /** Defaults to a fresh uuid v4 (control uses the `egress_credentials.id`). */
  readonly credentialId?: string;
  /** Absolute expiry in unix seconds; wins over `ttlSeconds`. */
  readonly expiresAtSeconds?: number;
  /** Lifetime from now; default 24 h. */
  readonly ttlSeconds?: number;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
}

export interface MintedCredential {
  readonly username: string;
  readonly password: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly credentialId: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/** Build and sign a credential; throws when the ids would not survive parsing. */
export function mintCredential(options: MintOptions): MintedCredential {
  const verifier = SharedSecretVerifier.fromHex(options.secretHex);
  const now = options.now ?? Date.now;
  const credentialId = options.credentialId ?? randomUUID();
  const expiresAt =
    options.expiresAtSeconds ??
    Math.floor(now() / 1000) + (options.ttlSeconds ?? CREDENTIAL_TTL_SECONDS);
  const username = credentialUsername(options.userId, options.deviceId, credentialId, expiresAt);
  const parsed = parseCredentialUsername(username);
  if (parsed === null) {
    throw new Error(
      "credential fields do not survive the round-trip: userId, deviceId, and credentialId must be lowercase uuids and the expiry a non-negative integer",
    );
  }
  return {
    username,
    password: verifier.sign(username),
    userId: options.userId,
    deviceId: options.deviceId,
    credentialId,
    expiresAt,
  };
}

/** `Proxy-Authorization: Basic base64(username:password)`. */
export function basicProxyAuthorization(credential: {
  readonly username: string;
  readonly password: string;
}): string {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`;
}

/** `Proxy-Authorization: Bearer <username>.<password>`. */
export function bearerProxyAuthorization(credential: {
  readonly username: string;
  readonly password: string;
}): string {
  return `Bearer ${credential.username}.${credential.password}`;
}

function mainFromArgv(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv): number {
  const [userId, deviceId, ttlText] = argv;
  const secretHex = env[ENV.tokenSecret];
  if (userId === undefined || deviceId === undefined) {
    console.error(`usage: mint.ts <userId> <deviceId> [ttlSeconds]   (reads ${ENV.tokenSecret})`);
    return 2;
  }
  if (secretHex === undefined || secretHex.trim() === "") {
    console.error(`${ENV.tokenSecret} must be set (64 lowercase hex characters)`);
    return 2;
  }
  const ttlSeconds = ttlText === undefined ? undefined : Number(ttlText);
  if (ttlSeconds !== undefined && !(Number.isInteger(ttlSeconds) && ttlSeconds > 0)) {
    console.error("ttlSeconds must be a positive integer");
    return 2;
  }
  try {
    const credential = mintCredential({ secretHex, userId, deviceId, ttlSeconds });
    console.log(JSON.stringify(credential, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (isEntrypoint(import.meta.url)) {
  process.exitCode = mainFromArgv(process.argv.slice(2), process.env);
}
