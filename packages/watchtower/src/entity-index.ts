import type { SQLInputValue, StatementResultingChanges } from "node:sqlite";
import { inflateRawSync } from "node:zlib";
import {
  WATCHTOWER_ENTITY_KINDS,
  WATCHTOWER_FACT_KINDS,
  WATCHTOWER_SAVED_ROLE_SALIENCE,
  type WatchtowerEntity,
  type WatchtowerEntityDecision,
  type WatchtowerEntityDocument,
  type WatchtowerEntityKind,
  type WatchtowerEntityRef,
  type WatchtowerFactKind,
  type WatchtowerHit,
  type WatchtowerIndex,
  type WatchtowerIndexCandidate,
  type WatchtowerIndexJob,
  type WatchtowerKnownEntity,
  type WatchtowerSavedEntity,
  type WatchtowerSettings,
  type WatchtowerSubject,
} from "@pistachio/agent-runtime/watchtower";
import { entityKey, findCandidates, keyTokens } from "./entities.js";

/**
 * The index: what saved pages are ABOUT, as objects that persist across
 * sites. Stripe's pricing page, a TechCrunch story and a podcast transcript
 * all mention one Company("Stripe"); the index holds that entry once, with
 * every page it was named on (`mention`), every way it was written
 * (`entity_alias`) and the sentences pages wrote about it (`fact`).
 *
 * Everything here is DERIVED from saved versions and forgotten with them:
 * mentions and facts cascade from their snapshot, and an entry nothing
 * mentions any more is removed. Saved text is never changed by it.
 *
 * A saved version is indexed in steps (`snapshot.understood`):
 *   0 → 1  at capture, locally: only what the page settles by itself
 *          (declared structured data, a repository, a search);
 *   1 → 2  later, when the person allows it: the decision model sorts the
 *          names in the page's text and matches them to existing entries;
 *   → 3    when the person saves the page on purpose (shift, shift): a
 *          language model reads it for everything it is about, and that
 *          reading is merged in and never replaced by a later pass.
 */

/** The structure SQLite gives back for a hit; see `archive.ts`. */
const HIT = `o.id AS observationId, v.id AS visitId, p.id AS pageId,
 o.snapshot_id AS snapshotId, v.url, COALESCE(s.title,v.title) AS title,
 COALESCE(s.kind,'page') AS kind, v.at AS visitedAt, o.at AS capturedAt,
 o.coverage, '' AS snippet, (p.kept_key IS NOT NULL) AS kept`;
const FACT_ORDER: Record<WatchtowerFactKind, number> = {
  definition: 0,
  metric: 1,
  price: 2,
  event: 3,
  claim: 4,
};
/** Known entries offered per name; the decision model reads each one's description. */
const MAX_KNOWN = 4;
/** Saved versions indexed locally per backlog pass, and scanned per model job. */
const LOCAL_BATCH = 20;
const SCAN = 2000;

export interface IndexHost {
  all<T>(sql: string, ...params: SQLInputValue[]): T[];
  run(sql: string, ...params: SQLInputValue[]): StatementResultingChanges;
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined;
  transaction<T>(work: () => T): T;
  blocks(snapshotId: number): string[];
  settings(): WatchtowerSettings;
}

const isKind = (value: unknown): value is WatchtowerEntityKind =>
  typeof value === "string" &&
  (WATCHTOWER_ENTITY_KINDS as readonly string[]).includes(value);
const isFactKind = (value: unknown): value is WatchtowerFactKind =>
  typeof value === "string" &&
  (WATCHTOWER_FACT_KINDS as readonly string[]).includes(value);
const placeholders = (n: number): string => Array(n).fill("?").join(",");

export class EntityIndex {
  constructor(private readonly archive: IndexHost) {}

  /* ------------------------------ building jobs ----------------------------- */

  /** Title parts a site signs most of its pages with: "The New York Times", "BBC News". */
  private siteNames(host: string): Set<string> {
    const titles = this.archive.all<{ title: string }>(
      "SELECT s.title FROM snapshot s JOIN page p ON p.id=s.page_id WHERE p.host=? ORDER BY s.id DESC LIMIT 40",
      host,
    );
    const counts = new Map<string, number>();
    for (const { title } of titles)
      for (const key of new Set(
        title.split(/\s+[|–—·•-]\s+/u).map((part) => entityKey(part)),
      ))
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    return new Set(
      titles.length < 3
        ? []
        : [...counts]
            .filter(([, n]) => n >= titles.length * 0.6)
            .map(([key]) => key),
    );
  }

