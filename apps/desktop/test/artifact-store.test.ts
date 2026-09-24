import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore, artifactResponse, setArtifactStore } from "../src/main/artifact-store";
import { MAX_ARTIFACTS, type ArtifactSource } from "@pistachio/shell-contracts/artifacts";

const AGENT: ArtifactSource = { kind: "agent", runId: "run-1" };
const LATER: ArtifactSource = { kind: "agent", runId: "run-2" };
const DOC = "<!doctype html>\n<html><head><title>Feed</title></head><body><h1>Today</h1></body></html>";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pistachio-artifacts-"));
}

/** A clock the test moves by hand, so updatedAt ordering is deterministic. */
function clock(start = "2026-08-28T12:00:00.000Z") {
  let at = new Date(start);
  return {
    now: () => at,
    advance(ms: number) {
      at = new Date(at.getTime() + ms);
    },
  };
}

function open(directory = scratch(), time = clock()) {
  return { store: new ArtifactStore(directory, { now: time.now }), directory, time };
}

function feed(store: ArtifactStore, source: ArtifactSource = AGENT) {
  return store.create({ title: "Morning news feed", brief: "What I missed", html: DOC, builtWith: "anthropic/claude-opus-5" }, source);
}

describe("ArtifactStore", () => {
  it("persists metadata and the page, and reads both back", () => {
    const { store, directory } = open();
    const created = feed(store);
    expect(created).toMatchObject({ title: "Morning news feed", revision: 1, source: AGENT, builtWith: "anthropic/claude-opus-5" });
    expect(created.id).toMatch(/^[a-f0-9]{12}$/);
    expect(readFileSync(join(directory, "artifacts", `${created.id}.html`), "utf8")).toBe(DOC);
    expect(JSON.parse(readFileSync(join(directory, "artifacts.json"), "utf8"))).toMatchObject({ version: 1 });
    const reopened = new ArtifactStore(directory);
    expect(reopened.get(created.id)).toEqual(created);
    expect(reopened.html(created.id)).toBe(DOC);
  });

  it("keeps the id and address across updates while the content changes", () => {
    const { store, time } = open();
    const created = feed(store);
    time.advance(60_000);
    const fresh = DOC.replace("Today", "Tomorrow");
    const updated = store.update(created.id, { html: fresh, builtWith: "anthropic/claude-opus-5" }, LATER);
    expect(updated.id).toBe(created.id);
    expect(updated.revision).toBe(2);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(updated.title).toBe(created.title);
    expect(updated.source).toEqual(LATER);
    expect(store.html(created.id)).toBe(fresh);
  });

  it("lists the most recently touched first", () => {
    const { store, time } = open();
    const first = feed(store);
    time.advance(1000);
    const second = store.create({ title: "Trip plan", brief: "", html: DOC, builtWith: "m" }, AGENT);
    expect(store.all().map((artifact) => artifact.id)).toEqual([second.id, first.id]);
    time.advance(1000);
    store.update(first.id, { html: DOC, builtWith: "m" }, AGENT);
    expect(store.all().map((artifact) => artifact.id)).toEqual([first.id, second.id]);
  });

  it("refuses an unknown id, an empty page, and a blank title", () => {
    const { store } = open();
    expect(() => store.update("aaaabbbbcccc", { html: DOC, builtWith: "m" }, AGENT)).toThrow(/no artifact/);
    expect(() => store.create({ title: "x", brief: "", html: "   ", builtWith: "m" }, AGENT)).toThrow(/document/);
    expect(() => store.create({ title: "  ", brief: "", html: DOC, builtWith: "m" }, AGENT)).toThrow(/title/);
  });

  it("holds the library at its cap and says what to do instead", () => {
    const { store } = open();
    for (let index = 0; index < MAX_ARTIFACTS; index += 1) feed(store);
    expect(() => feed(store)).toThrow(/update an existing one/);
  });
});

describe("serving", () => {
  it("serves the page under a strict CSP, uncached", async () => {
    const { store } = open();
    const created = feed(store);
    const response = store.respond(new URL(`pistachio://artifact/${created.id}`));
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe(DOC);
    expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const csp = response?.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("img-src data: blob:");
  });

  it("answers 404 for an id it does not hold and null off its hosts", () => {
    const { store } = open();
    expect(store.respond(new URL("pistachio://artifact/aaaabbbbcccc"))?.status).toBe(404);
    expect(store.respond(new URL("pistachio://artifact/../escape"))?.status).toBe(404);
    expect(store.respond(new URL("pistachio://reminders"))).toBeNull();
    expect(store.respond(new URL("pistachio://demo/invoices"))).toBeNull();
  });

  it("serves the library index with every page linked, and an empty state", async () => {
    const { store } = open();
    const empty = await store.respond(new URL("pistachio://artifacts"))?.text();
    expect(empty).toContain("Nothing here yet");
    const created = feed(store);
    const index = await store.respond(new URL("pistachio://artifacts"))?.text();
    // No account: the web app renders an artifact out of the signed-in
    // account's sync session, so the index links this Mac's own copy.
    expect(index).toContain(`pistachio://artifact/${created.id}`);
    expect(index).toContain("Morning news feed");
  });

  it("links the account's own web origin, never a hardcoded production one", async () => {
    let web: string | null = null;
    const store = new ArtifactStore(scratch(), { webUrl: () => web });
    const created = feed(store);
    web = "http://localhost:3000";
    expect(await store.respond(new URL("pistachio://artifacts"))?.text()).toContain(
      `http://localhost:3000/app/artifacts/${created.id}`,
    );
    // Signing out puts the link back on this Mac.
    web = null;
    expect(await store.respond(new URL("pistachio://artifacts"))?.text()).toContain(
      `pistachio://artifact/${created.id}`,
    );
  });

  it("escapes a title that carries markup", async () => {
    const { store } = open();
    store.create({ title: `<script>alert(1)</script>`, brief: "", html: DOC, builtWith: "m" }, AGENT);
    const index = (await store.respond(new URL("pistachio://artifacts"))?.text()) ?? "";
    expect(index).not.toContain("<script>alert(1)");
    expect(index).toContain("&lt;script&gt;");
  });

  it("answers through the registered store, and null before one exists", () => {
    setArtifactStore(null);
    expect(artifactResponse(new URL("pistachio://artifacts"))).toBeNull();
    const { store } = open();
    const created = feed(store);
    setArtifactStore(store);
    try {
      expect(artifactResponse(new URL(`pistachio://artifact/${created.id}`))?.status).toBe(200);
    } finally {
      setArtifactStore(null);
    }
  });

  it("survives a metadata entry whose file went missing", () => {
    const { store, directory } = open();
    const created = feed(store);
    rmSync(join(directory, "artifacts", `${created.id}.html`));
    expect(store.html(created.id)).toBeNull();
    expect(store.respond(new URL(`pistachio://artifact/${created.id}`))?.status).toBe(404);
  });
});
