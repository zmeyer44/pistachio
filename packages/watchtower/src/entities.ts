import type {
  WatchtowerEntityKind,
  WatchtowerFactCandidate,
  WatchtowerIndexCandidate,
  WatchtowerSubject,
} from "@pistachio/agent-runtime/watchtower";

/**
 * The names on a saved page, found locally.
 *
 * A page is a document; what it is about — a person, a company, a product —
 * persists across sites. This file finds the CANDIDATES: runs of capitalized
 * words in the page's own sentences, what its structured data declares, the
 * repository a code page is, the search a results page ran. It settles what
 * it can on its own (a declared Product is a product; a GitHub address is a
 * project) and leaves the rest undecided, for the decision model to sort
 * (`agent-runtime/watchtower-entities`).
 *
 * Nothing here writes: everything returned is text the page itself holds,
 * so a fact is always a sentence someone published, never a summary.
 */

export const INDEX_LIMITS = {
  /** Names kept per page, most central first. */
  candidates: 24,
  facts: 8,
  factsPerCandidate: 2,
  context: 200,
  fact: 280,
  name: 80,
} as const;

/* ----------------------------------- keys ---------------------------------- */

/** ", Inc." at the end of a name: the same name, formally. */
const LEGAL_TAIL =
  /,?\s+(?:Inc|Incorporated|LLC|Ltd|Limited|Corp|Corporation|Co|GmbH|AG|PLC|S\.A|N\.V|B\.V|Pty|LLP|LP)\.?$/u;
const LEGAL_SUFFIX = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "gmbh",
  "ag",
  "plc",
  "sa",
  "nv",
  "bv",
  "pty",
  "llp",
  "lp",
]);

/**
 * One spelling for every way a name is written: "Stripe, Inc.", "stripe"
 * and "Stripe’s" are one key; "The New York Times" and "New York Times"
 * too. Keeps what distinguishes names (C++, C#, AT&T).
 */
