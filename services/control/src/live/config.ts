/**
 * Live share's configuration (docs/live-share.md §11): the LiveKit server the
 * rooms live on, and the lobby's one tunable bound.
 *
 *   LIVEKIT_URL         what clients dial (`wss://…`; `ws://` for a local server)
 *   LIVEKIT_API_URL     the server API; defaults to LIVEKIT_URL as http(s)
 *   LIVEKIT_API_KEY     the key and secret every token is signed with
 *   LIVEKIT_API_SECRET
 *   LIVE_MAX_GUESTS     admitted guests per share (default 8)
 *
 * All unset is "live share off" (every `/v1/live` route answers 503); a key
 * without its secret, or a URL without either, is a mistake and throws, so
 * `server.ts` can refuse to boot rather than mint tokens nobody accepts.
 */

export interface LiveKitConfig {
  /** What clients connect to, handed out with every token. */
  url: string;
  /** Where control calls the server API (Twirp over HTTP). */
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
}

export class LiveKitConfigError extends Error {}

export const DEFAULT_LIVE_MAX_GUESTS = 8;
/** A ceiling on the knob, so a typo cannot open a share to a crowd. */
const LIVE_MAX_GUESTS_CEILING = 50;

const API_SCHEMES: Readonly<Record<string, string>> = { "ws:": "http:", "wss:": "https:" };

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function parseUrl(name: string, raw: string, schemes: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new LiveKitConfigError(`${name} is not a URL`);
  }
  if (!schemes.includes(url.protocol)) {
    throw new LiveKitConfigError(`${name} must be ${schemes.map((s) => s.replace(/:$/u, "")).join(" or ")}`);
  }
  return url;
}

/** Resolve the LiveKit server; null when none is configured. */
export function livekitFromEnv(env: Record<string, string | undefined>): LiveKitConfig | null {
  const url = env["LIVEKIT_URL"];
  const apiUrl = env["LIVEKIT_API_URL"];
  const apiKey = env["LIVEKIT_API_KEY"];
  const apiSecret = env["LIVEKIT_API_SECRET"];
  if (![url, apiUrl, apiKey, apiSecret].some(present)) return null;
  if (!present(url) || !present(apiKey) || !present(apiSecret)) {
    throw new LiveKitConfigError("live share needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET together");
  }
  const client = parseUrl("LIVEKIT_URL", url, ["ws:", "wss:"]);
  let api: URL;
  if (present(apiUrl)) {
    api = parseUrl("LIVEKIT_API_URL", apiUrl, ["http:", "https:"]);
  } else {
    api = new URL(client.href);
    api.protocol = API_SCHEMES[client.protocol] ?? "https:";
  }
  return {
    url: client.href.replace(/\/$/u, ""),
    apiUrl: api.href.replace(/\/$/u, ""),
    apiKey: apiKey.trim(),
    apiSecret: apiSecret.trim(),
  };
}

/** `LIVE_MAX_GUESTS`, or the default when it is unset or not a sensible count. */
export function liveMaxGuests(env: Record<string, string | undefined>): number {
  const raw = env["LIVE_MAX_GUESTS"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_LIVE_MAX_GUESTS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= LIVE_MAX_GUESTS_CEILING ? parsed : DEFAULT_LIVE_MAX_GUESTS;
}
