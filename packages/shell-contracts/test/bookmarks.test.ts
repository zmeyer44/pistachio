import { describe, expect, it } from "vitest";
import {
  bookmarkHosts,
  bookmarkScore,
  bookmarkUrlKey,
  canonicalUrl,
  cleanBookmarkUrl,
  cleanTitle,
  detectKind,
  detailsFromPage,
  draftFromPage,
  formatPrice,
  humanDuration,
  imageCandidates,
  isBookmarkableUrl,
  isBookmarksUrl,
  pageSnapshotFromHtml,
  sanitizeBookmarkDocument,
  sanitizeBookmarkInput,
  sanitizeBookmarkPatch,
  searchBookmarks,
  type Bookmark,
  type PageSnapshot,
} from "../src/bookmarks.js";

function page(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: "https://example.com/thing",
    title: "Thing",
    lang: "en",
    meta: [],
    links: [],
    jsonLd: [],
    headline: "",
    images: [],
    text: "",
    ...overrides,
  };
}

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: overrides.id ?? "b1",
    url: "https://example.com/thing",
    kind: "website",
    title: "Thing",
    description: "",
    imageUrl: null,
    faviconUrl: null,
    siteName: "",
    keywords: [],
    details: [],
    note: "",
    status: "ready",
    provenance: "page",
    editedFields: [],
    source: { kind: "user", runId: null },
    createdAt: "2026-08-27T21:40:00.000Z",
    updatedAt: "2026-08-27T21:40:00.000Z",
    ...overrides,
  };
}

const AMAZON = page({
  url: "https://www.amazon.com/Breville-Barista-Express-Espresso-Machine/dp/B00CH9QWOU/ref=sr_1_3?keywords=espresso&qid=1&sr=8-3&tag=aff-20",
  title: "Amazon.com: Breville Barista Express Espresso Machine, Brushed Stainless Steel, BES870XL : Home & Kitchen",
  meta: [
    { name: "og:site_name", content: "Amazon.com" },
    { name: "description", content: "Breville Barista Express BES870XL. Grind, dose, tamp, extract." },
    { name: "og:image", content: "https://m.media-amazon.com/images/I/71x.jpg" },
  ],
  jsonLd: [
    {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Breville Barista Express Espresso Machine BES870XL",
      brand: { "@type": "Brand", name: "Breville" },
      image: ["https://m.media-amazon.com/images/I/71x.jpg"],
      offers: { "@type": "Offer", price: "699.95", priceCurrency: "USD", availability: "https://schema.org/InStock" },
      aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", reviewCount: "22041" },
    },
  ],
  images: ["https://m.media-amazon.com/images/I/71x.jpg", "https://m.media-amazon.com/images/I/sprite.png"],
  text: "Breville Barista Express. Grind, dose, tamp, extract. 15 bar pump, integrated grinder.",
});

describe("bookmark addresses", () => {
  it("cleans tracking parameters, fragments, and Amazon's search tails", () => {
    expect(cleanBookmarkUrl(AMAZON.url)).toBe("https://www.amazon.com/dp/B00CH9QWOU");
    expect(cleanBookmarkUrl("https://Example.com/a?utm_source=x&id=2&fbclid=y#top")).toBe("https://example.com/a?id=2");
    expect(cleanBookmarkUrl("not a url")).toBe("not a url");
    // Amazon's tails are Amazon's: elsewhere a tag, a keyword, or a ref selects content.
    expect(cleanBookmarkUrl("https://example.com/search?tag=typescript&keywords=ai&ref=42")).toBe("https://example.com/search?tag=typescript&keywords=ai&ref=42");
    expect(cleanBookmarkUrl("https://www.amazon.com/s?k=mug&tag=aff-20&ref=nav")).toBe("https://www.amazon.com/s?k=mug");
  });

  it("keys one page's many addresses to one bookmark", () => {
    expect(bookmarkUrlKey("https://www.example.com/a/")).toBe(bookmarkUrlKey("http://example.com/a?utm_medium=mail"));
    expect(bookmarkUrlKey(AMAZON.url)).toBe(bookmarkUrlKey("https://amazon.com/gp/product/B00CH9QWOU?th=1"));
    // The path and query keep their case; the host does not.
    expect(bookmarkUrlKey("https://Example.com/Report?q=A")).toBe("example.com/Report?q=A");
    expect(bookmarkUrlKey("https://example.com/Report")).not.toBe(bookmarkUrlKey("https://example.com/report"));
    expect(bookmarkUrlKey("https://example.com:8080/a")).not.toBe(bookmarkUrlKey("https://example.com/a"));
  });

  it("knows the app's own pages from the web", () => {
    expect(isBookmarksUrl("pistachio://bookmarks")).toBe(true);
    expect(isBookmarksUrl("https://bookmarks")).toBe(false);
    expect(isBookmarkableUrl("https://example.com")).toBe(true);
    expect(isBookmarkableUrl("pistachio://reminders")).toBe(false);
    expect(isBookmarkableUrl("about:blank")).toBe(false);
  });

  it("takes the page's canonical address unless it points at the front door", () => {
    expect(canonicalUrl(page({ url: "https://a.com/x?utm_source=1", links: [{ rel: "canonical", href: "https://a.com/x" }] }))).toBe("https://a.com/x");
    expect(canonicalUrl(page({ url: "https://a.com/x", links: [{ rel: "canonical", href: "https://a.com/" }] }))).toBe("https://a.com/x");
    expect(canonicalUrl(page({ url: "https://a.com/x", meta: [{ name: "og:url", content: "https://other.com/x" }] }))).toBe("https://a.com/x");
  });
});

