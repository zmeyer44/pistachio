import type { AgentToolCall, AgentToolOutput } from "./index.js";

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
