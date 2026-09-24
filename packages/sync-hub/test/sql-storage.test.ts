import { PGlite } from "@electric-sql/pglite";
import { compareHlc, encodeHlc, type Hlc } from "@pistachio/sync-protocol";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HubCore } from "../src/hub-core.js";
import { MemoryHubStorage } from "../src/storage/memory.js";
import { SqlHubStorage, prefixUpperBound } from "../src/storage/sql.js";
import { FakeConnection, frame, hex64, makeHlc, makeRecord, sendHello } from "./helpers.js";

const USER_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const USER_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";

/** The `hub_kv` DDL of docs/cloud-sync-design.md §7.1; control's
 * `migrate.ts` owns the real one, so tests carry their own copy. */
const HUB_KV_DDL = sql`
  CREATE TABLE IF NOT EXISTS hub_kv (
    user_id uuid NOT NULL,
    key text COLLATE "C" NOT NULL,
    value jsonb NOT NULL,
    PRIMARY KEY (user_id, key)
  )
`;

/** The eight keys from §4, in the byte order `COLLATE "C"` must produce. */
const ORDERED_KEYS = [
  "rec:",
  "rec:A",
  "rec:a",
  "rec:a-b",
  "rec:a:b",
  "rec:ab",
  "rec:aÿ",
  "rec;a",
] as const;