  private ignored(spaceId: string): Set<string> {
    return new Set(
      this.archive
        .all<{ key: string }>(
          "SELECT key FROM entity_ignore WHERE space_id=?",
          spaceId,
        )
        .map((row) => row.key),
    );
  }

  /**
   * Existing entries a name may be: the same spelling (in any kind — the
   * model settles what it is), or one name inside the other ("Collison" and
   * "Patrick Collison", "stripe pricing" and "stripe pricing plans").
   */
  known(spaceId: string, candidate: Pick<WatchtowerIndexCandidate, "key" | "aliases">, exclude?: number): WatchtowerKnownEntity[] {
    const keys = [
      ...new Set([candidate.key, ...candidate.aliases.map(entityKey)].filter(Boolean)),
    ].slice(0, 8);
    const scored = new Map<number, { ref: WatchtowerEntityRef; score: number }>();
    for (const row of this.archive.all<WatchtowerEntityRef>(
      `SELECT DISTINCT e.id,e.kind,e.name FROM entity_alias a JOIN entity e ON e.id=a.entity_id
       WHERE e.space_id=? AND a.key IN (${placeholders(keys.length)})`,
      spaceId,
      ...keys,
    ))
      scored.set(row.id, { ref: row, score: 10 });
    const own = new Set(keyTokens(candidate.key));
    for (const token of [...own].filter((token) => token.length >= 3 || /\p{N}/u.test(token)).slice(0, 4))
      for (const row of this.archive.all<WatchtowerEntityRef & { key: string }>(
        `SELECT e.id,e.kind,e.name,a.key FROM entity_alias a JOIN entity e ON e.id=a.entity_id
         WHERE e.space_id=? AND (' '||a.key||' ') LIKE ? LIMIT 60`,
        spaceId,
        `% ${token} %`,
      )) {
        if (scored.has(row.id) && scored.get(row.id)!.score >= 10) continue;
        const theirs = new Set(keyTokens(row.key));
        const shared = [...own].filter((word) => theirs.has(word)).length;
        // One name must contain the other; sharing "university" is not enough.
        if (shared < Math.min(own.size, theirs.size)) continue;
        const score = shared / Math.max(own.size, theirs.size);
        if (score > (scored.get(row.id)?.score ?? 0))
          scored.set(row.id, { ref: { id: row.id, kind: row.kind, name: row.name }, score });
      }
    scored.delete(exclude ?? -1);
    return [...scored.values()]
      .sort((a, b) => b.score - a.score || a.ref.id - b.ref.id)
      .slice(0, MAX_KNOWN)
      .map(({ ref }) => ({ ...ref, ...this.describe(ref.id) }));
  }

  /** What the decision model is told about an existing entry: other spellings, sites, an example sentence. */
  private describe(id: number): Pick<WatchtowerKnownEntity, "aliases" | "sites" | "context"> {
    return {
      aliases: this.archive
        .all<{ name: string }>(
          "SELECT name FROM entity_alias WHERE entity_id=? LIMIT 4",
          id,
        )
        .map((row) => row.name),
      sites: this.archive
        .all<{ host: string }>(
          `SELECT DISTINCT p.host FROM mention m JOIN snapshot s ON s.id=m.snapshot_id
           JOIN page p ON p.id=s.page_id WHERE m.entity_id=? LIMIT 3`,
          id,
        )
        .map((row) => row.host.replace(/^www\./u, "")),
      context:
        this.archive.get<{ context: string }>(
          "SELECT context FROM mention WHERE entity_id=? ORDER BY salience DESC,count DESC LIMIT 1",
          id,
        )?.context ?? "",
    };
  }

