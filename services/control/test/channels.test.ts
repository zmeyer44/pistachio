/**
 * Channels (§7.3): link binding, secret auth, idempotent ingress, the
 * outbound webhook with exact headers, and `vetOutboundUrl` rejections
 * including a mocked private DNS answer.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSpaceRootSecret, wrapRootSecretToDevice } from "@pistachio/sync-protocol";
import type { HostedRunRecord } from "@pistachio/runtime";
import { OutboundUrlError, vetOutboundUrl } from "../src/channels.js";
import * as schema from "../src/db/schema.js";
import {
  authed,
  claimRun,
  desktopAccount,
  enableCloud,
  fakeRunner,
  json,
  jsonInit,
  makeHarness,
  serviceInit,
  settle,
  type FakeRunner,
  type Harness,
} from "./helpers.js";

interface Delivery {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  path: string;
}

let h: Harness;
let runner: FakeRunner;
let webhook: Server;
let webhookUrl: string;
const deliveries: Delivery[] = [];
let webhookStatus = 200;
const dnsAnswers = new Map<string, string[]>();

beforeAll(async () => {
  runner = await fakeRunner((path, init) => h.request(path, init));
  h = await makeHarness({
    runner: runner.client,
    channels: {
      lookup: (host) => Promise.resolve(dnsAnswers.get(host) ?? []),
      timeoutMs: 2_000,
    },
  });
  webhook = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      deliveries.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), path: req.url ?? "" });
      res.writeHead(webhookStatus).end();
    });
  });
  await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
  webhookUrl = `http://127.0.0.1:${String((webhook.address() as AddressInfo).port)}/hook`;
});

afterAll(async () => {
  await runner.close();
  await new Promise<void>((resolve) => webhook.close(() => resolve()));
});

async function cloudAccount(): Promise<{ userId: string; token: string; deviceId: string }> {
  const account = await desktopAccount(h);
  const cloud = await enableCloud(h, account.token);
  const identity = runner.identities.get(account.userId);
  if (!identity) throw new Error("no identity");
  const wrapper = await wrapRootSecretToDevice(
    generateSpaceRootSecret(),
    "work",
    { deviceId: cloud["id"] as string, agreementPublicKeyRaw: identity.agreementPublicKeyRaw },
    { deviceId: account.deviceId, signingKey: account.keys.signing.privateKey },
  );
  await h.request(
    "/v1/spaces/work/wrappers",
    jsonInit("PUT", { wrappers: [{ kind: wrapper.kind, credentialId: wrapper.credentialId, salt: wrapper.salt, wrapped: wrapper.wrapped, senderDeviceId: wrapper.senderDeviceId, signature: wrapper.signature }] }, account.token),
  );
  return { userId: account.userId, token: account.token, deviceId: account.deviceId };
}

async function createChannel(token: string, outboundUrl?: string): Promise<{ linkId: string; secret: string }> {
  const res = await h.request("/v1/channels", jsonInit("POST", { name: "Ops bot", spaceId: "work", ...(outboundUrl === undefined ? {} : { outboundUrl }) }, token));
  expect(res.status).toBe(201);
  const out = await json<{ linkId: string; secret: string }>(res);
  expect(out.secret.startsWith("pch_")).toBe(true);
  return out;
}

async function inbound(linkId: string, secret: string, body: unknown): Promise<Response> {
  return h.request(`/v1/channels/${linkId}/inbound`, jsonInit("POST", body, secret));
}

describe("channel links", () => {
  it("creates, lists, and revokes links; the secret is stored only as a hash", async () => {
    const a = await cloudAccount();
    const { linkId, secret } = await createChannel(a.token, webhookUrl);
    const [row] = await h.db.select().from(schema.channelLinks).where(eq(schema.channelLinks.id, linkId));
    expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.secretHash).not.toContain(secret);
    expect(row?.outboundUrl).toBe(webhookUrl);
    const list = await json<{ channels: Array<Record<string, unknown>> }>(await h.request("/v1/channels", authed(a.token)));
    expect(list.channels).toHaveLength(1);
    expect(list.channels[0]).toMatchObject({ id: linkId, name: "Ops bot", spaceId: "work", outboundUrl: webhookUrl, revokedAt: null });
    expect(JSON.stringify(list)).not.toContain(secret);
    expect((await h.request(`/v1/channels/${linkId}`, authed(a.token, "DELETE"))).status).toBe(204);
    expect((await h.request(`/v1/channels/${linkId}`, authed(a.token, "DELETE"))).status).toBe(204);
    expect((await h.request(`/v1/channels/${randomUUID()}`, authed(a.token, "DELETE"))).status).toBe(404);
    const revoked = await inbound(linkId, secret, { deliveryId: "d1", text: "hello" });
    expect(revoked.status).toBe(404);
    expect((await h.request("/v1/channels", jsonInit("POST", { name: "x", spaceId: "nope" }, a.token))).status).toBe(404);
  });

  it("deletes a Space that still has a channel link and a hosted run", async () => {
    const account = await desktopAccount(h);
    const cloud = await enableCloud(h, account.token);
    expect((await h.request("/v1/spaces/side-project", jsonInit("PUT", { name: "Side" }, account.token))).status).toBe(200);
    const identity = runner.identities.get(account.userId);
    if (!identity) throw new Error("no identity");
    const wrapper = await wrapRootSecretToDevice(
      generateSpaceRootSecret(),
      "side-project",
      { deviceId: cloud["id"] as string, agreementPublicKeyRaw: identity.agreementPublicKeyRaw },
      { deviceId: account.deviceId, signingKey: account.keys.signing.privateKey },
    );
    expect(
      (
        await h.request(
          "/v1/spaces/side-project/wrappers",
          jsonInit("PUT", { wrappers: [{ kind: wrapper.kind, credentialId: wrapper.credentialId, salt: wrapper.salt, wrapped: wrapper.wrapped, senderDeviceId: wrapper.senderDeviceId, signature: wrapper.signature }] }, account.token),
        )
      ).status,
    ).toBe(200);
    const created = await h.request("/v1/channels", jsonInit("POST", { name: "Side bot", spaceId: "side-project" }, account.token));
    expect(created.status).toBe(201);
    const link = await json<{ linkId: string; secret: string }>(created);
    const ingress = await inbound(link.linkId, link.secret, { deliveryId: "side-1", text: "Do the thing" });
    expect(ingress.status).toBe(202);
    const { runId } = await json<{ runId: string }>(ingress);

    const deleted = await h.request("/v1/spaces/side-project", authed(account.token, "DELETE"));
    expect(deleted.status).toBe(204);
    expect(await h.db.select().from(schema.channelLinks).where(eq(schema.channelLinks.id, link.linkId))).toHaveLength(0);
    expect(await h.db.select().from(schema.channelMessages).where(eq(schema.channelMessages.linkId, link.linkId))).toHaveLength(0);
    expect(await h.db.select().from(schema.hostedRuns).where(eq(schema.hostedRuns.id, runId))).toHaveLength(0);
    expect(await h.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runId))).toHaveLength(0);
  });

  it("authenticates ingress with the link secret only and enforces the strict body", async () => {
    const a = await cloudAccount();
    const { linkId, secret } = await createChannel(a.token);
    expect((await inbound(linkId, "pch_wrong", { deliveryId: "d1", text: "hi" })).status).toBe(401);
    expect((await inbound(linkId, a.token, { deliveryId: "d1", text: "hi" })).status).toBe(401);
    expect((await h.request(`/v1/channels/${linkId}/inbound`, jsonInit("POST", { deliveryId: "d1", text: "hi" }))).status).toBe(401);
    expect((await inbound(randomUUID(), secret, { deliveryId: "d1", text: "hi" })).status).toBe(404);
    expect((await inbound(linkId, secret, { deliveryId: "d1", text: "hi", extra: 1 })).status).toBe(400);
    expect((await inbound(linkId, secret, { deliveryId: "", text: "hi" })).status).toBe(400);
    expect((await inbound(linkId, secret, { text: "hi" })).status).toBe(400);
  });

  it("creates one channel-originated run per delivery and answers 202 either way", async () => {
    const a = await cloudAccount();
    const { linkId, secret } = await createChannel(a.token);
    const first = await inbound(linkId, secret, { deliveryId: "msg-1", text: "Book a table for two" });
    expect(first.status).toBe(202);
    const out = await json<{ runId: string; duplicate: boolean }>(first);
    expect(out.duplicate).toBe(false);
    const dup = await inbound(linkId, secret, { deliveryId: "msg-1", text: "Book a table for two" });
    expect(dup.status).toBe(202);
    expect(await json(dup)).toEqual({ runId: out.runId, duplicate: true });
    const run = await json<{ run: HostedRunRecord }>(await h.request(`/v1/runs/${out.runId}`, authed(a.token)));
    expect(run.run.origin).toEqual({ kind: "channel", linkId, deliveryId: "msg-1", channelName: "Ops bot" });
    expect(run.run.intent).toBe("Book a table for two");
    const messages = await h.db.select().from(schema.channelMessages).where(eq(schema.channelMessages.linkId, linkId));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.runId).toBe(out.runId);
    const runs = await h.db.select().from(schema.hostedRuns).where(eq(schema.hostedRuns.userId, a.userId));
    expect(runs).toHaveLength(1);
  });

  it("refuses ingress for a space that is not cloud enabled and rate-limits per link", async () => {
    const plain = await desktopAccount(h);
    const { linkId, secret } = await createChannel(plain.token);
    const res = await inbound(linkId, secret, { deliveryId: "d", text: "x" });
    expect(res.status).toBe(400);
    expect((await json(res))["error"]).toBe("space_not_cloud_enabled");
    const a = await cloudAccount();
    const link = await createChannel(a.token);
    let last = 0;
    for (let i = 0; i < 61; i += 1) {
      last = (await inbound(link.linkId, link.secret, { deliveryId: `d${String(i)}`, text: "x" })).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe("outbound replies", () => {
  it("POSTs replies, questions, takeovers, and terminal statuses to the webhook with the exact headers", async () => {
    deliveries.length = 0;
    const a = await cloudAccount();
    const { linkId, secret } = await createChannel(a.token, webhookUrl);
    const { runId } = await json<{ runId: string }>(await inbound(linkId, secret, { deliveryId: "m1", text: "Find the invoice" }));
    const { leaseToken } = await claimRun(h, runId);
    const at = new Date().toISOString();
    const appended = await h.request(
      `/v1/internal/runs/${runId}/events`,
      serviceInit("POST", {
        leaseToken,
        events: [
          { eventId: "r1", at, event: { t: "reply", text: "Found it: #4471" } },
          { eventId: "q1", at, event: { t: "question.asked", questionId: "q1" } },
          { eventId: "k1", at, event: { t: "takeover.requested", takeoverId: "k1" } },
          { eventId: "s1", at, event: { t: "status", status: "running", completedAt: null } },
        ],
      }),
    );
    expect(appended.status).toBe(200);
    await h.control.idle();
    await settle(() => deliveries.length >= 3);
    const kinds = deliveries.map((d) => (d.body as { kind: string }).kind).sort();
    expect(kinds).toEqual(["approval", "question", "reply"]);
    const reply = deliveries.find((d) => (d.body as { kind: string }).kind === "reply");
    expect(reply?.body).toEqual({ runId, kind: "reply", text: "Found it: #4471" });
    expect(reply?.headers["content-type"]).toBe("application/json");
    expect(reply?.headers["user-agent"]).toBe("pistachio-control");
    expect(reply?.headers["x-pistachio-delivery"]).toBe(`${runId}:r1:channel:${linkId}`);
    expect(reply?.headers["authorization"]).toBeUndefined();
    expect(reply?.path).toBe("/hook");

    const done = await h.request(`/v1/internal/runs/${runId}/complete`, serviceInit("POST", { leaseToken }));
    expect(done.status).toBe(200);
    await h.control.idle();
    await settle(() => deliveries.some((d) => (d.body as { kind: string }).kind === "done"));
    const completion = deliveries.find((d) => (d.body as { kind: string }).kind === "done");
    expect(completion?.body).toEqual({ runId, kind: "done", text: "Run completed." });
    // Every occurrence is marked sent exactly once.
    const occurrences = await h.db.select().from(schema.notificationOccurrences).where(eq(schema.notificationOccurrences.userId, a.userId));
    expect(occurrences.every((o) => o.status === "sent")).toBe(true);
    expect(occurrences).toHaveLength(4);
    const before = deliveries.length;
    await h.control.dispatchNotifications();
    expect(deliveries.length).toBe(before);
  });

  it("retries a failed delivery up to three attempts, then marks it failed", async () => {
    deliveries.length = 0;
    webhookStatus = 500;
    const a = await cloudAccount();
    const { linkId, secret } = await createChannel(a.token, webhookUrl);
    const { runId } = await json<{ runId: string }>(await inbound(linkId, secret, { deliveryId: "m1", text: "x" }));
    const { leaseToken } = await claimRun(h, runId);
    await h.request(`/v1/internal/runs/${runId}/events`, serviceInit("POST", { leaseToken, events: [{ eventId: "r1", at: new Date().toISOString(), event: { t: "reply", text: "hi" } }] }));
    await h.control.idle();
    const occurrenceId = `${runId}:r1`;
    const state = async () => (await h.db.select().from(schema.notificationOccurrences).where(eq(schema.notificationOccurrences.occurrenceId, occurrenceId)))[0];
    expect((await state())?.status).toBe("pending");
    expect((await state())?.attempts).toBe(1);
    await h.control.dispatchNotifications(Date.now() + 10_000);
    await h.control.dispatchNotifications(Date.now() + 20_000);
    const final = await state();
    expect(final?.status).toBe("failed");
    expect(final?.attempts).toBe(3);
    expect(final?.lastError).toContain("500");
    expect(deliveries).toHaveLength(3);
    webhookStatus = 200;
  });

  it("refuses to dial a host whose DNS answer is private, and never posts", async () => {
    deliveries.length = 0;
    dnsAnswers.set("hooks.example.test", ["10.0.0.7"]);
    const a = await cloudAccount();
    const { linkId, secret } = await createChannel(a.token, "https://hooks.example.test/in");
    const { runId } = await json<{ runId: string }>(await inbound(linkId, secret, { deliveryId: "m1", text: "x" }));
    const { leaseToken } = await claimRun(h, runId);
    await h.request(`/v1/internal/runs/${runId}/events`, serviceInit("POST", { leaseToken, events: [{ eventId: "r1", at: new Date().toISOString(), event: { t: "reply", text: "leak?" } }] }));
    await h.control.idle();
    const [occurrence] = await h.db.select().from(schema.notificationOccurrences).where(eq(schema.notificationOccurrences.occurrenceId, `${runId}:r1`));
    expect(occurrence?.status).toBe("pending");
    expect(occurrence?.lastError).toContain("10.0.0.7");
    expect(deliveries).toHaveLength(0);
    dnsAnswers.set("hooks.example.test", []);
    await h.control.dispatchNotifications(Date.now() + 10_000);
    const [unresolved] = await h.db.select().from(schema.notificationOccurrences).where(eq(schema.notificationOccurrences.occurrenceId, `${runId}:r1`));
    expect(unresolved?.lastError).toBe("unresolvable");
    expect(deliveries).toHaveLength(0);
  });
});

describe("vetOutboundUrl", () => {
  const prod = { production: true };
  const dev = { production: false };

  it("accepts https on 443 to a public name and normalizes", () => {
    expect(vetOutboundUrl("HTTPS://Hooks.Example.com/path?x=1", prod)).toBe("https://hooks.example.com/path?x=1");
    expect(vetOutboundUrl("https://hooks.example.com:443/", prod)).toBe("https://hooks.example.com/");
  });

  it("rejects everything else with a reason", () => {
    const reasons = (url: string, options = prod): string => {
      try {
        vetOutboundUrl(url, options);
      } catch (err) {
        if (err instanceof OutboundUrlError) return err.reason;
        throw err;
      }
      return "accepted";
    };
    expect(reasons("not a url")).toBe("invalid_url");
    expect(reasons("http://hooks.example.com/")).toBe("scheme");
    expect(reasons("ftp://hooks.example.com/")).toBe("scheme");
    expect(reasons("https://user:pw@hooks.example.com/")).toBe("credentials");
    expect(reasons("https://user@hooks.example.com/")).toBe("credentials");
    expect(reasons("https://hooks.example.com:8443/")).toBe("port");
    expect(reasons("https://203.0.113.5/")).toBe("ip_literal");
    expect(reasons("https://[2001:db8::1]/")).toBe("ip_literal");
    expect(reasons("https://localhost/")).toBe("private_host");
    expect(reasons("https://hooks.localhost/")).toBe("private_host");
    expect(reasons("https://intranet/")).toBe("private_host");
    expect(reasons("http://127.0.0.1:9999/hook", prod)).toBe("scheme");
    expect(reasons("http://127.0.0.1:9999/hook", dev)).toBe("accepted");
    expect(reasons("http://localhost:9999/hook", dev)).toBe("accepted");
    expect(reasons("http://10.0.0.1:9999/hook", dev)).toBe("scheme");
  });

  it("is enforced by POST /channels", async () => {
    const a = await cloudAccount();
    const res = await h.request("/v1/channels", jsonInit("POST", { name: "x", spaceId: "work", outboundUrl: "https://10.0.0.1/hook" }, a.token));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "outbound_url_rejected", reason: "ip_literal" });
  });
});
