/**
 * The gateway's control-plane client (docs/cloud-sync-design.md §7.3,
 * "Service bearer (gateway)"): `POST /v1/usage/egress`,
 * `GET /v1/egress/revocations`, `GET /v1/egress/limits`, all authenticated
 * with `Authorization: Bearer <EGRESS_GATEWAY_TOKEN>`. `EGRESS_CONTROL_URL`
 * is control's origin (e.g. `http://localhost:8787`); routes are appended.
 */

import { CONTROL_REQUEST_TIMEOUT_MS } from "./config.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ControlClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export class ControlRequestError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number) {
    super(`${method} ${path} -> ${status}`);
    this.name = "ControlRequestError";
    this.status = status;
  }
}

export class ControlClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: ControlClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS;
  }

  /** GET with a query string; resolves the parsed JSON body. */
  async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const search = new URLSearchParams(query).toString();
    const url = `${this.#baseUrl}${path}${search === "" ? "" : `?${search}`}`;
    const response = await this.#fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.#token}`, accept: "application/json" },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new ControlRequestError("GET", path, response.status);
    return (await response.json()) as unknown;
  }

  /** POST a JSON body; the response body is discarded. */
  async post(path: string, body: unknown): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new ControlRequestError("POST", path, response.status);
    await response.arrayBuffer().catch(() => undefined);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
