/**
 * EgressService (docs/cloud-sync-design.md §10.3): proxy rules per Space
 * policy with no direct fallback, the `login` predicate matrix, credential
 * refresh on a rejected challenge, re-apply on rotation and health changes,
 * and the explicit, non-sticky "browse direct for now".
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EgressService, type ProxySession } from "../src/main/egress/egress-service";
import type { ControlClient, ControlEgressResponse } from "../src/main/account/control-client";
import { SpaceStore } from "../src/main/space-store";
import type { EgressStatus } from "@pistachio/shell-contracts/ipc";

const dirs: string[] = [];

function scratchSpaces(): SpaceStore {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-egress-"));
  dirs.push(dir);
  return new SpaceStore(dir);
}

function fakeSession(): ProxySession & { proxies: Array<Record<string, unknown>>; authCacheClears: number } {
  const proxies: Array<Record<string, unknown>> = [];
  const session = {
    proxies,
    authCacheClears: 0,
    setProxy: async (config: Record<string, unknown>) => {
      proxies.push(config);
    },
    clearAuthCache: async () => {
      session.authCacheClears += 1;
    },
  };
  return session;
}

function credential(id: string, expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()) {
  return { username: `pe1.u.d.${id}.1`, password: `pw-${id}`, expiresAt, credentialId: id };
}

interface Harness {
  service: EgressService;
  spaces: SpaceStore;
  sessions: ReturnType<typeof fakeSession>[];
  statuses: EgressStatus[];
  egressCalls: number;
  probes: string[];
  gatewayUp: boolean;
  response: ControlEgressResponse;
}

function harness(options: { quic?: boolean; pin?: string; enrolled?: boolean } = {}): Harness {
  const spaces = scratchSpaces();
  const statuses: EgressStatus[] = [];
  const state: Harness = {
    service: undefined as unknown as EgressService,
    spaces,
    sessions: [],
    statuses,
    egressCalls: 0,
    probes: [],
    gatewayUp: true,
    response: {
      gateway: { host: "gw.example", port: 8443, egressIp: "203.0.113.7", region: "iad", state: "ready" },
      credential: credential("c1"),
      policy: { mediaBypass: [], hostileSeed: [], checkoutRules: [] },
    },
  };
  const control = {
    egress: async () => {
      state.egressCalls += 1;
      return state.response;
    },
  } as unknown as ControlClient;
  state.service = new EgressService({
    spaces,
    control: () => (options.enrolled === false ? null : control),
    quicDisabledAtStartup: options.quic ?? true,
    egressUrlPin: options.pin,
    publish: (status) => statuses.push(status),
    fetchImpl: (async (input: RequestInfo | URL) => {
      state.probes.push(String(input));
      if (!state.gatewayUp) throw new Error("ECONNREFUSED");
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch,
  });
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function started(h: Harness): Promise<void> {
  h.service.start();
  await vi.advanceTimersByTimeAsync(0);
}

describe("applyProxy", () => {
  it("routes a direct Space direct and an identity Space through the gateway with no fallback", async () => {
    const h = harness();
    await started(h);
    const direct = fakeSession();
    await h.service.applyProxy(direct, "work", "persist:pistachio-space-work");
    expect(direct.proxies.at(-1)).toMatchObject({ proxyRules: "direct://" });

    h.spaces.setEgressPolicy("work", "identity");
    const identity = fakeSession();
    await h.service.applyProxy(identity, "work", "persist:pistachio-space-work");
    const config = identity.proxies.at(-1)!;
    expect(config["mode"]).toBe("fixed_servers");
    expect(config["proxyRules"]).toBe("https://gw.example:8443");
    expect(String(config["proxyRules"])).not.toContain("direct://");
    expect(String(config["proxyBypassRules"])).toContain("<local>");
    expect(h.service.proxyCredentialFor("work")).toEqual({
      username: "pe1.u.d.c1.1",
      password: "pw-c1",
      host: "gw.example",
      port: 8443,
    });
    expect(h.service.proxyCredentialFor("missing")).toBeNull();
  });

  it("browses direct with restartRequired when QUIC could not be disabled this run", async () => {
    const h = harness({ quic: false });
    await started(h);
    h.spaces.setEgressPolicy("work", "identity");
    const session = fakeSession();
    await h.service.applyProxy(session, "work");
    expect(session.proxies.at(-1)).toMatchObject({ proxyRules: "direct://" });
    expect(h.service.status().spaces).toEqual([
      { spaceId: "work", policy: "identity", failClosed: false, temporaryDirectOverride: false, restartRequired: true },
    ]);
    expect(h.service.proxyCredentialFor("work")).toBeNull();
  });

  it("follows a dev http pin for the proxy rule and the probe", async () => {
    const h = harness({ pin: "http://127.0.0.1:8443" });
    await started(h);
    h.spaces.setEgressPolicy("work", "identity");
    const session = fakeSession();
    await h.service.applyProxy(session, "work");
    expect(session.proxies.at(-1)).toMatchObject({ proxyRules: "http://127.0.0.1:8443" });
    expect(h.probes[0]).toBe("http://127.0.0.1:8443/healthz");
    expect(h.service.proxyCredentialFor("work")).toMatchObject({ host: "127.0.0.1", port: 8443 });
  });

  it("re-applies to every registered session when the policy changes", async () => {
    const h = harness();
    await started(h);
    const human = fakeSession();
    const agent = fakeSession();
    await h.service.applyProxy(human, "work", "persist:pistachio-space-work");
    await h.service.applyProxy(agent, "work", "pistachio-agent-run1");
    await h.service.setSpacePolicy("work", "identity");
    expect(human.proxies.at(-1)).toMatchObject({ proxyRules: "https://gw.example:8443" });
    expect(agent.proxies.at(-1)).toMatchObject({ proxyRules: "https://gw.example:8443" });
    await h.service.setSpacePolicy("work", "direct");
    expect(human.proxies.at(-1)).toMatchObject({ proxyRules: "direct://" });
  });
});

describe("handleLogin (§10.3 predicate)", () => {
  function challenge(h: Harness, authInfo: { isProxy: boolean; host: string; port: number }, firstAuthAttempt = true) {
    const event = { prevented: false, preventDefault: () => undefined as void };
    event.preventDefault = () => {
      event.prevented = true;
    };
    const answers: Array<[string | undefined, string | undefined]> = [];
    h.service.handleLogin(event, { firstAuthAttempt }, authInfo, (username, password) => {
      answers.push([username, password]);
    });
    return { event, answers };
  }

  it("ignores an origin's own challenge", async () => {
    const h = harness();
    await started(h);
    const { event, answers } = challenge(h, { isProxy: false, host: "gw.example", port: 8443 });
    expect(event.prevented).toBe(false);
    expect(answers).toEqual([]);
  });

  it("ignores a proxy challenge from the wrong port or host", async () => {
    const h = harness();
    await started(h);
    expect(challenge(h, { isProxy: true, host: "gw.example", port: 3128 }).answers).toEqual([]);
    expect(challenge(h, { isProxy: true, host: "evil.example", port: 8443 }).answers).toEqual([]);
  });

  it("answers the gateway's challenge with the credential", async () => {
    const h = harness();
    await started(h);
    const { event, answers } = challenge(h, { isProxy: true, host: "gw.example", port: 8443 });
    expect(event.prevented).toBe(true);
    expect(answers).toEqual([["pe1.u.d.c1.1", "pw-c1"]]);
  });

  it("refreshes once after a rejected credential and answers with the new one", async () => {
    const h = harness();
    await started(h);
    expect(h.egressCalls).toBe(1);
    h.response = { ...h.response, credential: credential("c2") };
    const { answers } = challenge(h, { isProxy: true, host: "gw.example", port: 8443 }, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.egressCalls).toBe(2);
    expect(answers).toEqual([["pe1.u.d.c2.1", "pw-c2"]]);
    // Another rejection inside the cooldown is cancelled, not refreshed or re-answered.
    const again = challenge(h, { isProxy: true, host: "gw.example", port: 8443 }, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.egressCalls).toBe(2);
    expect(again.answers).toEqual([[undefined, undefined]]);
    // Past the cooldown a rejection refreshes once more.
    await vi.advanceTimersByTimeAsync(31_000);
    h.response = { ...h.response, credential: credential("c3") };
    const later = challenge(h, { isProxy: true, host: "gw.example", port: 8443 }, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.egressCalls).toBe(3);
    expect(later.answers).toEqual([["pe1.u.d.c3.1", "pw-c3"]]);
  });

  it("cancels the challenge when no live credential is held", async () => {
    const h = harness();
    h.response = { ...h.response, credential: null };
    await started(h);
    const { event, answers } = challenge(h, { isProxy: true, host: "gw.example", port: 8443 });
    expect(event.prevented).toBe(true);
    expect(answers).toEqual([[undefined, undefined]]);
  });
});

describe("rotation, health, and the override", () => {
  it("clears the proxied sessions' auth cache when the credential rotates and re-applies when the gateway moves", async () => {
    const h = harness();
    await started(h);
    h.spaces.setEgressPolicy("work", "identity");
    const session = fakeSession();
    await h.service.applyProxy(session, "work");
    const applied = session.proxies.length;
    h.response = { ...h.response, credential: credential("c2") };
    await h.service.refreshCredential();
    expect(session.authCacheClears).toBe(1);
    h.response = { ...h.response, gateway: { ...h.response.gateway!, host: "gw2.example" } };
    await h.service.refreshCredential();
    expect(session.proxies.length).toBeGreaterThan(applied);
    expect(session.proxies.at(-1)).toMatchObject({ proxyRules: "https://gw2.example:8443" });
  });

  it("refreshes an hour before the credential expires", async () => {
    const h = harness();
    h.response = { ...h.response, credential: credential("c1", new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()) };
    await started(h);
    expect(h.egressCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    expect(h.egressCalls).toBe(1);
    h.response = { ...h.response, credential: credential("c2", new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()) };
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(h.egressCalls).toBe(2);
    // A credential control keeps answering with too little life left is not
    // re-read in a tight loop.
    h.response = { ...h.response, credential: credential("c3", new Date(Date.now() + 30 * 60 * 1000).toISOString()) };
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
    const before = h.egressCalls;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(h.egressCalls - before).toBeLessThanOrEqual(11);
  });

  it("fails closed while the gateway is down, browses direct only by explicit request, and resets when it returns", async () => {
    const h = harness();
    h.gatewayUp = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await started(h);
    h.spaces.setEgressPolicy("work", "identity");
    const session = fakeSession();
    await h.service.applyProxy(session, "work");
    expect(h.service.status().health).toBe("down");
    expect(h.service.status().spaces[0]).toMatchObject({ failClosed: true, temporaryDirectOverride: false });
    // Still pointed at the gateway: nothing leaks direct on its own.
    expect(session.proxies.at(-1)).toMatchObject({ proxyRules: "https://gw.example:8443" });

    await h.service.browseDirect("work");
    expect(warn).toHaveBeenCalled();
    expect(session.proxies.at(-1)).toMatchObject({ proxyRules: "direct://" });
    expect(h.service.status().spaces[0]).toMatchObject({ failClosed: false, temporaryDirectOverride: true });
    expect(h.service.proxyCredentialFor("work")).toBeNull();

    h.gatewayUp = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.service.status().health).toBe("up");
    expect(h.service.status().spaces[0]).toMatchObject({ failClosed: false, temporaryDirectOverride: false });
    expect(session.proxies.at(-1)).toMatchObject({ proxyRules: "https://gw.example:8443" });
    warn.mockRestore();
  });

  it("stop forgets the credential and routes everything direct", async () => {
    const h = harness();
    await started(h);
    h.spaces.setEgressPolicy("work", "identity");
    const session = fakeSession();
    await h.service.applyProxy(session, "work");
    h.service.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.proxyCredentialFor("work")).toBeNull();
    expect(h.service.status()).toMatchObject({ enabled: false, credentialExpiresAt: null, gateway: null });
    expect(session.proxies.at(-1)).toMatchObject({ proxyRules: "direct://" });
  });

  it("does nothing before enrollment", async () => {
    const h = harness({ enrolled: false });
    await started(h);
    expect(h.egressCalls).toBe(0);
    expect(h.service.status().gateway).toBeNull();
  });
});
