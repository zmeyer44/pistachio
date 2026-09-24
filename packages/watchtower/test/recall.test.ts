import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Archive } from "../src/archive.js";
import type {
  WatchtowerCapture,
  WatchtowerVisit,
} from "@pistachio/agent-runtime/watchtower";

const visit = (id: string, url: string, at: number, title = id, spaceId = "personal"): WatchtowerVisit => ({ id, at, spaceId, url, title });
const capture = (url: string, title: string, blocks: string[], links: WatchtowerCapture["links"] = []): WatchtowerCapture => ({
  url, title, description: "", creator: "", kind: "article", blocks, links, truncated: false,
});
const save = (archive: Archive, id: string, url: string, at: number, title: string, blocks: string[], links: WatchtowerCapture["links"] = []) => {
  const v = visit(id, url, at, title);
  archive.visit(v);
  archive.ingest(v, `o-${id}`, at + 1, capture(url, title, blocks, links));
};
const DAY = 86400000;

describe("Watchtower recall", () => {
  it("ranks the page about the words above a newer page that mentions them", () => {
    const archive = new Archive(":memory:");
    try {
      const now = Date.now();
      save(archive, "about", "https://farm.example/blight", now - 40 * DAY, "Pistachio blight: a deep dive", [
        "Pistachio blight is devastating orchards. Growers report pistachio blight across the valley.",
      ]);
      save(archive, "mention", "https://home.example/list", now - DAY, "Weekly grocery list", [
        "Buy milk, eggs, and a pistachio snack for the long drive on Saturday with the whole family.",
        "Unrelated reminder: the neighbour said tomato blight was mentioned once on the radio this week.",
      ]);
      expect(archive.search("personal", "pistachio blight").map((hit) => hit.visitId)).toEqual(["about", "mention"]);
    } finally {
      archive.close();
    }
  });

  it("completes the word being typed, matches inflections, and keeps a finished word exact", () => {
    const archive = new Archive(":memory:");
    try {
      save(archive, "a", "https://a.example/", 1000, "Orchards", ["Pistachio blights spread through the orchards."]);
      save(archive, "b", "https://b.example/", 2000, "News", ["A new newton meter arrived."]);
      expect(archive.search("personal", "pistach")).toHaveLength(1);
      expect(archive.search("personal", "blight")).toHaveLength(1);
      expect(archive.search("personal", "orchard blights")).toHaveLength(1);
      // "new" is a word the archive knows, so it is not read as "newton…".
      expect(archive.search("personal", "new").map((hit) => hit.visitId)).toEqual(["b"]);
      expect(archive.search("personal", "newt").map((hit) => hit.visitId)).toEqual(["b"]);
      // A trailing space says the word is finished.
      expect(archive.search("personal", "pistach ")).toHaveLength(0);
    } finally {
      archive.close();
    }
  });

  it("finds a windowed visit through a block it shares with a much older page", () => {
    const archive = new Archive(":memory:");
    try {
      save(archive, "old", "https://a.example/old", 1 * DAY, "Old", ["A shared boilerplate paragraph about walnut orchards."]);
      for (let i = 0; i < 20; i++) save(archive, `mid${i}`, `https://a.example/mid${i}`, 5 * DAY + i, `Mid ${i}`, [`Filler text number ${i}.`]);
      save(archive, "late", "https://a.example/late", 30 * DAY, "Late", ["A shared boilerplate paragraph about walnut orchards.", "Fresh text."]);
      const day = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
      expect(archive.search("personal", `walnut after:${day(29)} before:${day(32)}`).map((hit) => hit.visitId)).toEqual(["late"]);
      expect(archive.search("personal", `walnut after:${day(0)} before:${day(3)}`).map((hit) => hit.visitId)).toEqual(["old"]);
      expect(archive.search("personal", `walnut after:${day(10)} before:${day(12)}`)).toEqual([]);
    } finally {
      archive.close();
    }
  });

  it("treats an anchor as a place in a page and a hash route as a page", () => {
    const archive = new Archive(":memory:");
    try {
      save(archive, "top", "https://wiki.example/Pistachio", 1000, "Pistachio", ["The pistachio is a small tree."]);
      save(archive, "history", "https://wiki.example/Pistachio#History", 2000, "Pistachio", ["The pistachio is a small tree."]);
      save(archive, "inbox", "https://app.example/#/inbox", 3000, "Inbox", ["Inbox view."]);
      save(archive, "sent", "https://app.example/#/sent", 4000, "Sent", ["Sent view."]);
      const stats = archive.stats("personal");
      expect(stats.pages).toBe(3);
      expect(stats.snapshots).toBe(3);
      const opened = archive.read("personal", "o-history");
      expect(opened.url).toBe("https://wiki.example/Pistachio#History");
      expect(opened.history.map((hit) => hit.visitId).sort()).toEqual(["history", "top"]);
    } finally {
      archive.close();
    }
  });

  it("does not call a page new because its links rotated, and stores a linked address once", () => {
    const archive = new Archive(":memory:");
    try {
      const url = "https://news.example/story";
      save(archive, "first", url, 1000, "Story", ["The same story text."], [{ url: "https://news.example/more/1#top", text: "More 1" }]);
      save(archive, "second", url, 2000, "Story", ["The same story text."], [{ url: "https://news.example/more/2", text: "More 2" }]);
      save(archive, "other", "https://news.example/other", 3000, "Other", ["Another story."], [{ url: "https://news.example/more/1", text: "More 1" }]);
      expect(archive.stats("personal").snapshots).toBe(2);
      expect(archive.get<{ n: number }>("SELECT count(*) n FROM link_target")?.n).toBe(1);
      expect(archive.read("personal", "o-second").links).toEqual([{ url: "https://news.example/more/1", text: "More 1" }]);
    } finally {
      archive.close();
    }
  });

  it("keeps a visit's first dozen states and no more", () => {
    const archive = new Archive(":memory:");
    try {
      const v = visit("feed", "https://feed.example/", 1000);
      archive.visit(v);
      for (let i = 0; i < 30; i++)
        archive.ingest(v, `o${i}`, 2000 + i, capture(v.url, "Feed", [`State number ${i} of the feed.`]));
      expect(archive.get<{ n: number }>("SELECT count(*) n FROM observation")?.n).toBe(12);
    } finally {
      archive.close();
    }
  });

  it("forgets a site with its subdomains, a bounded time range, or every Space", () => {
    const archive = new Archive(":memory:");
    try {
      save(archive, "bank", "https://www.bank.example/accounts", 1000, "Accounts", ["Private balance details."]);
      save(archive, "blog", "https://blog.example/post", 2000, "Post", ["Public post text."]);
      save(archive, "later", "https://blog.example/later", 9000, "Later", ["A later post."]);
      const work = visit("work", "https://work.example/", 3000, "Work", "work");
      archive.visit(work);
      archive.ingest(work, "o-work", 3001, capture(work.url, "Work", ["Work notes."]));
      archive.learn("bank.example", [{ signature: "div#ads", keep: false, role: "advertising", source: "model", at: 1 }]);

      archive.forget("personal", { host: "bank.example" });
      expect(archive.search("personal", "balance")).toHaveLength(0);
      expect(archive.search("personal", "post")).toHaveLength(2);
      archive.forget("personal", { since: 1500, until: 5000 });
      expect(archive.search("personal", "").map((hit) => hit.visitId)).toEqual(["later"]);
      expect(archive.search("work", "notes")).toHaveLength(1);
      archive.forget("personal", { all: true, everySpace: true });
      expect(archive.search("work", "notes")).toHaveLength(0);
      for (const table of ["page", "visit", "observation", "snapshot", "manifest", "block", "link", "link_target", "rule"])
        expect(archive.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)?.n, table).toBe(0);
    } finally {
      archive.close();
    }
  });

  it("remembers layout verdicts per site, bounded, and drops them with the site", () => {
    const archive = new Archive(":memory:");
    try {
      save(archive, "v", "https://video.example/watch", 1000, "Watch", ["A video description."]);
      archive.learn("video.example", [
        { signature: "div#secondary", keep: false, role: "recommendations", source: "model", at: 5 },
        { signature: "div#description", keep: true, role: "main_content", source: "model", at: 5 },
      ]);
      archive.learn("video.example", [{ signature: "div#secondary", keep: false, role: "recommendations", source: "model", at: 9 }]);
      const rules = archive.rules("video.example");
      expect(rules).toHaveLength(2);
      expect(rules.find((rule) => rule.signature === "div#secondary")).toMatchObject({ keep: false, at: 9 });
      expect(archive.rules("elsewhere.example")).toEqual([]);
      archive.forget("personal", { host: "video.example" });
      expect(archive.rules("video.example")).toEqual([]);
    } finally {
      archive.close();
    }
  });

  it("warns before the budget is reached", () => {
    const archive = new Archive(":memory:");
    try {
      archive.configure({ maxSizeMb: 16 });
      const stats = archive.stats("personal");
      expect(stats.budgetBytes).toBe(16 * 1024 * 1024);
      expect(stats.nearFull).toBe(false);
    } finally {
      archive.close();
    }
  });

  it("upgrades a version 2 archive: hex hashes, per-snapshot link rows and unstemmed indexes", () => {
    const directory = mkdtempSync(join(tmpdir(), "watchtower-v2-"));
    const path = join(directory, "archive.db");
    try {
      // The version 2 shapes, written the way version 2 wrote them.
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE page(id INTEGER PRIMARY KEY, space_id TEXT NOT NULL, url TEXT NOT NULL, host TEXT NOT NULL, UNIQUE(space_id,url));
        CREATE TABLE visit(search_id INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, page_id INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE, url TEXT NOT NULL, title TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE TABLE snapshot(id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE, digest TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, links TEXT NOT NULL, UNIQUE(page_id,digest));
        CREATE TABLE observation(id TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES visit(id) ON DELETE CASCADE, snapshot_id INTEGER REFERENCES snapshot(id), at INTEGER NOT NULL, coverage TEXT NOT NULL);
        CREATE TABLE block(id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, body BLOB NOT NULL, codec INTEGER NOT NULL, bytes INTEGER NOT NULL);
        CREATE TABLE manifest(snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, block_id INTEGER NOT NULL REFERENCES block(id), PRIMARY KEY(snapshot_id,ordinal)) WITHOUT ROWID;
        CREATE TABLE link(snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE, url TEXT NOT NULL, PRIMARY KEY(snapshot_id,url)) WITHOUT ROWID;
        CREATE VIRTUAL TABLE block_fts USING fts5(body, content='',tokenize='unicode61');
        CREATE VIRTUAL TABLE visit_fts USING fts5(title,url,content='',tokenize='unicode61');
        INSERT INTO page VALUES(1,'personal','https://old.example/page','old.example');
        INSERT INTO visit VALUES(1,'v-old',1,'https://old.example/page','Old page',1000);
        INSERT INTO snapshot VALUES(1,1,'${"ab".repeat(32)}','Old page','article','[{"url":"https://old.example/next","text":"Next"}]');
        INSERT INTO observation VALUES('o-old','v-old',1,1001,'complete');
        INSERT INTO block VALUES(1,'${"cd".repeat(32)}',CAST('Walnut orchards were surveyed.' AS BLOB),0,30);
        INSERT INTO manifest VALUES(1,0,1);
        INSERT INTO link VALUES(1,'https://old.example/next');
        INSERT INTO block_fts(rowid,body) VALUES(1,'Walnut orchards were surveyed.');
        INSERT INTO visit_fts(rowid,title,url) VALUES(1,'Old page','https://old.example/page');
        PRAGMA user_version=2;
      `);
      old.close();
      const archive = new Archive(path);
      try {
        // Stemmed now: the singular finds the plural the old index held verbatim.
        expect(archive.search("personal", "orchard")).toHaveLength(1);
        const document = archive.read("personal", "o-old");
        expect(document.blocks).toEqual(["Walnut orchards were surveyed."]);
        expect(document.links).toEqual([{ url: "https://old.example/next", text: "Next" }]);
        expect(archive.get<{ t: string }>("SELECT typeof(hash) t FROM block")?.t).toBe("blob");
        // New captures dedupe against upgraded rows and deletion still works.
        save(archive, "new", "https://old.example/next", 5000, "Next", ["A next page."]);
        expect(archive.read("personal", "o-old").links[0]?.observationId).toBe("o-new");
        archive.forget("personal", { all: true });
        expect(archive.get<{ n: number }>("SELECT count(*) n FROM block")?.n).toBe(0);
      } finally {
        archive.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