describe("what kind of thing a page is about", () => {
  it("reads JSON-LD first, then Open Graph, then the host", () => {
    expect(detectKind(AMAZON)).toBe("product");
    expect(detectKind(page({ meta: [{ name: "og:type", content: "book" }] }))).toBe("book");
    expect(detectKind(page({ meta: [{ name: "og:type", content: "video.movie" }] }))).toBe("movie");
    expect(detectKind(page({ meta: [{ name: "og:type", content: "video.tv_show" }] }))).toBe("show");
    expect(detectKind(page({ url: "https://www.goodreads.com/book/show/1" }))).toBe("book");
    expect(detectKind(page({ url: "https://www.youtube.com/watch?v=1" }))).toBe("video");
    expect(detectKind(page({ url: "https://github.com/vercel/ai" }))).toBe("software");
    expect(detectKind(page({ jsonLd: [{ "@type": "Recipe", name: "Pasta" }], url: "https://www.amazon.com/x" }))).toBe("recipe");
    expect(detectKind(page({ jsonLd: [{ "@graph": [{ "@type": "WebPage" }, { "@type": "NewsArticle" }] }] }))).toBe("article");
    expect(detectKind(page({ jsonLd: [{ "@type": ["Restaurant", "LocalBusiness"] }] }))).toBe("place");
  });

  it("falls back to the tags a kind leaves behind, else website", () => {
    expect(detectKind(page({ meta: [{ name: "product:price:amount", content: "12.00" }] }))).toBe("product");
    expect(detectKind(page({ meta: [{ name: "article:published_time", content: "2026-01-01" }] }))).toBe("article");
    expect(detectKind(page())).toBe("website");
  });
});

describe("the page's first draft", () => {
  it("names the thing, not the page, and keeps the facts the page stated", () => {
    const draft = draftFromPage(AMAZON);
    expect(draft.kind).toBe("product");
    // The structured name beats the SEO title when there is no og:title.
    expect(draft.title).toBe("Breville Barista Express Espresso Machine BES870XL");
    expect(draft.siteName).toBe("Amazon.com");
    expect(draft.description).toContain("Grind, dose, tamp");
    expect(draft.imageUrl).toBe("https://m.media-amazon.com/images/I/71x.jpg");
    expect(draft.details).toEqual(
      expect.arrayContaining([
        { label: "Price", value: "$699.95" },
        { label: "Brand", value: "Breville" },
        { label: "Rating", value: "4.6 / 5 (22,041)" },
        { label: "Availability", value: "In Stock" },
      ]),
    );
    expect(draft.keywords).toEqual(expect.arrayContaining(["breville", "product", "amazon.com", "espresso", "barista"]));
    expect(draft.keywords.length).toBeLessThanOrEqual(24);
  });

  it("strips the site from either end of a title, and nothing else", () => {
    expect(cleanTitle("Project Hail Mary by Andy Weir | Goodreads", "Goodreads", "goodreads.com")).toBe("Project Hail Mary by Andy Weir");
    expect(cleanTitle("The Verge - Apple announces a thing", "The Verge", "theverge.com")).toBe("Apple announces a thing");
    expect(cleanTitle("Dune: Part Two (2024) - IMDb", "IMDb", "imdb.com")).toBe("Dune: Part Two (2024)");
    expect(cleanTitle("A plain title", "", "example.com")).toBe("A plain title");
    expect(cleanTitle("Amazon.com: Nice Mug : Home & Kitchen", "Amazon.com", "amazon.com")).toBe("Nice Mug");
  });

  it("reads a recipe's times and yield, a book's author, a film's cast", () => {
    const recipe = page({
      jsonLd: [{ "@type": "Recipe", name: "Cacio e Pepe", totalTime: "PT25M", recipeYield: "4 servings", recipeCuisine: "Italian", author: { name: "Priya" } }],
    });
    expect(detailsFromPage(recipe, "recipe")).toEqual([
      { label: "Total time", value: "25m" },
      { label: "Serves", value: "4 servings" },
      { label: "Cuisine", value: "Italian" },
      { label: "By", value: "Priya" },
    ]);
    const book = page({ meta: [{ name: "book:author", content: "Andy Weir" }, { name: "book:release_date", content: "2021-05-04" }, { name: "book:isbn", content: "9780593135204" }] });
    expect(detailsFromPage(book, "book")).toEqual([
      { label: "Author", value: "Andy Weir" },
      { label: "Published", value: "2021" },
      { label: "ISBN", value: "9780593135204" },
    ]);
    const film = page({ jsonLd: [{ "@type": "Movie", director: { name: "Denis Villeneuve" }, actor: [{ name: "Timothée Chalamet" }, { name: "Zendaya" }], datePublished: "2024-03-01", duration: "PT2H46M" }] });
    expect(detailsFromPage(film, "movie")).toEqual([
      { label: "Director", value: "Denis Villeneuve" },
      { label: "Starring", value: "Timothée Chalamet, Zendaya" },
      { label: "Year", value: "2024" },
      { label: "Runtime", value: "2h 46m" },
    ]);
  });

  it("offers every picture once, best first, and never a sprite", () => {
    expect(imageCandidates(AMAZON)).toEqual(["https://m.media-amazon.com/images/I/71x.jpg", "https://m.media-amazon.com/images/I/sprite.png"]);
    expect(imageCandidates(page({ images: ["/relative.jpg", "data:image/png;base64,x"] }))).toEqual(["https://example.com/relative.jpg"]);
  });

  it("formats what it shows", () => {
    expect(humanDuration("PT1H5M")).toBe("1h 5m");
    expect(humanDuration("PT45S")).toBe("45s");
    expect(humanDuration("about an hour")).toBe("about an hour");
    expect(formatPrice("12.5", "EUR")).toBe("€12.5");
    expect(formatPrice("$12.50", "")).toBe("12.50");
    expect(formatPrice("900", "SEK")).toBe("kr 900");
  });
});

