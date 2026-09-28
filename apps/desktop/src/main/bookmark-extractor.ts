/**
 * Reading a page for what it is ABOUT.
 *
 * Two passes. The first is deterministic and instant: Open Graph, JSON-LD,
 * and plain meta tags become a draft (@pistachio/shell-contracts/bookmarks `draftFromPage`)
 * — good enough for most pages, and all there is when no model is
 * configured. The second hands the draft, the tags, and an excerpt of the
 * page's text to the model with one question: what is the thing here, and
 * how would the person find it again? Its answer is checked against the
 * page (an image it names must be one the page showed) and replaces the
 * draft where it improves on it.
 *
 * The same answer names everything ELSE the page is about, for Watchtower's
 * index: a profile page is a person and the company they run, a review is
 * a product and its maker, a funding story a company, its founders and its
 * investors. Each comes with sentences copied from the page — checked to be
 * there, word for word, before one is kept — so a fact is always something
 * the page said, never something the model wrote.
 *
 * Best-effort in the way memory's learner is: no key, a timeout, a model
 * that returns nonsense — the draft stands and the bookmark is still
 * saved. Nothing here can fail a capture.
 */

import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import {
  BOOKMARK_KIND_LABEL,
  BOOKMARK_KINDS,
  bookmarkHost,
  canonicalUrl,
  draftFromPage,
  imageCandidates,
  MAX_BOOKMARK_DESCRIPTION,
  MAX_BOOKMARK_DETAILS,
  MAX_BOOKMARK_KEYWORDS,
  MAX_BOOKMARK_TITLE,
  sanitizeDetails,
  sanitizeKeywords,
  type BookmarkFields,
  type BookmarkProvenance,
  type PageSnapshot,
} from "@pistachio/shell-contracts/bookmarks";
import {
  WATCHTOWER_ENTITY_KINDS,
  WATCHTOWER_FACT_KINDS,
  type WatchtowerSavedEntity,
} from "@pistachio/shell-contracts/watchtower";
import { aiAvailable, configuredModel, loadWorkspaceEnvironment } from "./model-provider";

export interface BookmarkExtraction {
  fields: BookmarkFields;
  /** The page's own address for itself, cleaned. */
  url: string;
  provenance: BookmarkProvenance;
  /** What the page is about, for Watchtower's index. Empty without a model. */
  entities?: WatchtowerSavedEntity[];
}

export interface ExtractOptions {
  /** Consult the model at all (Settings → Bookmarks). */
  useModel?: boolean;
  model?: LanguageModel;
  env?: NodeJS.ProcessEnv;
  /** What the person or the agent said about the save — "the espresso machine, not the grinder". */
  hint?: string;
  timeoutMs?: number;
}

const MODEL_TIMEOUT_MS = 45_000;
/** The whole captured text: a person named in the last paragraph is still named. */
const MAX_PROMPT_TEXT = 12_000;
export const MAX_SAVED_ENTITIES = 12;
const MAX_FACTS_PER_ENTITY = 4;
const MAX_FACT = 400;
const SAVED_KINDS = WATCHTOWER_ENTITY_KINDS.filter(
  (kind): kind is Exclude<(typeof WATCHTOWER_ENTITY_KINDS)[number], "question"> => kind !== "question",
);
const MAX_PROMPT_META = 60;
const MAX_PROMPT_JSON_LD = 5_000;

/** Offline under Playwright unless a live agent was asked for, like the embedder and read-aloud. */
function offline(env: NodeJS.ProcessEnv): boolean {
  return env["PISTACHIO_E2E"] === "1" && env["PISTACHIO_AGENT_LIVE"] !== "1";
}

