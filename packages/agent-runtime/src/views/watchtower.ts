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
});
export type WatchtowerSettings = z.infer<typeof watchtowerSettingsSchema>;
export const DEFAULT_WATCHTOWER_SETTINGS = watchtowerSettingsSchema.parse({});

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
}
export interface WatchtowerDocument extends WatchtowerHit {
  markdown: string;
  blocks: string[];
  history: WatchtowerHit[];
  links: { url: string; text: string; observationId?: string }[];
  backlinks: WatchtowerHit[];
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
}

/** A deliberately narrow, Space-bound host; archive text is untrusted evidence. */
export interface WatchtowerToolHost {
  search(query: string): Promise<WatchtowerHit[]>;
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
