import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { Archive } from "../src/archive.js";
import { parseQuery } from "../src/query.js";
import {
  watchtowerEligible,
  watchtowerUrl,
  watchtowerRequestSchema,
  DEFAULT_WATCHTOWER_SETTINGS,
  type WatchtowerCapture,
  type WatchtowerVisit,
} from "@pistachio/agent-runtime/watchtower";

const visit = (
  id: string,
  at = 1000,
  spaceId = "personal",
): WatchtowerVisit => ({
  id,
  at,
  spaceId,
  url: "https://example.com/lathe",
  title: "Lathe",
});
const capture = (blocks: string[], title = "Lathe"): WatchtowerCapture => ({
  url: visit("v").url,
  title,
  description: "",
  creator: "",
  kind: "article",
  blocks,
  links: [],
  truncated: false,
});

describe("Watchtower archive", () => {
  it("reconstructs complete observations, deduplicates A-B-A, and searches terms across blocks in the right visit", () => {
    const archive = new Archive(":memory:");
    try {
      const a = capture([
        "Restoring a vintage lathe.",
        "Bronze bearings support the spindle.",
      ]);
      const b = capture(
        [a.blocks[0]!, "Ceramic bearings support the spindle."],
        "Updated workshop",
      );
      for (const [id, at, data] of [
        ["a", 1000, a],
        ["b", 2000, b],
        ["c", 3000, a],
      ] as const) {
        archive.visit(visit(id, at));
        archive.ingest(visit(id, at), id, at + 1, data);
      }
      expect(archive.stats("personal")).toMatchObject({
        visits: 3,
        snapshots: 2,
        blocks: 5,
      });
      expect(archive.read("personal", "a").blocks).toEqual([
        "# Lathe",
        ...a.blocks,
      ]);
      expect(archive.read("personal", "c").snapshotId).toBe(
        archive.read("personal", "a").snapshotId,
      );
      expect(
        archive.search("personal", "lathe bronze").map((r) => r.visitId),
      ).toEqual(["c", "a"]);
      expect(archive.search("personal", '"lathe bronze"')).toHaveLength(2);
      expect(archive.search("personal", "ceramic")).toHaveLength(1);
      expect(archive.search("personal", "updated")[0]?.visitId).toBe("b");
      expect(() => archive.read("work", "a")).toThrow(/another Space/u);
      expect(archive.search("work", "lathe")).toEqual([]);
      archive.forget("personal", { since: 2000 });
      expect(archive.read("personal", "a").blocks).toEqual([
        "# Lathe",
        ...a.blocks,
      ]);
      expect(archive.search("personal", "ceramic")).toEqual([]);
      expect(archive.stats("personal")).toMatchObject({
        visits: 1,
        snapshots: 1,
        blocks: 3,
      });
      // An in-flight capture cannot resurrect a forgotten visit.
      archive.ingest(visit("b", 2000), "late", 4000, b);
      expect(archive.search("personal", "ceramic")).toEqual([]);
    } finally {
      archive.close();
    }
  });

  it("keeps changes during one visit and preserves meaningful links, repeats and ordering", () => {
    const archive = new Archive(":memory:");
    try {
      const v = visit("v");
      archive.visit(v);
      archive.ingest(v, "first", 1001, capture(["One", "Two", "One"]));
      archive.ingest(v, "later", 2000, capture(["One", "Three", "One"]));
      archive.ingest(v, "later", 2000, capture(["One", "Three", "One"]));
      expect(archive.search("personal", "")).toHaveLength(1);
      expect(archive.read("personal", "first").history).toHaveLength(2);
      expect(archive.diff("personal", "first", "later")).toMatchObject({
        removed: ["Two"],
        added: ["Three"],
      });
      expect(archive.read("personal", "first").blocks).toEqual([
        "# Lathe",
        "One",
        "Two",
        "One",
      ]);
    } finally {
      archive.close();
    }
  });

  it("persists settings and exports source Markdown with visit provenance", () => {
    const directory = mkdtempSync(join(tmpdir(), "watchtower-test-"));
    let archive = new Archive(join(directory, "archive.db"));
    try {
      archive.configure({ enabled: true, excludedHosts: ["bank.example"] });
      archive.visit(visit("v"));
      archive.ingest(visit("v"), "o", 1001, capture(["Substantive words."]));
      archive.close();
      archive = new Archive(join(directory, "archive.db"));
      expect(archive.settings().enabled).toBe(true);
      const exported = archive.export("personal", join(directory, "export"));
      expect(readFileSync(join(exported, "snapshot-1.md"), "utf8")).toContain(
        "Substantive words.",
      );
      expect(
        JSON.parse(readFileSync(join(exported, "visits.json"), "utf8")),
      ).toHaveLength(1);
      archive.forget("personal", { all: true });
      expect(archive.stats("personal")).toMatchObject({
        pages: 0,
        snapshots: 0,
        blocks: 0,
      });
    } finally {
      archive.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains a reused snapshot while pruning older visits", () => {
    const archive = new Archive(":memory:");
    try {
      for (const [id, at] of [
        ["old", 1],
        ["recent", 10 * 86400000],
      ] as const) {
        archive.visit(visit(id, at));
        archive.ingest(visit(id, at), id, at + 1, capture(["Timeless text."]));
      }
      archive.prune(2, 11 * 86400000);
      expect(archive.read("personal", "recent").blocks).toContain(
        "Timeless text.",
      );
      // Retention removes old saved TEXT, not the visit: it stays as history.
      expect(archive.stats("personal").visits).toBe(2);
      expect(archive.stats("personal").snapshots).toBe(1);
      const expired = archive.search("personal", "").find((hit) => hit.visitId === "old");
      expect(expired?.coverage).toBe("expired");
      expect(archive.read("personal", expired!.observationId).blocks).toEqual([]);
    } finally {
      archive.close();
    }
  });
});

describe("Watchtower boundaries", () => {
  it("preserves app routes and distinct URLs while excluding secrets and tracking", () => {
    expect(
      watchtowerUrl("https://example.com/?q=lathe&utm_source=x#/item/3"),
    ).toBe("https://example.com/?q=lathe#/item/3");
    expect(watchtowerUrl("https://a:b@example.com/?token=secret&q=lathe")).toBe(
      "https://example.com/?q=lathe",
    );
    expect(watchtowerUrl("file:///secret")).toBeNull();
    const settings = {
      ...DEFAULT_WATCHTOWER_SETTINGS,
      enabled: true,
      excludedHosts: ["example.com"],
    };
    expect(watchtowerEligible("https://sub.example.com", "s", settings)).toBe(
      false,
    );
    expect(watchtowerEligible("https://notexample.com", "s", settings)).toBe(
      true,
    );
    expect(
      watchtowerEligible("https://elsewhere.com", "s", {
        ...settings,
        paused: true,
      }),
    ).toBe(false);
  });
  it("parses a bounded grammar and validates dates rather than interpolating FTS syntax", () => {
    expect(
      parseQuery(
        '"bronze bearings" site:example.com after:2026-09-01 kind:video',
      ),
    ).toMatchObject({
      terms: ["bronze", "bearings"],
      phrases: ["bronze bearings"],
      host: "example.com",
      kind: "video",
    });
    expect(() => parseQuery("after:2026-02-30")).toThrow(/dates/u);
    expect(parseQuery("' OR 1=1 --").terms).toEqual(["or", "1"]);
  });
});

describe("Watchtower retrieval and storage limits", () => {
  it("paginates verified phrases and can find an earlier matching observation in a visit", () => {
    const archive = new Archive(":memory:");
    try {
      for (let i = 0; i < 64; i++) {
        const v = visit(`v${i}`, 1000 + i);
        archive.visit(v);
        archive.ingest(v, `match${i}`, 2000 + i, capture(["bronze bearings"]));
        archive.ingest(
          v,
          `nomatch${i}`,
          3000 + i,
          capture(["bearings of bronze"]),
        );
      }
      const first = archive.search("personal", '"bronze bearings"');
      const second = archive.search("personal", '"bronze bearings"', 50);
      expect(first).toHaveLength(50);
      expect(second).toHaveLength(14);
      expect(
        new Set([...first, ...second].map((hit) => hit.visitId)).size,
      ).toBe(64);
      expect(first[0]?.observationId).toBe("match63");
      // Stemming makes "bearing" and "bearings" one word; order still matters.
      expect(archive.search("personal", '"bronze bearing"')).toHaveLength(50);
      expect(archive.search("personal", '"bearing bronze"')).toHaveLength(0);
    } finally {
      archive.close();
    }
  });
  it("does not accumulate observations for unchanged in-page recaptures", () => {
    const archive = new Archive(":memory:");
    try {
      const v = visit("v");
      archive.visit(v);
      for (let i = 0; i < 50; i++)
        archive.ingest(v, `o${i}`, i + 1000, capture(["Stable content"]));
      expect(archive.read("personal", "o0").history).toHaveLength(1);
    } finally {
      archive.close();
    }
  });
  it("links saved documents within their Space and exports navigable Markdown", () => {
    const directory = mkdtempSync(join(tmpdir(), "watchtower-wiki-"));
    const archive = new Archive(":memory:");
    try {
      const v = visit("source", 2000);
      const linked = {
        ...visit("linked", 1000),
        url: "https://example.com/reference",
      };
      archive.visit(linked);
      archive.ingest(linked, "reference", 1001, {
        ...capture(["Reference detail"], "Reference"),
        url: linked.url,
      });
      archive.visit(v);
      archive.ingest(v, "source", 2001, {
        ...capture(["Linked evidence"]),
        links: [{ url: linked.url, text: "Reference" }],
      });
      expect(archive.read("personal", "source").links[0]?.observationId).toBe(
        "reference",
      );
      expect(
        archive.read("personal", "reference").backlinks[0]?.observationId,
      ).toBe("source");
      const path = archive.export("personal", directory);
      expect(readFileSync(join(path, "snapshot-2.md"), "utf8")).toContain(
        "[Reference](<snapshot-1.md>)",
      );
      archive.forget("personal", {
        pageId: archive.read("personal", "reference").pageId,
      });
      expect(
        archive.read("personal", "source").links[0]?.observationId,
      ).toBeUndefined();
    } finally {
      archive.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("keeps durable history when the storage budget stops new captures", () => {
    const archive = new Archive(":memory:");
    try {
      const v = visit("one");
      archive.visit(v);
      archive.ingest(v, "saved", 1001, capture(["Still readable"]));
      archive.configure({ maxSizeMb: 16 });
      archive.db.exec(
        "CREATE TABLE ballast(body BLOB); INSERT INTO ballast VALUES(zeroblob(16000000))",
      );
      archive.visit(visit("two"));
      expect(archive.stats("personal").full).toBe(true);
      expect(archive.stats("personal").visits).toBe(1);
      expect(archive.read("personal", "saved").markdown).toContain(
        "Still readable",
      );
    } finally {
      archive.close();
    }
  });
});

it("patches only requested settings, including across the IPC schema", () => {
  const archive = new Archive(":memory:");
  try {
    archive.configure({
      enabled: true,
      remoteRerank: true,
      excludedHosts: ["bank.example"],
    });
    const request = watchtowerRequestSchema.parse({
      type: "settings",
      patch: { paused: true },
    });
    if (request.type !== "settings") throw new Error("bad request");
    expect(request.patch).toEqual({ paused: true });
    expect(archive.configure(request.patch)).toMatchObject({
      enabled: true,
      remoteRerank: true,
      paused: true,
      excludedHosts: ["bank.example"],
    });
  } finally {
    archive.close();
  }
});

it("searches metadata-only visits and broadens enhanced recall locally", () => {
  const archive = new Archive(":memory:");
  try {
    archive.visit(visit("brief"));
    expect(archive.search("personal", "lathe")[0]?.coverage).toBe("metadata");
    const v = { ...visit("full"), url: "https://example.com/restoration" };
    archive.visit(v);
    archive.ingest(v, "full", 1100, {
      ...capture(["Bronze spindle restoration"]),
      url: v.url,
    });
    expect(
      archive.search("personal", "that video I saw about bronze restoration"),
    ).toHaveLength(0);
    expect(
      archive.search(
        "personal",
        "that video I saw about bronze restoration",
        0,
        true,
      )[0]?.observationId,
    ).toBe("full");
  } finally {
    archive.close();
  }
});

it("keeps shared content for another Space and preserves an early metadata link", () => {
  const archive = new Archive(":memory:");
  try {
    for (const space of ["personal", "work"]) {
      const v = visit(space, Date.UTC(2026, 8, 2), space);
      archive.visit(v);
      archive.ingest(v, `${space}:full`, v.at + 1, {
        ...capture(["Bronze bearings"]),
        kind: "video",
      });
    }
    expect(archive.read("personal", "personal:metadata").coverage).toBe(
      "metadata",
    );
    expect(
      archive.search(
        "personal",
        "bronze kind:video after:2026-09-01 before:2026-09-03",
      ),
    ).toHaveLength(1);
    expect(archive.search("personal", "bronze after:2026-09-03")).toHaveLength(
      0,
    );
    archive.forget("personal", { all: true });
    expect(archive.search("personal", "bronze")).toEqual([]);
    expect(archive.search("work", "bronze")).toHaveLength(1);
    expect(() => archive.read("personal", "personal:metadata")).toThrow();
    expect(archive.read("work", "work:full").blocks).toContain(
      "Bronze bearings",
    );
  } finally {
    archive.close();
  }
});