  /** The candidates of one saved version, with what the index already holds for each. */
  prepare(snapshotId: number, options: { local?: boolean } = {}): WatchtowerIndexJob | null {
    const row = this.archive.get<{
      title: string;
      url: string;
      host: string;
      space_id: string;
      subjects: Uint8Array | null;
    }>(
      `SELECT s.title,p.url,p.host,p.space_id,s.subjects FROM snapshot s
       JOIN page p ON p.id=s.page_id WHERE s.id=?`,
      snapshotId,
    );
    if (!row) return null;
    const found = findCandidates({
      url: row.url,
      title: row.title,
      blocks: options.local ? [] : this.archive.blocks(snapshotId),
      subjects: row.subjects
        ? (JSON.parse(
            inflateRawSync(row.subjects, { maxOutputLength: 65536 }).toString("utf8"),
          ) as WatchtowerSubject[])
        : undefined,
      siteNames: options.local ? undefined : this.siteNames(row.host),
      declaredOnly: options.local,
    });
    const ignored = this.ignored(row.space_id);
    const renumber = new Map<number, number>();
    const candidates: WatchtowerIndexCandidate[] = [];
    found.candidates.forEach((candidate, index) => {
      if (ignored.has(candidate.key)) return;
      renumber.set(index, candidates.length);
      // Locally nothing is asked: a declared kind links by spelling alone.
      let known = options.local ? [] : this.known(row.space_id, candidate);
      // A page that declares what a name is, and an entry of that kind by
      // that name: nothing to ask.
      if (
        candidate.kind !== null &&
        known.some((entry) => entry.kind === candidate.kind && this.spells(entry.id, candidate.key))
      )
        known = [];
      candidates.push({ ...candidate, known });
    });
    return {
      snapshotId,
      spaceId: row.space_id,
      host: row.host.replace(/^www\./u, ""),
      title: row.title,
      candidates,
      facts: found.facts.flatMap((fact) => {
        const candidate = renumber.get(fact.candidate);
        return candidate === undefined ? [] : [{ ...fact, candidate }];
      }),
    };
  }

  private spells(id: number, key: string): boolean {
    return (
      this.archive.get(
        "SELECT 1 FROM entity_alias WHERE entity_id=? AND key=?",
        id,
        key,
      ) !== undefined
    );
  }

  /**
   * A deliberate save's reading as a job: the language model's entities,
   * their kinds settled, each with the entries it may already be. Its facts
   * come sorted already; `factKinds[j]` is fact j's kind. Only matches are
   * left to ask.
   */
  prepareSaved(
    snapshotId: number,
    entities: readonly WatchtowerSavedEntity[],
    kept: { observationId: string; spaceId: string },
  ): { job: WatchtowerIndexJob; factKinds: WatchtowerFactKind[] } | null {
    if (!this.holds(kept.observationId, snapshotId, kept.spaceId)) return null;
    const row = this.archive.get<{ title: string; host: string; space_id: string }>(
      "SELECT s.title,p.host,p.space_id FROM snapshot s JOIN page p ON p.id=s.page_id WHERE s.id=?",
      snapshotId,
    );
    if (!row) return null;
    const ignored = this.ignored(row.space_id);
    const candidates: WatchtowerIndexCandidate[] = [];
    const facts: WatchtowerIndexJob["facts"] = [];
    const factKinds: WatchtowerFactKind[] = [];
    for (const entity of entities.slice(0, 16)) {
      const key = entityKey(entity.name);
      if (!key || ignored.has(key) || !isKind(entity.kind) || (entity.kind as string) === "question") continue;
      const aliases = entity.aliases.filter((alias) => entityKey(alias) !== "").slice(0, 6);
      let known = this.known(row.space_id, { key, aliases });
      // The same name, already an entry of this kind: nothing to ask.
      if (known.some((entry) => entry.kind === entity.kind && this.spells(entry.id, key))) known = [];
      const index = candidates.length;
      candidates.push({
        name: entity.name,
        key,
        kind: entity.kind,
        aliases,
        count: 1,
        salience: WATCHTOWER_SAVED_ROLE_SALIENCE[entity.role] ?? 0.3,
        context: entity.context,
        known,
      });
      for (const fact of entity.facts.slice(0, 6))
        if (isFactKind(fact.kind)) {
          facts.push({ candidate: index, text: fact.text });
          factKinds.push(fact.kind);
        }
    }
    return {
      job: {
        snapshotId,
        spaceId: row.space_id,
        observationId: kept.observationId,
        host: row.host.replace(/^www\./u, ""),
        title: row.title,
        candidates,
        facts,
      },
      factKinds,
    };
  }

  /**
   * Whether an observation still exists in this Space and still holds this
   * version. A version id alone is not an identity: once the version is
   * forgotten, SQLite gives its id to the next one saved — any page's.
   */
  private holds(observationId: string, snapshotId: number, spaceId: string): boolean {
    return (
      this.archive.get(
        `SELECT 1 FROM observation o JOIN visit v ON v.id=o.visit_id JOIN page p ON p.id=v.page_id
         WHERE o.id=? AND o.snapshot_id=? AND p.space_id=?`,
        observationId,
        snapshotId,
        spaceId,
      ) !== undefined
    );
  }

  /** Whether a job has anything to ask: a name to sort, a match to confirm, a sentence to read. */
  static asks(job: WatchtowerIndexJob): boolean {
    return (
      job.facts.length > 0 ||
      job.candidates.some(
        (candidate) =>
          candidate.kind === null ||
          candidate.search === true ||
          candidate.known.length > 0,
      )
    );
  }

