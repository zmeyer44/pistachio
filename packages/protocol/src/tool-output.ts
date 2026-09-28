import type { AgentSource, AgentToolCall, AgentToolOutput } from "./index.js";

/** How much of a page's title a source keeps: enough to name it, never a whole heading stack. */
const MAX_SOURCE_TITLE = 200;

function webAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The page a completed call read, from the tool's own result shape: an
 * inspected tab (`page.inspect` returns the page's title and address) or a
 * saved page opened from Watchtower (`watchtower.read` returns its hit as
 * `source`). Only web addresses count — an answer cannot cite a
 * `pistachio://` page — and anything else is null.
 */
export function toolSourceOf(name: AgentToolCall["name"], data: unknown): AgentSource | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const page = name === "page.inspect" ? record : name === "watchtower.read" ? record["source"] : null;
  if (typeof page !== "object" || page === null) return null;
  const fields = page as Record<string, unknown>;
  const url = webAddress(fields["url"]);
  if (url === null) return null;
  const title = typeof fields["title"] === "string" ? fields["title"].trim().slice(0, MAX_SOURCE_TITLE) : "";
  return { url, title: title === "" ? new URL(url).host : title };
}

/**
 * The output a completed call's result names, read from the tool's own
 * result shape (the note and artifact tool views in @pistachio/agent-runtime).
 * Anything else — a listing, a read, a delete, a malformed result — is null.
 */
export function toolOutputOf(name: AgentToolCall["name"], data: unknown): AgentToolOutput | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const id = text("id");
  if (id === null) return null;
  const title = text("title") ?? "Untitled";
  switch (name) {
    case "note.create":
    case "note.update":
      return { kind: "note", action: name === "note.create" ? "created" : "updated", id, title };
    case "artifact.create":
    case "artifact.update": {
      const url = text("url");
      if (url === null) return null;
      return { kind: "artifact", action: name === "artifact.create" ? "created" : "updated", id, title, url };
    }
    default:
      return null;
  }
}
