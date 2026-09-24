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
import { aiAvailable, configuredModel, loadWorkspaceEnvironment } from "./model-provider";

export interface BookmarkExtraction {
  fields: BookmarkFields;
  /** The page's own address for itself, cleaned. */
  url: string;
  provenance: BookmarkProvenance;
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
const MAX_PROMPT_TEXT = 7_000;
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
- imageUrl: the picture OF the thing. A logo, an avatar, or a banner is not it; return null rather than a wrong image.`;
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
    return { fields: mergeModelAnswer(draft, object, images), url, provenance: "model" };
  } catch {
    return { fields: draft, url, provenance: "page" };
  }
}

/**
 * The model's answer, checked against the page: an image must be one of
 * the candidates; empty answers keep the draft's value; keywords are the
 * model's first, the draft's after, so the page's own tags are never lost.
 */
export function mergeModelAnswer(draft: BookmarkFields, answer: z.infer<typeof EXTRACTION_SCHEMA>, images: string[]): BookmarkFields {
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
