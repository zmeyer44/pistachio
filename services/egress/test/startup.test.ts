import { describe, expect, it } from "vitest";

import { DEFAULT_DEV_LISTEN, DEFAULT_LISTEN, ENV } from "../src/config.js";
import { DevVerifier, SharedSecretVerifier } from "../src/auth.js";
import { StartupError, isLoopbackLiteral, parseExtraPorts, parseListen, resolveStartup } from "../src/startup.js";
import { SECRET_HEX, USER_A, credentialFor } from "./helpers.js";

const listenText = (l: { host: string; port: number }): string => `${l.host}:${l.port}`;

describe("resolveStartup", () => {
  it("refuses to start with no verifier configured (no default that serves)", () => {
    expect(() => resolveStartup({})).toThrow(StartupError);
    try {
      resolveStartup({});
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(ENV.tokenSecret);
      expect(message).toContain(ENV.devInsecure);
    }
  });

  it("makes the dev verifier reachable only through the opt-in, and loopback only", () => {
    expect(() => resolveStartup({ [ENV.listen]: "0.0.0.0:8443" })).toThrow(StartupError);

    const dev = resolveStartup({ [ENV.devInsecure]: "1" });
    expect(listenText(dev.listen)).toBe(DEFAULT_DEV_LISTEN);
    expect(dev.devInsecure).toBe(true);
    expect(dev.verifier).toBeInstanceOf(DevVerifier);
    expect(dev.control).toBeNull();
    expect(dev.warnings.some((w) => w.includes(ENV.controlUrl))).toBe(true);
    expect(resolveStartup({ [ENV.devInsecure]: "1", [ENV.listen]: "127.0.0.1:0" }).listen.port).toBe(0);
    expect(resolveStartup({ [ENV.devInsecure]: "1", [ENV.listen]: "[::1]:8443" }).listen.host).toBe("::1");

    for (const listen of ["0.0.0.0:8443", "[::]:8443", "192.168.1.20:8443", "gw:8443", "localhost:8443"]) {
      expect(() => resolveStartup({ [ENV.devInsecure]: "1", [ENV.listen]: listen }), listen).toThrow(
        new RegExp(ENV.devInsecure),
      );
    }

    // A typo in the opt-in value is an error, not a silent "off".
    expect(() => resolveStartup({ [ENV.devInsecure]: "true" })).toThrow(StartupError);
    // Both configured: refuse rather than pick.
    expect(() => resolveStartup({ [ENV.devInsecure]: "1", [ENV.tokenSecret]: SECRET_HEX })).toThrow(/both set/);
  });

  it("yields a MAC-checking verifier on the default public listener from a secret", () => {
    const config = resolveStartup({ [ENV.tokenSecret]: SECRET_HEX, [ENV.extraPorts]: "8443, 9000,junk,25" });
    expect(listenText(config.listen)).toBe(DEFAULT_LISTEN);
    expect(config.devInsecure).toBe(false);
    expect(config.extraPorts).toEqual([8443, 9000, 25]);
    expect(config.verifier).toBeInstanceOf(SharedSecretVerifier);
    const credential = credentialFor();
    expect(config.verifier.verify(credential.username, credential.password)).toBe(true);
    expect(config.verifier.verify(credential.username, "devsig")).toBe(false);
  });

  it("treats a malformed secret, owner id, control url, or TLS pair as a startup error", () => {
    expect(() => resolveStartup({ [ENV.tokenSecret]: "not-hex" })).toThrow(/hex/);
    expect(() => resolveStartup({ [ENV.tokenSecret]: SECRET_HEX, [ENV.ownerUserId]: "Bob" })).toThrow(/uuid/);
    expect(resolveStartup({ [ENV.tokenSecret]: SECRET_HEX, [ENV.ownerUserId]: USER_A }).ownerUserId).toBe(USER_A);
    expect(() => resolveStartup({ [ENV.tokenSecret]: SECRET_HEX, [ENV.controlUrl]: "http://c" })).toThrow(
      new RegExp(ENV.gatewayToken),
    );
    expect(() =>
      resolveStartup({ [ENV.tokenSecret]: SECRET_HEX, [ENV.controlUrl]: "nope", [ENV.gatewayToken]: "t" }),
    ).toThrow(/URL/);
    const withControl = resolveStartup({
      [ENV.tokenSecret]: SECRET_HEX,
      [ENV.controlUrl]: "http://127.0.0.1:8787/",
      [ENV.gatewayToken]: "t",
    });
    expect(withControl.control).toEqual({ baseUrl: "http://127.0.0.1:8787", token: "t" });
    expect(() => resolveStartup({ [ENV.tokenSecret]: SECRET_HEX, [ENV.tlsCert]: "/c.pem" })).toThrow(/together/);
    const tls = resolveStartup(
      { [ENV.tokenSecret]: SECRET_HEX, [ENV.tlsCert]: "/c.pem", [ENV.tlsKey]: "/k.pem" },
      { readFile: (p) => `pem:${p}` },
    );
    expect(tls.tls).toEqual({ cert: "pem:/c.pem", key: "pem:/k.pem" });
    expect(() =>
      resolveStartup(
        { [ENV.tokenSecret]: SECRET_HEX, [ENV.tlsCert]: "/c.pem", [ENV.tlsKey]: "/k.pem" },
        {
          readFile: () => {
            throw new Error("ENOENT");
          },
        },
      ),
    ).toThrow(/ENOENT/);
  });
});

describe("listen parsing", () => {
  it("parses host:port and [v6]:port", () => {
    expect(parseListen("0.0.0.0:8443")).toEqual({ host: "0.0.0.0", port: 8443 });
    expect(parseListen("[::1]:0")).toEqual({ host: "::1", port: 0 });
    for (const bad of ["", "8443", ":8443", "host:", "host:70000", "[::1]", "[::1]8443"]) {
      expect(parseListen(bad), bad).toBeNull();
    }
  });

  it("recognises loopback literals only", () => {
    for (const ok of ["127.0.0.1", "127.9.8.7", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackLiteral(ok), ok).toBe(true);
    for (const no of ["0.0.0.0", "::", "10.0.0.1", "::ffff:10.0.0.1", "localhost", "gw"]) {
      expect(isLoopbackLiteral(no), no).toBe(false);
    }
  });

  it("parses extra ports leniently and dedupes", () => {
    expect(parseExtraPorts(undefined)).toEqual([]);
    expect(parseExtraPorts("8443,8443, 80,0,65536,x")).toEqual([8443, 80]);
  });
});