describe("a page read from its HTML", () => {
  const html = `<!doctype html><html lang="en"><head>
    <title>Cacio e Pepe Recipe &amp; Notes | Serious Eats</title>
    <meta property="og:title" content="Cacio e Pepe">
    <meta name="description" content='Three ingredients, one pan.'>
    <link rel="canonical" href="/recipes/cacio-e-pepe">
    <script type="application/ld+json">{"@type":"Recipe","name":"Cacio e Pepe","totalTime":"PT20M"}</script>
    <script type="application/ld+json">{ not json</script>
    <style>.x{}</style>
  </head><body><h1>Cacio <em>e</em> Pepe</h1><img src="/hero.jpg" width="800"><img src="/pixel.gif" width="1" height="1">
    <p>Boil the pasta.</p><script>track()</script><p>Toss with cheese &amp; pepper.</p></body></html>`;

  it("finds the tags, the structured data, the heading, and the words", () => {
    const snapshot = pageSnapshotFromHtml(html, "https://www.seriouseats.com/recipes/cacio-e-pepe?utm_source=x");
    expect(snapshot.title).toBe("Cacio e Pepe Recipe & Notes | Serious Eats");
    expect(snapshot.meta).toEqual([
      { name: "og:title", content: "Cacio e Pepe" },
      { name: "description", content: "Three ingredients, one pan." },
    ]);
    expect(snapshot.links).toEqual([{ rel: "canonical", href: "https://www.seriouseats.com/recipes/cacio-e-pepe" }]);
    expect(snapshot.jsonLd).toEqual([{ "@type": "Recipe", name: "Cacio e Pepe", totalTime: "PT20M" }]);
    expect(snapshot.headline).toBe("Cacio e Pepe");
    expect(snapshot.images).toEqual(["https://www.seriouseats.com/hero.jpg"]);
    expect(snapshot.text).toBe("Cacio e Pepe\nBoil the pasta.\nToss with cheese & pepper.");
    expect(snapshot.lang).toBe("en");
    const draft = draftFromPage(snapshot);
    expect(draft).toMatchObject({ kind: "recipe", title: "Cacio e Pepe", details: [{ label: "Total time", value: "20m" }] });
    expect(canonicalUrl(snapshot)).toBe("https://www.seriouseats.com/recipes/cacio-e-pepe");
  });

  it("never throws on rubbish", () => {
    expect(pageSnapshotFromHtml("", "https://a.com")).toMatchObject({ title: "", meta: [], jsonLd: [] });
    expect(pageSnapshotFromHtml("<html><head><meta property=og:title content=Bare></head>", "https://a.com").meta).toEqual([{ name: "og:title", content: "Bare" }]);
  });
});