let client: PGlite;
let db: PgliteDatabase;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client);
  await db.execute(HUB_KV_DDL);
}, 60_000);

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM hub_kv`);
});

describe("prefixUpperBound", () => {
  it("replaces the last code point with its successor", () => {
    expect(prefixUpperBound("rec:")).toBe("rec;");
    expect(prefixUpperBound("hist:s1:abc:")).toBe("hist:s1:abc;");
    expect(prefixUpperBound("a")).toBe("b");
    expect(prefixUpperBound("aÿ")).toBe("aĀ");
  });

  it("skips the surrogate block and handles astral code points", () => {
    expect(prefixUpperBound("x퟿")).toBe("x");
    expect(prefixUpperBound("x\u{1F600}")).toBe("x\u{1F601}");
  });

  it("throws where no successor exists", () => {
    expect(() => prefixUpperBound("")).toThrow(/empty/);
    expect(() => prefixUpperBound("x\uD83D")).toThrow(/surrogate/);
    expect(() => prefixUpperBound("x\uDE00")).toThrow(/surrogate/);
    expect(() => prefixUpperBound("x\u{10FFFF}")).toThrow(/10FFFF/);
  });
});

describe("SqlHubStorage on PGlite", () => {
  it('declares hub_kv.key with attcollation "C"', async () => {
    const result = await db.execute(sql`
      SELECT c.collname FROM pg_attribute a
      JOIN pg_collation c ON c.oid = a.attcollation
      WHERE a.attrelid = 'hub_kv'::regclass AND a.attname = 'key'
    `);
    expect(result.rows).toEqual([{ collname: "C" }]);
  });

  it("round-trips get/put/delete with jsonb values of every shape", async () => {
    const storage = new SqlHubStorage(db, USER_A);
    expect(await storage.get("missing")).toBeUndefined();
    expect(await storage.delete("missing")).toBe(false);

    const hlc = makeHlc(1234, "dev-a", 5);
    await storage.put("obj", { hlc, nested: [1, [2, 3]], s: "x" });
    await storage.put("bool", true);
    await storage.put("arr", ["s1", "s2"]);
    await storage.put("num", 42);
    await storage.put("str", "plain");
    expect(await storage.get("obj")).toEqual({ hlc, nested: [1, [2, 3]], s: "x" });
    expect(await storage.get("bool")).toBe(true);
    expect(await storage.get("arr")).toEqual(["s1", "s2"]);
    expect(await storage.get("num")).toBe(42);
    expect(await storage.get("str")).toBe("plain");

    await storage.put("obj", { replaced: true });
    expect(await storage.get("obj")).toEqual({ replaced: true });
    expect(await storage.delete("obj")).toBe(true);
    expect(await storage.get("obj")).toBeUndefined();
    expect(await storage.delete("obj")).toBe(false);
  });

  it("isolates users sharing the table", async () => {
    const a = new SqlHubStorage(db, USER_A);
    const b = new SqlHubStorage(db, USER_B);
    await a.put("shared-key", "from-a");
    await b.put("shared-key", "from-b");
    await a.put("only-a", 1);
    expect(await a.get("shared-key")).toBe("from-a");
    expect(await b.get("shared-key")).toBe("from-b");
    expect(await b.get("only-a")).toBeUndefined();
    expect([...(await b.list({ prefix: "" })).keys()]).toEqual(["shared-key"]);
    expect(await b.delete("only-a")).toBe(false);
    expect(await a.get("only-a")).toBe(1);
  });

  it("lists prefixes in byte order and matches MemoryHubStorage exactly", async () => {
    const storage = new SqlHubStorage(db, USER_A);
    const memory = new MemoryHubStorage();
    // Insert shuffled so the order can only come from the collation.
    const shuffled = [...ORDERED_KEYS].sort(() => 0.5 - Math.random());
    for (const key of shuffled) {
      await storage.put(key, { key });
      await memory.put(key, { key });
    }
    const listed = await storage.list<{ key: string }>({ prefix: "rec:" });
    expect([...listed.keys()]).toEqual(ORDERED_KEYS.slice(0, 7));
    expect([...listed.values()].map((v) => v.key)).toEqual(ORDERED_KEYS.slice(0, 7));
    expect([...(await memory.list({ prefix: "rec:" })).keys()]).toEqual([...listed.keys()]);

    // The bound excludes the successor prefix, and narrower prefixes nest.
    expect([...(await storage.list({ prefix: "rec;" })).keys()]).toEqual(["rec;a"]);
    expect([...(await storage.list({ prefix: "rec:a" })).keys()]).toEqual([
      "rec:a",
      "rec:a-b",
      "rec:a:b",
      "rec:ab",
      "rec:aÿ",
    ]);
    expect([...(await storage.list({ prefix: "rec:a:" })).keys()]).toEqual(["rec:a:b"]);
    expect([...(await storage.list({ prefix: "" })).keys()]).toEqual([...ORDERED_KEYS]);
    expect((await storage.list({ prefix: "zzz" })).size).toBe(0);
  });

  it("caps a listing with limit, identically in both backends", async () => {
    const storage = new SqlHubStorage(db, USER_A);
    const memory = new MemoryHubStorage();
    for (const key of [...ORDERED_KEYS].sort(() => 0.5 - Math.random())) {
      await storage.put(key, { key });
      await memory.put(key, { key });
    }
    const head = ORDERED_KEYS.slice(0, 7);
    for (const limit of [1, 3, 7, 99]) {
      const expected = head.slice(0, limit);
      expect([...(await storage.list({ prefix: "rec:", limit })).keys()], `sql ${String(limit)}`).toEqual(expected);
      expect([...(await memory.list({ prefix: "rec:", limit })).keys()], `memory ${String(limit)}`).toEqual(expected);
    }
    // The cap applies to the unprefixed scan too, and 0 asks for nothing.
    expect([...(await storage.list({ prefix: "", limit: 2 })).keys()]).toEqual(ORDERED_KEYS.slice(0, 2));
    expect([...(await memory.list({ prefix: "", limit: 2 })).keys()]).toEqual(ORDERED_KEYS.slice(0, 2));
    expect((await storage.list({ prefix: "rec:", limit: 0 })).size).toBe(0);
    expect((await memory.list({ prefix: "rec:", limit: 0 })).size).toBe(0);
  });

  it("returns hist: versions in ascending HLC order", async () => {
    const storage = new SqlHubStorage(db, USER_A);
    const recordId = hex64(7);
    const versions: Hlc[] = [
      makeHlc(0x100, "dev-b", 0),
      makeHlc(0xff, "dev-a", 3),
      makeHlc(0x10, "dev-a", 0),
      makeHlc(0x100, "dev-a", 1),
      makeHlc(0x100, "dev-a", 0),
      makeHlc(0x1_0000_0000, "dev-a", 0),
    ];
    for (const hlc of versions) {
      await storage.put(`hist:s1:${recordId}:${encodeHlc(hlc)}`, { hlc });
    }
    // A neighbouring record's history must not bleed in.
    await storage.put(`hist:s1:${hex64(8)}:${encodeHlc(makeHlc(1, "dev-a"))}`, { other: true });

    const listed = await storage.list<{ hlc: Hlc }>({ prefix: `hist:s1:${recordId}:` });
    const expected = [...versions].sort(compareHlc);
    expect([...listed.values()].map((v) => v.hlc)).toEqual(expected);
    expect([...listed.keys()]).toEqual(expected.map((hlc) => `hist:s1:${recordId}:${encodeHlc(hlc)}`));
  });

  it("drives HubCore end to end: publish, history, hydrate, leases", async () => {
    const core = new HubCore(new SqlHubStorage(db, USER_A), () => 1_000_000);
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    expect(b.ofType("hello.ack")[0]?.presence).toHaveLength(2);

    const base = makeRecord({ spaceId: "s1", hlc: makeHlc(1, "dev-a") });
    for (let i = 1; i <= 3; i += 1) {
      await core.handleMessage(
        a,
        frame({ t: "publish", records: [{ ...base, hlc: makeHlc(i, "dev-a") }] }),
        [b],
      );
    }
    expect(a.ofType("publish.ack").map((ack) => ack.accepted)).toEqual([
      [base.recordId],
      [base.recordId],
      [base.recordId],
    ]);
    expect(b.ofType("records")).toHaveLength(3);

    const c = new FakeConnection();
    await sendHello(core, c, "dev-c", ["s1"], [a, b]);
    await core.handleMessage(c, frame({ t: "hydrate", spaceId: "s1", sinceHlc: null }), [a, b]);
    const streamed = c.ofType("records").flatMap((f) => f.records);
    expect(streamed.map((r) => r.hlc.physicalMs)).toEqual([1, 2, 3]);
    expect(c.ofType("hydrate.done")[0]?.watermark).toEqual(makeHlc(3, "dev-a"));

    const originId = hex64(0xcafe);
    await core.handleMessage(a, frame({ t: "lease.acquire", spaceId: "s1", originId }), [b, c]);
    expect(a.ofType("lease.granted")).toHaveLength(1);
    await core.handleMessage(b, frame({ t: "lease.acquire", spaceId: "s1", originId }), [a, c]);
    expect(b.ofType("lease.denied")[0]?.holderDeviceId).toBe("dev-a");
    await core.handleClose(a, [b, c]);
    expect(b.ofType("lease.released")).toEqual([{ t: "lease.released", spaceId: "s1", originId }]);
    expect(b.ofType("presence").at(-1)?.devices[0]).toMatchObject({ deviceId: "dev-a", online: false });
  });
});