  /** At capture: what the page settles by itself, with no model. */
  local(snapshotId: number): void {
    const job = this.prepare(snapshotId, { local: true });
    if (!job) return;
    this.apply(
      job,
      job.candidates.map((candidate) => ({ kind: candidate.kind, same: null })),
      [],
      1,
    );
  }

  /** Versions saved before the index existed, indexed locally a few at a time. */
  backlog(limit = LOCAL_BATCH): number {
    const ids = this.archive.all<{ id: number }>(
      "SELECT id FROM snapshot WHERE understood=0 ORDER BY id DESC LIMIT ?",
      limit,
    );
    for (const { id } of ids) this.local(id);
    return ids.length;
  }

  /**
   * The next saved version the decision model should read, newest first.
   * Versions with nothing to ask are completed on the way, a bounded number
   * per call. Excluded sites and Spaces are never offered.
   */
  next(): WatchtowerIndexJob | null {
    const eligible = this.eligible();
    let settled = 0;
    // Exclusions are applied BEFORE the limit: thousands of versions of an
    // excluded site must not stand in front of an eligible one forever.
    for (const row of this.archive.all<{ id: number }>(
      `SELECT s.id FROM snapshot s JOIN page p ON p.id=s.page_id
       WHERE s.understood<2 AND ${eligible.sql} ORDER BY s.id DESC LIMIT ?`,
      ...eligible.params,
      SCAN,
    )) {
      const job = this.prepare(row.id);
      if (!job) continue;
      if (EntityIndex.asks(job)) return job;
      this.apply(
        job,
        job.candidates.map((candidate) => ({ kind: candidate.kind, same: null })),
        [],
        2,
      );
      if (++settled >= LOCAL_BATCH) return null;
    }
    return null;
  }

  /**
   * Saved versions in a Space still waiting for the decision model. An
   * excluded site is not waiting: it will never be read.
   */
  pending(spaceId: string): number {
    const eligible = this.eligible();
    return (
      this.archive.get<{ n: number }>(
        `SELECT count(*) n FROM snapshot s JOIN page p ON p.id=s.page_id
         WHERE p.space_id=? AND s.understood<2 AND ${eligible.sql}`,
        spaceId,
        ...eligible.params,
      )?.n ?? 0
    );
  }

  /**
   * The SQL condition (over `page p`) for what may be offered to the model:
   * not in an excluded Space, not on an excluded site or its subdomains.
   * Excluded hosts are validated domains ([a-z0-9.-]), so none holds a LIKE
   * wildcard.
   */
  private eligible(): { sql: string; params: SQLInputValue[] } {
    const settings = this.archive.settings();
    return {
      sql: `p.space_id NOT IN (SELECT value FROM json_each(?))
        AND NOT EXISTS(SELECT 1 FROM json_each(?) h WHERE p.host=h.value OR p.host LIKE '%.'||h.value)`,
      params: [JSON.stringify(settings.excludedSpaces), JSON.stringify(settings.excludedHosts)],
    };
  }

