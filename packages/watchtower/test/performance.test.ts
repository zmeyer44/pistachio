import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { Archive } from "../src/archive.js";

it("keeps 2,000 representative visits compact and searchable", () => {
  const directory = mkdtempSync(join(tmpdir(), "watchtower-benchmark-"));
  const archive = new Archive(join(directory, "archive.db"));
  const ingest: number[] = [],
    searches: number[] = [];
  try {
    for (let i = 0; i < 2000; i++) {
      const page = i % 200;
      const revision = Math.floor(i / 200) % 2;
      const visit = {
        id: `v${i}`,
        url: `https://example.com/article/${page}`,
        title: `Workshop ${page}`,
        spaceId: "personal",
        at: 1000 + i,
      };
      const blocks = Array.from(
        { length: 40 },
        (_, paragraph) =>
          `Workshop ${page}, paragraph ${paragraph}: ${"The machine uses bronze bearings. Preserve the spindle alignment during restoration. ".repeat(8)}`,
      );
      blocks[20] = `Version ${revision}: calibrated spindle marker${page}`;
      const start = performance.now();
      archive.visit(visit);
      archive.ingest(visit, `o${i}`, visit.at + 1, {
        url: visit.url,
        title: visit.title,
        description: "",
        creator: "",
        kind: "article",
        blocks,
        links: [],
        truncated: false,
      });
      ingest.push(performance.now() - start);
    }
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const results = archive.search("personal", `bronze marker${i % 200}`);
      searches.push(performance.now() - start);
      expect(results).toHaveLength(10);
    }
    const percentile = (values: number[], p: number): number =>
      Number(
        [...values]
          .sort((a, b) => a - b)
          [Math.floor((values.length - 1) * p)]!.toFixed(2),
      );
    const stats = archive.stats("personal");
    const metrics = {
      visits: stats.visits,
      snapshots: stats.snapshots,
      sharedBlocks: stats.blocks,
      databaseBytes: stats.databaseBytes,
      logicalSnapshotBytes: stats.logicalBytes,
      compressedBlockBytes: stats.storedBytes,
      ingestP50Ms: percentile(ingest, 0.5),
      ingestP95Ms: percentile(ingest, 0.95),
      searchP50Ms: percentile(searches, 0.5),
      searchP95Ms: percentile(searches, 0.95),
    };
    expect(stats.snapshots).toBe(400);
    expect(stats.logicalBytes).toBeGreaterThan(stats.storedBytes * 10);
    if (process.env["WATCHTOWER_BENCHMARK_REPORT"])
      writeFileSync(
        process.env["WATCHTOWER_BENCHMARK_REPORT"],
        JSON.stringify(metrics, null, 2) + "\n",
      );
    console.info("Watchtower synthetic benchmark", metrics);
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
