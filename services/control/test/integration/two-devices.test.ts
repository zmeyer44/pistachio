/**
 * Two desktops and one cloud device against control + hub in-process on
 * PGlite (docs/cloud-sync-design.md §12): real keys through the HTTP
 * routes, two `SpaceSyncEngine`s over `WsTransport`, and the lease/revocation
 * behaviour the desktop relies on.
 */

import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  computeOriginIdHex,
  deriveSpaceKeys,
  fromBase64,
  generateSpaceRootSecret,
  importPublicKeyRaw,
  parseServerMessage,
  seal,
  utf8,
  toBase64,
  workspaceSealAad,
  workspaceSigningBytes,
  wrapRootSecretToDevice,
  type ClientMessage,
  type CookieAttributes,
  type CookieIdentity,
  type CookiePlain,
  type ServerMessage,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import {
  DeviceRegistryVerifier,
  SpaceSyncEngine,
  WsTransport,
  type CookieApplier,
  type TransportEvents,
  type TransportState,
} from "@pistachio/sync-engine";
import type { HubHost } from "@pistachio/sync-hub";
import { createApp, type ControlApp } from "../../src/app.js";
import { generateSigningKeys } from "../../src/keys-provider.js";
import {
  authed,
  deviceLogin,
  enableCloud,
  enrollDesktop,
  fakeRunner,
  json,
  jsonInit,
  makeDb,
  newDeviceKeys,
  settle,
  signup,
  type DeviceKeys,
  type EnrolledDevice,
  type FakeRunner,
  type Harness,
} from "../helpers.js";

const SPACE = "work";

let h: Harness;
let control: ControlApp;
let server: HttpServer;
let host: HubHost;
let baseUrl: string;
let hubUrl: string;
let runner: FakeRunner;

let userId: string;
let desktopA: EnrolledDevice;
let desktopB: EnrolledDevice;
let stranger: EnrolledDevice;
let cloudId: string;
let cloudIdentity: DeviceKeys;
let cloudToken: string;
let keys: SpaceKeys;

class Applier implements CookieApplier {
  readonly applied: CookiePlain[] = [];
  apply(plain: CookiePlain): Promise<void> {
    this.applied.push(plain);
    return Promise.resolve();
  }
}

interface Peer {
  device: EnrolledDevice;
  engine: SpaceSyncEngine;
  transport: WsTransport;
  applier: Applier;
  verifier: DeviceRegistryVerifier;
  states: TransportState[];
  revoked: boolean;
  released: string[];
  workspaceDocs: string[];
}

function makePeer(device: EnrolledDevice, verifier: DeviceRegistryVerifier): Peer {
  const applier = new Applier();
  const peer: Partial<Peer> = { device, applier, verifier, states: [], revoked: false, released: [], workspaceDocs: [] };
  const events: TransportEvents = {
    getToken: () => Promise.resolve(device.token),
    authRequired: () => true,
    onStateChanged: (state) => {
      peer.states?.push(state);
      peer.engine?.setOnline(state === "connected");
    },
    onRecords: (spaceId, records) => {
      if (spaceId === SPACE) void peer.engine?.applyRemote(records);
    },
    onPublishRejected: (rejections) => {
      for (const r of rejections) void peer.engine?.publishRejected(r.recordId, r.reason);
    },
    onPublishInterrupted: (ids) => {
      for (const id of ids) void peer.engine?.publishRejected(id, "lease_required");
    },
    onLeaseRevoked: (_spaceId, originId) => peer.engine?.leaseRevoked(originId),
    onLeaseReleased: (_spaceId, originId) => {
      peer.released?.push(originId);
      peer.engine?.leaseReleased(originId);
    },
    onRevoked: () => {
      peer.revoked = true;
    },
    onWorkspaceRecords: (docs) => {
      for (const doc of docs) peer.workspaceDocs?.push(doc.key);
    },
  };
  const transport = new WsTransport(hubUrl, device.deviceId, "desktop", events);
  const engine = new SpaceSyncEngine(
    SPACE,
    keys,
    { deviceId: device.deviceId, privateKey: device.keys.signing.privateKey },
    transport,
    applier,
    { deviceId: device.deviceId, leaseKind: "desktop", verifier, deferToForeignLease: (d) => d.holderKind === "cloud" },
  );
  peer.transport = transport;
  peer.engine = engine;
  return peer as Peer;
}