describe("search", () => {
  const machine = bookmark({ id: "m", kind: "product", title: "Breville Barista Express", siteName: "Amazon", keywords: ["espresso", "coffee maker", "breville"], details: [{ label: "Price", value: "$699.95" }], createdAt: "2026-08-20T00:00:00.000Z" });
  const novel = bookmark({ id: "n", kind: "book", title: "Project Hail Mary", siteName: "Goodreads", keywords: ["andy weir", "science fiction"], note: "Sam said it is great", createdAt: "2026-08-25T00:00:00.000Z" });
  const pasta = bookmark({ id: "p", kind: "recipe", title: "Cacio e Pepe", url: "https://seriouseats.com/x", keywords: ["pasta", "italian"], createdAt: "2026-08-27T00:00:00.000Z" });
  const all = [machine, novel, pasta];

  it("finds the thing by any of its words, best first", () => {
    expect(searchBookmarks(all, "espresso").map((b) => b.id)).toEqual(["m"]);
    expect(searchBookmarks(all, "coffee").map((b) => b.id)).toEqual(["m"]);
    expect(searchBookmarks(all, "weir").map((b) => b.id)).toEqual(["n"]);
    expect(searchBookmarks(all, "sam great").map((b) => b.id)).toEqual(["n"]);
    expect(searchBookmarks(all, "italian pasta").map((b) => b.id)).toEqual(["p"]);
    expect(searchBookmarks(all, "book").map((b) => b.id)).toEqual(["n"]);
    expect(searchBookmarks(all, "amazon").map((b) => b.id)).toEqual(["m"]);
    expect(searchBookmarks(all, "unicorn")).toEqual([]);
  });

  it("every word must land somewhere, and a title beats a description", () => {
    expect(searchBookmarks(all, "espresso weir")).toEqual([]);
    const described = bookmark({ id: "d", description: "a breville accessory" });
    expect(bookmarkScore(machine, "breville")).toBeGreaterThan(bookmarkScore(described, "breville"));
  });

  it("filters by kind and site, and lists newest first with no query", () => {
    expect(searchBookmarks(all, "").map((b) => b.id)).toEqual(["p", "n", "m"]);
    expect(searchBookmarks(all, "", { kind: "book" }).map((b) => b.id)).toEqual(["n"]);
    expect(searchBookmarks(all, "", { host: "seriouseats.com" }).map((b) => b.id)).toEqual(["p"]);
    expect(bookmarkHosts(all)).toEqual([
      { host: "example.com", count: 2 },
      { host: "seriouseats.com", count: 1 },
    ]);
  });
});

describe("sanitizing", () => {
  it("accepts a creation request with a web address and nothing else required", () => {
    expect(sanitizeBookmarkInput({ url: "https://a.com/x", title: "  X  ", kind: "book", keywords: ["A", "a", " b "], details: [{ label: "Price", value: "$1" }, { label: "price", value: "$2" }], note: "n" })).toEqual({
      url: "https://a.com/x",
      title: "X",
      kind: "book",
      keywords: ["a", "b"],
      details: [{ label: "Price", value: "$1" }],
      note: "n",
    });
    expect(sanitizeBookmarkInput({ url: "pistachio://reminders" })).toBeNull();
    expect(sanitizeBookmarkInput({ url: "javascript:alert(1)" })).toBeNull();
    expect(sanitizeBookmarkInput("nope")).toBeNull();
  });

  it("keeps only the fields a patch names, and only good values", () => {
    expect(sanitizeBookmarkPatch({ title: "", kind: "spaceship", imageUrl: "ftp://x", note: "n", description: "d" })).toEqual({ imageUrl: null, note: "n", description: "d" });
    expect(sanitizeBookmarkPatch({ kind: "movie", url: "https://b.com" })).toEqual({ kind: "movie", url: "https://b.com/" });
  });

  it("reads a file back, dropping what it cannot, and reopens an interrupted extraction as ready", () => {
    const document = sanitizeBookmarkDocument({
      version: 1,
      bookmarks: [
        { ...bookmark(), status: "extracting" },
        { ...bookmark({ id: "dupe" }) },
        { ...bookmark({ id: "dupe" }) },
        { id: "bad", url: "nope", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "x", url: "https://a.com", createdAt: "not a date" },
        null,
      ],
    });
    expect(document.bookmarks.map((entry) => entry.id)).toEqual(["b1", "dupe"]);
    expect(document.bookmarks[0]?.status).toBe("ready");
    expect(sanitizeBookmarkDocument(undefined)).toEqual({ version: 1, bookmarks: [] });
    // Edited fields come back as the known names only, in canonical order.
    const edited = sanitizeBookmarkDocument({ version: 1, bookmarks: [{ ...bookmark(), editedFields: ["note", "title", "bogus", 3] }] });
    expect(edited.bookmarks[0]?.editedFields).toEqual(["title", "note"]);
  });
});