/** Flat on purpose: one shape every provider's structured output can fill. */
const EXTRACTION_SCHEMA = z.object({
  kind: z.enum(BOOKMARK_KINDS).describe("What the page is about. product for anything for sale; article for a piece of writing; website for a site or a page that is not about one thing."),
  title: z
    .string()
    .min(1)
    .max(MAX_BOOKMARK_TITLE)
    .describe("The thing's own name, as a person would say it: “Breville Barista Express”, “Project Hail Mary”, “Dune: Part Two”. No site name, no SEO tail, no category."),
  description: z
    .string()
    .max(MAX_BOOKMARK_DESCRIPTION)
    .describe("One or two plain sentences on what it is and what makes it worth saving, from the page. No marketing voice."),
  siteName: z.string().max(80).nullable().describe("The site or publisher, short: “Amazon”, “Goodreads”, “The Verge”."),
  imageUrl: z.string().nullable().describe("The candidate image that shows the thing itself — the product, the cover, the poster, the dish — or null if none does."),
  keywords: z
    .array(z.string().max(40))
    .max(MAX_BOOKMARK_KEYWORDS)
    .describe("Words a person would search to find this again: category, brand, author, genre, topic, cuisine, what it is for. Lowercase, 6 to 12 of them."),
  details: z
    .array(z.object({ label: z.string().min(1).max(40), value: z.string().min(1).max(200) }))
    .max(MAX_BOOKMARK_DETAILS)
    .describe("Facts the page states about the thing, each a short label and value: Price, Brand, Author, Director, Year, Rating, Cook time, Serves, Platform. Only what the page says; never guess."),
  entities: z
    .array(
      z.object({
        kind: z
          .enum(SAVED_KINDS as [string, ...string[]])
          .describe("person, company (a business or brand), organization (not a business: university, government, team, band), product, technology, place, event, work (a book, film, show, song, game, paper, recipe, course), project (an open-source repository or initiative), concept (an idea, field or topic)."),
        name: z.string().min(1).max(120).describe("Its own full name as the page writes it: “Patrick Collison”, “Stripe”, “Barista Express”."),
        alsoKnownAs: z.array(z.string().max(120)).max(4).describe("Other names the page uses for it: a surname, an abbreviation, a legal name."),
        role: z.enum(["subject", "major", "mention"]).describe("subject: what the page is about; major: discussed at some length; mention: named in passing."),
        facts: z
          .array(
            z.object({
              kind: z.enum(WATCHTOWER_FACT_KINDS).describe("definition: what it is or does; metric: a measured number; price: what it costs; event: something that happened to it; claim: an assertion someone could check or dispute."),
              quote: z.string().min(1).max(MAX_FACT).describe("One sentence copied EXACTLY from the visible text, word for word, that states the fact."),
            }),
          )
          .max(MAX_FACTS_PER_ENTITY),
      }),
    )
    .max(MAX_SAVED_ENTITIES)
    .describe("Everything the page is about that the person might look up again, most central first — the thing itself, and the people, companies, products, places and ideas the page tells them about."),
});

function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_PROMPT_TEXT ? `${collapsed.slice(0, MAX_PROMPT_TEXT)}…` : collapsed;
}

