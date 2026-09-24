/**
 * The egress credential v1 wire format (docs/cloud-sync-design.md §7.6).
 *
 * `username = 'pe1.<userId>.<deviceId>.<credentialId>.<expUnixSeconds>'` —
 * exactly five dot-separated fields, three lowercase uuids and decimal
 * seconds — and `password = base64url(HMAC-SHA256(key, utf8(username)))`
 * without padding (43 chars), keyed by the 32-byte gateway secret supplied as
 * 64 lowercase hex characters.
 *
 * Only the *format* lives here: the minting side (control) and the verifying
 * side (the gateway) must agree on every byte of the username the MAC covers,
 * and two hand-copied parsers is exactly how they drift. The HMAC itself stays
 * in each Node service — this package is browser-safe and must not reach for
 * `node:crypto`.
 */

/** Credential username prefix (§7.6); bumping it is a format break. */
export const CREDENTIAL_PREFIX = "pe1";

/** Shared-secret length: 32 bytes supplied as 64 lowercase hex characters. */
export const CREDENTIAL_SECRET_BYTES = 32;

/** The one accepted spelling of a gateway secret in configuration. */
export const SECRET_HEX_RE = new RegExp(`^[0-9a-f]{${String(CREDENTIAL_SECRET_BYTES * 2)}}$`);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL_RE = /^[0-9]{1,15}$/;

/** The five authenticated fields of a credential username. */
export interface ParsedCredential {
  readonly username: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly credentialId: string;
  /** Expiry, unix seconds. */
  readonly exp: number;
}

/** Build the username the MAC is computed over. */
export function credentialUsername(
  userId: string,
  deviceId: string,
  credentialId: string,
  expUnixSeconds: number,
): string {
  return `${CREDENTIAL_PREFIX}.${userId}.${deviceId}.${credentialId}.${String(expUnixSeconds)}`;
}

/**
 * Parse `pe1.<userId>.<deviceId>.<credentialId>.<exp>`: exactly five
 * dot-separated fields, three lowercase uuids and decimal seconds.
 */
export function parseCredentialUsername(username: string): ParsedCredential | null {
  const fields = username.split(".");
  if (fields.length !== 5) return null;
  const [prefix, userId, deviceId, credentialId, expText] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (prefix !== CREDENTIAL_PREFIX) return null;
  if (!UUID_RE.test(userId) || !UUID_RE.test(deviceId) || !UUID_RE.test(credentialId)) return null;
  if (!DECIMAL_RE.test(expText)) return null;
  const exp = Number(expText);
  if (!Number.isSafeInteger(exp)) return null;
  return { username, userId, deviceId, credentialId, exp };
}

/** True for the 64-lowercase-hex form used in configuration. */
export function isCredentialSecretHex(secretHex: string): boolean {
  return SECRET_HEX_RE.test(secretHex);
}
