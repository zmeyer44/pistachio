/**
 * Bookmarks: the THINGS a person saves while browsing, not the pages.
 *
 * A bookmark on a coffee maker's Amazon listing is about the coffee maker;
 * one on a Goodreads page is about the book. So a bookmark carries what the
 * page was about — its kind (product, book, article, recipe…), a title in
 * the thing's own name, a description, an image, the facts the page stated
 * (price, author, cook time), and the words a person would search for it
 * by — with the address kept alongside as the way back.
 *
 * Everything here is the pure half: the types, the caps, the sanitizers,
 * the readers that turn a page's metadata (Open Graph, JSON-LD, plain
 * <meta> tags) into a first draft, the HTML reader for a page the agent
 * names without a tab, and the search. main/bookmark-store.ts owns the
 * file; main/bookmark-extractor.ts owns the model that refines a draft;
 * the renderer only ever reads a snapshot and asks main for a change.
 */

/* --------------------------------- types -------------------------------- */

export const BOOKMARK_KINDS = [
  "website",
  "article",
  "product",
  "book",
  "movie",
  "show",
  "video",
  "music",
  "recipe",
  "place",
  "software",
  "other",
] as const;
export type BookmarkKind = (typeof BOOKMARK_KINDS)[number];

export const BOOKMARK_KIND_LABEL: Record<BookmarkKind, string> = {
  website: "Website",
  article: "Article",
  product: "Product",
  book: "Book",
  movie: "Movie",
  show: "TV show",
  video: "Video",
  music: "Music",
  recipe: "Recipe",
  place: "Place",
  software: "Software",
  other: "Other",
};

/** Plural, for filters and counts: "3 Books". */
export const BOOKMARK_KIND_PLURAL: Record<BookmarkKind, string> = {
  website: "Websites",
  article: "Articles",
  product: "Products",
  book: "Books",
  movie: "Movies",
  show: "TV shows",
  video: "Videos",
  music: "Music",
  recipe: "Recipes",
  place: "Places",
  software: "Software",
  other: "Other",
};

/** One fact the page stated about the thing: "Price" → "$129.99". */
export interface BookmarkDetail {
  label: string;
  value: string;
}

/**
 * `extracting` while the page is being read and the model consulted — the
 * skeleton card; `ready` once the fields are filled, however well.
 */
export type BookmarkStatus = "extracting" | "ready";
export const BOOKMARK_STATUSES: readonly BookmarkStatus[] = ["extracting", "ready"];

/**
 * Where the fields came from: the model read the page; only the page's own
 * metadata was read; or nothing could be read and the tab's title stands.
 */
export type BookmarkProvenance = "model" | "page" | "none";
export const BOOKMARK_PROVENANCES: readonly BookmarkProvenance[] = ["model", "page", "none"];

export const BOOKMARK_SOURCE_KINDS = ["user", "agent"] as const;
export type BookmarkSourceKind = (typeof BOOKMARK_SOURCE_KINDS)[number];

/** Who saved it: the person (a double tap of shift), or the agent in a run. */
export interface BookmarkSource {
  kind: BookmarkSourceKind;
  runId: string | null;
}

/** The fields extraction settles on, and the person may then edit. */
export interface BookmarkFields {
  kind: BookmarkKind;
  title: string;
  description: string;
  imageUrl: string | null;
  siteName: string;
  keywords: string[];
  details: BookmarkDetail[];
}

/** The fields a person can change by hand — the ones a later reading must not overwrite. */
export type BookmarkEditableField = keyof BookmarkPatch;
export const BOOKMARK_EDITABLE_FIELDS: readonly BookmarkEditableField[] = ["url", "title", "kind", "description", "imageUrl", "siteName", "keywords", "details", "note"];

export interface Bookmark extends BookmarkFields {
  id: string;
  /** The page's address — canonical when the page named one. */
  url: string;
  faviconUrl: string | null;
  /** The person's own words about why they kept it. */
  note: string;
  status: BookmarkStatus;
  provenance: BookmarkProvenance;
  /**
   * The fields changed by hand (or by the agent's own words), kept with the
   * bookmark so a reading of the page — now or after a restart — fills only
   * the rest.
   */
  editedFields: BookmarkEditableField[];
  source: BookmarkSource;
  createdAt: string;
  updatedAt: string;
}

export interface BookmarkDocument {
  version: 1;
  bookmarks: Bookmark[];
}

/** What the renderer holds. */
export interface BookmarkSnapshot {
  bookmarks: Bookmark[];
}

/** A creation request: the address, and whatever the caller already knows. */
export interface BookmarkInput {
  url: string;
  title?: string;
  kind?: BookmarkKind;
  description?: string;
  imageUrl?: string | null;
  faviconUrl?: string | null;
  siteName?: string;
  keywords?: string[];
  details?: BookmarkDetail[];
  note?: string;
}

export interface BookmarkPatch {
  url?: string;
  title?: string;
  kind?: BookmarkKind;
  description?: string;
  imageUrl?: string | null;
  siteName?: string;
  keywords?: string[];
  details?: BookmarkDetail[];
  note?: string;
}

/**
 * The card main shows above the page after a capture: which bookmark, and
 * whether it was already there (a second tap on a saved page shows the
 * existing card rather than making a twin).
 */
export interface BookmarkToast {
  id: string;
  existed: boolean;
  shownAt: string;
}

export const MAX_BOOKMARKS = 5_000;
export const MAX_BOOKMARK_URL = 2_048;
export const MAX_BOOKMARK_TITLE = 200;
export const MAX_BOOKMARK_DESCRIPTION = 1_000;
export const MAX_BOOKMARK_NOTE = 2_000;
export const MAX_BOOKMARK_SITE = 80;
export const MAX_BOOKMARK_KEYWORDS = 24;
export const MAX_BOOKMARK_KEYWORD = 40;
export const MAX_BOOKMARK_DETAILS = 12;
export const MAX_BOOKMARK_DETAIL_LABEL = 40;
export const MAX_BOOKMARK_DETAIL_VALUE = 200;

