import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_SESSION_IDLE_MS,
  DEFAULT_BROWSER_URL,
  DEFAULT_INTENT_MODEL,
  DEFAULT_WEB_URL,
  parseStateKey,
  readCloudBrowserConfig,
} from "../src/config.js";
import { CHROMIUM } from "./helpers/chromium.js";

const key = randomBytes(32);

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PISTACHIO_CONTROL_URL: "http://localhost:8787/",
    CLOUD_BROWSER_SERVICE_TOKEN: "svc",
    CLOUD_BROWSER_STATE_DIR: "/tmp/state",
    CLOUD_BROWSER_STATE_KEY: key.toString("base64"),
    PISTACHIO_AGENT_MODEL: "test/model",
    AI_GATEWAY_API_KEY: "gw",
    ...(CHROMIUM === null ? {} : { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: CHROMIUM }),
    ...overrides,
  };
}

describe("cloud browser config", () => {
  it("parses the state key from base64 or hex", () => {
    expect(Buffer.from(parseStateKey(key.toString("base64")))).toEqual(key);
    expect(Buffer.from(parseStateKey(key.toString("hex")))).toEqual(key);
    expect(() => parseStateKey("short")).toThrow("32-byte");
  });

  it.skipIf(CHROMIUM === null)("reads the §8.6 variables", () => {
    const config = readCloudBrowserConfig(
      env({
        PORT: "0",
        CLOUD_BROWSER_PUBLIC_URL: "https://cloud.example/",
        PISTACHIO_WEB_URL: "https://www.example/",
        PISTACHIO_BROWSER_URL: "https://app.example/",
      }),
    );
    expect(config.port).toBe(0);
    expect(config.controlUrl).toBe("http://localhost:8787");
    expect(config.publicUrl).toBe("https://cloud.example");
    expect(config.webUrl).toBe("https://www.example");
    expect(config.browserUrl).toBe("https://app.example");
    expect(config.agentModel).toBe("test/model");
    expect(config.chromiumExecutablePath).toBe(CHROMIUM);
    expect(Buffer.from(config.stateKey)).toEqual(key);
  });

  it.skipIf(CHROMIUM === null)("names Jev as the address bar's intent model, and nothing when it is turned off", () => {
    expect(readCloudBrowserConfig(env()).intentModel).toBe(DEFAULT_INTENT_MODEL);
    expect(readCloudBrowserConfig(env({ PISTACHIO_INTENT_MODEL: " typesafe-ai/jev-mini " })).intentModel).toBe(
      "typesafe-ai/jev-mini",
    );
    for (const off of ["off", "0", "false"]) {
      expect(readCloudBrowserConfig(env({ PISTACHIO_INTENT_MODEL: off })).intentModel).toBeNull();
    }
  });

  it.skipIf(CHROMIUM === null)("defaults the two web apps to their production hosts (§15)", () => {
    // Neither is required: a deployment that does not host a web app still
    // boots, and the two origins it then pins are simply never sent.
    const config = readCloudBrowserConfig(env());
    expect(config.webUrl).toBe(DEFAULT_WEB_URL);
    expect(config.browserUrl).toBe(DEFAULT_BROWSER_URL);
    expect(config.browserUrl).not.toBe(config.webUrl);
    // And an unusable value is a configuration error, not a silent fallback.
    expect(() => readCloudBrowserConfig(env({ PISTACHIO_BROWSER_URL: "ftp://x" }))).toThrow("expected an HTTP(S) URL");
  });

  it("names every missing variable", () => {
    expect(() => readCloudBrowserConfig(env({ CLOUD_BROWSER_STATE_KEY: undefined, AI_GATEWAY_API_KEY: "" }))).toThrow(
      "missing CLOUD_BROWSER_STATE_KEY, AI_GATEWAY_API_KEY",
    );
  });

  it("lets a programmatic model factory stand in for the gateway key", () => {
    expect(() => readCloudBrowserConfig(env({ AI_GATEWAY_API_KEY: undefined, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/nope" }), { modelFactorySupplied: true })).toThrow(
      "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH does not exist",
    );
  });

  it("rejects a non-HTTP control URL and a bad port", () => {
    expect(() => readCloudBrowserConfig(env({ PISTACHIO_CONTROL_URL: "ftp://x" }))).toThrow("expected an HTTP(S) URL");
    expect(() => readCloudBrowserConfig(env({ PORT: "70000" }))).toThrow("PORT must be");
  });

  it.skipIf(CHROMIUM === null)("reads the browser session idle window, and defaults it to half an hour (§12)", () => {
    expect(readCloudBrowserConfig(env()).sessionIdleMs).toBe(DEFAULT_BROWSER_SESSION_IDLE_MS);
    expect(readCloudBrowserConfig(env({ CLOUD_BROWSER_SESSION_IDLE_MS: "60000" })).sessionIdleMs).toBe(60_000);
    // A window of a second or a week is a misconfiguration, not a preference.
    expect(() => readCloudBrowserConfig(env({ CLOUD_BROWSER_SESSION_IDLE_MS: "10" }))).toThrow("CLOUD_BROWSER_SESSION_IDLE_MS");
    expect(() => readCloudBrowserConfig(env({ CLOUD_BROWSER_SESSION_IDLE_MS: "soon" }))).toThrow("CLOUD_BROWSER_SESSION_IDLE_MS");
  });
});
