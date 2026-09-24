import type { WatchtowerRawCapture } from "@pistachio/agent-runtime/watchtower";

/**
 * Page-owned data is bounded and re-typed before anything else sees it; the
 * archive is never handed arbitrary DOM-derived objects. Returns null for
 * anything that is not the shape `capturePage` produces.
 */
export function validateCapture(raw: unknown): WatchtowerRawCapture | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value["url"] !== "string" ||
    typeof value["title"] !== "string" ||
    !Array.isArray(value["blocks"]) ||
    value["blocks"].length > 1500
  )
    return null;
  const paths = (Array.isArray(value["paths"]) ? value["paths"] : [])
    .slice(0, 400)
    .map((path) =>
      typeof path === "string"
        ? path
            .slice(0, 1100)
            .split(">")
            .slice(0, 10)
            .map((segment) => segment.slice(0, 100))
        : [],
    );
  const blocks: WatchtowerRawCapture["blocks"] = [];
  let length = 0;
  for (const block of value["blocks"] as unknown[]) {
    if (!block || typeof block !== "object") return null;
    const { text, path, linkChars } = block as Record<string, unknown>;
    if (typeof text !== "string" || text.length > 21000) return null;
    length += Buffer.byteLength(text);
    if (length > 240 * 1024) return null;
    blocks.push({
      text,
      path: (typeof path === "number" ? paths[path] : undefined) ?? [],
      linkChars:
        typeof linkChars === "number" && Number.isFinite(linkChars)
          ? Math.max(0, Math.min(text.length, Math.floor(linkChars)))
          : 0,
    });
  }
  const links: WatchtowerRawCapture["links"] = [];
  if (Array.isArray(value["links"]))
    for (const item of value["links"].slice(0, 100) as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const link = item as Record<string, unknown>;
      if (typeof link["url"] !== "string" || link["url"].length > 2048) continue;
      const text =
        typeof link["text"] === "string" ? link["text"].slice(0, 300) : "";
      length += Buffer.byteLength(link["url"] + text);
      if (length > 240 * 1024) return null;
      links.push({
        url: link["url"],
        text,
        block:
          typeof link["block"] === "number" && Number.isInteger(link["block"])
            ? link["block"]
            : -1,
      });
    }
  const short = (field: unknown, max: number): string =>
    typeof field === "string" ? field.slice(0, max) : "";
  return {
    url: value["url"].slice(0, 8192),
    title: value["title"].slice(0, 500),
    description: short(value["description"], 3000),
    creator: short(value["creator"], 300),
    published: short(value["published"], 40),
    duration: short(value["duration"], 40),
    kind:
      value["kind"] === "video" || value["kind"] === "article"
        ? value["kind"]
        : "page",
    blocks,
    links,
    truncated: value["truncated"] === true,
  };
}