/** The one address the bookmarks page answers to. */
export const BOOKMARKS_URL = "pistachio://bookmarks";

export function isBookmarksUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "pistachio:" && url.host === "bookmarks";
  } catch {
    return false;
  }
}

/** Only web pages are bookmarked: the app's own pages are chrome, not things. */
export function isBookmarkableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/* ------------------------------ addresses ------------------------------- */

/**
 * Parameters that only ever say where a visit came from — the cross-site
 * trackers every analytics and mail tool appends. Nothing here selects
 * content on any site, so dropping it never changes the page.
 */
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|_ga|yclid|s_kwcid|_hsenc|_hsmi|vero_id|oly_[a-z_]+|wickedid|zanpid|srsltid)$/i;

/**
 * Amazon's search-tail and affiliate parameters, scoped to Amazon: `tag`,
 * `keywords`, and `ref` mean something else on other sites (a tag filter,
 * a search, a referenced item) and are left alone there.
 */
const AMAZON_PARAM = /^(tag|linkcode|camp|creative|creativeasin|ascsubtag|pd_rd_[a-z]+|pf_rd_[a-z]+|qid|sr|keywords|sprefix|crid|th|psc|ref|ref_|spm)$/i;

function isAmazonHost(hostname: string): boolean {
  return /(^|\.)amazon\.[a-z.]+$/.test(hostname);
}

/**
 * The address a bookmark keeps: tracking parameters gone, the fragment
 * gone, the host lowercased. Amazon's listing pages are reduced to the
 * product's own `/dp/<ASIN>` path, since the same coffee maker otherwise
 * has as many addresses as search results that led to it.
 */
export function cleanBookmarkUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return value.trim();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return url.toString();
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  const amazon = isAmazonHost(url.hostname);
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key) || (amazon && AMAZON_PARAM.test(key))) url.searchParams.delete(key);
  }
  if (amazon) {
    const asin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/.exec(url.pathname);
    if (asin?.[1] !== undefined) {
      url.pathname = `/dp/${asin[1]}`;
      url.search = "";
    }
  }
  return url.toString();
}

/**
 * Two addresses that name one page: cleaned, scheme-blind, `www.`-blind,
 * trailing-slash-blind. The path and query keep their case — `/Report`
 * and `/report` are different pages on most servers.
 */
