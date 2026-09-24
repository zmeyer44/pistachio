import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { deflateRawSync, inflateRawSync, inflateSync } from "node:zlib";
import {
  DEFAULT_WATCHTOWER_SETTINGS,
  watchtowerPageUrl,
  watchtowerSettingsSchema,
  watchtowerUrl,
  type WatchtowerCapture,
  type WatchtowerDocument,
  type WatchtowerHit,
  type WatchtowerRegionRule,
  type WatchtowerSettings,
  type WatchtowerStats,
  type WatchtowerVisit,
} from "@pistachio/agent-runtime/watchtower";
import { parseQuery, words } from "./query.js";

/** 32 raw bytes: a hex string and its unique index cost 130 bytes a block. */
const hash = (text: string): Buffer =>
  createHash("sha256").update(text).digest();
const MAX_BYTES = 256 * 1024;
/** A feed open all afternoon may change forever; a visit keeps its first dozen states. */
const MAX_OBSERVATIONS_PER_VISIT = 12;
const MAX_RULES_PER_HOST = 300;
const TOKENIZER = "porter unicode61";
const pack = (value: unknown): Buffer =>
  deflateRawSync(Buffer.from(JSON.stringify(value)), { level: 6 });
const unpack = <T>(value: Uint8Array | string): T =>
  JSON.parse(
    typeof value === "string"
      ? value
      : inflateRawSync(value, { maxOutputLength: 4 * MAX_BYTES }).toString("utf8"),
  ) as T;
const HIT = `o.id AS observationId, v.id AS visitId, p.id AS pageId,
 o.snapshot_id AS snapshotId, v.url, COALESCE(s.title,v.title) AS title,
 COALESCE(s.kind,'page') AS kind, v.at AS visitedAt, o.at AS capturedAt,
 o.coverage, '' AS snippet`;
const JOINS = `observation o JOIN visit v ON v.id=o.visit_id JOIN page p ON p.id=v.page_id
 LEFT JOIN snapshot s ON s.id=o.snapshot_id`;

