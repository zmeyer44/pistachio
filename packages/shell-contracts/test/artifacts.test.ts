import { describe, expect, it } from "vitest";
import {
  artifactToolView,
  artifactUrl,
  extractArtifactHtml,
  isArtifactId,
  sanitizeArtifactDocument,
  type Artifact,
} from "../src/artifacts.js";

const DOC = "<!doctype html>\n<html><head><title>Hi</title></head><body><p>Hi</p></body></html>";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "a1b2c3d4e5f6",
    title: "Morning news feed",
    brief: "What I missed since yesterday",
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
    revision: 1,
    builtWith: "anthropic/claude-opus-5",
    source: { kind: "agent", runId: "run-1" },
    ...overrides,
  };
}

describe("artifact addresses", () => {
  it("builds the stable hosted address from the id and configured web origin", () => {
    expect(artifactUrl("a1b2c3d4e5f6")).toBe("https://pistachio.run/app/artifacts/a1b2c3d4e5f6");
    expect(artifactUrl("a1b2c3d4e5f6", "http://localhost:3000/")).toBe("http://localhost:3000/app/artifacts/a1b2c3d4e5f6");
  });

  it("accepts exactly twelve hex characters as an id", () => {
    expect(isArtifactId("a1b2c3d4e5f6")).toBe(true);
    expect(isArtifactId("A1B2C3D4E5F6")).toBe(false);
    expect(isArtifactId("a1b2c3d4e5")).toBe(false);
    expect(isArtifactId("../etc/passwd")).toBe(false);
    expect(isArtifactId("")).toBe(false);
  });

  it("shows the tool the address, not the file", () => {
    expect(artifactToolView(artifact())).toEqual({
      id: "a1b2c3d4e5f6",
      url: "https://pistachio.run/app/artifacts/a1b2c3d4e5f6",
      title: "Morning news feed",
      brief: "What I missed since yesterday",
      updatedAt: "2026-08-28T12:00:00.000Z",
      revision: 1,
    });
  });
});

describe("extractArtifactHtml", () => {
  it("passes a bare document through untouched", () => {
    expect(extractArtifactHtml(DOC, "Hi")).toBe(DOC);
  });

  it("peels a code fence off a fenced answer", () => {
    expect(extractArtifactHtml("```html\n" + DOC + "\n```", "Hi")).toBe(DOC);
  });

  it("drops prose before the doctype and after the close tag", () => {
    expect(extractArtifactHtml(`Here is your page:\n\n${DOC}\n\nEnjoy!`, "Hi")).toBe(DOC);
  });

  it("wraps a fragment in a minimal document carrying the title", () => {
    const wrapped = extractArtifactHtml("<p>Just this</p>", "A <weird> \"title\"");
    expect(wrapped).toContain("<!doctype html>");
    expect(wrapped).toContain("<p>Just this</p>");
    expect(wrapped).toContain("<title>A &lt;weird&gt; &quot;title&quot;</title>");
  });

  it("refuses an answer with no markup at all", () => {
    expect(() => extractArtifactHtml("I could not build the page, sorry.", "Hi")).toThrow(/no HTML/);
  });
});

describe("sanitizeArtifactDocument", () => {
  it("keeps what parses and drops what does not", () => {
    const good = artifact();
    const document = sanitizeArtifactDocument({
      version: 1,
      artifacts: [good, { id: "nope" }, null, artifact({ id: "not hex chars" }), artifact({ revision: 0 })],
    });
    expect(document.artifacts).toEqual([good]);
  });

  it("keeps only the first appearance of a duplicated id", () => {
    const first = artifact({ title: "First" });
    const document = sanitizeArtifactDocument({ version: 1, artifacts: [first, artifact({ title: "Second" })] });
    expect(document.artifacts).toEqual([first]);
  });

  it("answers empty for garbage, a wrong version, or no file", () => {
    expect(sanitizeArtifactDocument(null).artifacts).toEqual([]);
    expect(sanitizeArtifactDocument("what").artifacts).toEqual([]);
    expect(sanitizeArtifactDocument({ version: 2, artifacts: [artifact()] }).artifacts).toEqual([]);
  });
});
