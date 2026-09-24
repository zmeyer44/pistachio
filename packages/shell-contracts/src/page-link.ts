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