/** One writer, owned by the archive process. No Electron or renderer dependencies. */
export class Archive {
  #stats = new Map<string, WatchtowerStats>();
  #spaces: string[] | null = null;
  readonly db: DatabaseSync;
  readonly path: string;
  #commits = 0;

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.path = path;
    if (path !== ":memory:" && !options.readOnly)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    if (options.readOnly) return;
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000;",
    );
    const version =
      this.get<{ user_version: number }>("PRAGMA user_version")?.user_version ??
      0;
    if (version > 3) {
      this.db.close();
      throw new Error("This Watchtower archive needs a newer Pistachio.");
    }
    if (version === 1 || version === 2) this.upgrade();
    this.db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS page(id INTEGER PRIMARY KEY, space_id TEXT NOT NULL,
        url TEXT NOT NULL, host TEXT NOT NULL, UNIQUE(space_id,url));
      CREATE TABLE IF NOT EXISTS visit(search_id INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, page_id INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
        url TEXT NOT NULL, title TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS visit_page_time ON visit(page_id,at DESC);
      CREATE INDEX IF NOT EXISTS visit_time ON visit(at DESC);
      CREATE TABLE IF NOT EXISTS snapshot(id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
        digest BLOB NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, links BLOB NOT NULL, UNIQUE(page_id,digest));
      CREATE TABLE IF NOT EXISTS observation(id TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES visit(id) ON DELETE CASCADE,
        snapshot_id INTEGER REFERENCES snapshot(id), at INTEGER NOT NULL, coverage TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS observation_visit ON observation(visit_id,at DESC);
      CREATE INDEX IF NOT EXISTS observation_snapshot ON observation(snapshot_id);
      CREATE TABLE IF NOT EXISTS block(id INTEGER PRIMARY KEY, hash BLOB NOT NULL UNIQUE,
        body BLOB NOT NULL, codec INTEGER NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manifest(snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, block_id INTEGER NOT NULL REFERENCES block(id),
        PRIMARY KEY(snapshot_id,ordinal)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS manifest_block ON manifest(block_id,snapshot_id);
      -- A linked address is stored once however many saved pages point at it.
      CREATE TABLE IF NOT EXISTS link_target(id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS link(snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES link_target(id), PRIMARY KEY(snapshot_id,target_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS link_target_snapshot ON link(target_id,snapshot_id);
      -- What a site's layout regions turned out to be; holds no page text.
      CREATE TABLE IF NOT EXISTS rule(host TEXT NOT NULL, signature TEXT NOT NULL, keep INTEGER NOT NULL,
        role TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(host,signature)) WITHOUT ROWID;
      CREATE VIRTUAL TABLE IF NOT EXISTS block_fts USING fts5(body, content='',tokenize='${TOKENIZER}');
      CREATE VIRTUAL TABLE IF NOT EXISTS visit_fts USING fts5(title,url,content='',tokenize='${TOKENIZER}');
      CREATE TRIGGER IF NOT EXISTS visit_search_insert AFTER INSERT ON visit BEGIN
        INSERT INTO visit_fts(rowid,title,url) VALUES(new.search_id,new.title,new.url);
      END;
      CREATE TRIGGER IF NOT EXISTS visit_search_delete AFTER DELETE ON visit BEGIN
        INSERT INTO visit_fts(visit_fts,rowid,title,url) VALUES('delete',old.search_id,old.title,old.url);
      END;
      CREATE TRIGGER IF NOT EXISTS visit_search_update AFTER UPDATE OF title ON visit BEGIN
        INSERT INTO visit_fts(visit_fts,rowid,title,url) VALUES('delete',old.search_id,old.title,old.url);
        INSERT INTO visit_fts(rowid,title,url) VALUES(new.search_id,new.title,new.url);
      END;
      COMMIT;
    `);
    this.db.exec(`
      INSERT INTO block_fts(block_fts,rank) VALUES('secure-delete',1);
      INSERT INTO visit_fts(visit_fts,rank) VALUES('secure-delete',1);
      PRAGMA user_version=3;
      PRAGMA temp_store=MEMORY;
      CREATE VIRTUAL TABLE temp.query_tokens USING fts5(body, content='', tokenize='${TOKENIZER}');
      CREATE VIRTUAL TABLE temp.query_vocab USING fts5vocab(temp,query_tokens,instance);
      CREATE VIRTUAL TABLE temp.block_vocab USING fts5vocab(main,block_fts,row);
      CREATE TABLE temp.doomed_block(id INTEGER PRIMARY KEY);
      CREATE TABLE temp.doomed_target(id INTEGER PRIMARY KEY);
    `);
  }

  /**
   * Versions 1 and 2 (both unreleased) to 3: binary hashes, links interned
   * and compressed, and both indexes rebuilt with the stemming tokenizer —
   * which also replaces version 1's contentless-delete tables, whose
   * tombstones cannot honor FTS secure-delete.
   */
  private upgrade(): void {
    this.transaction(() => {
      this.db.exec(`
        DROP TRIGGER IF EXISTS visit_search_insert; DROP TRIGGER IF EXISTS visit_search_delete;
        DROP TRIGGER IF EXISTS visit_search_update;
        DROP TABLE block_fts; DROP TABLE visit_fts;
        CREATE VIRTUAL TABLE block_fts USING fts5(body,content='',tokenize='${TOKENIZER}');
        CREATE VIRTUAL TABLE visit_fts USING fts5(title,url,content='',tokenize='${TOKENIZER}');
        INSERT INTO visit_fts(rowid,title,url) SELECT search_id,title,url FROM visit;
        UPDATE block SET hash=unhex(hash) WHERE typeof(hash)='text';
        UPDATE snapshot SET digest=unhex(digest) WHERE typeof(digest)='text';
      `);
      if (
        this.all<{ name: string }>("PRAGMA table_info(link)").some(
          (column) => column.name === "url",
        )
      )
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS link_target(id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE);
          INSERT OR IGNORE INTO link_target(url) SELECT DISTINCT url FROM link;
          CREATE TABLE link_v3(snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
            target_id INTEGER NOT NULL REFERENCES link_target(id), PRIMARY KEY(snapshot_id,target_id)) WITHOUT ROWID;
          INSERT OR IGNORE INTO link_v3 SELECT l.snapshot_id,t.id FROM link l JOIN link_target t ON t.url=l.url;
          DROP TABLE link;
          ALTER TABLE link_v3 RENAME TO link;
        `);
      const insert = this.db.prepare(
        "INSERT INTO block_fts(rowid,body) VALUES(?,?)",
      );
      for (const block of this.db
        .prepare("SELECT id,body,codec FROM block")
        .iterate() as unknown as Iterable<{
        id: number;
        body: Uint8Array;
        codec: number;
      }>)
        insert.run(block.id, this.decode(block));
      const repack = this.db.prepare("UPDATE snapshot SET links=? WHERE id=?");
      for (const row of this.all<{ id: number; links: string | Uint8Array }>(
        "SELECT id,links FROM snapshot",
      ))
        if (typeof row.links === "string")
          repack.run(pack(unpack(row.links)), row.id);
    });
  }

  /** Use the index's own tokenizer, including its Unicode version and diacritics rules. */
  tokenize(text: string): string[] {
    this.db.exec(
      "INSERT INTO temp.query_tokens(query_tokens) VALUES('delete-all')",
    );
    try {
      this.db
        .prepare("INSERT INTO temp.query_tokens(rowid,body) VALUES(1,?)")
        .run(text);
      return this.all<{ term: string }>(
        "SELECT term FROM temp.query_vocab ORDER BY offset",
      ).map((row) => row.term);
    } finally {
      this.db.exec(
        "INSERT INTO temp.query_tokens(query_tokens) VALUES('delete-all')",
      );
    }
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      this.#stats.clear();
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  settings(): WatchtowerSettings {
    const raw = this.get<{ value: string }>(
      "SELECT value FROM meta WHERE key='settings'",
    );
    return raw
      ? watchtowerSettingsSchema.parse(JSON.parse(raw.value) as unknown)
      : { ...DEFAULT_WATCHTOWER_SETTINGS };
  }
  configure(patch: Partial<WatchtowerSettings>): WatchtowerSettings {
    const settings = watchtowerSettingsSchema.parse({
      ...this.settings(),
      ...patch,
    });
    this.db
      .prepare("INSERT OR REPLACE INTO meta VALUES('settings',?)")
      .run(JSON.stringify(settings));
    this.#stats.clear();
    this.prune(settings.retentionDays);
    return settings;
  }
  databaseBytes(): number {
    if (this.path === ":memory:")
      return (
        (this.get<{ page_count: number }>("PRAGMA page_count")?.page_count ??
          0) * 4096
      );
    return [this.path, `${this.path}-wal`, `${this.path}-shm`].reduce(
      (n, path) => {
        try {
          return n + statSync(path).size;
        } catch {
          return n;
        }
      },
      0,
    );
  }
  hasRoom(bytes = 0): boolean {
    return (
      this.databaseBytes() -
        (this.get<{ freelist_count: number }>("PRAGMA freelist_count")
          ?.freelist_count ?? 0) *
          (this.get<{ page_size: number }>("PRAGMA page_size")?.page_size ??
            4096) +
        bytes * 3 +
        1024 * 1024 <
      this.settings().maxSizeMb * 1024 * 1024
    );
  }
  private capacity(): Pick<
    WatchtowerStats,
    "databaseBytes" | "full" | "nearFull" | "budgetBytes"
  > {
    const databaseBytes = this.databaseBytes();
    const budgetBytes = this.settings().maxSizeMb * 1024 * 1024;
    const full = !this.hasRoom();
    return {
      databaseBytes,
      budgetBytes,
      full,
      nearFull: full || databaseBytes >= budgetBytes * 0.9,
    };
  }
  /** What this site's layout regions were judged to be. Holds no page text. */
  rules(host: string): WatchtowerRegionRule[] {
    return this.all<Omit<WatchtowerRegionRule, "keep"> & { keep: number }>(
      "SELECT signature,keep,role,source,at FROM rule WHERE host=?",
      host,
    ).map((rule) => ({ ...rule, keep: rule.keep === 1 }));
  }
  learn(host: string, rules: WatchtowerRegionRule[]): void {
    if (rules.length === 0 || host.length > 253) return;
    this.transaction(() => {
      const upsert = this.db.prepare(
        "INSERT OR REPLACE INTO rule(host,signature,keep,role,source,at) VALUES(?,?,?,?,?,?)",
      );
      for (const rule of rules.slice(0, 60))
        upsert.run(
          host,
          rule.signature.slice(0, 400),
          rule.keep ? 1 : 0,
          rule.role,
          rule.source,
          rule.at,
        );
      this.db
        .prepare(
          "DELETE FROM rule WHERE host=? AND signature NOT IN (SELECT signature FROM rule WHERE host=? ORDER BY at DESC LIMIT ?)",
        )
        .run(host, host, MAX_RULES_PER_HOST);
    });
  }
  spaces(): string[] {
    return (this.#spaces ??= this.all<{ space_id: string }>(
      "SELECT DISTINCT space_id FROM page",
    ).map((row) => row.space_id));
  }
  stats(spaceId: string): WatchtowerStats {
    const count = (sql: string): number =>
      this.get<{ n: number }>(sql, spaceId)?.n ?? 0;
    const cached = this.#stats.get(spaceId);
    if (cached) return { ...cached, ...this.capacity() };
    const stats = {
      pages: count("SELECT count(*) n FROM page WHERE space_id=?"),
      visits: count(
        "SELECT count(*) n FROM visit v JOIN page p ON p.id=v.page_id WHERE p.space_id=?",
      ),
      snapshots: count(
        "SELECT count(*) n FROM snapshot s JOIN page p ON p.id=s.page_id WHERE p.space_id=?",
      ),
      blocks: count(
        "SELECT count(DISTINCT m.block_id) n FROM manifest m JOIN snapshot s ON s.id=m.snapshot_id JOIN page p ON p.id=s.page_id WHERE p.space_id=?",
      ),
      storedBytes:
        this.get<{ n: number }>(
          "SELECT COALESCE(sum(length(body)),0) n FROM block WHERE id IN (SELECT m.block_id FROM manifest m JOIN snapshot s ON s.id=m.snapshot_id JOIN page p ON p.id=s.page_id WHERE p.space_id=?)",
          spaceId,
        )?.n ?? 0,
      logicalBytes:
        this.get<{ n: number }>(
          "SELECT COALESCE(sum(b.bytes),0) n FROM manifest m JOIN block b ON b.id=m.block_id JOIN snapshot s ON s.id=m.snapshot_id JOIN page p ON p.id=s.page_id WHERE p.space_id=?",
          spaceId,
        )?.n ?? 0,
      ...this.capacity(),
    };
    if (this.#stats.size >= 32) this.#stats.clear();
    this.#stats.set(spaceId, stats);
    return stats;
  }
  updateTitle(visit: WatchtowerVisit): void {
    this.db
      .prepare(
        `UPDATE visit SET title=? WHERE id=? AND page_id IN
      (SELECT id FROM page WHERE space_id=? AND url=?) AND title!=?`,
      )
      .run(
        visit.title.slice(0, 500),
        visit.id,
        visit.spaceId,
        watchtowerPageUrl(visit.url) ?? "",
        visit.title.slice(0, 500),
      );
  }
  visit(visit: WatchtowerVisit): void {
    const url = watchtowerUrl(visit.url);
    // An anchor is a place in a page, not another page: the visit keeps the
    // address as visited, the page is the address without it.
    const pageUrl = watchtowerPageUrl(visit.url);
    if (!url || !pageUrl || !this.hasRoom()) return;
    this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO page(space_id,url,host) VALUES(?,?,?)")
        .run(visit.spaceId, pageUrl, new URL(pageUrl).hostname);
      const page = this.get<{ id: number }>(
        "SELECT id FROM page WHERE space_id=? AND url=?",
        visit.spaceId,
        pageUrl,
      )!;
      this.db
        .prepare(
          "INSERT OR IGNORE INTO visit(id,page_id,url,title,at) VALUES(?,?,?,?,?)",
        )
        .run(visit.id, page.id, url, visit.title.slice(0, 500), visit.at);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO observation SELECT ?,?,NULL,?,'metadata' WHERE NOT EXISTS (SELECT 1 FROM observation WHERE visit_id=?)",
        )
        .run(`${visit.id}:metadata`, visit.id, visit.at, visit.id);
    });
    if (this.#spaces && !this.#spaces.includes(visit.spaceId))
      this.#spaces.push(visit.spaceId);
  }
  ingest(
    visit: WatchtowerVisit,
    id: string,
    at: number,
    capture: WatchtowerCapture,
  ): void {
    if (watchtowerPageUrl(capture.url) !== watchtowerPageUrl(visit.url)) return;
    const existingVisit = this.get<{ page_id: number; space_id: string }>(
      "SELECT v.page_id,p.space_id FROM visit v JOIN page p ON p.id=v.page_id WHERE v.id=?",
      visit.id,
    );
    if (!existingVisit || existingVisit.space_id !== visit.spaceId) return; // forgotten or stale job
    if (this.get("SELECT id FROM observation WHERE id=?", id)) return;
    if (
      (this.get<{ n: number }>(
        "SELECT count(*) n FROM observation WHERE visit_id=?",
        visit.id,
      )?.n ?? 0) >= MAX_OBSERVATIONS_PER_VISIT
    )
      return;
    const title = capture.title.slice(0, 500);
    const line = (label: string, value: string | undefined, max: number) =>
      value?.trim() ? `${label}: ${value.trim().replace(/\s+/gu, " ").slice(0, max)}` : "";
    const card = [
      `# ${title.replace(/[\r\n]/gu, " ")}`,
      capture.description.slice(0, 3000),
      [
        line("Creator", capture.creator, 300),
        line("Published", capture.published, 40),
        line("Duration", capture.duration, 40),
      ]
        .filter(Boolean)
        .join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n");
    const blocks = [card, ...capture.blocks.slice(0, 1500)].filter(
      (block) => block.trim() !== "",
    );
    const bytes = blocks.reduce((n, text) => n + Buffer.byteLength(text), 0);
    if (bytes > MAX_BYTES || !this.hasRoom(bytes)) return;
    const seen = new Set<string>();
    const links = capture.links.slice(0, 300).flatMap((link) => {
      // A link names a page, so `#section` links resolve to the saved page.
      const url = watchtowerPageUrl(link.url);
      if (!url || seen.has(url)) return [];
      seen.add(url);
      return [{ url, text: link.text.slice(0, 300) }];
    });
    const coverage = capture.truncated ? "partial" : "complete";
    // Links are not part of a version's identity: a rotating "more stories"
    // list under unchanged text is the same document.
    const digest = hash(JSON.stringify([2, capture.kind, coverage, blocks]));
    this.transaction(() => {
      let snapshotId = this.get<{ id: number }>(
        "SELECT id FROM snapshot WHERE page_id=? AND digest=?",
        existingVisit.page_id,
        digest,
      )?.id;
      if (snapshotId === undefined) {
        snapshotId = Number(
          this.db
            .prepare(
              "INSERT INTO snapshot(page_id,digest,title,kind,links) VALUES(?,?,?,?,?)",
            )
            .run(
              existingVisit.page_id,
              digest,
              title,
              capture.kind,
              pack(links),
            ).lastInsertRowid,
        );
        const find = this.db.prepare(
          "SELECT id,body,codec FROM block WHERE hash=?",
        );
        const addBlock = this.db.prepare(
          "INSERT INTO block(hash,body,codec,bytes) VALUES(?,?,?,?)",
        );
        const index = this.db.prepare(
          "INSERT INTO block_fts(rowid,body) VALUES(?,?)",
        );
        const list = this.db.prepare("INSERT INTO manifest VALUES(?,?,?)");
        for (const [ordinal, text] of blocks.entries()) {
          const key = hash(`1:${text}`);
          let block = find.get(key) as unknown as
            | { id: number; body: Uint8Array; codec: number }
            | undefined;
          if (block) {
            if (this.decode(block) !== text)
              throw new Error("Archive content hash mismatch.");
          } else {
            const raw = Buffer.from(text);
            const compressed = deflateRawSync(raw, { level: 6 });
            const codec = compressed.length < raw.length ? 2 : 0;
            const body = codec ? compressed : raw;
            const blockId = Number(
              addBlock.run(key, body, codec, raw.length).lastInsertRowid,
            );
            index.run(blockId, text);
            block = { id: blockId, body, codec };
          }
          list.run(snapshotId, ordinal, block.id);
        }
        const target = this.db.prepare(
          "INSERT OR IGNORE INTO link_target(url) VALUES(?)",
        );
        const point = this.db.prepare(
          "INSERT OR IGNORE INTO link SELECT ?,id FROM link_target WHERE url=?",
        );
        for (const link of links) {
          target.run(link.url);
          point.run(snapshotId, link.url);
        }
      }
      const latest = this.get<{ snapshot_id: number }>(
        "SELECT snapshot_id FROM observation WHERE visit_id=? ORDER BY at DESC,id DESC LIMIT 1",
        visit.id,
      );
      if (latest?.snapshot_id === snapshotId) return;
      this.db
        .prepare("DELETE FROM observation WHERE id=? AND snapshot_id IS NULL")
        .run(`${visit.id}:metadata`);
      this.db
        .prepare("INSERT INTO observation VALUES(?,?,?,?,?)")
        .run(id, visit.id, snapshotId, at, coverage);
    });
    if (++this.#commits % 50 === 0) {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.prune(this.settings().retentionDays);
    }
  }
  decode(block: { body: Uint8Array; codec: number }): string {
    return (
      block.codec === 2
        ? inflateRawSync(block.body, { maxOutputLength: MAX_BYTES })
        : block.codec === 1
          ? inflateSync(block.body, { maxOutputLength: MAX_BYTES })
          : Buffer.from(block.body)
    ).toString("utf8");
  }
  blocks(id: number): string[] {
    return this.all<{ body: Uint8Array; codec: number }>(
      "SELECT b.body,b.codec FROM manifest m JOIN block b ON b.id=m.block_id WHERE m.snapshot_id=? ORDER BY m.ordinal",
      id,
    ).map((block) => this.decode(block));
  }
  search(
    spaceId: string,
    input: string,
    offset = 0,
    broad = false,
    limit = 50,
  ): WatchtowerHit[] {
    const query = parseQuery(input, (text) => this.tokenize(text));
    if (broad && query.phrases.length === 0) {
      const filler = new Set([
        "a",
        "an",
        "the",
        "i",
        "my",
        "me",
        "that",
        "this",
        "those",
        "was",
        "were",
        "is",
        "it",
        "about",
        "of",
        "and",
        "or",
        "to",
        "for",
        "on",
        "in",
        "saw",
        "remember",
        "find",
        "something",
      ]);
      const distinctive = query.terms.filter((term) => !filler.has(term));
      if (distinctive.length) query.terms = distinctive;
    }
    const terms = query.terms
      .map((term) => {
        // How many blocks hold the word.
        const docs =
          this.get<{ doc: number }>(
            "SELECT doc FROM temp.block_vocab WHERE term=?",
            term,
          )?.doc ?? 0;
        // The word still being typed completes to whatever it begins —
        // unless it already is a word the archive knows ("new" is not
        // "newton"), which keeps a finished query exact.
        const open = term === query.prefix && docs === 0;
        return {
          term,
          match: open ? `"${term}"*` : `"${term}"`,
          docs: open ? Number.MAX_SAFE_INTEGER : docs,
        };
      })
      .sort((a, b) => a.docs - b.docs);
    // A word in a quarter of everything saved tells pages apart no better
    // than "the" does, and reading its whole posting list is the one slow
    // thing a search can do. Beside a more telling word, it is dropped.
    const blockCount =
      this.get<{ n: number | null }>("SELECT max(id) n FROM block")?.n ?? 0;
    if (query.phrases.length === 0 && blockCount > 2000)
      while (
        terms.length > 1 &&
        terms[terms.length - 1]!.docs !== Number.MAX_SAFE_INTEGER &&
        terms[terms.length - 1]!.docs > blockCount * 0.25
      )
        terms.pop();
    const where = ["p.space_id=?", "v.at>=?", "v.at<?"];
    const scope: SQLInputValue[] = [spaceId, query.after, query.before];
    if (query.host) {
      where.push("(p.host=? OR p.host LIKE ? ESCAPE '\\')");
      scope.push(query.host, `%.${query.host.replace(/[\\%_]/gu, "\\$&")}`);
    }
    if (query.kind) {
      where.push("s.kind=?");
      scope.push(query.kind);
    }
    // Best block per word, summed: a page ABOUT the words outranks a page
    // that mentions them, and a long page is not rewarded for its length.
    // (`rank` is FTS5's bm25 as a column; the bm25() function cannot be used
    // under a join and GROUP BY. One pass per word is the whole cost —
    // correlated per-page probes were measured at ~36 ms EACH.)
    //
    // Block ids are chronological, and FTS5 can confine a match to a rowid
    // range without reading the rest of a posting list. So a date window is
    // pushed down as the range of blocks its visits used, and a query made
    // only of near-universal words is matched against recent content.
    let range: [number, number] | null = null;
    const windowed = query.after > 0 || query.before < 8640000000000000;
    if (terms.length && windowed) {
      const inWindow =
        this.get<{ n: number }>(
          "SELECT count(*) n FROM (SELECT 1 FROM visit WHERE at>=? AND at<? LIMIT 5001)",
          query.after,
          query.before,
        )?.n ?? 5001;
      if (inWindow <= 5000) {
        const span = this.get<{ lo: number | null; hi: number | null }>(
          `SELECT min(m.block_id) lo,max(m.block_id) hi FROM visit v JOIN observation o ON o.visit_id=v.id
           JOIN manifest m ON m.snapshot_id=o.snapshot_id WHERE v.at>=? AND v.at<?`,
          query.after,
          query.before,
        );
        range = [span?.lo ?? 0, span?.hi ?? -1];
      }
    } else if (
      terms.length &&
      query.phrases.length === 0 &&
      blockCount > 100000 &&
      terms.every((term) => term.docs > blockCount * 0.25)
    )
      range = [blockCount - 60000, blockCount];
    const cteParams: SQLInputValue[] = [];
    let cte = "";
    if (terms.length) {
      cte = `WITH term_hits AS (${terms
        .map((term, i) => {
          cteParams.push(term.match);
          if (range) cteParams.push(range[0], range[1]);
          return `SELECT m.snapshot_id, ${i} term, -f.rank score FROM block_fts f JOIN manifest m ON m.block_id=f.rowid WHERE f.block_fts MATCH ?${range ? " AND f.rowid BETWEEN ? AND ?" : ""}`;
        })
        .join(
          " UNION ALL ",
        )}), per_term AS (SELECT snapshot_id,term,max(score) best FROM term_hits GROUP BY snapshot_id,term),
        matches AS (SELECT snapshot_id,count(*) relevance,sum(best) score FROM per_term GROUP BY snapshot_id HAVING count(*)>=${broad ? 1 : terms.length})`;
    }
    const selectParams: SQLInputValue[] = [];
    let weight = "0.0";
    if (terms.length) {
      // Words in the title count for more than words in passing; recency
      // only separates results the text cannot.
      weight = `COALESCE(mt.score,0)${terms
        .map((term) => {
          selectParams.push(term.term);
          return "+3.0*(instr(lower(COALESCE(s.title,v.title)),?)>0)";
        })
        .join("")}+2.0/(1.0+max(0,?-v.at)/2592000000.0)`;
      selectParams.push(Date.now());
    }
    const filter = [...where];
    const filterParams = [...scope];
    if (terms.length) {
      filter.push(
        "(mt.snapshot_id IS NOT NULL OR (o.snapshot_id IS NULL AND v.search_id IN (SELECT rowid FROM visit_fts WHERE visit_fts MATCH ?)))",
      );
      filterParams.push(
        terms.map((term) => term.match).join(broad ? " OR " : " AND "),
      );
    }
    const joins = `${JOINS}${terms.length ? " LEFT JOIN matches mt ON mt.snapshot_id=o.snapshot_id" : ""}`;
    // Rank historical observations within each visit AFTER applying content/date scope.
    const order = terms.length
      ? `${broad ? "relevance DESC," : ""}weight DESC,`
      : "";
    const sql = `${cte} SELECT * FROM (SELECT ${HIT}, ROW_NUMBER() OVER (PARTITION BY v.id ORDER BY o.at DESC,o.id DESC) rn, ${weight} weight${terms.length ? ", COALESCE(mt.relevance,0) relevance" : ""}
      FROM ${joins} WHERE ${filter.join(" AND ")}) WHERE rn=1 ORDER BY ${order}visitedAt DESC,visitId DESC LIMIT ? OFFSET ?`;
    const params = [...cteParams, ...selectParams, ...filterParams];
    const results: WatchtowerHit[] = [];
    // Phrase verification spans blocks and uses SQLite tokenization. Refuse overly broad
    // phrase scans explicitly instead of returning a silently incomplete result.
    const phraseSql = `${cte} SELECT ${HIT} FROM ${joins} WHERE ${filter.join(" AND ")} ORDER BY v.at DESC,v.id DESC,o.at DESC,o.id DESC`;
    const candidates = query.phrases.length
      ? (this.db
          .prepare(phraseSql)
          .iterate(...cteParams, ...filterParams) as unknown as Iterable<WatchtowerHit>)
      : this.all<WatchtowerHit>(sql, ...params, limit, offset);
    const seen = new Set<string>();
    let skipped = 0;
    let verifiedBytes = 0;
    const phraseMatches = new Map<number | string, boolean>();
    const started = performance.now();
    let examined = 0;
    for (const hit of candidates) {
      if (
        query.phrases.length &&
        (++examined > 10000 || performance.now() - started > 1000)
      )
        throw new Error(
          "This phrase matches too much content. Add site: or date filters to narrow the search.",
        );
      if (seen.has(hit.visitId)) continue;
      const knownMatch = phraseMatches.get(hit.snapshotId ?? hit.visitId);
      if (knownMatch === false) continue;
      if (knownMatch === true && skipped < offset) {
        seen.add(hit.visitId);
        skipped++;
        continue;
      }
      const blocks =
        hit.snapshotId === null
          ? [hit.title, hit.url]
          : this.blocks(hit.snapshotId);
      if (query.phrases.length) {
        const key = hit.snapshotId ?? hit.visitId;
        let matches = phraseMatches.get(key);
        if (matches === undefined) {
          verifiedBytes += blocks.reduce(
            (n, block) => n + Buffer.byteLength(block),
            0,
          );
          if (
            phraseMatches.size >= 500 ||
            verifiedBytes > 16 * 1024 * 1024 ||
            performance.now() - started > 1000
          )
            throw new Error(
              "This phrase matches too much content. Add site: or date filters to narrow the search.",
            );
          const tokens = ` ${this.tokenize(blocks.join(" ")).join(" ")} `;
          matches = query.phrases.every((phrase) =>
            tokens.includes(` ${phrase} `),
          );
          phraseMatches.set(key, matches);
        }
        if (!matches) continue;
      }
      seen.add(hit.visitId);
      if (query.phrases.length && skipped++ < offset) continue;
      // The block that says the most of what was asked, not the first to say any.
      let best =
        blocks[1] ?? blocks[0] ?? "Content was not captured for this visit.";
      let bestCount = 0;
      for (const block of blocks) {
        const found = words(block);
        const count = query.terms.filter((term) =>
          found.some((word) => word.startsWith(term)),
        ).length;
        if (count > bestCount) {
          best = block;
          bestCount = count;
        }
        if (count === query.terms.length) break;
      }
      const lower = best.toLowerCase();
      const first =
        query.terms
          .map((term) => lower.indexOf(term))
          .filter((n) => n >= 0)
          .sort((a, b) => a - b)[0] ?? 0;
      const start = Math.max(0, first - 80);
      hit.snippet = `${start ? "…" : ""}${best.slice(start, start + 280).replace(/\s+/gu, " ")}${best.length > start + 280 ? "…" : ""}`;
      const extra = hit as unknown as Record<string, unknown>;
      delete extra["rn"];
      delete extra["weight"];
      delete extra["relevance"];
      results.push(hit);
      if (results.length === limit) break;
    }
    return results;
  }
  read(spaceId: string, observationId: string): WatchtowerDocument {
    let hit = this.get<WatchtowerHit>(
      `SELECT ${HIT} FROM ${JOINS} WHERE p.space_id=? AND o.id=?`,
      spaceId,
      observationId,
    );
    // A metadata link may have been copied before extraction completed. Its
    // immutable visit record remains a valid source even after the placeholder
    // observation is replaced by substantive content.
    if (!hit && observationId.endsWith(":metadata")) {
      hit = this.get<WatchtowerHit>(
        `SELECT ? observationId,v.id visitId,p.id pageId,NULL snapshotId,v.url,v.title,'page' kind,v.at visitedAt,v.at capturedAt,'metadata' coverage,'' snippet
        FROM visit v JOIN page p ON p.id=v.page_id WHERE p.space_id=? AND v.id=?`,
        observationId,
        spaceId,
        observationId.slice(0, -9),
      );
    }
    if (!hit)
      throw Object.assign(
        new Error("This saved visit was removed or belongs to another Space."),
        { code: "NOT_FOUND" },
      );
    const blocks = hit.snapshotId === null ? [] : this.blocks(hit.snapshotId);
    const links =
      hit.snapshotId === null
        ? []
        : unpack<WatchtowerDocument["links"]>(
            this.get<{ links: Uint8Array | string }>(
              "SELECT links FROM snapshot WHERE id=?",
              hit.snapshotId,
            )!.links,
          );
    for (const link of links) {
      const saved = this.get<{ id: string }>(
        `SELECT o.id FROM ${JOINS} WHERE p.space_id=? AND p.url=? AND o.snapshot_id IS NOT NULL
        ORDER BY (v.at<=?) DESC,v.at DESC,o.at DESC,o.id DESC LIMIT 1`,
        spaceId,
        link.url,
        hit.visitedAt,
      );
      if (saved) link.observationId = saved.id;
    }
    const history = this.all<WatchtowerHit>(
      `SELECT ${HIT} FROM ${JOINS} WHERE p.space_id=? AND p.id=? ORDER BY o.at DESC,o.id DESC LIMIT 100`,
      spaceId,
      hit.pageId,
    );
    if (!history.some((item) => item.observationId === hit.observationId))
      history.push(hit);
    const pointing =
      "SELECT l.snapshot_id FROM link l JOIN link_target t ON t.id=l.target_id WHERE t.url=?";
    const pageUrl =
      this.get<{ url: string }>("SELECT url FROM page WHERE id=?", hit.pageId)
        ?.url ?? hit.url;
    const backlinks = this.all<WatchtowerHit>(
      `SELECT ${HIT} FROM ${JOINS} WHERE p.space_id=? AND p.id!=?
      AND o.snapshot_id IN (${pointing}) AND o.id=(SELECT o2.id FROM observation o2 JOIN visit v2 ON v2.id=o2.visit_id WHERE v2.page_id=p.id AND o2.snapshot_id IN (${pointing}) ORDER BY v2.at DESC,o2.at DESC,o2.id DESC LIMIT 1) ORDER BY v.at DESC LIMIT 30`,
      spaceId,
      hit.pageId,
      pageUrl,
      pageUrl,
    );

    return {
      ...hit,
      blocks,
      links,
      history,
      backlinks,
      markdown: markdown(hit, blocks),
    };
  }
  diff(spaceId: string, beforeId: string, afterId: string) {
    const before = this.read(spaceId, beforeId);
    const after = this.read(spaceId, afterId);
    if (before.pageId !== after.pageId)
      throw new Error("Choose two observations of the same page.");
    // Keep ordering and repeated occurrences: trim common prefix/suffix, show changed region.
    let start = 0;
    while (
      start < before.blocks.length &&
      start < after.blocks.length &&
      before.blocks[start] === after.blocks[start]
    )
      start++;
    let endBefore = before.blocks.length,
      endAfter = after.blocks.length;
    while (
      endBefore > start &&
      endAfter > start &&
      before.blocks[endBefore - 1] === after.blocks[endAfter - 1]
    ) {
      endBefore--;
      endAfter--;
    }
    const source = ({
      markdown: _markdown,
      blocks: _blocks,
      history: _history,
      links: _links,
      backlinks: _backlinks,
      ...hit
    }: WatchtowerDocument): WatchtowerHit => hit;
    return {
      before: source(before),
      after: source(after),
      removed: before.blocks.slice(start, endBefore),
      added: after.blocks.slice(start, endAfter),
    };
  }
  forget(
    spaceId: string,
    options: {
      pageId?: number;
      host?: string;
      since?: number;
      until?: number;
      all?: boolean;
      everySpace?: boolean;
    },
  ): void {
    if (
      !options.all &&
      options.pageId === undefined &&
      options.host === undefined &&
      options.since === undefined &&
      options.until === undefined
    )
      throw new Error("Choose a page, site, time range, or all visits to forget.");
    this.transaction(() => {
      const pages = ["1=1"];
      const params: SQLInputValue[] = [];
      if (!(options.all && options.everySpace)) {
        pages.push("space_id=?");
        params.push(spaceId);
      }
      if (options.host !== undefined) {
        pages.push("(host=? OR host LIKE ? ESCAPE '\\')");
        params.push(
          options.host,
          `%.${options.host.replace(/[\\%_]/gu, "\\$&")}`,
        );
      }
      const where = [`page_id IN (SELECT id FROM page WHERE ${pages.join(" AND ")})`];
      if (options.pageId !== undefined) {
        where.push("page_id=?");
        params.push(options.pageId);
      }
      if (options.since !== undefined) {
        where.push("at>=?");
        params.push(options.since);
      }
      if (options.until !== undefined) {
        where.push("at<?");
        params.push(options.until);
      }
      this.db
        .prepare(`DELETE FROM visit WHERE ${where.join(" AND ")}`)
        .run(...params);
      this.collect();
    });
    this.#spaces = null;
    this.purgeIndex();
  }
  /**
   * Retention removes the saved TEXT of old visits and keeps the visit: old
   * history thins into ordinary history (title, address, date, marked
   * expired) instead of vanishing.
   */
  prune(days: number, now = Date.now()): void {
    if (days <= 0) return;
    const cutoff = now - days * 86400000;
    if (
      !this.get(
        "SELECT 1 FROM observation o JOIN visit v ON v.id=o.visit_id WHERE v.at<? AND o.snapshot_id IS NOT NULL LIMIT 1",
        cutoff,
      )
    )
      return;
    this.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM observation WHERE snapshot_id IS NOT NULL AND visit_id IN (SELECT id FROM visit WHERE at<?)",
        )
        .run(cutoff);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO observation SELECT id||':metadata',id,NULL,at,'expired' FROM visit
           WHERE at<? AND NOT EXISTS(SELECT 1 FROM observation WHERE visit_id=visit.id)`,
        )
        .run(cutoff);
      this.collect();
    });
    this.purgeIndex();
  }
  /**
   * Removes what nothing refers to any more. It looks only at what the
   * orphaned versions used — never a scan of every block in the archive.
   */
  collect(): void {
    this.db.exec(`
      DELETE FROM temp.doomed_block; DELETE FROM temp.doomed_target;
      INSERT OR IGNORE INTO temp.doomed_block SELECT m.block_id FROM manifest m
        WHERE m.snapshot_id IN (SELECT id FROM snapshot WHERE NOT EXISTS(SELECT 1 FROM observation WHERE snapshot_id=snapshot.id));
      INSERT OR IGNORE INTO temp.doomed_target SELECT l.target_id FROM link l
        WHERE l.snapshot_id IN (SELECT id FROM snapshot WHERE NOT EXISTS(SELECT 1 FROM observation WHERE snapshot_id=snapshot.id));
      DELETE FROM snapshot WHERE NOT EXISTS(SELECT 1 FROM observation WHERE snapshot_id=snapshot.id);
      DELETE FROM temp.doomed_block WHERE EXISTS(SELECT 1 FROM manifest WHERE block_id=doomed_block.id);
      DELETE FROM temp.doomed_target WHERE EXISTS(SELECT 1 FROM link WHERE target_id=doomed_target.id);
    `);
    const unindex = this.db.prepare(
      "INSERT INTO block_fts(block_fts,rowid,body) VALUES('delete',?,?)",
    );
    for (const block of this.all<{ id: number; body: Uint8Array; codec: number }>(
      "SELECT id,body,codec FROM block WHERE id IN (SELECT id FROM temp.doomed_block)",
    ))
      unindex.run(block.id, this.decode(block));
    this.db.exec(`
      DELETE FROM block WHERE id IN (SELECT id FROM temp.doomed_block);
      DELETE FROM link_target WHERE id IN (SELECT id FROM temp.doomed_target);
      DELETE FROM page WHERE NOT EXISTS(SELECT 1 FROM visit WHERE page_id=page.id);
      DELETE FROM rule WHERE host NOT IN (SELECT host FROM page);
      DELETE FROM temp.doomed_block; DELETE FROM temp.doomed_target;
    `);
  }
  purgeIndex(): void {
    // Both FTS secure-delete and core secure_delete remove old entries in-place.
    // Freed pages are reused; never rewrite the whole archive to compact a deletion.
    // Checkpoint failure must not misreport a committed Forget as a failed operation.
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* retry on close/next maintenance */
    }
  }
  export(spaceId: string, directory: string): string {
    this.db.exec("BEGIN");
    try {
      return this.exportSnapshot(spaceId, directory);
    } finally {
      this.db.exec("ROLLBACK");
    }
  }
  private exportSnapshot(spaceId: string, directory: string): string {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const visits = this.all<WatchtowerHit>(
      `SELECT ${HIT} FROM ${JOINS} WHERE p.space_id=? ORDER BY v.at,o.at,o.id`,
      spaceId,
    );
    const files = new Map<number, string>();
    const index = [
      "# Watchtower",
      "",
      "Saved content and visit provenance. Dates are UTC. Each version is complete; visits.json records every observation.",
      "",
    ];
    const snapshots = new Map<number, WatchtowerHit>();
    for (const hit of visits)
      if (hit.snapshotId !== null && !snapshots.has(hit.snapshotId)) {
        snapshots.set(hit.snapshotId, hit);
        files.set(hit.snapshotId, `snapshot-${hit.snapshotId}.md`);
      }
    // Resolve the wiki graph in bulk, without the reader's per-link queries,
    // historical timeline, or backlinks query for every exported version.
    const byUrl = new Map<string, WatchtowerHit[]>();
    for (const hit of visits)
      if (hit.snapshotId !== null) {
        const key = watchtowerPageUrl(hit.url) ?? hit.url;
        const list = byUrl.get(key) ?? [];
        list.push(hit);
        byUrl.set(key, list);
      }
    const resolveLink = (
      url: string,
      at: number,
    ): WatchtowerHit | undefined => {
      const list = byUrl.get(url);
      if (!list?.length) return undefined;
      let lo = 0,
        hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (list[mid]!.visitedAt <= at) lo = mid + 1;
        else hi = mid;
      }
      return list[lo ? lo - 1 : list.length - 1];
    };
    const linksBySnapshot = new Map(
      this.all<{ id: number; links: Uint8Array | string }>(
        "SELECT s.id,s.links FROM snapshot s JOIN page p ON p.id=s.page_id WHERE p.space_id=?",
        spaceId,
      ).map((row) => [
        row.id,
        unpack<WatchtowerDocument["links"]>(row.links),
      ]),
    );
    const incoming = new Map<string, Map<number, WatchtowerHit>>();
    for (const hit of visits)
      if (hit.snapshotId !== null) {
        for (const link of linksBySnapshot.get(hit.snapshotId) ?? []) {
          const pages =
            incoming.get(link.url) ?? new Map<number, WatchtowerHit>();
          pages.set(hit.pageId, hit);
          incoming.set(link.url, pages);
        }
      }
    const label = (value: string): string =>
      value.replace(/[\]\\\r\n[]/gu, " ");
    for (const [snapshotId, hit] of snapshots) {
      const file = files.get(snapshotId)!;
      const links = (linksBySnapshot.get(snapshotId) ?? []).map((link) => {
        const target = resolveLink(link.url, hit.visitedAt);
        const saved = target?.snapshotId
          ? files.get(target.snapshotId)
          : undefined;
        return `- [${label(link.text || link.url)}](<${saved ?? link.url.replace(/>/gu, "%3E")}>)${saved ? " · saved version" : " · live source"}`;
      });
      const backlinks = [
        ...(incoming.get(watchtowerPageUrl(hit.url) ?? hit.url)?.values() ?? []),
      ]
        .filter((backlink) => backlink.pageId !== hit.pageId)
        .flatMap((backlink) => {
          const saved = backlink.snapshotId
            ? files.get(backlink.snapshotId)
            : undefined;
          return saved ? [`- [${label(backlink.title)}](${saved})`] : [];
        });
      writeFileSync(
        join(directory, file),
        markdown(hit, this.blocks(snapshotId)) +
          (links.length
            ? "\n## Linked pages\n\n" + links.join("\n") + "\n"
            : "") +
          (backlinks.length
            ? "\n## Referenced by\n\n" + backlinks.join("\n") + "\n"
            : ""),
        { mode: 0o600 },
      );
      index.push(`- [${label(hit.title)}](${file})`);
    }
    writeFileSync(join(directory, "index.md"), index.join("\n") + "\n", {
      mode: 0o600,
    });
    writeFileSync(
      join(directory, "visits.json"),
      JSON.stringify(
        visits.map((hit) => ({
          ...hit,
          file: hit.snapshotId === null ? null : files.get(hit.snapshotId),
        })),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return directory;
  }
  close(): void {
    this.db.close();
  }
}

function markdown(hit: WatchtowerHit, blocks: string[]): string {
  const front = `---\ntitle: ${JSON.stringify(hit.title)}\nsource: ${JSON.stringify(hit.url)}\nvisited: ${JSON.stringify(new Date(hit.visitedAt).toISOString())}\ncaptured: ${JSON.stringify(new Date(hit.capturedAt).toISOString())}\ncoverage: ${hit.coverage}\n---\n\n`;
  return (
    front +
    (blocks.length
      ? blocks.join("\n\n")
      : hit.coverage === "expired"
        ? "The saved text of this visit expired under the retention setting."
        : "Content was not captured for this visit.") +
    "\n"
  );
}