  /**
   * Writes one version's mentions and facts, replacing what an earlier pass
   * wrote. `decisions[i]` is candidate i's kind (null: not an entity) and
   * the known entry it is; `facts[j]` fact j's kind (null: not a fact).
   * Returns false, writing nothing, when the version was forgotten
   * meanwhile, when a deliberate save's observation no longer holds it, or
   * when a deeper reading landed first — a passive pass that was still
   * asking Jev when the person saved the page must not erase the save.
   */
  apply(
    job: WatchtowerIndexJob,
    decisions: readonly (WatchtowerEntityDecision | null | undefined)[],
    facts: readonly (WatchtowerFactKind | null | undefined)[],
    level: 1 | 2 | 3,
    options: { merge?: boolean } = {},
  ): boolean {
    return this.archive.transaction(() => {
      const snapshot = this.archive.get<{ space_id: string; understood: number }>(
        "SELECT p.space_id,s.understood FROM snapshot s JOIN page p ON p.id=s.page_id WHERE s.id=?",
        job.snapshotId,
      );
      if (!snapshot || snapshot.space_id !== job.spaceId) return false;
      if (job.observationId !== undefined && !this.holds(job.observationId, job.snapshotId, job.spaceId)) return false;
      if (!options.merge && snapshot.understood > level) return false;
      const spaceId = snapshot.space_id;
      const ignored = this.ignored(spaceId);
      // A deliberate save adds to what earlier passes found; they replace.
      if (!options.merge) {
        this.run("DELETE FROM mention WHERE snapshot_id=?", job.snapshotId);
        this.run("DELETE FROM fact WHERE snapshot_id=?", job.snapshotId);
      }
      const ids = job.candidates.slice(0, 32).map((candidate, index): number | null => {
        const decision = decisions[index];
        const key = entityKey(candidate.name);
        if (!decision || !isKind(decision.kind) || !key || ignored.has(key)) return null;
        const id = this.resolve(spaceId, candidate, decision);
        const aliases = [candidate.name, ...(candidate.aliases ?? [])]
          .map((name) => String(name).replace(/\s+/gu, " ").trim().slice(0, 200))
          .filter((name) => entityKey(name) !== "")
          .slice(0, 8);
        for (const name of aliases)
          this.run(
            "INSERT OR IGNORE INTO entity_alias(entity_id,key,name) VALUES(?,?,?)",
            id,
            entityKey(name),
            name,
          );
        this.run(
          `INSERT INTO mention(entity_id,snapshot_id,count,salience,context) VALUES(?,?,?,?,?)
           ON CONFLICT(entity_id,snapshot_id) DO UPDATE SET ${options.merge ? "count=max(count,excluded.count)" : "count=count+excluded.count"},
           salience=max(salience,excluded.salience),
           context=CASE WHEN context='' THEN excluded.context ELSE context END`,
          id,
          job.snapshotId,
          Math.max(1, Math.min(10000, Math.floor(Number(candidate.count) || 1))),
          Math.max(0, Math.min(1, Number(candidate.salience) || 0)),
          String(candidate.context ?? "").slice(0, 400),
        );
        return id;
      });
      job.facts.slice(0, 64).forEach((fact, index) => {
        const kind = facts[index];
        const id = ids[fact.candidate];
        if (!isFactKind(kind) || id === null || id === undefined) return;
        const text = String(fact.text).slice(0, 600);
        if (
          options.merge &&
          this.archive.get(
            "SELECT 1 FROM fact WHERE entity_id=? AND snapshot_id=? AND text=?",
            id,
            job.snapshotId,
            text,
          )
        )
          return;
        this.run(
          "INSERT INTO fact(entity_id,snapshot_id,kind,text) VALUES(?,?,?,?)",
          id,
          job.snapshotId,
          kind,
          text,
        );
      });
      this.run(
        "UPDATE snapshot SET understood=max(understood,?) WHERE id=?",
        level,
        job.snapshotId,
      );
      this.orphans(spaceId);
      return true;
    });
  }

  /**
   * Which entry a judged name is: the known entry the model matched, else an
   * entry of the same kind spelled the same, else a new one. Doubt never
   * merges — a duplicate can be merged later, a wrong merge hides a page.
   */
  private resolve(
    spaceId: string,
    candidate: WatchtowerIndexCandidate,
    decision: WatchtowerEntityDecision,
  ): number {
    const kind = decision.kind!;
    const key = entityKey(candidate.name);
    let id: number | undefined;
    if (
      decision.same !== null &&
      candidate.known?.some((entry) => entry.id === decision.same)
    )
      id = this.archive.get<{ id: number }>(
        "SELECT id FROM entity WHERE id=? AND space_id=?",
        decision.same,
        spaceId,
      )?.id;
    id ??= this.archive.get<{ id: number }>(
      `SELECT e.id FROM entity_alias a JOIN entity e ON e.id=a.entity_id
       WHERE a.key=? AND e.space_id=? AND e.kind=? ORDER BY e.id LIMIT 1`,
      key,
      spaceId,
      kind,
    )?.id;
    const name = candidate.name.replace(/\s+/gu, " ").trim().slice(0, 200);
    if (id === undefined)
      return Number(
        this.run(
          "INSERT INTO entity(space_id,kind,name,at) VALUES(?,?,?,?)",
          spaceId,
          kind,
          name,
          Date.now(),
        ).lastInsertRowid,
      );
    // "Collison", then "Patrick Collison": the entry takes the fuller name.
    const entry = this.archive.get<{ kind: string; name: string }>(
      "SELECT kind,name FROM entity WHERE id=?",
      id,
    );
    if (entry?.kind === "person") {
      const current = keyTokens(entityKey(entry.name));
      const offered = keyTokens(key);
      if (offered.length > current.length && current.every((token) => offered.includes(token)))
        this.run("UPDATE entity SET name=? WHERE id=?", name, id);
    }
    return id;
  }

