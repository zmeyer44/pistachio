import { z } from "zod";

export const WATCHTOWER_URL = "pistachio://watchtower";
export const WATCHTOWER_KINDS = ["article", "page", "video"] as const;
export type WatchtowerKind = (typeof WATCHTOWER_KINDS)[number];
export const watchtowerSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  paused: z.boolean().default(false),
  excludedHosts: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .max(253)
        .transform((value) => value.replace(/^\*\./u, "").replace(/^\./u, ""))
        .refine(
          (value) =>
            /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value) &&
            !value.includes(".."),
          "Enter a domain such as example.com, without a URL or path",
        ),
    )
    .max(200)
    .default([]),
  excludedSpaces: z.array(z.string().max(160)).max(100).default([]),
  retentionDays: z.number().int().min(0).max(36500).default(0),
  maxSizeMb: z.number().int().min(16).max(102400).default(2048),
  /** Off until the person says yes: archived text a run retrieves reaches its model. */
  agentAccess: z.boolean().default(false),
  remoteRerank: z.boolean().default(false),
  /**
   * Ask the decision model (Jev) which regions of an unfamiliar page layout
   * are content. Off keeps capture fully local, on local heuristics alone.
   */
  smartFilter: z.boolean().default(true),
  /**
   * Ask the decision model (Jev) what the names on a saved page are — a
   * person, a company, a product — and whether they are ones already in the
   * index. Off until chosen: an archive enabled before the index existed
   * never agreed to it. Off, the index holds only what a page declares
   * about itself (structured data, a repository, a search).
   */
  smartIndex: z.boolean().default(false),
});
export type WatchtowerSettings = z.infer<typeof watchtowerSettingsSchema>;
export const DEFAULT_WATCHTOWER_SETTINGS = watchtowerSettingsSchema.parse({});

/**
 * The primitives a page is decomposed into. A page is a document; what it
 * is ABOUT persists across sites: Stripe's own pages, a TechCrunch story
 * and a podcast transcript describe one Company("Stripe").
 */
export const WATCHTOWER_ENTITY_KINDS = [
  "person",
  "company",
  "organization",
  "product",
  "technology",
  "place",
  "event",
  "work",
  "project",
  "concept",
  "question",
] as const;
export type WatchtowerEntityKind = (typeof WATCHTOWER_ENTITY_KINDS)[number];
/** What a sentence on a page says about an entity: kept verbatim, with its source. */
export const WATCHTOWER_FACT_KINDS = [
  "definition",
  "metric",
  "price",
  "event",
  "claim",
] as const;
export type WatchtowerFactKind = (typeof WATCHTOWER_FACT_KINDS)[number];
/** How each kind is named, one and many: "1 company", "117 companies". */
export const WATCHTOWER_ENTITY_LABELS: Record<
  WatchtowerEntityKind,
  { one: string; many: string }
> = {
  person: { one: "Person", many: "People" },
  company: { one: "Company", many: "Companies" },
  organization: { one: "Organization", many: "Organizations" },
  product: { one: "Product", many: "Products" },
  technology: { one: "Technology", many: "Technologies" },
  place: { one: "Place", many: "Places" },
  event: { one: "Event", many: "Events" },
  work: { one: "Work", many: "Works" },
  project: { one: "Project", many: "Projects" },
  concept: { one: "Concept", many: "Concepts" },
  question: { one: "Question", many: "Questions" },
};
export const WATCHTOWER_FACT_LABELS: Record<WatchtowerFactKind, string> = {
  definition: "What it is",
  metric: "Numbers",
  price: "Pricing",
  event: "What happened",
  claim: "Claims",
};

