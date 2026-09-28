/**
 * A page as a Markdown link, `[title](url)`, for "Copy page URL as Markdown".
 * The title is the link text, so the characters that would end or break it
 * are escaped; a page with no title links its address instead. The URL is
 * wrapped in angle brackets only when it holds a character Markdown would
 * otherwise stop at (a space, or an unbalanced parenthesis is rare enough to
 * cover with the same rule).
 */
export function pageLinkMarkdown(title: string, url: string): string {
  const text = title.trim().replace(/\s+/g, " ").replace(/([\\[\]])/g, "\\$1");
  const target = /[\s()<>]/.test(url) ? `<${url}>` : url;
  return `[${text === "" ? url : text}](${target})`;
}

/**
 * What the chrome says once "Copy page URL" has done its copying — the key
 * (⌘⇧C, ⌘⌥⇧C) has no visible result of its own. One wording for the desktop
 * and the cloud browser, so the same press reads the same in both.
 */
export function copyUrlNotice(format: "plain" | "markdown"): string {
  return format === "markdown" ? "Link copied as Markdown" : "URL copied";
}

/**
 * Whether a copy in this document has anything of its own to copy: a range
 * (text, an image) or the selected part of a text field, looked for through
 * open shadow roots. Any sign of one counts, so a bare ⌘C only ever falls
 * back to copying the page's URL when there is truly nothing selected.
 */
export function hasCopyableSelection(document: Document): boolean {
  const selection = document.getSelection();
  if (selection !== null && (selection.type === "Range" || selection.toString() !== "")) return true;
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    return active.selectionStart !== null && active.selectionStart !== active.selectionEnd;
  }
  return false;
}