  private run(sql: string, ...params: SQLInputValue[]): StatementResultingChanges {
    return this.archive.run(sql, ...params);
  }

  /** Entries nothing mentions any more. */
  orphans(spaceId?: string): void {
    if (spaceId === undefined)
      this.run(
        "DELETE FROM entity WHERE NOT EXISTS(SELECT 1 FROM mention WHERE entity_id=entity.id)",
      );
    else
      this.run(
        "DELETE FROM entity WHERE space_id=? AND NOT EXISTS(SELECT 1 FROM mention WHERE entity_id=entity.id)",
        spaceId,
      );
  }

  /* ---------------------------------- reads --------------------------------- */

  /** The entries a saved version is about, most central first. */
  about(snapshotId: number): WatchtowerEntityRef[] {
    return this.archive.all<WatchtowerEntityRef>(
      `SELECT e.id,e.kind,e.name FROM mention m JOIN entity e ON e.id=m.entity_id
       WHERE m.snapshot_id=? ORDER BY m.salience DESC,m.count DESC,e.name LIMIT 24`,
      snapshotId,
    );
  }

  list(
    spaceId: string,
    options: { query?: string; kind?: WatchtowerEntityKind; offset?: number; limit?: number },
  ): WatchtowerIndex {
    const where = ["e.space_id=?"];
    const params: SQLInputValue[] = [spaceId];
    if (options.kind) {
      where.push("e.kind=?");
      params.push(options.kind);
    }
    const key = entityKey(options.query ?? "");
    if (key) {
      // Any word of any spelling, from its start: "coll" finds Patrick Collison.
      where.push(
        "e.id IN (SELECT entity_id FROM entity_alias WHERE (' '||key) LIKE ?)",
      );
      params.push(`% ${key}%`);
    }
    const rows = this.archive.all<Omit<WatchtowerEntity, "aliases" | "firstSeen" | "lastSeen">>(
      `SELECT e.id,e.kind,e.name,count(DISTINCT s.page_id) pageCount,count(DISTINCT p.host) siteCount,
       (SELECT count(*) FROM fact f WHERE f.entity_id=e.id) factCount
       FROM entity e JOIN mention m ON m.entity_id=e.id JOIN snapshot s ON s.id=m.snapshot_id
       JOIN page p ON p.id=s.page_id WHERE ${where.join(" AND ")}
       GROUP BY e.id ORDER BY pageCount DESC,max(m.salience) DESC,e.name COLLATE NOCASE,e.id
       LIMIT ? OFFSET ?`,
      ...params,
      options.limit ?? 50,
      options.offset ?? 0,
    );
    const counts: WatchtowerIndex["counts"] = {};
    for (const row of this.archive.all<{ kind: string; n: number }>(
      "SELECT kind,count(*) n FROM entity WHERE space_id=? GROUP BY kind",
      spaceId,
    ))
      if (isKind(row.kind)) counts[row.kind] = row.n;
    return {
      entities: this.complete(rows),
      counts,
      pending: this.pending(spaceId),
    };
  }

  /** Spellings and first/last visit dates for a page of entries. */
  private complete(
    rows: Omit<WatchtowerEntity, "aliases" | "firstSeen" | "lastSeen">[],
  ): WatchtowerEntity[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const aliases = new Map<number, string[]>();
    for (const row of this.archive.all<{ entity_id: number; name: string }>(
      `SELECT entity_id,name FROM entity_alias WHERE entity_id IN (${placeholders(ids.length)})`,
      ...ids,
    ))
      aliases.set(row.entity_id, [...(aliases.get(row.entity_id) ?? []), row.name]);
    const seen = new Map(
      this.archive
        .all<{ id: number; first: number; last: number }>(
          `SELECT m.entity_id id,min(v.at) first,max(v.at) last FROM mention m
           JOIN observation o ON o.snapshot_id=m.snapshot_id JOIN visit v ON v.id=o.visit_id
           WHERE m.entity_id IN (${placeholders(ids.length)}) GROUP BY m.entity_id`,
          ...ids,
        )
        .map((row) => [row.id, row]),
    );
    return rows.map((row) => ({
      ...row,
      aliases: [
        row.name,
        ...(aliases.get(row.id) ?? []).filter((name) => name !== row.name),
      ],
      firstSeen: seen.get(row.id)?.first ?? 0,
      lastSeen: seen.get(row.id)?.last ?? 0,
    }));
  }

