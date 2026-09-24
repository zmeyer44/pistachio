/**
 * Runner configuration from the environment (docs/cloud-sync-design.md §8.6).
 * Read from an explicit `env` object so the same reader serves `server.ts`,
 * `dev-server.ts` (which fills in defaults first), and tests.
 */

import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

export const DEFAULT_PORT = 8791;
/**
 * How long a browser session stays claimed after its last viewer detaches
 * with no run acting in it (docs/web-browser-design.md §6.4, §12). Half an
 * hour: long enough that closing a laptop lid and coming back finds the same
 * pages live, short enough that a fleet is not holding Chromium contexts for
 * everyone who ever opened one.
 */
export const DEFAULT_BROWSER_SESSION_IDLE_MS = 1_800_000;

/**
 * The two web apps (docs/web-browser-design.md §15). `www` is the site and
 * the account dashboard; the browser app is the shell on a stream surface,
 * and it is a separate origin so that a page on one cannot act as the other.
 * These are the production defaults; a deployment that hosts them elsewhere
 * sets `PISTACHIO_WEB_URL` and `PISTACHIO_BROWSER_URL`.
 */
export const DEFAULT_WEB_URL = "https://pistachio.run";
export const DEFAULT_BROWSER_URL = "https://app.pistachio.run";

/** The address bar's intent model when `PISTACHIO_INTENT_MODEL` names none. */
export const DEFAULT_INTENT_MODEL = "typesafe-ai/jev";

export interface CloudBrowserConfig {
  port: number;
  controlUrl: string;
  serviceToken: string;
  stateDir: string;
  /** 32-byte AES-256-GCM key protecting `device.json` files. */
  stateKey: Uint8Array;
  publicUrl: string | null;
  /**
   * This worker's address on the private network (§8.5). A live view may land
   * on any worker behind the fleet's one public address; the one that gets it
   * relays to the one holding the run, at this address.
   */
  internalUrl: string | null;
  /**
   * `PISTACHIO_WEB_URL`: `www` — the marketing-and-account site. Artifact
   * tool views and credential-capture links point here, and it is one of the
   * two origins a live view may be opened from (docs/web-browser-design.md
   * §15).
   */
  webUrl: string;
  /**
   * `PISTACHIO_BROWSER_URL`: the browser app, which is a different site from
   * `www` and therefore a different origin (§15). It is the ONLY origin the
   * shell socket and the download route accept, and the second origin the
   * live view accepts.
   */
  browserUrl: string;
  chromiumExecutablePath: string;
  aiGatewayApiKey: string | null;
  agentModel: string;
  /**
   * `PISTACHIO_INTENT_MODEL`: the evaluation model the address bar asks what
   * typed prose means (docs/smart-suggestions.md). `off` (or `0`/`false`)
   * turns smart suggestions off for every session on this worker, whatever
   * each person's setting says.
   */
  intentModel: string | null;
  /** `CLOUD_BROWSER_SESSION_IDLE_MS`; see `DEFAULT_BROWSER_SESSION_IDLE_MS`. */
  sessionIdleMs: number;
}

export interface ReadConfigOptions {
  /** When true, `AI_GATEWAY_API_KEY` may be absent (a programmatic model factory is supplied). */
  modelFactorySupplied?: boolean;
}