function metaLines(snapshot: PageSnapshot): string {
  const wanted = snapshot.meta.filter((entry) => /^(og:|twitter:|article:|book:|video:|music:|product:|description$|keywords$|author$|title$)/.test(entry.name));
  const rest = snapshot.meta.filter((entry) => !wanted.includes(entry));
  return [...wanted, ...rest]
    .slice(0, MAX_PROMPT_META)
    .map((entry) => `${entry.name}: ${entry.content.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
}

function jsonLdText(snapshot: PageSnapshot): string {
  if (snapshot.jsonLd.length === 0) return "(none)";
  try {
    const text = JSON.stringify(snapshot.jsonLd);
    return text.length > MAX_PROMPT_JSON_LD ? `${text.slice(0, MAX_PROMPT_JSON_LD)}…` : text;
  } catch {
    return "(unreadable)";
  }
}

export function extractionPrompt(snapshot: PageSnapshot, draft: BookmarkFields, images: string[], hint: string | undefined): string {
  return `A person just bookmarked a web page in their browser. The bookmark is about the THING on the page, not the page: a listing for a coffee maker is a bookmark of the coffee maker; a Goodreads or Amazon page for a novel is a bookmark of the novel; a recipe page is the recipe; a news story is the story. Read what the page says about itself and fill in the bookmark.

Address: ${snapshot.url}
Site: ${bookmarkHost(snapshot.url)}
Document title: ${snapshot.title || "(none)"}
First heading: ${snapshot.headline || "(none)"}
${hint === undefined || hint.trim() === "" ? "" : `What the person said when saving it: ${hint.trim()}\n`}
A first reading from the page's tags — improve on it where the page supports better, keep it where it is right:
kind: ${draft.kind} (${BOOKMARK_KIND_LABEL[draft.kind]})
title: ${draft.title}
description: ${draft.description || "(none)"}
site: ${draft.siteName || "(none)"}
details: ${draft.details.length === 0 ? "(none)" : draft.details.map((detail) => `${detail.label}=${detail.value}`).join("; ")}
keywords: ${draft.keywords.join(", ") || "(none)"}

Meta tags:
${metaLines(snapshot) || "(none)"}

Structured data (JSON-LD):
${jsonLdText(snapshot)}

Candidate images, best guess first (choose imageUrl from these exactly, or null):
${images.length === 0 ? "(none)" : images.map((image, index) => `${String(index + 1)}. ${image}`).join("\n")}

Visible text (excerpt):
"""
${excerpt(snapshot.text) || "(none)"}
"""

Rules:
- title names the thing, not the page or the site. Drop "Amazon.com:", "| Goodreads", " - YouTube", category tails, and model-number noise unless it is the name.
- kind: pick the one thing the page is about. A store's category or search page is a website; a single listing is a product. A channel page is a website; one video is a video. A restaurant's own site or its Yelp page is a place.
- description: what it is, in plain words, from the page. Two sentences at most.
- details: only facts the page states, and only ones a person would want at a glance for this kind of thing. Prices with their currency symbol; years as years; durations like "2h 10m".
- keywords: what the person would type to find it again — the category, the maker, the author, the genre, the topic, the use. Not the site's SEO list verbatim.
- imageUrl: the picture OF the thing. A logo, an avatar, or a banner is not it; return null rather than a wrong image.
- entities: the thing itself first, then each person, company, organization, product, technology, place, event, work, project or concept the page says something about. A page about a founder is the person AND their company; a review is the product AND its maker. Leave out the site that published the page unless the page is about it, and anything only listed in navigation, ads or "related" links. A name from the page, never one you know from elsewhere.
- facts: copy whole sentences from the visible text above exactly as written — never paraphrase, never combine two sentences, never add a fact the text does not state. Better none than one that is not on the page.`;
}

/** Whitespace and typographic quotes vary between how a page renders and how a model copies it. */
function comparable(text: string): string {
  return text.replace(/[“”«»„]/gu, '"').replace(/[‘’‚]/gu, "'").replace(/\s+/gu, " ").trim();
}

/** The sentence of the page that names `names` first, for an entry's example. */
function sentenceNaming(text: string, names: string[]): string {
  for (const name of names) {
    if (name.length < 2) continue;
    const at = text.indexOf(name);
    if (at === -1) continue;
    const start = Math.max(text.lastIndexOf(". ", at) + 2, at - 160, 0);
    const stop = text.indexOf(". ", at + name.length);
    const end = stop === -1 ? Math.min(text.length, at + 200) : Math.min(stop + 1, at + 200);
    return text.slice(start, end).trim();
  }
  return "";
}

/**
 * The model's entities, checked against the page: a fact is kept only if
 * its sentence is in the page's text; names are trimmed and deduplicated;
 * at most twelve, most central first.
 */
export function verifiedEntities(answer: z.infer<typeof EXTRACTION_SCHEMA>["entities"], pageText: string): WatchtowerSavedEntity[] {
  const page = comparable(pageText);
  const seen = new Set<string>();
  const out: WatchtowerSavedEntity[] = [];
  const order = { subject: 0, major: 1, mention: 2 } as const;
  for (const entity of [...answer].sort((a, b) => order[a.role] - order[b.role])) {
    const name = entity.name.replace(/\s+/gu, " ").trim();
    const key = `${entity.kind}:${name.toLowerCase()}`;
    if (name === "" || seen.has(key) || !(SAVED_KINDS as readonly string[]).includes(entity.kind)) continue;
    seen.add(key);
    const facts: WatchtowerSavedEntity["facts"] = [];
    for (const fact of entity.facts) {
      const text = comparable(fact.quote).replace(/^"|"$/gu, "");
      if (text.length < 12 || !page.includes(text) || facts.some((kept) => kept.text === text)) continue;
      facts.push({ kind: fact.kind, text: text.slice(0, MAX_FACT) });
    }
    const aliases = [...new Set(entity.alsoKnownAs.map((alias) => alias.replace(/\s+/gu, " ").trim()))].filter((alias) => alias !== "" && alias !== name).slice(0, 4);
    out.push({
      kind: entity.kind as WatchtowerSavedEntity["kind"],
      name: name.slice(0, 120),
      aliases,
      role: entity.role,
      facts: facts.slice(0, MAX_FACTS_PER_ENTITY),
      context: sentenceNaming(comparable(pageText), [name, ...aliases]) || facts[0]?.text || "",
    });
    if (out.length === MAX_SAVED_ENTITIES) break;
  }
  return out;
}

/**
 * The draft, then the model's improvement of it when one is available.
 * Resolves with the page's draft on any failure; never throws.
 */
export async function extractBookmark(snapshot: PageSnapshot, options: ExtractOptions = {}): Promise<BookmarkExtraction> {
  const draft = draftFromPage(snapshot);
  const url = canonicalUrl(snapshot);
  const env = options.env ?? process.env;
  if (options.useModel === false || offline(env)) return { fields: draft, url, provenance: "page" };
  let model: LanguageModel;
  try {
    loadWorkspaceEnvironment();
    if (options.model === undefined && !aiAvailable()) return { fields: draft, url, provenance: "page" };
    model = options.model ?? configuredModel();
  } catch {
    return { fields: draft, url, provenance: "page" };
  }
  const images = imageCandidates(snapshot);
  try {
    const { object } = await generateObject({
      model,
      schema: EXTRACTION_SCHEMA,
      prompt: extractionPrompt(snapshot, draft, images, options.hint),
      abortSignal: AbortSignal.timeout(options.timeoutMs ?? MODEL_TIMEOUT_MS),
    });
    return { fields: mergeModelAnswer(draft, object, images), url, provenance: "model", entities: verifiedEntities(object.entities, snapshot.text) };
  } catch {
    return { fields: draft, url, provenance: "page" };
  }
}

/**
 * The model's answer, checked against the page: an image must be one of
 * the candidates; empty answers keep the draft's value; keywords are the
 * model's first, the draft's after, so the page's own tags are never lost.
 */
export function mergeModelAnswer(draft: BookmarkFields, answer: Omit<z.infer<typeof EXTRACTION_SCHEMA>, "entities">, images: string[]): BookmarkFields {
  const title = answer.title.replace(/\s+/g, " ").trim();
  const description = answer.description.replace(/\s+/g, " ").trim();
  const image = answer.imageUrl?.trim() ?? "";
  const imageUrl = image === "" ? null : images.find((candidate) => candidate === image) ?? images.find((candidate) => candidate.startsWith(image) || image.startsWith(candidate)) ?? null;
  const keywords = sanitizeKeywords([...answer.keywords, ...draft.keywords]);
  const details = sanitizeDetails(answer.details);
  return {
    kind: answer.kind,
    title: title === "" ? draft.title : title.slice(0, MAX_BOOKMARK_TITLE),
    description: description === "" ? draft.description : description.slice(0, MAX_BOOKMARK_DESCRIPTION),
    imageUrl: imageUrl ?? draft.imageUrl,
    siteName: (answer.siteName ?? "").trim() || draft.siteName,
    keywords: keywords.length === 0 ? draft.keywords : keywords,
    details: details.length === 0 ? draft.details : details,
  };
}
