import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate.js";
import { users } from "../src/db/schema.js";
import { authed, enrollRequest, json, makeDb, makeHarness, newDeviceKeys, signup, type Harness } from "./helpers.js";

let h: Harness;
let now = Date.now();

beforeAll(async () => {
  h = await makeHarness({ now: () => now });
});

async function enrollWeb(bootstrapToken: string): Promise<string> {
  const response = await enrollRequest(h, bootstrapToken, await newDeviceKeys(), { platform: "web" });
  expect(response.status).toBe(201);
  return (await json<{ token: string }>(response)).token;
}

describe("account onboarding", () => {
  it("starts incomplete and shares a durable, idempotent completion across devices", async () => {
    const account = await signup(h);
    const other = await signup(h);
    const first = await enrollWeb(account.bootstrapToken);
    const second = await enrollWeb(account.bootstrapToken);
    expect(await json(await h.request("/v1/me", authed(first)))).toMatchObject({ onboardingCompletedAt: null });

    const response = await h.request("/v1/me/onboarding/complete", authed(first, "POST"));
    expect(response.status).toBe(200);
    const completed = await json(response);
    expect(completed).toEqual({ onboardingCompletedAt: new Date(now).toISOString() });
    const [saved] = await h.db.select().from(users).where(eq(users.id, account.userId));
    expect(saved?.onboardingCompletedAt?.toISOString()).toBe(completed["onboardingCompletedAt"]);
    expect(await json(await h.request("/v1/me", authed(second)))).toMatchObject(completed);
    expect(await json(await h.request("/v1/me", authed(other.bootstrapToken)))).toMatchObject({ onboardingCompletedAt: null });

    now += 1_000;
    expect(await json(await h.request("/v1/me/onboarding/complete", authed(second, "POST")))).toEqual(completed);
    // A new app instance has no in-memory knowledge of the completion.
    const restarted = await makeHarness({ db: h.db, signing: h.signing, now: () => now });
    expect(await json(await restarted.request("/v1/me", authed(first)))).toMatchObject(completed);
  });

  it("requires authentication and an enrolled user device", async () => {
    expect((await h.request("/v1/me/onboarding/complete", { method: "POST" })).status).toBe(401);
    const account = await signup(h);
    const response = await h.request("/v1/me/onboarding/complete", authed(account.bootstrapToken, "POST"));
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: "device_required" });
    expect(await json(await h.request("/v1/me", authed(account.bootstrapToken)))).toMatchObject({ onboardingCompletedAt: null });
  });

  it("seeds legacy users as incomplete once and preserves completion on later migrations", async () => {
    const db = await makeDb();
    await db.execute(sql`ALTER TABLE users DROP COLUMN onboarding_completed_at`);
    await db.execute(sql`INSERT INTO users (email) VALUES ('legacy@example.com')`);
    await db.execute(sql`DELETE FROM schema_state`);
    await ensureSchema(db);
    const [legacy] = await db.select().from(users);
    expect(legacy?.onboardingCompletedAt).toBeNull();

    const completed = new Date(now);
    await db.update(users).set({ onboardingCompletedAt: completed });
    // Force the full DDL path, as a future schema change would.
    await db.execute(sql`DELETE FROM schema_state`);
    await ensureSchema(db);
    const [preserved] = await db.select().from(users);
    expect(preserved?.onboardingCompletedAt).toEqual(completed);
    const [fresh] = await db.insert(users).values({ email: "new@example.com" }).returning();
    expect(fresh?.onboardingCompletedAt).toBeNull();
  });
});
