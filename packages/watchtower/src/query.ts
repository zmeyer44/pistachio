export interface ArchiveQuery {
  terms: string[];
  /** The word still being typed: matched as a prefix, so "pistach" finds "pistachio". */
  prefix: string | null;
  phrases: string[];
  host: string | null;
  kind: string | null;
  after: number;
  before: number;
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
}

/** Deliberately small grammar; SQL and FTS syntax never come from raw input. */
export function parseQuery(
  input: string,
  tokenize: (text: string) => string[] = words,
): ArchiveQuery {
  if (input.length > 1000)
    throw new Error("Search is limited to 1,000 characters.");
  const result: ArchiveQuery = {
    terms: [],
    prefix: null,
    phrases: [],
    host: null,
    kind: null,
    after: 0,
    before: 8640000000000000,
  };
  const tokens = input.match(/"[^"]*"|\S+/gu) ?? [];
  for (const token of tokens) {
    const filter = /^(site|kind|after|before):(.+)$/iu.exec(token);
    if (filter) {
      const [, key, value = ""] = filter;
      if (key?.toLowerCase() === "site") {
        try {
          result.host = new URL(
            value.includes("://") ? value : `https://${value}`,
          ).hostname.toLowerCase();
        } catch {
          throw new Error("Use a domain after site:.");
        }
      } else if (key?.toLowerCase() === "kind") {
        if (!["article", "page", "video"].includes(value))
          throw new Error("Use kind:article, kind:page, or kind:video.");
        result.kind = value;
      } else {
        const at = Date.parse(`${value}T00:00:00Z`);
        if (
          !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
          !Number.isFinite(at) ||
          new Date(at).toISOString().slice(0, 10) !== value
        )
          throw new Error("Use dates as YYYY-MM-DD; date filters use UTC.");
        if (key?.toLowerCase() === "after") result.after = at;
        else result.before = at;
      }
      continue;
    }
    const parts = tokenize(token);
    if (token.startsWith('"') && parts.length > 0)
      result.phrases.push(parts.join(" "));
    result.terms.push(...parts);
  }
  const last = tokens[tokens.length - 1];
  if (
    last !== undefined &&
    !/\s$/u.test(input) &&
    !last.startsWith('"') &&
    !/^(site|kind|after|before):/iu.test(last)
  ) {
    const typed = tokenize(last).at(-1);
    if (typed !== undefined && typed.length >= 3) result.prefix = typed;
  }
  result.terms = [...new Set(result.terms)];
  if (result.terms.length > 12) throw new Error("Use up to 12 search words.");
  return result;
}