class RawClient {
  readonly frames: ServerMessage[] = [];
  private readonly waiters: Array<() => void> = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws.on("message", (data) => {
      this.frames.push(parseServerMessage(data.toString()));
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static open(token: string): Promise<RawClient> {
    const ws = new WebSocket(`${hubUrl}?access_token=${encodeURIComponent(token)}`);
    const client = new RawClient(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade rejected with ${String(res.statusCode)}`)));
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  async next<T extends ServerMessage["t"]>(t: T, timeoutMs = 5_000): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex((f) => f.t === t);
      if (index >= 0) return this.frames.splice(index, 1)[0] as Extract<ServerMessage, { t: T }>;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${t}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

function identity(name: string, hostKey = "example.com"): CookieIdentity {
  return { spaceId: SPACE, hostKey, name, path: "/", partitionKey: "", sourceScheme: "secure" };
}

function attrs(value: string): CookieAttributes {
  return { value, expiresMs: null, persistent: false, secure: true, httpOnly: true, sameSite: "lax", priority: "medium" };
}

async function connect(peer: Peer): Promise<void> {
  peer.transport.start([SPACE]);
  await settle(() => peer.transport.state === "connected", 1_000);
}

async function wrapToCloud(spaceId: string, secret: Uint8Array): Promise<void> {
  const wrapper = await wrapRootSecretToDevice(
    secret,
    spaceId,
    { deviceId: cloudId, agreementPublicKeyRaw: cloudIdentity.agreementPublicKeyRaw },
    { deviceId: desktopA.deviceId, signingKey: desktopA.keys.signing.privateKey },
  );
  const res = await h.request(
    `/v1/spaces/${spaceId}/wrappers`,
    jsonInit("PUT", { wrappers: [{ kind: wrapper.kind, credentialId: wrapper.credentialId, salt: wrapper.salt, wrapped: wrapper.wrapped, senderDeviceId: wrapper.senderDeviceId, signature: wrapper.signature }] }, desktopA.token),
  );
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  const db = await makeDb();
  const signing = await generateSigningKeys();
  runner = await fakeRunner((path, init) => fetch(`${baseUrl}${path}`, init));
  const logs: string[] = [];
  control = createApp(db, {
    signing,
    runner: runner.client,
    env: { CLOUD_BROWSER_SERVICE_TOKEN: "svc-token-for-tests", EGRESS_GATEWAY_TOKEN: "gw-token-for-tests" },
    log: (line) => logs.push(line),
  });
  server = await new Promise<HttpServer>((resolve) => {
    const s = serve({ fetch: control.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s as HttpServer)) as HttpServer;
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(port)}`;
  hubUrl = `ws://127.0.0.1:${String(port)}/v1/hub/ws`;
  host = control.hub.attach(server);
  h = {
    db,
    control,
    signing,
    hub: control.hub.host as never,
    env: {},
    logs,
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
  };

  const account = await signup(h);
  userId = account.userId;
  desktopA = await enrollDesktop(h, account.bootstrapToken);
  const loginB = await json<{ bootstrapToken: string }>(await h.request("/v1/auth/password-login", jsonInit("POST", { email: account.email, password: "correct-horse-battery" })));
  desktopB = await enrollDesktop(h, loginB.bootstrapToken);
  const loginX = await json<{ bootstrapToken: string }>(await h.request("/v1/auth/password-login", jsonInit("POST", { email: account.email, password: "correct-horse-battery" })));
  stranger = await enrollDesktop(h, loginX.bootstrapToken, await newDeviceKeys());

  const cloud = await enableCloud(h, desktopA.token, SPACE);
  cloudId = cloud["id"] as string;
  const found = runner.identities.get(userId);
  if (!found) throw new Error("cloud identity missing");
  cloudIdentity = found;
  cloudToken = (await deviceLogin(h, cloudIdentity)).token;

  const rootSecret = generateSpaceRootSecret();
  keys = await deriveSpaceKeys(SPACE, rootSecret);
  await wrapToCloud(SPACE, rootSecret);
  await wrapToCloud("__workspace__", generateSpaceRootSecret());
});

afterAll(async () => {
  await host.close();
  await runner.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function registryVerifier(token: string, exclude: string[] = []): Promise<DeviceRegistryVerifier> {
  const verifier = new DeviceRegistryVerifier("reject");
  const { devices } = await json<{ devices: Array<{ id: string; devicePublicKey: string; revokedAt: string | null }> }>(await h.request("/v1/devices", authed(token)));
  for (const device of devices) {
    if (device.revokedAt !== null || exclude.includes(device.id)) continue;
    verifier.addDevice(device.id, await importPublicKeyRaw(fromBase64(device.devicePublicKey)));
  }
  return verifier;
}

describe("two desktops and a cloud device", () => {
  let a: Peer;
  let b: Peer;
  let originId: string;
  let cloud: RawClient;

  it("enrolls three real devices and lists them with fingerprints", async () => {
    const { devices } = await json<{ devices: Array<{ id: string; platform: string }> }>(await h.request("/v1/devices", authed(desktopA.token)));
    expect(devices.map((d) => d.platform).sort()).toEqual(["cloud", "macos", "macos", "macos"]);
    expect(devices.map((d) => d.id)).toEqual(expect.arrayContaining([desktopA.deviceId, desktopB.deviceId, cloudId]));
  });

  it("converges a cookie written on A onto B over the hub", async () => {
    a = makePeer(desktopA, await registryVerifier(desktopA.token, [stranger.deviceId]));
    b = makePeer(desktopB, await registryVerifier(desktopB.token, [stranger.deviceId]));
    await connect(a);
    await connect(b);
    const wire = await a.engine.localChange(identity("sid"), attrs("v1"), false, "explicit");
    expect(wire).not.toBeNull();
    await settle(() => b.applier.applied.some((p) => p.identity.name === "sid" && p.attributes?.value === "v1"), 1_000);
    expect(a.applier.applied).toHaveLength(0);
  });

  it("rejects a hello whose device id or kind does not match the token", async () => {
    const mismatch = await RawClient.open(desktopA.token);
    mismatch.send({ t: "hello", deviceId: desktopB.deviceId, kind: "desktop", spaceIds: [SPACE] });
    const error = await mismatch.next("error");
    expect(error.code).toBe("device_mismatch");
    expect((await mismatch.closed).code).toBe(4400);
    const wrongKind = await RawClient.open(desktopA.token);
    wrongKind.send({ t: "hello", deviceId: desktopA.deviceId, kind: "cloud", spaceIds: [SPACE] });
    expect((await wrongKind.next("error")).code).toBe("device_mismatch");
    expect((await wrongKind.closed).code).toBe(4400);
  });

  it("the verifier drops records from a device it does not know", async () => {
    const x = makePeer(stranger, await registryVerifier(stranger.token));
    await connect(x);
    const before = b.applier.applied.length;
    const wire = await x.engine.localChange(identity("intruder"), attrs("evil"), false, "explicit");
    expect(wire).not.toBeNull();
    // B sees the record but rejects it; a peer that knows X applies it.
    const y = makePeer(desktopA, await registryVerifier(desktopA.token));
    await connect(y);
    await settle(() => y.applier.applied.some((p) => p.identity.name === "intruder"), 1_000);
    expect(b.applier.applied.length).toBe(before);
    expect(b.applier.applied.some((p) => p.identity.name === "intruder")).toBe(false);
    x.transport.stop();
    y.transport.stop();
  });

  it("device-workspace docs are writable only by the device they name", async () => {
    const raw = await RawClient.open(desktopA.token);
    raw.send({ t: "hello", deviceId: desktopA.deviceId, kind: "desktop", spaceIds: [SPACE] });
    await raw.next("hello.ack");
    const doc = async (key: string) => {
      const hlc = { physicalMs: Date.now(), logical: 0, deviceId: desktopA.deviceId };
      const sealedValue = toBase64(await seal(keys.sealKey, utf8(JSON.stringify({ kind: "deviceActivity" })), workspaceSealAad(key)));
      const sig = new Uint8Array(
        await crypto.subtle.sign("Ed25519", desktopA.keys.signing.privateKey, workspaceSigningBytes(key, sealedValue, hlc) as BufferSource),
      );
      return { key, sealedValue, hlc, deviceSig: toBase64(sig) };
    };
    raw.send({ t: "workspace.publish", docs: [await doc(`device-workspace:${desktopB.deviceId}`)] });
    const error = await raw.next("error");
    expect(error.code).toBe("malformed");
    raw.send({ t: "workspace.publish", docs: [await doc(`device-workspace:${desktopA.deviceId}`)] });
    await settle(() => b.workspaceDocs.includes(`device-workspace:${desktopA.deviceId}`), 1_000);
    expect(b.workspaceDocs).not.toContain(`device-workspace:${desktopB.deviceId}`);
    raw.ws.close();
    await raw.closed;
  });

  it("a desktop defers behind the cloud device's exclusive lease and drains when a run is revoked", async () => {
    originId = await computeOriginIdHex(keys.idKey, SPACE, "shop.example");
    cloud = await RawClient.open(cloudToken);
    cloud.send({ t: "hello", deviceId: cloudId, kind: "cloud", spaceIds: [SPACE] });
    await cloud.next("hello.ack");
    cloud.send({ t: "lease.acquire", spaceId: SPACE, originId, exclusive: true });
    const granted = await cloud.next("lease.granted");
    expect(granted.exclusive).toBe(true);

    const before = b.applier.applied.length;
    await a.engine.localChange(identity("cart", "shop.example"), attrs("deferred-1"), false, "explicit");
    await settle(() => a.engine.deferredDepth === 1, 1_000);
    expect(b.applier.applied.length).toBe(before);

    const created = await h.request("/v1/runs", jsonInit("POST", { spaceId: SPACE, intent: "buy" }, desktopA.token));
    expect(created.status).toBe(201);
    const { runId } = await json<{ runId: string }>(created);
    const revoked = await h.request(`/v1/runs/${runId}/revoke`, authed(desktopA.token, "POST"));
    expect(revoked.status).toBe(202);
    const released = await cloud.next("lease.released");
    expect(released.originId).toBe(originId);
    await settle(() => a.released.includes(originId), 1_000);
    await settle(() => a.engine.deferredDepth === 0, 1_000);
    await settle(() => b.applier.applied.some((p) => p.attributes?.value === "deferred-1"), 1_000);
  });

  it("revoking the cloud device releases its lease (draining A) and closes its socket with 4003", async () => {
    cloud.send({ t: "lease.acquire", spaceId: SPACE, originId, exclusive: true });
    await cloud.next("lease.granted");
    await a.engine.localChange(identity("cart", "shop.example"), attrs("deferred-2"), false, "explicit");
    await settle(() => a.engine.deferredDepth === 1, 1_000);

    const res = await h.request(`/v1/devices/${cloudId}/revoke`, authed(desktopA.token, "POST"));
    expect(res.status).toBe(200);
    expect((await cloud.closed).code).toBe(4003);
    await settle(() => a.engine.deferredDepth === 0, 1_000);
    await settle(() => b.applier.applied.some((p) => p.attributes?.value === "deferred-2"), 1_000);
    expect((await h.request("/v1/me", authed(cloudToken))).status).toBe(401);
    await settle(() => runner.steers.some((s) => s.kind === "device.revoked" && s.deviceId === cloudId), 1_000);
  });

  it("revoking a desktop closes its transport with 4003 and it does not reconnect", async () => {
    const res = await h.request(`/v1/devices/${desktopB.deviceId}/revoke`, authed(desktopA.token, "POST"));
    expect(res.status).toBe(200);
    await settle(() => b.revoked && b.transport.state === "off", 1_000);
    expect(b.states.at(-1)).toBe("off");
    expect((await h.request("/v1/me", authed(desktopB.token))).status).toBe(401);
    // A keeps working: a later write is not affected.
    await a.engine.localChange(identity("after"), attrs("ok"), false, "explicit");
    await settle(() => a.transport.state === "connected", 200);
    a.transport.stop();
    b.transport.stop();
  });
});