export const watchtowerRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }),
  z.object({
    type: z.literal("settings"),
    patch: z.object({
      enabled: watchtowerSettingsSchema.shape.enabled
        .removeDefault()
        .optional(),
      paused: watchtowerSettingsSchema.shape.paused.removeDefault().optional(),
      excludedHosts: watchtowerSettingsSchema.shape.excludedHosts
        .removeDefault()
        .optional(),
      excludedSpaces: watchtowerSettingsSchema.shape.excludedSpaces
        .removeDefault()
        .optional(),
      retentionDays: watchtowerSettingsSchema.shape.retentionDays
        .removeDefault()
        .optional(),
      maxSizeMb: watchtowerSettingsSchema.shape.maxSizeMb
        .removeDefault()
        .optional(),
      agentAccess: watchtowerSettingsSchema.shape.agentAccess
        .removeDefault()
        .optional(),
      remoteRerank: watchtowerSettingsSchema.shape.remoteRerank
        .removeDefault()
        .optional(),
      smartFilter: watchtowerSettingsSchema.shape.smartFilter
        .removeDefault()
        .optional(),
      smartIndex: watchtowerSettingsSchema.shape.smartIndex
        .removeDefault()
        .optional(),
    }),
  }),
  z.object({
    type: z.literal("search"),
    query: z.string().max(1000).default(""),
    offset: z.number().int().min(0).max(100000).default(0),
    /** The address palette shows three rows; it should not pay for fifty snippets. */
    limit: z.number().int().min(1).max(50).default(50),
    enhance: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("read"),
    observationId: z.string().min(1).max(160),
  }),
  z.object({
    type: z.literal("diff"),
    beforeId: z.string().min(1).max(160),
    afterId: z.string().min(1).max(160),
  }),
  z.object({
    type: z.literal("forget"),
    pageId: z.number().int().positive().optional(),
    /** A site and its subdomains. */
    host: z.string().trim().toLowerCase().min(1).max(253).optional(),
    since: z.number().finite().nonnegative().optional(),
    until: z.number().finite().nonnegative().optional(),
    all: z.boolean().optional(),
    /** With `all`: every Space's archive, not only the active one. */
    everySpace: z.boolean().optional(),
  }),
  z.object({ type: z.literal("export") }),
  /** The index: what the saved pages are about, by name and kind. */
  z.object({
    type: z.literal("entities"),
    query: z.string().max(200).default(""),
    kind: z.enum(WATCHTOWER_ENTITY_KINDS).optional(),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  z.object({
    type: z.literal("entity"),
    entityId: z.number().int().positive(),
  }),
  /** What Watchtower holds for a saved page: its saved text, and what it is about. */
  z.object({
    type: z.literal("about"),
    url: z.string().min(1).max(8192),
  }),
  /**
   * Normalizing by hand: `merge` folds one entry into another (names,
   * pages, facts), `kind` corrects what an entry is, `remove` takes a
   * name out of the index and keeps it out. Saved pages are untouched.
   */
  z.object({
    type: z.literal("entity-edit"),
    entityId: z.number().int().positive(),
    merge: z.number().int().positive().optional(),
    kind: z.enum(WATCHTOWER_ENTITY_KINDS).optional(),
    remove: z.boolean().optional(),
  }),
]);
export type WatchtowerRequest = z.input<typeof watchtowerRequestSchema>;
/** What the archive stores: the blocks that survived region filtering. */
export interface WatchtowerCapture {
  url: string;
  title: string;
  description: string;
  creator: string;
  /** From structured data when the page declares them; part of the card. */
  published?: string;
  duration?: string;
  kind: WatchtowerKind;
  blocks: string[];
  links: { url: string; text: string }[];
  truncated: boolean;
  /**
   * What the page declares it is about, from its structured data: a
   * Product and its brand, an Event and its venue, an article's author.
   * `type` is the declared schema.org type, or the property the name was
   * found under (`author`, `brand`) when the page gave none.
   */
  subjects?: WatchtowerSubject[];
}
export interface WatchtowerSubject {
  name: string;
  /** The declared schema.org type; empty when the page declared none. */
  type: string;
  /** The property it was found under (`author`, `brand`, `about`); absent for a top-level item. */
  via?: string;
}
/**
 * One extracted block with where it sat in the page. `path` is the chain of
 * ancestor signatures (`tag#id.class`) from the capture root down to the
 * block's container; `linkChars` is how much of `text` was link text.
 */
