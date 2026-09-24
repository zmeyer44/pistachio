/**
 * Reading a page for its ARTICLE — the counterpart to bookmark-extractor,
 * which reads a page for what it is about.
 *
 * The script itself moved to `@pistachio/shell-contracts/reader-extract` in
 * S6 so the cloud shell host reads a page the same way (§11); what stays here
 * is main's way of running it, inside the tab's own WebContents (like
 * BrowserController.capturePage), so a piece behind a sign-in or rendered by
 * script is read exactly as the person sees it.
 */

import type { WebContents } from "electron";
import { normalizeReaderArticle, type ReaderArticle } from "@pistachio/shell-contracts/reader";
import { READER_EXTRACT_SCRIPT } from "@pistachio/shell-contracts/reader-extract";

/**
 * Read the tab's article, or null when the page has no readable prose. Never
 * throws for a page it cannot read — reader view is offered, not enforced.
 */
export async function extractReaderArticle(contents: WebContents): Promise<ReaderArticle | null> {
  let raw: unknown;
  try {
    raw = await contents.executeJavaScript(READER_EXTRACT_SCRIPT, true);
  } catch (error) {
    console.warn("[reader] the page could not be read", error);
    return null;
  }
  const article = normalizeReaderArticle(raw);
  // A handful of stray lines is a landing page, not something to sit and read.
  if (article === null || article.wordCount < 120) return null;
  return article;
}

export { READER_EXTRACT_SCRIPT };