export function entityKey(name: string): string {
  const tokens = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    // U.S. → US; "Node.js" keeps its dot as a word break, like "node js".
    .replace(/(?<=(?:^|[^\p{L}])\p{L})\.(?=\p{L}(?:\.|[^\p{L}]|$))/gu, "")
    .toLowerCase()
    .replace(/['’]s(?=[^\p{L}]|$)/gu, "")
    .replace(/(^|\s)&(?=\s|$)/gu, "$1and")
    .replace(/[^\p{L}\p{N}+#&]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (tokens.length > 1 && tokens[0] === "the") tokens.shift();
  while (tokens.length > 1 && LEGAL_SUFFIX.has(tokens[tokens.length - 1]!))
    tokens.pop();
  return tokens.join(" ").slice(0, 120);
}

/** The words of a key, for matching one name against another. */
export const keyTokens = (key: string): string[] =>
  key.split(" ").filter((token) => token.length > 1 || /\p{N}/u.test(token));

/* ------------------------------ declared subjects -------------------------- */

/** The page or its furniture: a document's own item is not what it is about. */
const DOCUMENT_TYPE =
  /^(WebPage|WebSite|Article|NewsArticle|BlogPosting|Report|TechArticle|AnalysisNewsArticle|OpinionNewsArticle|VideoObject|Clip|ImageObject|MediaObject|BreadcrumbList|ItemList|ListItem|SiteNavigationElement|FAQPage|QAPage|CollectionPage|ProfilePage|SearchResultsPage|AboutPage|ContactPage|ItemPage|Recipe|HowTo|HowToStep|Comment|DiscussionForumPosting|SocialMediaPosting|LiveBlogPosting|Review|Rating|AggregateRating|Offer|AggregateOffer|SearchAction|ReadAction|WatchAction|EntryPoint|WPHeader|WPFooter|WPSideBar|PostalAddress|ContactPoint|Thing|PropertyValue|QuantitativeValue|MonetaryAmount|Question|Answer)$/u;

const TYPE_KINDS: [RegExp, WatchtowerEntityKind][] = [
  [/^Person$/u, "person"],
  [
    /^(NGO|EducationalOrganization|CollegeOrUniversity|School|HighSchool|MiddleSchool|ElementarySchool|GovernmentOrganization|SportsTeam|SportsOrganization|MusicGroup|PerformingGroup|Consortium|ResearchOrganization|MedicalOrganization|Hospital|LibrarySystem|PoliticalParty|WorkersUnion|FundingScheme|Project|ResearchProject)$/u,
    "organization",
  ],
  [
    /^(Corporation|NewsMediaOrganization|OnlineBusiness|OnlineStore|Airline|Brand|Store|Restaurant|\w*Business)$/u,
    "company",
  ],
  [
    /^(Product|ProductModel|ProductGroup|IndividualProduct|SoftwareApplication|WebApplication|MobileApplication|Service|FinancialProduct|BankAccount|CreditCard|LoanOrCredit|Vehicle|Car|Motorcycle|Drug)$/u,
    "product",
  ],
  [/^(Event|\w+Event|Festival)$/u, "event"],
  [
    /^(Place|City|Country|State|AdministrativeArea|Continent|LandmarksOrHistoricalBuildings|TouristAttraction|TouristDestination|Airport|Park|Mountain|BodyOfWater|Beach|Accommodation|Hotel|CivicStructure|StadiumOrArena|Museum)$/u,
    "place",
  ],
  [
    /^(Book|Movie|TVSeries|TVSeason|TVEpisode|Episode|MusicAlbum|MusicRecording|MusicComposition|PodcastSeries|PodcastEpisode|VideoGame|ScholarlyArticle|Thesis|Course|CreativeWorkSeries|BookSeries|Play|Painting|Sculpture|VisualArtwork|Dataset)$/u,
    "work",
  ],
  [/^SoftwareSourceCode$/u, "project"],
  [/^DefinedTerm$/u, "concept"],
];
const VIA_KINDS: Record<string, WatchtowerEntityKind> = {
  brand: "company",
  manufacturer: "company",
  location: "place",
  founder: "person",
  director: "person",
  actor: "person",
  employee: "person",
};

/**
 * What a declared subject is: a kind, null when the declaration does not
 * settle it (an `author` may be a person or a channel; a bare
 * `Organization` a company or a university), undefined when it is the page
 * itself or its furniture.
 */
export function subjectKind(
  subject: Pick<WatchtowerSubject, "type" | "via">,
): WatchtowerEntityKind | null | undefined {
  const type = subject.type.replace(/^https?:\/\/schema\.org\//u, "");
  if (type !== "") {
    if (DOCUMENT_TYPE.test(type)) return undefined;
    for (const [pattern, kind] of TYPE_KINDS) if (pattern.test(type)) return kind;
  }
  return subject.via === undefined ? null : (VIA_KINDS[subject.via] ?? null);
}

/* -------------------------------- addresses -------------------------------- */

const SEARCH_ENGINES: [RegExp, RegExp, string[]][] = [
  [/(^|\.)google\.[a-z.]{2,6}$/u, /^\/search/u, ["q"]],
  [/(^|\.)bing\.com$/u, /^\/search/u, ["q"]],
  [/(^|\.)duckduckgo\.com$/u, /^\/$/u, ["q"]],
  [/(^|\.)search\.brave\.com$/u, /^\/search/u, ["q"]],
  [/(^|\.)kagi\.com$/u, /^\/search/u, ["q"]],
  [/(^|\.)search\.yahoo\.com$/u, /^\/search/u, ["p"]],
  [/(^|\.)ecosia\.org$/u, /^\/search/u, ["q"]],
  [/(^|\.)startpage\.com$/u, /^\/(do\/)?search/u, ["query", "q"]],
  [/(^|\.)perplexity\.ai$/u, /^\/search/u, ["q"]],
  [/(^|\.)youtube\.com$/u, /^\/results/u, ["search_query"]],
];

/** The words a search results page was a search for, or null for any other page. */
export function searchQuery(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  for (const [hostPattern, pathPattern, params] of SEARCH_ENGINES) {
    if (!hostPattern.test(host) || !pathPattern.test(url.pathname)) continue;
    for (const param of params) {
      const value = url.searchParams.get(param)?.replace(/\s+/gu, " ").trim();
      if (value) return value.slice(0, 200);
    }
  }
  return null;
}

const NOT_AN_OWNER = new Set(
  "about account apps blog codespaces collections contact customer-stories enterprise events explore features issues login marketplace new notifications orgs organizations pricing pulls readme search security settings site sponsors team topics trending users".split(
    " ",
  ),
);

/** `owner/repo` for a GitHub or GitLab repository page. */
export function repository(address: string): string | null {
  try {
    const url = new URL(address);
    if (!/^(www\.)?(github|gitlab)\.com$/u.test(url.hostname.toLowerCase()))
      return null;
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo || NOT_AN_OWNER.has(owner.toLowerCase())) return null;
    if (!/^[\w.-]{1,100}$/u.test(owner) || !/^[\w.-]{1,100}$/u.test(repo))
      return null;
    return `${owner}/${repo.replace(/\.git$/u, "")}`;
  } catch {
    return null;
  }
}

/** "stripe" for stripe.com, "bbc" for www.bbc.co.uk: what a site calls itself in titles. */
export function siteLabel(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./u, "").split(".");
  if (labels.length < 2) return labels[0] ?? "";
  const second = labels[labels.length - 2]!;
  return labels.length >= 3 &&
    labels[labels.length - 1]!.length === 2 &&
    /^(co|com|org|net|ac|gov|edu|ne|or)$/u.test(second)
    ? labels[labels.length - 3]!
    : second;
}

/** Worth calling an investigation without a model: a real question, a comparison, a how-to. */
export function looksLikeQuestion(query: string): boolean {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  return (
    /\?/u.test(query) ||
    /^(how|what|why|when|where|who|which|is|are|can|does|do|should|will|best)$/u.test(
      words[0] ?? "",
    ) ||
    words.some((word) => word === "vs" || word === "vs." || word === "versus") ||
    words.length >= 4
  );
}

/* ---------------------------------- words ---------------------------------- */

/** Never a name on their own, and not the start of one at the start of a sentence. */
const STARTERS = new Set(
  `a an the this that these those there here it its it's he she we they i you my your our their his her him them me us
  in on at for from to of by with without into onto upon over under about above below across among between through during
  within after before since until while when whenever where wherever why how what which who whom whose whether if unless
  and but or nor so yet also still then now once later earlier recently currently finally first second third last next
  however meanwhile moreover furthermore instead indeed perhaps maybe yes no not only even just unlike like despite although
  though because as according per via both either neither each every all any some many most much more less few several
  such other another one two three four five six seven eight nine ten is are was were be been being will would can could
  should may might must do does did has have had get gets got let lets today yesterday tomorrow tonight again already
  always never often sometimes usually soon ago thanks thank please hello hi dear welcome sorry oh ok okay`.split(/\s+/u),
);
/** Interface words: a run made only of these is a button or a menu, not a name. */
const INTERFACE = new Set(
  `read more share sign log in out up subscribe click home menu search back close open see view learn get try start
  join follow watch listen download buy shop contact privacy terms cookie cookies policy policies copyright reply replies
  comment comments posted updated published edited advertisement sponsored related top new popular trending latest
  pricing price prices fees plans plan features feature docs documentation blog news careers jobs support help login
  logout register dashboard overview introduction intro guide guides tutorial tutorials products product solutions
  resources customers enterprise company team teams about us faq faqs settings account profile notifications
  messages message inbox save saved edit delete cancel submit continue skip next previous prev page pages all show
  hide expand collapse load loading more less video videos image images photo photos audio podcast episode episodes
  chapter chapters section sections table contents note notes summary conclusion references sources source citation
  citations external links link see also further reading notes footnotes appendix abstract background history
  overview early life career personal death legacy works awards reception description details specifications specs
  reviews review rating ratings questions answers answer question discussion discussions forum forums community
  terms conditions accessibility sitemap language english free trial demo get started sales support status
  changelog release releases download downloads install installation setup configuration api reference examples
  example usage license contributing security code issues pull requests actions projects wiki insights`.split(/\s+/u),
);
const CALENDAR = new Set(
  `january february march april may june july august september october november december jan feb mar apr jun jul aug
  sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday mon tue tues thu thur thurs fri
  am pm utc gmt est pst cet bst`.split(/\s+/u),
);
const CONNECTORS = new Set(
  "of de del della di da van von der den la le du dos das y bin al".split(" "),
);

const WORD =
  /[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}'’&+.-]*[\p{L}\p{N}+#])?/gu;
const capitalized = (word: string): boolean =>
  /^\p{Lu}/u.test(word) || /^\p{Ll}{1,3}\p{Lu}/u.test(word);
const numeric = (word: string): boolean => /^\p{N}/u.test(word);
const bare = (word: string): string =>
  word.replace(/['’]s$/u, "").toLowerCase();

interface Word {
  text: string;
  start: number;
  end: number;
  initial: boolean;
}
function wordsOf(text: string): Word[] {
  const words: Word[] = [];
  let previous = 0;
  for (const match of text.matchAll(WORD)) {
    const start = match.index;
    const gap = text.slice(previous, start);
    words.push({
      text: match[0],
      start,
      end: start + match[0].length,
      initial:
        words.length === 0 ||
        /[.!?:;\n•·|]/u.test(gap) ||
        /["“‘([]\s*$/u.test(gap),
    });
    previous = start + match[0].length;
  }
  return words;
}

/** Words Title Case leaves in lower case; every other word it capitalizes. */
const TITLE_LOWER = new Set(
  "a an and as at but by for from in into nor of off on onto or over per so than the to up upon via vs with yet".split(" "),
);

/**
 * Title Case ("How Stripe Built Its Billing Engine"), where capitals say
 * nothing about names. Sentence case always leaves some content word in
 * lower case ("Patrick Collison spoke on Monday"); Title Case leaves none.
 */
function titleCase(words: Word[]): boolean {
  const rest = words.slice(1).filter((word) => !numeric(word.text));
  return (
    rest.filter((word) => capitalized(word.text)).length >= 2 &&
    rest.every(
      (word) => capitalized(word.text) || TITLE_LOWER.has(word.text.toLowerCase()),
    )
  );
}

interface Run {
  name: string;
  start: number;
  end: number;
  tokens: string[];
  initial: boolean;
}

/** Maximal runs of capitalized words: "Patrick Collison", "Bank of America", "iPhone 16", "AT&T". */
function runsOf(text: string, words: Word[]): Run[] {
  const runs: Run[] = [];
  let i = 0;
  while (i < words.length) {
    if (!capitalized(words[i]!.text)) {
      i++;
      continue;
    }
    const first = i;
    let last = i;
    let j = i + 1;
    while (j < words.length) {
      const gap = text.slice(words[j - 1]!.end, words[j]!.start);
      if (!/^(?:[ \t\u00a0]+|\s+&\s+)$/u.test(gap) || words[j]!.initial) break;
      const word = words[j]!.text;
      if (capitalized(word) || numeric(word)) {
        last = j;
        j++;
      } else if (
        CONNECTORS.has(word) &&
        j + 1 < words.length &&
        capitalized(words[j + 1]!.text) &&
        /^[ \t\u00a0]+$/u.test(text.slice(words[j]!.end, words[j + 1]!.start))
      )
        j++;
      else break;
    }
    let from = first;
    // "Yesterday Patrick Collison said": the sentence's first word is not the name's.
    while (
      from <= last &&
      (STARTERS.has(bare(words[from]!.text)) ||
        CONNECTORS.has(words[from]!.text))
    )
      from++;
    if (from <= last) {
      const tokens = words.slice(from, last + 1).map((word) => word.text);
      runs.push({
        name: text
          .slice(words[from]!.start, words[last]!.end)
          .replace(/['’]s$/u, ""),
        start: words[from]!.start,
        end: words[last]!.end,
        tokens,
        initial: words[from]!.initial,
      });
    }
    i = last + 1;
  }
  return runs;
}

/** A run that is a name at all: not a menu, a date, a number or a sentence in Title Case. */
function nameLike(run: Run): boolean {
  if (run.tokens.length > 6 || run.name.length > INDEX_LIMITS.name) return false;
  const lower = run.tokens.map(bare);
  if (
    lower.every(
      (token) =>
        LEGAL_SUFFIX.has(token.replace(/\.$/u, "")) ||
        STARTERS.has(token) ||
        INTERFACE.has(token) ||
        CALENDAR.has(token) ||
        CONNECTORS.has(token) ||
        /^\p{N}/u.test(token),
    )
  )
    return false;
  if (run.tokens.length === 1 && run.name.length < 2) return false;
  return /\p{L}{2}/u.test(run.name);
}

/* --------------------------------- sentences -------------------------------- */

const ABBREVIATION =
  /(?:^|\s)(?:inc|ltd|co|corp|dr|mr|mrs|ms|st|jr|sr|vs|no|u\.s|e\.g|i\.e|etc|approx|est|fig|vol|mt)$/iu;

/** Sentences of one block, without breaking "Stripe Inc. said" or "the U.S. market". */
export function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?]+["'”’)\]]*\s+(?=["'“‘(]?[\p{Lu}\p{N}])|\n+/gu)) {
    const end = match.index;
    const before = text.slice(start, end);
    if (match[0][0] === "." && ABBREVIATION.test(before)) continue;
    const sentence = text.slice(start, end + match[0].trimEnd().length).trim();
    if (sentence) sentences.push(sentence);
    start = end + match[0].length;
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

/** A readable excerpt around `at`, bounded, never cut mid-word when it can be helped. */
function around(sentence: string, at: number, max: number): string {
  if (sentence.length <= max) return sentence;
  let from = Math.max(0, Math.min(at - Math.floor(max / 3), sentence.length - max));
  let to = from + max;
  if (from > 0) {
    const space = sentence.indexOf(" ", from);
    if (space !== -1 && space < at) from = space + 1;
  }
  if (to < sentence.length) {
    const space = sentence.lastIndexOf(" ", to);
    if (space > from) to = space;
  }
  return `${from > 0 ? "…" : ""}${sentence.slice(from, to).trim()}${to < sentence.length ? "…" : ""}`;
}

/* --------------------------------- candidates ------------------------------- */

export interface IndexInput {
  url: string;
  title: string;
  /** The saved version's blocks: the card first, as the archive stores it. */
  blocks: string[];
  subjects?: WatchtowerSubject[];
  /**
   * Keys of the title parts this site puts on most of its pages ("The New
   * York Times", "BBC News"): the site signing its pages, not their subject.
   */
  siteNames?: ReadonlySet<string>;
  /**
   * Only what the page declares (structured data, a repository, a search):
   * all a capture-time pass can keep without a model, at a fraction of the
   * cost of reading the prose.
   */
  declaredOnly?: boolean;
}
type Candidate = Omit<WatchtowerIndexCandidate, "known">;
interface Tally {
  surfaces: Map<string, number>;
  count: number;
  title: boolean;
  heading: boolean;
  early: boolean;
  declared: WatchtowerEntityKind | null | "undeclared";
  main: boolean;
  context: string;
  aliases: Set<string>;
}

/**
 * The names a saved version holds, most central first, and the sentences
 * that may say something about them. Deterministic: the same version always
 * yields the same candidates.
 */
export function findCandidates(input: IndexInput): {
  candidates: Candidate[];
  facts: WatchtowerFactCandidate[];
} {
  let host = "";
  let path = "/";
  try {
    const url = new URL(input.url);
    host = url.hostname.toLowerCase();
    path = url.pathname;
  } catch {
    /* an address the archive accepted always parses */
  }

  // A results page is somebody else's summaries of other pages: what the
  // person looked for is the object, not the names in the snippets.
  const query = searchQuery(input.url);
  if (query !== null) {
    const key = entityKey(query);
    return {
      candidates: key
        ? [
            {
              name: query,
              key,
              kind: looksLikeQuestion(query) ? "question" : null,
              aliases: [],
              count: 1,
              salience: 1,
              context: query,
              search: true,
            },
          ]
        : [],
      facts: [],
    };
  }

  const tallies = new Map<string, Tally>();
  const tally = (key: string): Tally => {
    let entry = tallies.get(key);
    if (!entry) {
      entry = {
        surfaces: new Map(),
        count: 0,
        title: false,
        heading: false,
        early: false,
        declared: "undeclared",
        main: false,
        context: "",
        aliases: new Set(),
      };
      tallies.set(key, entry);
    }
    return entry;
  };
  const note = (key: string, surface: string, count = 1): Tally => {
    const entry = tally(key);
    entry.surfaces.set(surface, (entry.surfaces.get(surface) ?? 0) + count);
    return entry;
  };

  // What the page says it is about needs no reading.
  for (const subject of (input.subjects ?? []).slice(0, 12)) {
    const kind = subjectKind(subject);
    const key = entityKey(subject.name);
    if (kind === undefined || !key || subject.name.length > INDEX_LIMITS.name)
      continue;
    const entry = note(key, subject.name.trim(), 0);
    if (entry.declared === "undeclared" || entry.declared === null)
      entry.declared = kind;
    entry.main ||=
      subject.via === "about" ||
      subject.via === "mainEntity" ||
      (subject.via === undefined &&
        kind !== null &&
        kind !== "company" &&
        kind !== "organization");
  }
  const code = repository(input.url);
  if (code !== null) {
    const entry = note(entityKey(code), code, 0);
    entry.declared = "project";
    entry.main = true;
  }

  const [card = "", ...body] = input.declaredOnly ? [] : input.blocks;
  const cardLines = card.split("\n");
  const creator = cardLines
    .find((line) => line.startsWith("Creator: "))
    ?.slice(9);
  for (const name of creator?.split(/,\s+/u) ?? []) {
    const key = entityKey(name);
    if (!key || LEGAL_SUFFIX.has(key) || name.length > INDEX_LIMITS.name) continue;
    const entry = note(key, name.trim(), 0);
    if (entry.declared === "undeclared") entry.declared = null;
  }
  const description = cardLines
    .filter(
      (line) =>
        !line.startsWith("# ") &&
        !/^(Creator|Published|Duration): /u.test(line),
    )
    .join("\n")
    .trim();

  // The title names the page's subject, between the site's own name and a
  // slogan: "Patrick Collison - Wikipedia", "Pricing & Fees | Stripe". A
  // title that IS a name is read first, so the body can recognize it even
  // where it only starts sentences ("Stripe was founded…").
  const label = siteLabel(host);
  const home = path === "/" || path === "";
  const signs = (key: string): boolean => {
    const squashed = key.replace(/ /gu, "");
    return (
      input.siteNames?.has(key) === true ||
      squashed === label ||
      `the${squashed}` === label ||
      squashed === `the${label}`
    );
  };
  const headlines: { text: string; words: Word[]; key: string }[] = [];
  for (const part of input.declaredOnly ? [] : input.title.split(/\s+[|–—·•-]\s+/u)) {
    const text = part.trim();
    const partKey = entityKey(text);
    if (!partKey) continue;
    if (signs(partKey)) {
      // On its own home page, the site IS the subject.
      if (!home) continue;
      const entry = note(partKey, text);
      entry.title = true;
      entry.main = true;
      continue;
    }
    // "Stripe, Inc." is the name Stripe, formally.
    const core = text.replace(LEGAL_TAIL, "");
    const words = wordsOf(core);
    const whole = runsOf(core, words);
    // The whole part is a name ("Patrick Collison"), not a headline in
    // Title Case ("Stripe’s Next Move", "How It Works").
    if (
      whole.length === 1 &&
      whole[0]!.start === 0 &&
      whole[0]!.end === core.length &&
      words.length <= 4 &&
      nameLike(whole[0]!) &&
      !/['’]s\b|[?!]$/u.test(core) &&
      !words.some((word) => STARTERS.has(bare(word.text)) || INTERFACE.has(bare(word.text)))
    ) {
      const entry = note(entityKey(core), core);
      if (core !== text) entry.aliases.add(text);
      entry.title = true;
      entry.main = true;
      continue;
    }
    headlines.push({ text, words: wordsOf(text), key: partKey });
  }

  // Prose, where capitals mean names. Code, table cells and Title Case are not.
  interface Segment {
    text: string;
    heading: boolean;
    early: boolean;
  }
  const segments: Segment[] = [];
  if (description) segments.push({ text: description, heading: false, early: true });
  body.forEach((block, index) => {
    if (block.startsWith("~~~~")) return;
    for (const line of block.split("\n")) {
      const heading = /^#{1,6} /u.test(line);
      const text = line
        .replace(/^#{1,6} |^> |^- |^\d+\. /u, "")
        .trim();
      if (text) segments.push({ text, heading, early: index < 2 });
    }
  });

  // First pass: which words the page capitalizes mid-sentence, and which it
  // writes in lower case — "Billing" at the start of a sentence is a word if
  // the page also writes "billing".
  const midCapital = new Map<string, number>();
  const lowered = new Map<string, number>();
  const parsed = segments.map((segment) => {
    const sentences = sentencesOf(segment.text).map((sentence) => {
      const words = wordsOf(sentence);
      return { sentence, words, title: titleCase(words) };
    });
    for (const { words, title } of sentences)
      if (!title)
        for (const word of words) {
          if (!capitalized(word.text))
            lowered.set(bare(word.text), (lowered.get(bare(word.text)) ?? 0) + 1);
          else if (!word.initial)
            midCapital.set(bare(word.text), (midCapital.get(bare(word.text)) ?? 0) + 1);
        }
    return { segment, sentences };
  });

  const acronyms = new Map<string, { surface: string; key: string }>();
  for (const { segment, sentences } of parsed)
    for (const { sentence, words, title } of sentences) {
      if (title) continue;
      for (const run of runsOf(sentence, words)) {
        if (!nameLike(run)) continue;
        const lower = bare(run.tokens[0]!);
        if (run.tokens.length === 1 && !tallies.has(entityKey(run.name))) {
          // A lone capitalized word is a name only if the page treats it as
          // one: capitalized mid-sentence, and more often than written plain
          // — or it is what the title or the page's own data names.
          const capitals = midCapital.get(lower) ?? 0;
          if (run.initial && capitals === 0) continue;
          if (
            (lowered.get(lower) ?? 0) >= capitals &&
            !/\p{Lu}.*\p{Lu}/u.test(run.name)
          )
            continue;
        }
        const key = entityKey(run.name);
        if (!key) continue;
        const entry = note(key, run.name);
        entry.count++;
        if (segment.heading) entry.heading = true;
        if (segment.early) entry.early = true;
        if (!entry.context && !segment.heading)
          entry.context = around(sentence, run.start, INDEX_LIMITS.context);
        // "Y Combinator (YC)": the page names its own abbreviation.
        const paren = /^\s*\((\p{Lu}[\p{Lu}\p{N}&]{1,7})\)/u.exec(
          sentence.slice(run.end),
        );
        if (paren?.[1] && run.tokens.length > 1) {
          const initials = run.tokens
            .filter((token) => !CONNECTORS.has(token))
            .map((token) => token[0]!.toUpperCase())
            .join("");
          if (initials.startsWith(paren[1][0]!))
            acronyms.set(entityKey(paren[1]), { surface: paren[1], key });
        }
      }
    }

  // A headline: the names it shares with the page count as the page's
  // subject; its own capitals only when it is not in Title Case.
  for (const { text, words, key } of headlines) {
    const spaced = ` ${key} `;
    for (const [known, entry] of tallies)
      if (known && spaced.includes(` ${known} `)) entry.title = true;
    if (!titleCase(words))
      for (const run of runsOf(text, words)) {
        if (!nameLike(run)) continue;
        if (run.tokens.length === 1 && run.initial && !midCapital.has(bare(run.name)))
          continue;
        const entry = note(entityKey(run.name), run.name);
        entry.title = true;
      }
  }

  // One thing, written three ways: "YC" → Y Combinator; "Collison" →
  // Patrick Collison when the page also names him in full.
  for (const [acronym, { surface, key }] of acronyms) {
    tallies.get(key)?.aliases.add(surface);
    fold(tallies, acronym, key);
  }
  const people = [...tallies.keys()].filter((key) => {
    const tokens = key.split(" ");
    return tokens.length >= 2 && tokens.length <= 3;
  });
  for (const key of [...tallies.keys()]) {
    if (key.includes(" ") || tallies.get(key)?.declared !== "undeclared") continue;
    const full = people.filter((other) => other.endsWith(` ${key}`));
    if (full.length === 1) fold(tallies, key, full[0]!);
  }

  const scored = [...tallies.entries()]
    .map(([key, entry]) => {
      const score =
        entry.count +
        (entry.title ? 4 : 0) +
        (entry.heading ? 2 : 0) +
        (entry.early ? 1 : 0) +
        (entry.main ? 6 : entry.declared !== "undeclared" ? 3 : 0);
      return { key, entry, score };
    })
    // A name the page wrote once, mid-sentence and capitalized ("such as
    // Slack"), is still a name; the least central ones fall off the end.
    .filter(({ key }) => key.length >= 2)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, INDEX_LIMITS.candidates);
  const top = scored[0]?.score ?? 1;
  const candidates: Candidate[] = scored.map(({ key, entry, score }) => {
    const surfaces = [...entry.surfaces.entries()].sort(
      (a, b) => b[1] - a[1] || b[0].length - a[0].length,
    );
    const name = surfaces[0]?.[0] ?? key;
    return {
      name,
      key,
      kind: entry.declared === "undeclared" ? null : entry.declared,
      aliases: [
        ...new Set([
          ...surfaces.slice(1).map(([surface]) => surface),
          ...entry.aliases,
        ]),
      ]
        .filter((alias) => alias !== name)
        .slice(0, 6),
      count: Math.max(1, entry.count),
      salience: entry.main
        ? 1
        : Math.max(entry.title ? 0.9 : 0, Math.round((score / top) * 100) / 100),
      context: entry.context || input.title.slice(0, INDEX_LIMITS.context),
    };
  });
  return { candidates, facts: factsFor(candidates, parsed) };
}

function fold(tallies: Map<string, Tally>, from: string, into: string): void {
  const source = tallies.get(from);
  const target = tallies.get(into);
  if (!source || !target || from === into) return;
  for (const [surface, count] of source.surfaces) {
    target.aliases.add(surface);
    target.count += count;
  }
  for (const alias of source.aliases) target.aliases.add(alias);
  target.title ||= source.title;
  target.heading ||= source.heading;
  target.early ||= source.early;
  target.context ||= source.context;
  tallies.delete(from);
}

/* ----------------------------------- facts ---------------------------------- */

/** Where `name` occurs in `text` as whole words, or -1. */
function wordAt(text: string, name: string): number {
  if (!name) return -1;
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const before = text[at - 1] ?? " ";
    const after = text[at + name.length] ?? " ";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return at;
  }
  return -1;
}

const NUMBER =
  /[$€£¥₹]\s?\d|\d[\d,.]*\s?(%|percent|million|billion|trillion|thousand|[kmb]n?\b|users|customers|employees|people|countries|downloads|members|subscribers|times)|\b\d{2,}[\d,.]*\b/iu;
const DATE =
  /\b(1[89]\d{2}|20\d{2})\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/iu;

/**
 * Sentences that may say something about a candidate — what it is, a
 * number, a date — for the decision model to sort into facts or discard.
 * Each is the page's own sentence, verbatim.
 */
function factsFor(
  candidates: Candidate[],
  parsed: {
    segment: { heading: boolean };
    sentences: { sentence: string }[];
  }[],
): WatchtowerFactCandidate[] {
  const subjects = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => !candidate.search)
    .slice(0, 8);
  if (subjects.length === 0) return [];
  const found: (WatchtowerFactCandidate & { priority: number; order: number })[] = [];
  const used = new Set<string>();
  let order = 0;
  for (const { segment, sentences } of parsed) {
    if (segment.heading) continue;
    for (const { sentence } of sentences) {
      order++;
      if (sentence.length < 40 || sentence.length > INDEX_LIMITS.fact || used.has(sentence))
        continue;
      // Whom the sentence is about: the name it gives first, and of names
      // starting there the longest ("Stripe Billing", not "Stripe").
      let best: { index: number; at: number; length: number } | undefined;
      for (const { candidate, index } of subjects)
        for (const name of [candidate.name, ...candidate.aliases]) {
          const at = wordAt(sentence, name);
          if (at < 0) continue;
          if (!best || at < best.at || (at === best.at && name.length > best.length))
            best = { index, at, length: name.length };
        }
      if (best === undefined) continue;
      const after = sentence.slice(best.at);
      const priority = /^[^,.;]{0,80}?\s(is|was|are|were)\s(a|an|the|one)\s/iu.test(after)
        ? 3
        : NUMBER.test(sentence)
          ? 2
          : DATE.test(sentence)
            ? 1
            : 0;
      if (priority === 0) continue;
      found.push({ candidate: best.index, text: sentence, priority, order });
      used.add(sentence);
    }
  }
  const perCandidate = new Map<number, number>();
  return found
    .sort((a, b) => b.priority - a.priority || a.candidate - b.candidate || a.order - b.order)
    .filter((fact) => {
      const n = perCandidate.get(fact.candidate) ?? 0;
      if (n >= INDEX_LIMITS.factsPerCandidate) return false;
      perCandidate.set(fact.candidate, n + 1);
      return true;
    })
    .slice(0, INDEX_LIMITS.facts)
    .map(({ candidate, text }) => ({ candidate, text }));
}