export interface WatchtowerRawBlock {
  text: string;
  path: string[];
  linkChars: number;
}
/** What the in-page extractor returns, before regions are judged. */
export interface WatchtowerRawCapture extends Omit<WatchtowerCapture, "blocks" | "links"> {
  blocks: WatchtowerRawBlock[];
  /** `block` is the index of the block the link sat in. */
  links: { url: string; text: string; block: number }[];
}
export const WATCHTOWER_REGION_ROLES = [
  "main_content",
  "about_content",
  "discussion",
  "recommendations",
  "advertising",
  "site_chrome",
] as const;
export type WatchtowerRegionRole = (typeof WATCHTOWER_REGION_ROLES)[number];
/** A run of blocks that share a place in the page's layout. */
export interface WatchtowerRegion {
  /** Stable for one site layout: the joined ancestor signatures. */
  signature: string;
  blocks: number[];
  chars: number;
  linkChars: number;
  hasHeading: boolean;
  excerpt: string;
}
/** A remembered verdict for one region signature on one host. */
export interface WatchtowerRegionRule {
  signature: string;
  keep: boolean;
  /** `undecided`: the model was asked and was unsure; kept, and not asked again. */
  role: WatchtowerRegionRole | "local" | "undecided";
  source: "local" | "model";
  at: number;
}
export interface WatchtowerVisit {
  id: string;
  spaceId: string;
  url: string;
  title: string;
  at: number;
}
export interface WatchtowerHit {
  observationId: string;
  visitId: string;
  pageId: number;
  snapshotId: number | null;
  url: string;
  title: string;
  kind: WatchtowerKind;
  visitedAt: number;
  capturedAt: number;
  /** `expired`: retention removed the saved text and kept the visit. */
  coverage: "complete" | "partial" | "metadata" | "expired";
  snippet: string;
  /** SQLite's boolean: 1 when the page was saved on purpose (shift, shift) and keeps its text. */
  kept?: 0 | 1;
}
export interface WatchtowerDocument extends WatchtowerHit {
  markdown: string;
  blocks: string[];
  history: WatchtowerHit[];
  links: { url: string; text: string; observationId?: string }[];
  backlinks: WatchtowerHit[];
  /** What this saved version is about, most central first. */
  entities: WatchtowerEntityRef[];
}

/* ---------------------------------- index --------------------------------- */

export interface WatchtowerEntityRef {
  id: number;
  kind: WatchtowerEntityKind;
  name: string;
}
/** One entry of the index, as a list shows it. */
export interface WatchtowerEntity extends WatchtowerEntityRef {
  /** Every way pages have written it, the display name first. */
  aliases: string[];
  /** Distinct saved pages that mention it, and the sites they are on. */
  pageCount: number;
  siteCount: number;
  factCount: number;
  firstSeen: number;
  lastSeen: number;
}
/** A sentence a page wrote about an entity, verbatim, and where it was read. */
export interface WatchtowerFact {
  kind: WatchtowerFactKind;
  text: string;
  source: WatchtowerHit;
}
export interface WatchtowerMention {
  source: WatchtowerHit;
  /** The sentence it was named in. */
  context: string;
  /** 0–1: how central it was to that page. 1 is what the page is about. */
  salience: number;
}
export interface WatchtowerEntityDocument extends WatchtowerEntity {
  facts: WatchtowerFact[];
  mentions: WatchtowerMention[];
  sites: { host: string; pages: number }[];
  /** Entries that share pages with this one, most shared first. */
  related: WatchtowerEntityRef[];
  /** Entries that may be this one written differently: offered to merge, never merged unasked. */
  similar: WatchtowerEntityRef[];
}
export interface WatchtowerIndex {
  entities: WatchtowerEntity[];
  /** Entries per kind in this Space: "117 companies, 64 people…". */
  counts: Partial<Record<WatchtowerEntityKind, number>>;
  /** Saved versions still waiting for the decision model to read their names. */
  pending: number;
}

/**
 * One name found on a saved page, before it is judged — built locally from
 * the page's own text. `kind` is set when the page settled it without a
 * model (structured data, a repository address, a search); otherwise the
 * decision model is asked.
 */
export interface WatchtowerIndexCandidate {
  name: string;
  /** Normalized: case, accents, "the", "Inc." and possessives removed. */
  key: string;
  kind: WatchtowerEntityKind | null;
  /** Other ways this page wrote it ("Collison", "YC"). */
  aliases: string[];
  count: number;
  salience: number;
  context: string;
  /** A search the person made: asked whether it was an investigation, not what kind it is. */
  search?: boolean;
  /** Entries already in the index it may be: asked which, if any. */
  known: WatchtowerKnownEntity[];
}
export interface WatchtowerKnownEntity extends WatchtowerEntityRef {
  aliases: string[];
  sites: string[];
  context: string;
}
/** A sentence that may state something about `candidate`. */
export interface WatchtowerFactCandidate {
  candidate: number;
  text: string;
}
/** A saved version whose names need the decision model. Holds no URL beyond its host. */
export interface WatchtowerIndexJob {
  snapshotId: number;
  spaceId: string;
  /**
   * A deliberate save's job is bound to the observation it kept: forgotten
   * meanwhile, its version's id may already belong to another page.
   */
  observationId?: string;
  host: string;
  title: string;
  candidates: WatchtowerIndexCandidate[];
  facts: WatchtowerFactCandidate[];
}
/** What was decided about one candidate: its kind (null: not an entity) and which known entry it is. */
export interface WatchtowerEntityDecision {
  kind: WatchtowerEntityKind | null;
  same: number | null;
}

