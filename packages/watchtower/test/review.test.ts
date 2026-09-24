import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Archive } from "../src/archive.js";
import type {
  WatchtowerCapture,
  WatchtowerVisit,
} from "@pistachio/agent-runtime/watchtower";

const visit = (id: string, spaceId = "personal"): WatchtowerVisit => ({
  id,
  spaceId,
  url: `https://example.com/${id}`,
  title: "Old title",
  at: 1000,
});
const capture = (v: WatchtowerVisit, text: string): WatchtowerCapture => ({
  url: v.url,
  title: "Snapshot title",
  blocks: [text],
  description: "",
  creator: "",
  kind: "article",
  links: [],
  truncated: false,
});

describe("Watchtower review regressions", () => {
  it.each([
    "हिन्दी",
    "বাংলা",
    "தமிழ்",
    "ภาษาไทย",
    "عَرَبِيّ",
    "café",
    "cafe\u0301",
    "ộ",
    "東京",
  ])("uses the same tokenizer for terms and phrases in %s", (text) => {
    const archive = new Archive(":memory:");
    try {
      const v = visit("full");
      archive.visit(v);
      archive.ingest(v, "full", 1001, capture(v, `${text} example`));
      archive.visit({ ...visit("metadata"), title: `${text} example` });
      expect(archive.search("personal", text)).toHaveLength(2);
      expect(archive.search("personal", `"${text} example"`)).toHaveLength(2);
      expect(archive.search("personal", `"example ${text}"`)).toHaveLength(0);
    } finally {
      archive.close();
    }
  });

  it("caches scoped totals between writes and counts shared blocks within each Space", () => {
    const archive = new Archive(":memory:");
    try {
      for (const space of ["personal", "work"]) {
        const v = visit(space, space);
        archive.visit(v);
        archive.ingest(v, space, 1001, capture(v, "Shared text"));
      }
      const get = vi.spyOn(archive, "get");
      const personal = archive.stats("personal");
      const sums = () =>
        get.mock.calls.filter(([sql]) => sql.includes("sum(")).length;
      expect(sums()).toBe(2);
      archive.search("personal", "shared");
      archive.stats("personal");
      expect(sums()).toBe(2);
      expect(archive.stats("work").storedBytes).toBe(personal.storedBytes);
      expect(archive.stats("empty")).toMatchObject({
        storedBytes: 0,
        logicalBytes: 0,
        visits: 0,
      });
      archive.forget("personal", { all: true });
      expect(archive.stats("personal").storedBytes).toBe(0);
      expect(archive.stats("work").storedBytes).toBe(personal.storedBytes);
    } finally {
      archive.close();
    }
  });

  it("removes obsolete content and FTS bytes without optimize or VACUUM", () => {
    const directory = mkdtempSync(join(tmpdir(), "watchtower-delete-"));
    const path = join(directory, "archive.db");
    const archive = new Archive(path);
    try {
      const v = visit("victim");
      archive.visit({ ...v, title: "uniqueforgottentitle" });
      archive.ingest(v, "victim", 1001, capture(v, "uniqueforgottentoken"));
      const keeper = visit("keeper");
      archive.visit(keeper);
      archive.ingest(
        keeper,
        "keeper",
        1002,
        capture(keeper, "Surviving evidence"),
      );
      archive.db.exec(
        "INSERT INTO block_fts(block_fts) VALUES('optimize'); INSERT INTO visit_fts(visit_fts) VALUES('optimize'); PRAGMA wal_checkpoint(TRUNCATE)",
      );
      expect(
        readFileSync(path).includes(Buffer.from("uniqueforgottentoken")),
      ).toBe(true);
      const exec = vi.spyOn(archive.db, "exec");
      archive.forget("personal", {
        pageId: archive.read("personal", "victim").pageId,
      });
      expect(
        exec.mock.calls.some(([sql]) => /VACUUM|optimize/u.test(sql)),
      ).toBe(false);
      expect(
        readFileSync(path).includes(Buffer.from("uniqueforgottentoken")),
      ).toBe(false);
      expect(
        readFileSync(path).includes(Buffer.from("uniqueforgottentitle")),
      ).toBe(false);
      expect(archive.search("personal", "surviving")).toHaveLength(1);
    } finally {
      archive.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("updates metadata titles and their index without changing captured snapshot titles or reviving placeholders", () => {
    const archive = new Archive(":memory:");
    try {
      const v = visit("v");
      archive.visit(v);
      archive.updateTitle({ ...v, spaceId: "wrong", title: "Intruder" });
      expect(archive.search("personal", "intruder")).toHaveLength(0);
      archive.updateTitle({ ...v, title: "New metadata title" });
      expect(archive.search("personal", "old")).toHaveLength(0);
      expect(archive.search("personal", "new")[0]?.title).toBe(
        "New metadata title",
      );
      archive.ingest(v, "saved", 1001, capture(v, "Content"));
      archive.visit(v);
      archive.updateTitle({ ...v, title: "Later title" });
      expect(archive.read("personal", "saved").title).toBe("Snapshot title");
      expect(archive.read("personal", "saved").history).toHaveLength(1);
      expect(archive.read("personal", "v:metadata").title).toBe("Later title");
      archive.forget("personal", { all: true });
      archive.updateTitle(v);
      expect(archive.stats("personal").visits).toBe(0);
    } finally {
      archive.close();
    }
  });

  it("exports through a read-only connection without calling the interactive reader", () => {
    const directory = mkdtempSync(join(tmpdir(), "watchtower-export-"));
    const path = join(directory, "archive.db");
    const archive = new Archive(path);
    let reader: Archive | undefined;
    try {
      for (let i = 0; i < 300; i++) {
        const v = visit(`v${i}`);
        archive.visit(v);
        archive.ingest(v, `o${i}`, 1001, capture(v, `Evidence ${i}`));
      }
      reader = new Archive(path, { readOnly: true });
      vi.spyOn(reader, "read").mockImplementation(() => {
        throw new Error("Unexpected full reader query");
      });
      const output = reader.export("personal", join(directory, "export"));
      expect(
        JSON.parse(readFileSync(join(output, "visits.json"), "utf8")),
      ).toHaveLength(300);
      expect(readFileSync(join(output, "snapshot-300.md"), "utf8")).toContain(
        "Evidence 299",
      );
      expect(archive.search("personal", "evidence 299")).toHaveLength(1);
    } finally {
      reader?.close();
      archive.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades a contentless-delete archive and keeps saved observations readable", () => {
    const directory = mkdtempSync(join(tmpdir(), "watchtower-upgrade-"));
    const path = join(directory, "archive.db");
    let archive = new Archive(path);
    try {
      const v = visit("v");
      archive.visit(v);
      archive.ingest(v, "saved", 1001, capture(v, "Upgrade evidence"));
      archive.db
        .exec(`DROP TRIGGER visit_search_insert; DROP TRIGGER visit_search_delete; DROP TRIGGER visit_search_update;
        DROP TABLE block_fts; DROP TABLE visit_fts;
        CREATE VIRTUAL TABLE block_fts USING fts5(body,content='',contentless_delete=1);
        CREATE VIRTUAL TABLE visit_fts USING fts5(title,url,content='',contentless_delete=1);
        PRAGMA user_version=1;`);
      archive.close();
      archive = new Archive(path);
      expect(archive.search("personal", "upgrade")).toHaveLength(1);
      expect(archive.read("personal", "saved").markdown).toContain(
        "Upgrade evidence",
      );
      archive.forget("personal", { all: true });
      expect(archive.search("personal", "upgrade")).toHaveLength(0);
    } finally {
      archive.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an excessively broad phrase scan explicitly", () => {
    const archive = new Archive(":memory:");
    try {
      for (let i = 0; i < 502; i++) {
        const v = visit(`v${i}`);
        archive.visit(v);
        archive.ingest(v, `o${i}`, 1001, capture(v, `bronze ${i} bearings`));
      }
      expect(() => archive.search("personal", '"bronze bearings"')).toThrow(
        /narrow the search/u,
      );
    } finally {
      archive.close();
    }
  });
});