  read(spaceId: string, entityId: number): WatchtowerEntityDocument {
    const row = this.archive.get<Omit<WatchtowerEntity, "aliases" | "firstSeen" | "lastSeen">>(
      `SELECT e.id,e.kind,e.name,count(DISTINCT s.page_id) pageCount,count(DISTINCT p.host) siteCount,
       (SELECT count(*) FROM fact f WHERE f.entity_id=e.id) factCount
       FROM entity e JOIN mention m ON m.entity_id=e.id JOIN snapshot s ON s.id=m.snapshot_id
       JOIN page p ON p.id=s.page_id WHERE e.id=? AND e.space_id=? GROUP BY e.id`,
      entityId,
      spaceId,
    );
    if (!row)
      throw Object.assign(
        new Error("This entry was removed from the index or belongs to another Profile."),
        { code: "NOT_FOUND" },
      );
    const [entity] = this.complete([row]);
    // One row per page: its most recent visit that saw a mentioning version.
    const mentions = this.archive
      .all<WatchtowerHit & { context: string; salience: number; rn: number }>(
        `SELECT * FROM (SELECT ${HIT}, m.context, m.salience,
         ROW_NUMBER() OVER (PARTITION BY p.id ORDER BY v.at DESC,o.at DESC,o.id DESC) rn
         FROM mention m JOIN observation o ON o.snapshot_id=m.snapshot_id JOIN visit v ON v.id=o.visit_id
         JOIN page p ON p.id=v.page_id JOIN snapshot s ON s.id=o.snapshot_id
         WHERE m.entity_id=? AND p.space_id=?) WHERE rn=1
         ORDER BY salience DESC,visitedAt DESC LIMIT 50`,
        entityId,
        spaceId,
      )
      .map(({ context, salience, rn: _rn, ...source }) => ({ source, context, salience }));
    const seenFacts = new Set<string>();
    const facts = this.archive
      .all<WatchtowerHit & { factKind: string; text: string; rn: number }>(
        `SELECT * FROM (SELECT ${HIT}, f.kind factKind, f.text,
         ROW_NUMBER() OVER (PARTITION BY f.id ORDER BY v.at DESC,o.at DESC,o.id DESC) rn
         FROM fact f JOIN observation o ON o.snapshot_id=f.snapshot_id JOIN visit v ON v.id=o.visit_id
         JOIN page p ON p.id=v.page_id JOIN snapshot s ON s.id=o.snapshot_id
         WHERE f.entity_id=? AND p.space_id=?) WHERE rn=1 ORDER BY visitedAt DESC LIMIT 200`,
        entityId,
        spaceId,
      )
      .flatMap(({ factKind, text, rn: _rn, ...source }) => {
        // The same sentence on every version of a page is one fact.
        if (!isFactKind(factKind) || seenFacts.has(text)) return [];
        seenFacts.add(text);
        return [{ kind: factKind, text, source }];
      })
      .sort((a, b) => FACT_ORDER[a.kind] - FACT_ORDER[b.kind] || b.source.visitedAt - a.source.visitedAt)
      .slice(0, 60);
    const sites = this.archive.all<{ host: string; pages: number }>(
      `SELECT p.host,count(DISTINCT p.id) pages FROM mention m JOIN snapshot s ON s.id=m.snapshot_id
       JOIN page p ON p.id=s.page_id WHERE m.entity_id=? GROUP BY p.host ORDER BY pages DESC,p.host LIMIT 12`,
      entityId,
    );
    const related = this.archive.all<WatchtowerEntityRef>(
      `SELECT e.id,e.kind,e.name FROM mention a JOIN mention b ON b.snapshot_id=a.snapshot_id AND b.entity_id!=a.entity_id
       JOIN entity e ON e.id=b.entity_id WHERE a.entity_id=?
       GROUP BY e.id ORDER BY count(DISTINCT b.snapshot_id) DESC,max(b.salience) DESC,e.name LIMIT 12`,
      entityId,
    );
    const similar = new Map<number, WatchtowerEntityRef>();
    for (const alias of entity!.aliases.slice(0, 6))
      for (const known of this.known(spaceId, { key: entityKey(alias), aliases: [] }, entityId))
        if (known.kind === entity!.kind && similar.size < 6)
          similar.set(known.id, { id: known.id, kind: known.kind, name: known.name });
    return {
      ...entity!,
      facts,
      mentions,
      sites,
      related,
      similar: [...similar.values()],
    };
  }

  /* ---------------------------------- edits --------------------------------- */