export function bookmarkUrlKey(value: string): string {
  const cleaned = cleanBookmarkUrl(value);
  try {
    const url = new URL(cleaned);
    if (url.protocol !== "http:" && url.protocol !== "https:") return cleaned;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const port = url.port === "" ? "" : `:${url.port}`;
    return `${host}${port}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return cleaned;
  }
}

/** "amazon.com" for a page's address, or "" for none. */
export function bookmarkHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/* ------------------------------ the page -------------------------------- */

/**
 * A page as the capture script reports it — or as the HTML reader below
 * reconstructs it for a page the agent named without a tab. Meta names are
 * lowercased with `property` and `name` folded together, since sites use
 * either for the same tag.
 */
export interface PageSnapshot {
  url: string;
  title: string;
  lang: string;
  meta: Array<{ name: string; content: string }>;
  links: Array<{ rel: string; href: string }>;
  jsonLd: unknown[];
  /** The page's first <h1>, often the thing's own name where the title is SEO. */
  headline: string;
  /** Candidate pictures of the thing, best first — Open Graph's, then the page's largest. */
  images: string[];
  /** The visible text, collapsed, capped. */
  text: string;
}

export const MAX_PAGE_TEXT = 12_000;
export const MAX_PAGE_META = 160;
export const MAX_PAGE_IMAGES = 10;
export const MAX_PAGE_JSON_LD = 8;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function meta(snapshot: PageSnapshot, ...names: string[]): string {
  for (const name of names) {
    const hit = snapshot.meta.find((entry) => entry.name === name && entry.content !== "");
    if (hit !== undefined) return hit.content;
  }
  return "";
}

function metaAll(snapshot: PageSnapshot, name: string): string[] {
  return snapshot.meta.filter((entry) => entry.name === name && entry.content !== "").map((entry) => entry.content);
}

function link(snapshot: PageSnapshot, rel: string): string {
  return snapshot.links.find((entry) => entry.rel.split(/\s+/).includes(rel))?.href ?? "";
}

function absolute(raw: string, base: string): string | null {
  if (raw === "") return null;
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** JSON-LD nodes, flattened: a bare object, a list, or a @graph. */
export function jsonLdNodes(blocks: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const node = record(value);
    if (Object.keys(node).length === 0) return;
    out.push(node);
    if (Array.isArray(node["@graph"])) visit(node["@graph"], depth + 1);
    if (node["mainEntity"] !== undefined) visit(node["mainEntity"], depth + 1);
  };
  visit(blocks, 0);
  return out;
}

function typesOf(node: Record<string, unknown>): string[] {
  const type = node["@type"];
  const list = Array.isArray(type) ? type : [type];
  return list.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.replace(/^.*[/#]/, "").toLowerCase());
}

/** The JSON-LD @type values a kind answers to, most specific listed first. */
const JSON_LD_KIND: Array<[RegExp, BookmarkKind]> = [
  [/^recipe$/, "recipe"],
  [/^(book|audiobook)$/, "book"],
  [/^movie$/, "movie"],
  [/^(tvseries|tvseason|tvepisode)$/, "show"],
  [/^(videoobject|clip)$/, "video"],
  [/^(musicrecording|musicalbum|musicplaylist|musicgroup|podcastepisode|podcastseries|audioobject)$/, "music"],
  [/^(product|productgroup|individualproduct|productmodel|offer|vehicle|car)$/, "product"],
  [/^(softwareapplication|webapplication|mobileapplication|videogame|softwaresourcecode)$/, "software"],
  [/^(place|localbusiness|restaurant|cafeorcoffeeshop|bar|hotel|lodgingbusiness|touristattraction|store|museum|park|city|landmarksorhistoricalbuildings|eventvenue|event)$/, "place"],
  [/^(article|newsarticle|blogposting|techarticle|scholarlyarticle|report|howto|liveblogposting|analysisnewsarticle|reviewnewsarticle|opinionnewsarticle|discussionforumposting|question)$/, "article"],
];

/** Hosts whose pages are, by and large, one kind of thing. */
const HOST_KIND: Array<[RegExp, BookmarkKind]> = [
  [/(^|\.)amazon\.[a-z.]+$/, "product"],
  [/(^|\.)(ebay|etsy|walmart|target|bestbuy|homedepot|lowes|wayfair|ikea|newegg|bhphotovideo|aliexpress|temu|shein|zappos|nordstrom|costco|rei|sephora|ulta)\.[a-z.]+$/, "product"],
  [/(^|\.)(goodreads|storygraph|thestorygraph|bookshop|audible|librarything|openlibrary)\.[a-z.]+$/, "book"],
  [/(^|\.)(imdb|letterboxd|rottentomatoes|metacritic|themoviedb|justwatch)\.[a-z.]+$/, "movie"],
  [/(^|\.)(youtube|youtu|vimeo|twitch|dailymotion|tiktok)\.[a-z.]+$/, "video"],
  [/(^|\.)(spotify|bandcamp|soundcloud|music\.apple|tidal|deezer|last)\.[a-z.]+$/, "music"],
  [/(^|\.)(allrecipes|seriouseats|bonappetit|epicurious|food52|foodnetwork|budgetbytes|simplyrecipes|smittenkitchen|cooking\.nytimes|delish|tasty)\.[a-z.]+$/, "recipe"],
  [/(^|\.)(github|gitlab|npmjs|pypi|crates|apps\.apple|play\.google|producthunt|alternativeto)\.[a-z.]+$/, "software"],
  [/(^|\.)(yelp|tripadvisor|maps\.google|google\.[a-z.]+\/maps|foursquare|airbnb|booking|opentable|resy)\.[a-z.]+$/, "place"],
  [/(^|\.)(medium|substack|nytimes|washingtonpost|theguardian|bbc|theatlantic|newyorker|wired|arstechnica|theverge|techcrunch|bloomberg|reuters|apnews|economist|wsj|ft)\.[a-z.]+$/, "article"],
];

function kindFromOgType(value: string): BookmarkKind | null {
  const type = value.trim().toLowerCase();
  if (type === "") return null;
  if (type === "book" || type.startsWith("books.")) return "book";
  if (type === "video.movie") return "movie";
  if (type === "video.tv_show" || type === "video.episode") return "show";
  if (type.startsWith("video")) return "video";
  if (type.startsWith("music")) return "music";
  if (type === "product" || type.startsWith("product.") || type === "og:product") return "product";
  if (type === "article" || type === "blog" || type === "news") return "article";
  if (type === "place" || type === "restaurant" || type.startsWith("restaurant.") || type === "business.business" || type === "hotel") return "place";
  if (type === "recipe") return "recipe";
  if (type === "app" || type === "software" || type === "game") return "software";
  return null;
}

/**
 * What kind of thing the page is about, from the strongest signal down:
 * JSON-LD's own type, Open Graph's, the host, then the tags a kind leaves
 * behind (a price makes a product; a byline makes an article).
 */
export function detectKind(snapshot: PageSnapshot): BookmarkKind {
  const nodes = jsonLdNodes(snapshot.jsonLd);
  const types = nodes.flatMap(typesOf);
  for (const [pattern, kind] of JSON_LD_KIND) {
    if (types.some((type) => pattern.test(type))) return kind;
  }
  const og = kindFromOgType(meta(snapshot, "og:type"));
  if (og !== null) return og;
  const host = bookmarkHost(snapshot.url);
  for (const [pattern, kind] of HOST_KIND) {
    if (pattern.test(host) || pattern.test(`${host}${pathOf(snapshot.url)}`)) return kind;
  }
  const price = meta(snapshot, "product:price:amount", "og:price:amount", "price");
  if (price !== "" && /\d/.test(price)) return "product";
  if (meta(snapshot, "article:published_time", "article:author", "author", "citation_title", "dc.creator", "parsely-type") !== "") return "article";
  if (metaAll(snapshot, "article:tag").length > 0) return "article";
  return "website";
}

function pathOf(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}

const TITLE_SEPARATORS = /\s+[|\-–—:·»]\s+/;

/**
 * The thing's name out of a page title. Sites append or prepend themselves
 * ("Amazon.com: Breville …", "Project Hail Mary | Goodreads"); the segment
 * naming the site goes, and so does a trailing category tail Amazon adds.
 */
export function cleanTitle(raw: string, siteName: string, host: string): string {
  let title = raw.replace(/\s+/g, " ").trim();
  if (title === "") return "";
  const site = siteName.trim().toLowerCase();
  const base = host.split(".")[0]?.toLowerCase() ?? "";
  const namesSite = (segment: string): boolean => {
    const value = segment.trim().toLowerCase();
    if (value === "") return true;
    if (site !== "" && (value === site || value === `${site}.com` || (site.startsWith(value) && value.length >= 4))) return true;
    if (base !== "" && (value === base || value === host.toLowerCase() || value === `${base}.com`)) return true;
    if (host !== "" && value.endsWith(host.toLowerCase())) return true;
    return false;
  };
  // "Amazon.com: Nice Mug" — the site as a prefix, colon and all.
  const prefix = /^([^:|\-–—]{2,60}):\s+/.exec(title);
  if (prefix?.[1] !== undefined && namesSite(prefix[1])) title = title.slice(prefix[0].length).trim();
  const parts = title.split(TITLE_SEPARATORS);
  if (parts.length > 1) {
    const kept = parts.filter((part, index) => !((index === 0 || index === parts.length - 1) && namesSite(part)));
    if (kept.length > 0 && kept.length < parts.length) title = kept.join(" · ");
    else if (parts.length > 2 && /(^|\.)amazon\./.test(host)) title = parts.slice(0, -1).filter((part) => !namesSite(part)).join(" · ") || title;
  }
  // "Amazon.com : Category" tails and "(1,234)" review counts are not names.
  title = title.replace(/\s*:\s*[A-Z][\w &'-]{2,40}$/u, (tail) => (/(^|\.)amazon\./.test(host) ? "" : tail)).trim();
  return title.slice(0, MAX_BOOKMARK_TITLE);
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found !== "") return found;
    }
    return "";
  }
  const node = record(value);
  for (const key of ["name", "@value", "url", "contentUrl", "text"]) {
    const candidate = node[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return "";
}

function names(value: unknown, limit = 3): string {
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((item) => firstString(item))
    .filter((name) => name !== "")
    .slice(0, limit)
    .join(", ");
}

/** "PT2H10M" → "2h 10m"; "PT45M" → "45m"; a plain string stays as it was. */
export function humanDuration(value: string): string {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(value.trim());
  if (match === null) return value.trim();
  const [, days, hours, minutes, seconds] = match;
  const parts: string[] = [];
  if (days !== undefined) parts.push(`${days}d`);
  if (hours !== undefined) parts.push(`${hours}h`);
  if (minutes !== undefined) parts.push(`${minutes}m`);
  if (parts.length === 0 && seconds !== undefined) parts.push(`${seconds}s`);
  return parts.join(" ") || value.trim();
}

function yearOf(value: string): string {
  const match = /^(\d{4})/.exec(value.trim());
  return match?.[1] ?? value.trim();
}

const CURRENCY_SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CAD: "CA$", AUD: "A$", INR: "₹", CNY: "¥", KRW: "₩", CHF: "CHF ", SEK: "kr ", MXN: "MX$", BRL: "R$" };

export function formatPrice(amount: string, currency: string): string {
  const value = amount.trim().replace(/^[^\d.,-]+/, "");
  if (value === "") return "";
  const code = currency.trim().toUpperCase();
  const symbol = CURRENCY_SYMBOL[code];
  if (symbol !== undefined) return `${symbol}${value}`;
  return code === "" ? value : `${value} ${code}`;
}

function offerPrice(offers: unknown): string {
  const list = Array.isArray(offers) ? offers : [offers];
  for (const item of list) {
    const offer = record(item);
    const price = firstString(offer["price"] ?? offer["lowPrice"]);
    const currency = firstString(offer["priceCurrency"]);
    const spec = record(offer["priceSpecification"]);
    const specPrice = firstString(spec["price"]);
    if (price !== "") return formatPrice(price, currency);
    if (specPrice !== "") return formatPrice(specPrice, firstString(spec["priceCurrency"]));
  }
  return "";
}

function rating(node: Record<string, unknown>): string {
  const aggregate = record(node["aggregateRating"]);
  const value = firstString(aggregate["ratingValue"]);
  if (value === "") return "";
  const count = firstString(aggregate["ratingCount"] ?? aggregate["reviewCount"]);
  const rounded = Number.isFinite(Number(value)) ? String(Math.round(Number(value) * 10) / 10) : value;
  return count === "" ? `${rounded} / 5` : `${rounded} / 5 (${Number(count).toLocaleString("en-US")})`;
}

function push(details: BookmarkDetail[], label: string, value: string): void {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean === "" || details.some((detail) => detail.label === label)) return;
  details.push({ label, value: clean.slice(0, MAX_BOOKMARK_DETAIL_VALUE) });
}

/**
 * The facts the page stated about the thing, by kind: the price and brand
 * of a product, the author of a book, the cook time of a recipe. JSON-LD
 * first, since it is structured; the Open Graph verticals fill the gaps.
 */
export function detailsFromPage(snapshot: PageSnapshot, kind: BookmarkKind): BookmarkDetail[] {
  const details: BookmarkDetail[] = [];
  const nodes = jsonLdNodes(snapshot.jsonLd);
  const node = nodes.find((candidate) => JSON_LD_KIND.some(([pattern, k]) => k === kind && typesOf(candidate).some((type) => pattern.test(type)))) ?? nodes[0] ?? {};
  const author = names(node["author"] ?? node["creator"]);
  switch (kind) {
    case "product":
      push(details, "Price", offerPrice(node["offers"]) || formatPrice(meta(snapshot, "product:price:amount", "og:price:amount"), meta(snapshot, "product:price:currency", "og:price:currency")));
      push(details, "Brand", firstString(node["brand"]) || meta(snapshot, "product:brand", "brand"));
      push(details, "Rating", rating(node));
      push(details, "Availability", firstString(record(Array.isArray(node["offers"]) ? node["offers"][0] : node["offers"])["availability"]).replace(/^.*\//, "").replace(/([a-z])([A-Z])/g, "$1 $2"));
      push(details, "Model", firstString(node["model"] ?? node["mpn"]));
      break;
    case "book":
      push(details, "Author", author || meta(snapshot, "book:author", "author"));
      push(details, "Published", yearOf(firstString(node["datePublished"]) || meta(snapshot, "book:release_date")));
      push(details, "Pages", firstString(node["numberOfPages"]));
      push(details, "ISBN", firstString(node["isbn"]) || meta(snapshot, "book:isbn"));
      push(details, "Rating", rating(node));
      break;
    case "movie":
    case "show":
      push(details, "Director", names(node["director"]) || meta(snapshot, "video:director"));
      push(details, "Starring", names(node["actor"], 4) || metaAll(snapshot, "video:actor").slice(0, 4).join(", "));
      push(details, "Year", yearOf(firstString(node["datePublished"] ?? node["dateCreated"]) || meta(snapshot, "video:release_date")));
      push(details, "Runtime", humanDuration(firstString(node["duration"]) || meta(snapshot, "video:duration")));
      push(details, "Genre", names(node["genre"]));
      push(details, "Rating", rating(node));
      break;
    case "video":
      push(details, "Channel", author || names(record(node["publisher"])["name"]));
      push(details, "Duration", humanDuration(firstString(node["duration"]) || meta(snapshot, "video:duration")));
      push(details, "Published", yearOf(firstString(node["uploadDate"] ?? node["datePublished"])).slice(0, 10));
      break;
    case "music":
      push(details, "Artist", names(node["byArtist"]) || meta(snapshot, "music:musician") || author);
      push(details, "Album", firstString(node["inAlbum"]) || meta(snapshot, "music:album"));
      push(details, "Duration", humanDuration(firstString(node["duration"]) || meta(snapshot, "music:duration")));
      push(details, "Released", yearOf(firstString(node["datePublished"]) || meta(snapshot, "music:release_date")));
      break;
    case "recipe":
      push(details, "Total time", humanDuration(firstString(node["totalTime"])));
      push(details, "Prep", humanDuration(firstString(node["prepTime"])));
      push(details, "Cook", humanDuration(firstString(node["cookTime"])));
      push(details, "Serves", firstString(node["recipeYield"]));
      push(details, "Cuisine", names(node["recipeCuisine"]));
      push(details, "Course", names(node["recipeCategory"]));
      push(details, "By", author);
      push(details, "Rating", rating(node));
      break;
    case "place": {
      const address = record(node["address"]);
      push(details, "Address", typeof node["address"] === "string" ? node["address"] : [address["streetAddress"], address["addressLocality"], address["addressRegion"]].map(firstString).filter(Boolean).join(", "));
      push(details, "Cuisine", names(node["servesCuisine"]));
      push(details, "Price", firstString(node["priceRange"]));
      push(details, "Phone", firstString(node["telephone"]));
      push(details, "Rating", rating(node));
      break;
    }
    case "software":
      push(details, "Category", firstString(node["applicationCategory"]));
      push(details, "Platform", names(node["operatingSystem"]));
      push(details, "Price", offerPrice(node["offers"]));
      push(details, "Rating", rating(node));
      push(details, "By", author);
      break;
    case "article":
      push(details, "By", author || meta(snapshot, "article:author", "author", "dc.creator", "parsely-author"));
      push(details, "Published", (firstString(node["datePublished"]) || meta(snapshot, "article:published_time", "date", "dc.date", "parsely-pub-date")).slice(0, 10));
      push(details, "Publisher", firstString(record(node["publisher"])["name"]) || meta(snapshot, "og:site_name"));
      push(details, "Section", meta(snapshot, "article:section") || names(node["articleSection"]));
      break;
    case "website":
    case "other":
      break;
  }
  return details.slice(0, MAX_BOOKMARK_DETAILS);
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in into is it its of on or that the this to was were will with you your our not new best top free online official home page site www com".split(" "),
);

function keywordOf(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_BOOKMARK_KEYWORD);
}

function splitList(value: string): string[] {
  return value.split(/[,;|]/).map(keywordOf).filter((entry) => entry !== "");
}

/**
 * The words a person would search for the thing by: the page's own tags,
 * the facts (a brand, an author, a genre), the site, the kind, and the
 * distinctive words of the title. Lowercased, deduplicated, capped.
 */
export function keywordsFromPage(snapshot: PageSnapshot, fields: Omit<BookmarkFields, "keywords">): string[] {
  const nodes = jsonLdNodes(snapshot.jsonLd);
  const out: string[] = [];
  const add = (value: string): void => {
    const keyword = keywordOf(value);
    if (keyword === "" || keyword.length < 2 || out.includes(keyword)) return;
    if (out.length < MAX_BOOKMARK_KEYWORDS) out.push(keyword);
  };
  for (const tag of metaAll(snapshot, "article:tag")) add(tag);
  for (const tag of metaAll(snapshot, "video:tag")) add(tag);
  for (const csv of [meta(snapshot, "keywords", "news_keywords", "parsely-tags")]) for (const entry of splitList(csv).slice(0, 10)) add(entry);
  for (const node of nodes) {
    const keywords = node["keywords"];
    if (typeof keywords === "string") for (const entry of splitList(keywords).slice(0, 8)) add(entry);
    else if (Array.isArray(keywords)) for (const entry of keywords.slice(0, 8)) add(firstString(entry));
    for (const key of ["genre", "recipeCategory", "recipeCuisine", "applicationCategory", "category", "articleSection"]) {
      const value = node[key];
      if (Array.isArray(value)) for (const entry of value.slice(0, 4)) add(firstString(entry));
      else if (typeof value === "string") add(value);
    }
  }
  for (const detail of fields.details) {
    if (["Brand", "Author", "By", "Director", "Artist", "Channel", "Cuisine", "Course", "Genre", "Publisher", "Platform", "Category", "Starring", "Section"].includes(detail.label)) {
      for (const part of detail.value.split(",").slice(0, 3)) add(part);
    }
  }
  add(BOOKMARK_KIND_LABEL[fields.kind]);
  if (fields.siteName !== "") add(fields.siteName);
  for (const word of fields.title.toLowerCase().split(/[^\p{L}\p{N}'’+-]+/u)) {
    if (word.length >= 4 && !STOPWORDS.has(word)) add(word);
  }
  return out;
}

/** og:site_name, the publisher's name, or the host. */
export function siteNameFromPage(snapshot: PageSnapshot): string {
  const declared = meta(snapshot, "og:site_name", "application-name", "apple-mobile-web-app-title", "twitter:site");
  if (declared !== "" && !declared.startsWith("@")) return declared.slice(0, MAX_BOOKMARK_SITE);
  for (const node of jsonLdNodes(snapshot.jsonLd)) {
    const publisher = firstString(record(node["publisher"])["name"]);
    if (publisher !== "") return publisher.slice(0, MAX_BOOKMARK_SITE);
  }
  return bookmarkHost(snapshot.url).slice(0, MAX_BOOKMARK_SITE);
}

/** The best picture of the thing: Open Graph's, JSON-LD's, then the page's largest. */
export function imageFromPage(snapshot: PageSnapshot): string | null {
  const declared = [
    meta(snapshot, "og:image:secure_url", "og:image", "og:image:url"),
    meta(snapshot, "twitter:image", "twitter:image:src"),
    link(snapshot, "image_src"),
  ];
  for (const candidate of declared) {
    const url = absolute(candidate, snapshot.url);
    if (url !== null) return url;
  }
  for (const node of jsonLdNodes(snapshot.jsonLd)) {
    const url = absolute(firstString(node["image"] ?? node["thumbnailUrl"] ?? node["logo"]), snapshot.url);
    if (url !== null) return url;
  }
  for (const candidate of snapshot.images) {
    const url = absolute(candidate, snapshot.url);
    if (url !== null) return url;
  }
  return null;
}

/** Every picture worth offering the model, best first, without repeats. */
export function imageCandidates(snapshot: PageSnapshot): string[] {
  const out: string[] = [];
  const add = (raw: string): void => {
    const url = absolute(raw, snapshot.url);
    if (url !== null && !out.includes(url) && out.length < MAX_PAGE_IMAGES) out.push(url);
  };
  for (const name of ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"]) for (const value of metaAll(snapshot, name)) add(value);
  add(link(snapshot, "image_src"));
  for (const node of jsonLdNodes(snapshot.jsonLd)) {
    const image = node["image"] ?? node["thumbnailUrl"];
    if (Array.isArray(image)) for (const entry of image.slice(0, 3)) add(firstString(entry));
    else add(firstString(image));
  }
  for (const candidate of snapshot.images) add(candidate);
  return out;
}

export function descriptionFromPage(snapshot: PageSnapshot): string {
  const declared = meta(snapshot, "og:description", "twitter:description", "description", "dc.description");
  if (declared !== "") return declared.replace(/\s+/g, " ").trim().slice(0, MAX_BOOKMARK_DESCRIPTION);
  for (const node of jsonLdNodes(snapshot.jsonLd)) {
    const description = firstString(node["description"] ?? node["abstract"]);
    if (description !== "") return description.replace(/\s+/g, " ").trim().slice(0, MAX_BOOKMARK_DESCRIPTION);
  }
  const text = snapshot.text.replace(/\s+/g, " ").trim();
  if (text === "") return "";
  const cut = text.slice(0, 280);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (end > 80 ? cut.slice(0, end + 1) : text.length > 280 ? `${cut.trimEnd()}…` : cut).slice(0, MAX_BOOKMARK_DESCRIPTION);
}

export function titleFromPage(snapshot: PageSnapshot, siteName: string): string {
  const host = bookmarkHost(snapshot.url);
  const nodes = jsonLdNodes(snapshot.jsonLd);
  const structured = nodes.map((node) => firstString(node["name"] ?? node["headline"])).find((name) => name !== "" && name.length <= MAX_BOOKMARK_TITLE) ?? "";
  const candidates = [meta(snapshot, "og:title", "twitter:title"), structured, snapshot.headline, snapshot.title];
  for (const candidate of candidates) {
    const cleaned = cleanTitle(candidate, siteName, host);
    if (cleaned !== "") return cleaned;
  }
  return host || snapshot.url.slice(0, MAX_BOOKMARK_TITLE);
}

/** The page's own address for itself, when it names one; the given address otherwise. */
export function canonicalUrl(snapshot: PageSnapshot): string {
  const canonical = absolute(link(snapshot, "canonical") || meta(snapshot, "og:url"), snapshot.url);
  if (canonical === null) return cleanBookmarkUrl(snapshot.url);
  // A canonical that points at the site's front page (a lazy template) is
  // not this page's address.
  try {
    const own = new URL(snapshot.url);
    const declared = new URL(canonical);
    if (declared.hostname.replace(/^www\./, "") !== own.hostname.replace(/^www\./, "")) return cleanBookmarkUrl(snapshot.url);
    if (declared.pathname === "/" && own.pathname !== "/") return cleanBookmarkUrl(snapshot.url);
  } catch {
    return cleanBookmarkUrl(snapshot.url);
  }
  return cleanBookmarkUrl(canonical);
}

/**
 * A first draft from what the page says about itself: no model, no
 * network, deterministic. What the skeleton card becomes when no model is
 * configured, and what the model starts from when one is.
 */
export function draftFromPage(snapshot: PageSnapshot): BookmarkFields {
  const kind = detectKind(snapshot);
  const siteName = siteNameFromPage(snapshot);
  const title = titleFromPage(snapshot, siteName);
  const description = descriptionFromPage(snapshot);
  const imageUrl = imageFromPage(snapshot);
  const details = detailsFromPage(snapshot, kind);
  const fields = { kind, title, description, imageUrl, siteName, details };
  return { ...fields, keywords: keywordsFromPage(snapshot, fields) };
}

/* ------------------------------ from html ------------------------------- */

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " })[name] ?? "");
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag)) !== null) {
    const [, name, double, single, bare] = match;
    if (name === undefined) continue;
    out[name.toLowerCase()] = decodeEntities(double ?? single ?? bare ?? "");
  }
  return out;
}

/**
 * A page snapshot out of raw HTML, for a page the agent names that is not
 * open in a tab. A reading, not a parse: tags are found by pattern, which
 * is enough for <meta>, <link>, JSON-LD, the title, the first heading, and
 * a text excerpt with the markup stripped. Never throws.
 */
export function pageSnapshotFromHtml(html: string, url: string): PageSnapshot {
  const head = html.slice(0, 400_000);
  const metaTags: PageSnapshot["meta"] = [];
  for (const match of head.matchAll(/<meta\s+([^>]*?)\/?>/gi)) {
    const attrs = attributes(match[1] ?? "");
    const name = (attrs["property"] ?? attrs["name"] ?? attrs["itemprop"] ?? "").trim().toLowerCase();
    const content = (attrs["content"] ?? "").trim();
    if (name !== "" && content !== "") metaTags.push({ name, content });
    if (metaTags.length >= MAX_PAGE_META) break;
  }
  const links: PageSnapshot["links"] = [];
  for (const match of head.matchAll(/<link\s+([^>]*?)\/?>/gi)) {
    const attrs = attributes(match[1] ?? "");
    const rel = (attrs["rel"] ?? "").trim().toLowerCase();
    const href = absolute(attrs["href"] ?? "", url);
    if (rel !== "" && href !== null) links.push({ rel, href });
    if (links.length >= 40) break;
  }
  const jsonLd: unknown[] = [];
  for (const match of head.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      jsonLd.push(JSON.parse((match[1] ?? "").trim()));
    } catch {
      // A malformed block is one the page itself could not have used.
    }
    if (jsonLd.length >= MAX_PAGE_JSON_LD) break;
  }
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const headline = decodeEntities((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 300);
  const lang = attributes(/<html\s+([^>]*)>/i.exec(head)?.[1] ?? "")["lang"] ?? "";
  const images: string[] = [];
  for (const match of html.matchAll(/<img\s+([^>]*?)\/?>/gi)) {
    const attrs = attributes(match[1] ?? "");
    const src = absolute(attrs["src"] ?? attrs["data-src"] ?? "", url);
    const width = Number(attrs["width"] ?? "0");
    const height = Number(attrs["height"] ?? "0");
    if (src === null || images.includes(src)) continue;
    if ((width > 0 && width < 120) || (height > 0 && height < 120)) continue;
    if (/\b(sprite|icon|logo|pixel|spacer|tracking|badge)\b/i.test(src)) continue;
    images.push(src);
    if (images.length >= MAX_PAGE_IMAGES) break;
  }
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = decodeEntities(
    body
      .replace(/<(script|style|noscript|template|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
    .slice(0, MAX_PAGE_TEXT);
  return { url, title, lang, meta: metaTags, links, jsonLd, headline, images, text };
}

/* ------------------------------ sanitizing ------------------------------ */

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function line(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function prose(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "";
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** An http(s) address, or null. */
export function sanitizeWebUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_BOOKMARK_URL) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function sanitizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const keyword = keywordOf(typeof entry === "string" ? entry : "");
    if (keyword !== "" && !out.includes(keyword)) out.push(keyword);
    if (out.length === MAX_BOOKMARK_KEYWORDS) break;
  }
  return out;
}

export function sanitizeDetails(value: unknown): BookmarkDetail[] {
  if (!Array.isArray(value)) return [];
  const out: BookmarkDetail[] = [];
  for (const entry of value) {
    const raw = record(entry);
    const label = line(raw["label"], MAX_BOOKMARK_DETAIL_LABEL);
    const detail = line(raw["value"], MAX_BOOKMARK_DETAIL_VALUE);
    if (label === "" || detail === "" || out.some((existing) => existing.label.toLowerCase() === label.toLowerCase())) continue;
    out.push({ label, value: detail });
    if (out.length === MAX_BOOKMARK_DETAILS) break;
  }
  return out;
}

export function sanitizeEditedFields(value: unknown): BookmarkEditableField[] {
  if (!Array.isArray(value)) return [];
  return BOOKMARK_EDITABLE_FIELDS.filter((field) => value.includes(field));
}

export function sanitizeBookmarkSource(value: unknown): BookmarkSource {
  const raw = record(value);
  const runId = typeof raw["runId"] === "string" && ID.test(raw["runId"]) ? raw["runId"] : null;
  return { kind: oneOf(raw["kind"], BOOKMARK_SOURCE_KINDS, "user"), runId };
}

/** A creation request from the renderer or the agent, or null when it has no address. */
export function sanitizeBookmarkInput(value: unknown): BookmarkInput | null {
  const raw = record(value);
  const url = sanitizeWebUrl(raw["url"]);
  if (url === null) return null;
  const input: BookmarkInput = { url };
  const title = line(raw["title"], MAX_BOOKMARK_TITLE);
  if (title !== "") input.title = title;
  if (raw["kind"] !== undefined) input.kind = oneOf(raw["kind"], BOOKMARK_KINDS, "other");
  const description = prose(raw["description"], MAX_BOOKMARK_DESCRIPTION);
  if (description !== "") input.description = description;
  if (raw["imageUrl"] !== undefined) input.imageUrl = sanitizeWebUrl(raw["imageUrl"]);
  if (raw["faviconUrl"] !== undefined) input.faviconUrl = sanitizeWebUrl(raw["faviconUrl"]);
  const siteName = line(raw["siteName"], MAX_BOOKMARK_SITE);
  if (siteName !== "") input.siteName = siteName;
  if (raw["keywords"] !== undefined) input.keywords = sanitizeKeywords(raw["keywords"]);
  if (raw["details"] !== undefined) input.details = sanitizeDetails(raw["details"]);
  const note = prose(raw["note"], MAX_BOOKMARK_NOTE);
  if (note !== "") input.note = note;
  return input;
}

export function sanitizeBookmarkPatch(value: unknown): BookmarkPatch {
  const raw = record(value);
  const patch: BookmarkPatch = {};
  if (raw["url"] !== undefined) {
    const url = sanitizeWebUrl(raw["url"]);
    if (url !== null) patch.url = url;
  }
  if (raw["title"] !== undefined) {
    const title = line(raw["title"], MAX_BOOKMARK_TITLE);
    if (title !== "") patch.title = title;
  }
  if (raw["kind"] !== undefined && (BOOKMARK_KINDS as readonly unknown[]).includes(raw["kind"])) patch.kind = raw["kind"] as BookmarkKind;
  if (raw["description"] !== undefined) patch.description = prose(raw["description"], MAX_BOOKMARK_DESCRIPTION);
  if (raw["imageUrl"] !== undefined) patch.imageUrl = sanitizeWebUrl(raw["imageUrl"]);
  if (raw["siteName"] !== undefined) patch.siteName = line(raw["siteName"], MAX_BOOKMARK_SITE);
  if (raw["keywords"] !== undefined) patch.keywords = sanitizeKeywords(raw["keywords"]);
  if (raw["details"] !== undefined) patch.details = sanitizeDetails(raw["details"]);
  if (raw["note"] !== undefined) patch.note = prose(raw["note"], MAX_BOOKMARK_NOTE);
  return patch;
}

export function sanitizeBookmark(value: unknown): Bookmark | null {
  const raw = record(value);
  const id = typeof raw["id"] === "string" && ID.test(raw["id"]) ? raw["id"] : null;
  const url = sanitizeWebUrl(raw["url"]);
  const createdAt = isoOrNull(raw["createdAt"]);
  if (id === null || url === null || createdAt === null) return null;
  return {
    id,
    url,
    kind: oneOf(raw["kind"], BOOKMARK_KINDS, "website"),
    title: line(raw["title"], MAX_BOOKMARK_TITLE) || bookmarkHost(url) || url,
    description: prose(raw["description"], MAX_BOOKMARK_DESCRIPTION),
    imageUrl: sanitizeWebUrl(raw["imageUrl"]),
    faviconUrl: sanitizeWebUrl(raw["faviconUrl"]),
    siteName: line(raw["siteName"], MAX_BOOKMARK_SITE),
    keywords: sanitizeKeywords(raw["keywords"]),
    details: sanitizeDetails(raw["details"]),
    note: prose(raw["note"], MAX_BOOKMARK_NOTE),
    // A file written mid-extraction reopens as ready: the extraction it
    // was waiting on died with the process, and what it has is what it has.
    status: "ready",
    provenance: oneOf(raw["provenance"], BOOKMARK_PROVENANCES, "none"),
    editedFields: sanitizeEditedFields(raw["editedFields"]),
    source: sanitizeBookmarkSource(raw["source"]),
    createdAt,
    updatedAt: isoOrNull(raw["updatedAt"]) ?? createdAt,
  };
}

/** The whole file. Every record stands or falls on its own. */
export function sanitizeBookmarkDocument(value: unknown): BookmarkDocument {
  const raw = record(value);
  const bookmarks = (Array.isArray(raw["bookmarks"]) ? (raw["bookmarks"] as unknown[]) : [])
    .map(sanitizeBookmark)
    .filter((entry): entry is Bookmark => entry !== null);
  const seen = new Set<string>();
  return {
    version: 1,
    bookmarks: bookmarks.filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true))),
  };
}

/* -------------------------------- search -------------------------------- */

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function fieldScore(field: string, token: string, weight: number): number {
  if (field === "") return 0;
  if (field === token) return weight * 3;
  if (field.startsWith(token)) return weight * 2;
  const at = field.indexOf(token);
  if (at < 0) return 0;
  const boundary = at === 0 || !/[\p{L}\p{N}]/u.test(field[at - 1] ?? "");
  return boundary ? weight * 1.5 : weight;
}

/** How well a bookmark answers a query; 0 when some word of it matches nothing. */
export function bookmarkScore(bookmark: Bookmark, query: string): number {
  const tokens = normalize(query).split(" ").filter((token) => token !== "");
  if (tokens.length === 0) return 0;
  const fields: Array<[string, number]> = [
    [normalize(bookmark.title), 10],
    [normalize(bookmark.note), 6],
    [normalize(bookmark.siteName), 5],
    [normalize(BOOKMARK_KIND_LABEL[bookmark.kind]), 5],
    [normalize(BOOKMARK_KIND_PLURAL[bookmark.kind]), 5],
    [normalize(bookmarkHost(bookmark.url)), 4],
    [normalize(bookmark.description), 3],
    ...bookmark.keywords.map((keyword): [string, number] => [normalize(keyword), 7]),
    ...bookmark.details.map((detail): [string, number] => [normalize(`${detail.label} ${detail.value}`), 4]),
  ];
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const [field, weight] of fields) best = Math.max(best, fieldScore(field, token, weight));
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

export interface BookmarkSearchOptions {
  kind?: BookmarkKind | null;
  /** Only bookmarks from this host (an "amazon.com" filter on the page). */
  host?: string | null;
  limit?: number;
}

/**
 * Bookmarks answering a query, best first — newest first when the query
 * is empty. One search for the page and the agent, so "the coffee maker I
 * saved" finds the same card either way.
 */
export function searchBookmarks(bookmarks: Bookmark[], query: string, options: BookmarkSearchOptions = {}): Bookmark[] {
  const kind = options.kind ?? null;
  const host = options.host ?? null;
  const limit = options.limit ?? 100;
  const pool = bookmarks.filter((bookmark) => (kind === null || bookmark.kind === kind) && (host === null || bookmarkHost(bookmark.url) === host));
  if (normalize(query) === "") {
    return [...pool].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit);
  }
  return pool
    .map((bookmark) => ({ bookmark, score: bookmarkScore(bookmark, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.bookmark.createdAt) - Date.parse(a.bookmark.createdAt))
    .slice(0, limit)
    .map((entry) => entry.bookmark);
}

/** The hosts represented, most bookmarked first — the page's site filter. */
export function bookmarkHosts(bookmarks: Bookmark[]): Array<{ host: string; count: number }> {
  const counts = new Map<string, number>();
  for (const bookmark of bookmarks) {
    const host = bookmarkHost(bookmark.url);
    if (host !== "") counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

/* ------------------------------ the tool shape --------------------------- */

/** The bookmark as the agent sees it: enough to cite, open, and change. */
export interface BookmarkToolView {
  id: string;
  url: string;
  kind: BookmarkKind;
  title: string;
  description: string;
  siteName: string;
  keywords: string[];
  details: BookmarkDetail[];
  note: string;
  imageUrl: string | null;
  savedAt: string;
}

export function bookmarkToolView(bookmark: Bookmark): BookmarkToolView {
  return {
    id: bookmark.id,
    url: bookmark.url,
    kind: bookmark.kind,
    title: bookmark.title,
    description: bookmark.description,
    siteName: bookmark.siteName,
    keywords: bookmark.keywords,
    details: bookmark.details,
    note: bookmark.note,
    imageUrl: bookmark.imageUrl,
    savedAt: bookmark.createdAt,
  };
}

/** "Breville Barista Express — Product on amazon.com, $699.95". */
export function describeBookmark(bookmark: Bookmark): string {
  const facts = bookmark.details.slice(0, 2).map((detail) => detail.value).join(", ");
  const where = bookmark.siteName || bookmarkHost(bookmark.url);
  return `${bookmark.title} — ${BOOKMARK_KIND_LABEL[bookmark.kind]}${where === "" ? "" : ` on ${where}`}${facts === "" ? "" : `, ${facts}`}`;
}
