/**
 * The artifact builder: the specialist that turns commissioned content
 * into one complete HTML document. The primary agent does the browsing
 * and judgment — what to build, what material goes in — and hands this
 * builder a title, a brief, and the material; the builder answers with
 * the page. It is one model call, not a tool loop: it has no browser and
 * no tools, so it can be a heavyweight coding model
 * (`PISTACHIO_ARTIFACT_MODEL`, Claude Opus by default) without ever
 * holding the console.
 *
 * On an update the builder also receives the current document and is told
 * to keep its shape: a daily feed stays the same page with fresh
 * headlines, not a new design every morning.
 */

import { generateText } from "ai";
import { extractArtifactHtml } from "@pistachio/shell-contracts/artifacts";
import { artifactModelName, configuredArtifactModel } from "./model-provider";

export interface ArtifactBuildRequest {
  title: string;
  /** What the page is for and how it should lean, from the primary agent. */
  brief: string;
  /** The material — headlines, summaries, and source links — gathered upstream. */
  content: string;
  /** The current document on an update; null commissions a fresh design. */
  priorHtml: string | null;
  abortSignal?: AbortSignal;
}

export interface ArtifactBuildResult {
  html: string;
  model: string;
}

const BUILDER_INSTRUCTIONS = `You are Pistachio's artifact builder. You turn a commissioned brief and its material into one complete, self-contained HTML document hosted by the Pistachio web app.

Rules:
- Answer with the HTML document only, from <!doctype html> to </html>. No prose before or after, no code fences.
- Everything inline: all CSS in one <style> element, any JavaScript in one <script> element. The page's Content-Security-Policy blocks external stylesheets, scripts, frameworks, and font files, and blocks fetch, XHR, and form submission — code that relies on them will silently fail.
- Network-loaded images, video, fonts, and embeds are blocked to protect private content. Prefer typography, CSS, and inline SVG; data URLs may be used only when the material already supplies them. Source links may use exact web addresses from the material. Never invent or guess an address.
- The material is the content; present it faithfully and completely. Do not add facts, numbers, dates, or quotes of your own, and do not drop items without being told to.
- Design for a real browser tab: responsive from a narrow window to a wide one, a system font stack, honest hierarchy, generous spacing. Set color-scheme and support light and dark via prefers-color-scheme.
- Give every image alt text and a width/height or aspect-ratio so the page does not shift while loading.
- Interactivity is welcome when it serves the content — a filter, a tab strip, collapsible sections — small and dependency-free.
- Give the document a <title>.`;

function createPrompt(request: ArtifactBuildRequest): string {
  return `Build the document.

TITLE: ${request.title}

BRIEF:
${request.brief}

MATERIAL:
${request.content}`;
}

function updatePrompt(request: ArtifactBuildRequest, priorHtml: string): string {
  return `Update an existing document. Keep its structure, style, and layout so the page stays familiar — this is the same page the person already knows, carrying new content. Change what the brief and material call for and nothing else. Answer with the complete updated document.

TITLE: ${request.title}

BRIEF:
${request.brief}

CURRENT DOCUMENT:
${priorHtml}

NEW MATERIAL:
${request.content}`;
}

export async function buildArtifactHtml(request: ArtifactBuildRequest): Promise<ArtifactBuildResult> {
  const result = await generateText({
    model: configuredArtifactModel(),
    system: BUILDER_INSTRUCTIONS,
    prompt: request.priorHtml === null ? createPrompt(request) : updatePrompt(request, request.priorHtml),
    maxOutputTokens: 32_000,
    ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
  });
  if (result.finishReason === "length") throw new Error("the builder ran out of room; commission a smaller page");
  return { html: extractArtifactHtml(result.text, request.title), model: artifactModelName() };
}