/**
 * What a deliberate save (shift, shift) files: everything the page is
 * about, as the language model read it — a profile page yields the person
 * AND the company, a review the product AND its maker. Facts are sentences
 * copied from the page, each checked to be there before it is kept.
 */
export interface WatchtowerSavedEntity {
  kind: Exclude<WatchtowerEntityKind, "question">;
  name: string;
  aliases: string[];
  /** `subject`: what the page is about; `major`: discussed at length; `mention`: named in passing. */
  role: "subject" | "major" | "mention";
  facts: { kind: WatchtowerFactKind; text: string }[];
  /** A sentence of the page that names it. */
  context: string;
}
export const WATCHTOWER_SAVED_ROLE_SALIENCE: Record<WatchtowerSavedEntity["role"], number> = {
  subject: 1,
  major: 0.7,
  mention: 0.3,
};
/** Where a deliberate save stands in Watchtower, as the save's card shows it. */
export interface WatchtowerKeepStatus {
  /**
   * `saving`: the page is being read; `saved`: its text is in the archive
   * and what it is about is filed; `skipped`: not archived (`reason` says
   * why) — the save itself still stands.
   */
  state: "saving" | "saved" | "skipped";
  reason?: string;
  observationId?: string;
  /** What the save filed the page under, most central first. */
  entities: WatchtowerEntityRef[];
}
export interface WatchtowerStats {
  pages: number;
  visits: number;
  snapshots: number;
  blocks: number;
  /** Distinct compressed blocks used by the active Space; shared blocks count in each Space. */
  storedBytes: number;
  /** Reconstructed content bytes across this Space's unique snapshots. */
  logicalBytes: number;
  /** Physical archive, WAL and shared-memory files across all Spaces. */
  databaseBytes: number;
  full: boolean;
  /** Within a tenth of the budget: warn before capture stops. */
  nearFull: boolean;
  budgetBytes: number;
}
export interface WatchtowerResponse {
  settings: WatchtowerSettings;
  stats: WatchtowerStats;
  results?: WatchtowerHit[];
  document?: WatchtowerDocument;
  diff?: {
    before: WatchtowerHit;
    after: WatchtowerHit;
    removed: string[];
    added: string[];
  };
  exportPath?: string | null;
  rerankStatus?: "disabled" | "unconfigured" | "enhanced" | "unavailable";
  index?: WatchtowerIndex;
  entity?: WatchtowerEntityDocument;
  about?: { observationId: string; entities: WatchtowerEntityRef[] } | null;
}

/** A deliberately narrow, Space-bound host; archive text is untrusted evidence. */
export interface WatchtowerToolHost {
  search(query: string): Promise<WatchtowerHit[]>;
  entities(query: string, kind?: WatchtowerEntityKind): Promise<WatchtowerIndex>;
  entity(entityId: number): Promise<WatchtowerEntityDocument>;
  read(
    observationId: string,
    offset: number,
    maxChars: number,
  ): Promise<{
    source: WatchtowerHit;
    text: string;
    nextOffset: number | null;
  }>;
}

/** Preserve meaningful query strings and hash routes; no canonical-URL merging. */
export function watchtowerUrl(value: string): string | null {
  if (value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (
      /(?:^#|[?&])(access_token|id_token|token|password|code)=/iu.test(url.hash)
    )
      return null;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (
        /^(utm_.+|fbclid|gclid|access_token|id_token|token|password|code)$/iu.test(
          key,
        )
      )
        url.searchParams.delete(key);
    }
    return url.href.slice(0, 8192);
  } catch {
    return null;
  }
}

/**
 * The identity of a page: its visited address minus an ordinary document
 * anchor. `#History` and `#References` are one article; hash routes
 * (`#/inbox`, `#!/thread`) are different pages and keep their fragment.
 */
export function watchtowerPageUrl(value: string): string | null {
  const normalized = watchtowerUrl(value);
  if (normalized === null) return null;
  const url = new URL(normalized);
  if (!/^#(?:!|\/)/u.test(url.hash)) url.hash = "";
  return url.href;
}

export function watchtowerEligible(
  url: string,
  spaceId: string,
  settings: WatchtowerSettings,
): boolean {
  if (
    !settings.enabled ||
    settings.paused ||
    settings.excludedSpaces.includes(spaceId)
  )
    return false;
  const safe = watchtowerUrl(url);
  if (safe === null) return false;
  const host = new URL(safe).hostname.toLowerCase();
  return !settings.excludedHosts.some((value) => {
    const excluded = value.replace(/^\*\./u, "").replace(/^\./u, "");
    return (
      excluded !== "" && (host === excluded || host.endsWith(`.${excluded}`))
    );
  });
}