  /**
   * By hand: fold an entry into another, correct its kind, or take it out of
   * the index for good. Only the index changes; saved pages never do.
   */
  edit(
    spaceId: string,
    request: { entityId: number; merge?: number; kind?: WatchtowerEntityKind; remove?: boolean },
  ): number | null {
    return this.archive.transaction(() => {
      const owned = (id: number): boolean =>
        this.archive.get("SELECT 1 FROM entity WHERE id=? AND space_id=?", id, spaceId) !== undefined;
      if (!owned(request.entityId))
        throw Object.assign(new Error("This entry was removed from the index or belongs to another Profile."), {
          code: "NOT_FOUND",
        });
      if (request.remove) {
        this.run(
          "INSERT OR IGNORE INTO entity_ignore(space_id,key) SELECT ?,key FROM entity_alias WHERE entity_id=?",
          spaceId,
          request.entityId,
        );
        this.run("DELETE FROM entity WHERE id=?", request.entityId);
        return null;
      }
      if (request.merge !== undefined) {
        const into = request.merge;
        if (into === request.entityId || !owned(into)) throw new Error("Choose another entry in this Profile to merge with.");
        this.run(
          "INSERT OR IGNORE INTO entity_alias(entity_id,key,name) SELECT ?,key,name FROM entity_alias WHERE entity_id=?",
          into,
          request.entityId,
        );
        this.run(
          `INSERT INTO mention(entity_id,snapshot_id,count,salience,context)
           SELECT ?,snapshot_id,count,salience,context FROM mention WHERE entity_id=?
           ON CONFLICT(entity_id,snapshot_id) DO UPDATE SET count=count+excluded.count,
           salience=max(salience,excluded.salience)`,
          into,
          request.entityId,
        );
        this.run("UPDATE fact SET entity_id=? WHERE entity_id=?", into, request.entityId);
        this.run("DELETE FROM entity WHERE id=?", request.entityId);
        return into;
      }
      if (request.kind !== undefined)
        this.run("UPDATE entity SET kind=? WHERE id=?", request.kind, request.entityId);
      return request.entityId;
    });
  }

  /* --------------------------------- export --------------------------------- */

  /** Every entry of a Space with its pages and facts, for the Markdown wiki. */
  everything(spaceId: string): {
    entity: WatchtowerEntity;
    mentions: { snapshotId: number; context: string; salience: number }[];
    facts: { snapshotId: number; kind: WatchtowerFactKind; text: string }[];
  }[] {
    const rows = this.archive.all<Omit<WatchtowerEntity, "aliases" | "firstSeen" | "lastSeen">>(
      `SELECT e.id,e.kind,e.name,count(DISTINCT s.page_id) pageCount,count(DISTINCT p.host) siteCount,
       (SELECT count(*) FROM fact f WHERE f.entity_id=e.id) factCount
       FROM entity e JOIN mention m ON m.entity_id=e.id JOIN snapshot s ON s.id=m.snapshot_id
       JOIN page p ON p.id=s.page_id WHERE e.space_id=? GROUP BY e.id ORDER BY e.kind,e.name COLLATE NOCASE,e.id`,
      spaceId,
    );
    const mentions = new Map<number, { snapshotId: number; context: string; salience: number }[]>();
    for (const row of this.archive.all<{ entity_id: number; snapshotId: number; context: string; salience: number }>(
      `SELECT m.entity_id,m.snapshot_id snapshotId,m.context,m.salience FROM mention m
       JOIN entity e ON e.id=m.entity_id WHERE e.space_id=? ORDER BY m.salience DESC`,
      spaceId,
    ))
      mentions.set(row.entity_id, [...(mentions.get(row.entity_id) ?? []), row]);
    const facts = new Map<number, { snapshotId: number; kind: WatchtowerFactKind; text: string }[]>();
    for (const row of this.archive.all<{ entity_id: number; snapshotId: number; kind: string; text: string }>(
      `SELECT f.entity_id,f.snapshot_id snapshotId,f.kind,f.text FROM fact f
       JOIN entity e ON e.id=f.entity_id WHERE e.space_id=? ORDER BY f.id`,
      spaceId,
    ))
      if (isFactKind(row.kind))
        facts.set(row.entity_id, [...(facts.get(row.entity_id) ?? []), { ...row, kind: row.kind }]);
    const entities: WatchtowerEntity[] = [];
    for (let i = 0; i < rows.length; i += 400) entities.push(...this.complete(rows.slice(i, i + 400)));
    return entities.map((entity) => ({
      entity,
      mentions: mentions.get(entity.id) ?? [],
      facts: facts.get(entity.id) ?? [],
    }));
  }
}