export function readCloudBrowserConfig(
  env: NodeJS.ProcessEnv,
  options: ReadConfigOptions = {},
): CloudBrowserConfig {
  const required = [
    "PISTACHIO_CONTROL_URL",
    "CLOUD_BROWSER_SERVICE_TOKEN",
    "CLOUD_BROWSER_STATE_DIR",
    "CLOUD_BROWSER_STATE_KEY",
    "PISTACHIO_AGENT_MODEL",
    ...(options.modelFactorySupplied === true ? [] : ["AI_GATEWAY_API_KEY"]),
  ];
  const missing = required.filter((name) => !nonempty(env[name]));
  if (missing.length > 0) {
    throw new Error(`cloud browser is not configured; missing ${missing.join(", ")}`);
  }
  const rawPort = env["PORT"] ?? String(DEFAULT_PORT);
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer from 0 to 65535");
  }
  const publicUrl = env["CLOUD_BROWSER_PUBLIC_URL"]?.trim();
  const internalUrl = env["CLOUD_BROWSER_INTERNAL_URL"]?.trim();
  const apiKey = env["AI_GATEWAY_API_KEY"]?.trim();
  return {
    port,
    controlUrl: validHttpUrl(env["PISTACHIO_CONTROL_URL"] as string),
    serviceToken: (env["CLOUD_BROWSER_SERVICE_TOKEN"] as string).trim(),
    stateDir: (env["CLOUD_BROWSER_STATE_DIR"] as string).trim(),
    stateKey: parseStateKey(env["CLOUD_BROWSER_STATE_KEY"] as string),
    publicUrl: publicUrl === undefined || publicUrl === "" ? null : validHttpUrl(publicUrl),
    internalUrl: internalUrl === undefined || internalUrl === "" ? null : validHttpUrl(internalUrl),
    webUrl: validHttpUrl(env["PISTACHIO_WEB_URL"]?.trim() || DEFAULT_WEB_URL),
    browserUrl: validHttpUrl(env["PISTACHIO_BROWSER_URL"]?.trim() || DEFAULT_BROWSER_URL),
    chromiumExecutablePath: resolveChromiumExecutable(env),
    aiGatewayApiKey: apiKey === undefined || apiKey === "" ? null : apiKey,
    agentModel: (env["PISTACHIO_AGENT_MODEL"] as string).trim(),
    intentModel: intentModelName(env["PISTACHIO_INTENT_MODEL"]),
    sessionIdleMs: parseSessionIdleMs(env["CLOUD_BROWSER_SESSION_IDLE_MS"]),
  };
}

/** The intent model to use, Jev unless named otherwise, or nothing when off. */
function intentModelName(configured: string | undefined): string | null {
  const value = configured?.trim();
  if (value === "off" || value === "0" || value === "false") return null;
  return value === undefined || value === "" ? DEFAULT_INTENT_MODEL : value;
}

/**
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when set, else the Chromium build
 * Playwright's registry knows about. Throws when neither exists on disk.
 */
export function resolveChromiumExecutable(env: NodeJS.ProcessEnv): string {
  const fromEnv = env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!existsSync(fromEnv)) {
      throw new Error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH does not exist: ${fromEnv}`);
    }
    return fromEnv;
  }
  const registry = registryChromiumPath();
  if (registry === null) {
    throw new Error(
      "no Chromium found: set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or install Playwright's Chromium",
    );
  }
  return registry;
}

/** The registry Chromium if it is installed, else null (never throws). */
export function registryChromiumPath(): string | null {
  try {
    const candidate = chromium.executablePath();
    return candidate !== "" && existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** `CLOUD_BROWSER_STATE_KEY`: base64 (or hex) of exactly 32 bytes. */
export function parseStateKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/u.test(trimmed)) return new Uint8Array(Buffer.from(trimmed, "hex"));
  const key = Buffer.from(trimmed, "base64");
  if (key.byteLength !== 32) {
    throw new Error("CLOUD_BROWSER_STATE_KEY must be a base64- or hex-encoded 32-byte key");
  }
  return new Uint8Array(key);
}

/** Minutes to hours, in milliseconds; anything else is a configuration error. */
export function parseSessionIdleMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return DEFAULT_BROWSER_SESSION_IDLE_MS;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value < 1_000 || value > 86_400_000) {
    throw new Error("CLOUD_BROWSER_SESSION_IDLE_MS must be an integer from 1000 to 86400000");
  }
  return value;
}

function nonempty(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function validHttpUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`expected an HTTP(S) URL, got ${url.protocol}`);
  }
  return url.href.replace(/\/$/u, "");
}
