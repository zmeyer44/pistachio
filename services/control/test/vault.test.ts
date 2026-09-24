/**
 * The credential vault (D28): a person's device files and reads sealed
 * entries per Space; a leased runner reads and files them for the one Space
 * its run belongs to; control never sees a value and cloud devices never
 * see the account-wide listing.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSpaceRootSecret, wrapRootSecretToDevice } from "@pistachio/sync-protocol";
import type { VaultEntry } from "@pistachio/protocol";
import * as schema from "../src/db/schema.js";
import {
  authed,
  claimRun,
  desktopAccount,
  deviceLogin,
  enableCloud,
  fakeRunner,
  json,
  jsonInit,
  makeHarness,
  serviceInit,
  signup,
  type FakeRunner,
  type Harness,
} from "./helpers.js";

let h: Harness;
let runner: FakeRunner;

beforeAll(async () => {
  runner = await fakeRunner((path, init) => h.request(path, init));
  h = await makeHarness({ runner: runner.client });
});

afterAll(async () => {
  await runner.close();
});

const SEALED = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";

const loginFields = () => [
  { id: randomUUID(), label: "Email", type: "email" as const, autocomplete: "email" as const },
  { id: randomUUID(), label: "Password", type: "password" as const, autocomplete: "current-password" as const },
];

async function cloudAccount() {
  const account = await desktopAccount(h);
  const cloud = await enableCloud(h, account.token);
  const cloudId = cloud["id"] as string;
  const identity = runner.identities.get(account.userId);
  if (!identity) throw new Error("no identity");
  const wrapper = await wrapRootSecretToDevice(
    generateSpaceRootSecret(),
    "work",
    { deviceId: cloudId, agreementPublicKeyRaw: identity.agreementPublicKeyRaw },
    { deviceId: account.deviceId, signingKey: account.keys.signing.privateKey },
  );
  const put = await h.request(
    "/v1/spaces/work/wrappers",
    jsonInit("PUT", { wrappers: [{ kind: wrapper.kind, credentialId: wrapper.credentialId, salt: wrapper.salt, wrapped: wrapper.wrapped, senderDeviceId: wrapper.senderDeviceId, signature: wrapper.signature }] }, account.token),
  );
  expect(put.status).toBe(200);
  return { ...account, cloudId, identity };
}

async function createRun(token: string): Promise<string> {
  const res = await h.request("/v1/runs", jsonInit("POST", { spaceId: "work", intent: "Buy paper towels", startUrl: "https://www.example.com/" }, token));
  expect(res.status).toBe(201);
  return (await json<{ runId: string }>(res)).runId;
}

describe("credential vault", () => {
  it("lets a person's device file, list, update, and delete sealed entries per Space", async () => {
    const account = await desktopAccount(h);
    const stranger = await desktopAccount(h);
    const entryId = randomUUID();
    const fields = loginFields();

    expect(await json(await h.request("/v1/spaces/work/vault", authed(account.token)))).toEqual({ entries: [] });
    expect((await h.request("/v1/spaces/personal/vault", authed(account.token))).status).toBe(404);

    const created = await h.request(
      `/v1/spaces/work/vault/${entryId}`,
      jsonInit("PUT", { siteOrigin: "https://www.example.com/login?next=1", siteName: "Example", fields, sealedPayload: SEALED }, account.token),
    );
    expect(created.status).toBe(201);
    const { entry } = await json<{ entry: VaultEntry }>(created);
    expect(entry).toMatchObject({
      id: entryId,
      spaceId: "work",
      siteOrigin: "https://www.example.com",
      siteName: "Example",
      source: "manual",
      sealedPayload: SEALED,
      lastUsedAt: null,
    });
    expect(entry.fields).toEqual(fields);

    // One-time codes are never filed; neither is a field without an id.
    expect((await h.request(
      `/v1/spaces/work/vault/${randomUUID()}`,
      jsonInit("PUT", { siteOrigin: "https://www.example.com", siteName: "Example", fields: [{ id: randomUUID(), label: "Code", type: "otp" }], sealedPayload: SEALED }, account.token),
    )).status).toBe(400);
    expect((await h.request(
      `/v1/spaces/work/vault/${randomUUID()}`,
      jsonInit("PUT", { siteOrigin: "ftp://files.example", siteName: "Example", fields, sealedPayload: SEALED }, account.token),
    )).status).toBe(400);

    const updated = await h.request(
      `/v1/spaces/work/vault/${entryId}`,
      jsonInit("PUT", { siteOrigin: "https://www.example.com", siteName: "Example (personal)", fields, sealedPayload: `${SEALED.slice(0, -4)}AAA=` }, account.token),
    );
    expect(updated.status).toBe(200);
    expect((await json<{ entry: VaultEntry }>(updated)).entry.siteName).toBe("Example (personal)");
    const listed = await json<{ entries: VaultEntry[] }>(await h.request("/v1/spaces/work/vault", authed(account.token)));
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]?.source).toBe("manual");

    // Another account sees nothing and cannot overwrite the row by guessing its id.
    expect(await json(await h.request("/v1/spaces/work/vault", authed(stranger.token)))).toEqual({ entries: [] });
    expect((await h.request(
      `/v1/spaces/work/vault/${entryId}`,
      jsonInit("PUT", { siteOrigin: "https://www.example.com", siteName: "Hijack", fields, sealedPayload: SEALED }, stranger.token),
    )).status).toBe(404);
    expect((await h.request(`/v1/spaces/work/vault/${entryId}`, authed(stranger.token, "DELETE"))).status).toBe(404);

    // A bootstrap token has no device and therefore no key to open anything.
    const fresh = await signup(h);
    expect((await h.request("/v1/spaces/work/vault", authed(fresh.bootstrapToken))).status).toBe(403);

    expect((await h.request(`/v1/spaces/work/vault/${entryId}`, authed(account.token, "DELETE"))).status).toBe(200);
    expect((await h.request(`/v1/spaces/work/vault/${entryId}`, authed(account.token, "DELETE"))).status).toBe(404);
    expect(await json(await h.request("/v1/spaces/work/vault", authed(account.token)))).toEqual({ entries: [] });
    const kinds = (await h.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.userId, account.userId))).map((row) => row.kind);
    expect(kinds).toEqual(expect.arrayContaining(["vault.entry_created", "vault.entry_updated", "vault.entry_deleted"]));
  });

  it("keeps the cloud device out of the account listing", async () => {
    const account = await cloudAccount();
    const cloudToken = (await deviceLogin(h, account.identity)).token;
    const res = await h.request("/v1/spaces/work/vault", authed(cloudToken));
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: "cloud_device_forbidden" });
  });

  it("lets a leased runner look up, file, and mark entries for its run's Space only", async () => {
    const account = await cloudAccount();
    const runId = await createRun(account.token);
    const { leaseToken } = await claimRun(h, runId);
    const lookup = (origin: string, token = leaseToken) =>
      h.request(`/v1/internal/runs/${runId}/vault/lookup`, serviceInit("POST", { leaseToken: token, siteOrigin: origin }));
    const save = (id: string, fields: VaultEntry["fields"], token = leaseToken) =>
      h.request(
        `/v1/internal/runs/${runId}/vault/entries`,
        serviceInit("POST", { leaseToken: token, id, siteOrigin: "https://www.example.com/signin", siteName: "Example", fields, sealedPayload: SEALED }),
      );

    expect(await json(await lookup("https://www.example.com/anything"))).toEqual({ entries: [] });
    expect((await lookup("https://www.example.com", "not-the-lease")).status).toBe(409);

    const login = loginFields();
    const loginId = randomUUID();
    const filed = await save(loginId, login);
    expect(filed.status).toBe(201);
    expect(await json(filed)).toMatchObject({ replaced: 0, entry: { id: loginId, source: "capture", siteOrigin: "https://www.example.com" } });
    expect((await save(loginId, login)).status).toBe(409);

    // A narrower capture sits beside the wider one; a wider one replaces both.
    const passwordOnlyId = randomUUID();
    expect(await json(await save(passwordOnlyId, [login[1]!]))).toMatchObject({ replaced: 0 });
    expect((await json<{ entries: VaultEntry[] }>(await lookup("https://www.example.com"))).entries.map((e) => e.id).sort()).toEqual([loginId, passwordOnlyId].sort());
    const fullId = randomUUID();
    const full = [...loginFields(), { id: randomUUID(), label: "Card number", type: "text" as const, autocomplete: "cc-number" as const }];
    expect(await json(await save(fullId, full))).toMatchObject({ replaced: 2 });
    const remaining = (await json<{ entries: VaultEntry[] }>(await lookup("https://www.example.com"))).entries;
    expect(remaining.map((e) => e.id)).toEqual([fullId]);
    expect(remaining[0]?.lastUsedAt).not.toBeNull();

    // Other origins and other Spaces stay out of reach of this lease.
    expect(await json(await lookup("https://accounts.example.net"))).toEqual({ entries: [] });
    const other = await cloudAccount();
    const otherRun = await createRun(other.token);
    const otherLease = (await claimRun(h, otherRun)).leaseToken;
    expect(await json(await h.request(
      `/v1/internal/runs/${otherRun}/vault/lookup`,
      serviceInit("POST", { leaseToken: otherLease, siteOrigin: "https://www.example.com" }),
    ))).toEqual({ entries: [] });
    expect((await h.request(
      `/v1/internal/runs/${otherRun}/vault/entries/${fullId}/used`,
      serviceInit("POST", { leaseToken: otherLease }),
    )).status).toBe(404);

    const used = await h.request(`/v1/internal/runs/${runId}/vault/entries/${fullId}/used`, serviceInit("POST", { leaseToken }));
    expect(used.status).toBe(200);
    expect((await json<{ entry: VaultEntry }>(used)).entry.lastUsedAt).not.toBeNull();

    // The person's own listing shows what the run filed, ciphertext included.
    const mine = await json<{ entries: VaultEntry[] }>(await h.request("/v1/spaces/work/vault", authed(account.token)));
    expect(mine.entries).toHaveLength(1);
    expect(mine.entries[0]).toMatchObject({ id: fullId, source: "capture", sealedPayload: SEALED });
    const kinds = (await h.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.userId, account.userId))).map((row) => row.kind);
    expect(kinds.filter((kind) => kind === "vault.entry_saved")).toHaveLength(3);
    expect(kinds).toContain("vault.entry_used");
  });
});
