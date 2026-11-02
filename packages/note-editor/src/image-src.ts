/**
 * A picture by address (docs/notes.md §5): what the Image prompt accepts.
 * The web, by http or https, and nothing else — a `data:` picture would put
 * megabytes in the document, a `file:` one names something only one machine
 * has, and the rest is not a picture at all.
 */
export function safeImageSrc(input: string): string | null {
  const value = input.trim();
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/iu.test(value) ? value : `https://${value.replace(/^\/\//u, "")}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
  return url.toString();
}
