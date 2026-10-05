import { describe, expect, it } from "vitest";
import type { ArtifactListing } from "@pistachio/shell-contracts/artifacts";
import type { Bookmark } from "@pistachio/shell-contracts/bookmarks";
import type { NoteSummary } from "@pistachio/shell-contracts/notes";
import { filterArtifacts, filterNotes, filterSaved, librarySummary, matchesLibraryQuery } from "../src/lib/library";

const AT = "2026-10-01T09:00:00.000Z";

function artifact(title: string, brief = ""): ArtifactListing {
  return {
    id: "a1b2c3d4e5f6",
    title,
    brief,
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
    builtWith: "anthropic/claude-opus-5",
    source: { kind: "agent", runId: null },
    url: "pistachio://artifact/a1b2c3d4e5f6",
  };
}

function note(title: string, snippet = ""): NoteSummary {
  return { id: "0123456789ab", title, snippet, icon: null, blobIds: [], createdAt: AT, updatedAt: AT, revision: 1, source: { kind: "user", runId: null } };
}

function saved(fields: Partial<Bookmark>): Bookmark {
  return {
    id: "6f1c2a3e-0d4b-4c5e-9f6a-7b8c9d0e1f2a",
    url: "https://shop.example/espresso",
    kind: "product",
    title: "Espresso machine",
    description: "",
    imageUrl: null,
    faviconUrl: null,
    siteName: "Shop",
    keywords: [],
    details: [],
    note: "",
    status: "ready",
    provenance: "page",
    editedFields: [],
    source: { kind: "user", runId: null },
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  };
}

describe("matchesLibraryQuery", () => {
  it("matches everything when nothing is typed", () => {
    expect(matchesLibraryQuery(["Anything"], "")).toBe(true);
    expect(matchesLibraryQuery([], "   ")).toBe(true);
  });

  it("needs every word, in any order, any case, across fields", () => {
    expect(matchesLibraryQuery(["Lisbon — trip plan", "Four days in October"], "TRIP lisbon")).toBe(true);
    expect(matchesLibraryQuery(["Lisbon — trip plan", "Four days in October"], "october lisbon")).toBe(true);
    expect(matchesLibraryQuery(["Lisbon — trip plan"], "lisbon porto")).toBe(false);
  });
});

describe("the library's filters", () => {
  it("find an artifact by its brief as well as its title", () => {
    const feed = artifact("Morning news feed", "What I missed since yesterday");
    expect(filterArtifacts([feed, artifact("Trip plan")], "missed")).toEqual([feed]);
  });

  it("find a note by its words, and an untitled note by the name it is shown under", () => {
    const groceries = note("Groceries", "milk, eggs, coffee");
    const untitled = note("", "call the plumber");
    expect(filterNotes([groceries, untitled], "coffee")).toEqual([groceries]);
    expect(filterNotes([groceries, untitled], "untitled")).toEqual([untitled]);
  });

  it("find a saved page by its site, address, keywords or the person's own note", () => {
    const espresso = saved({ keywords: ["coffee"], note: "for the office" });
    const other = saved({ title: "Hiking boots", url: "https://boots.example/", siteName: "Boots", keywords: [] });
    expect(filterSaved([espresso, other], "shop.example")).toEqual([espresso]);
    expect(filterSaved([espresso, other], "coffee office")).toEqual([espresso]);
    expect(filterSaved([espresso, other], "boots")).toEqual([other]);
  });
});

describe("librarySummary", () => {
  it("names each kind it knows, in the page's order", () => {
    expect(librarySummary({ artifacts: 3, notes: 1, saved: 40, visits: 1203 })).toBe(
      `3 artifacts · 1 note · 40 saved · ${(1203).toLocaleString()} visits`,
    );
  });

  it("leaves out a kind not known yet rather than calling it zero", () => {
    expect(librarySummary({ artifacts: null, notes: 0, saved: null, visits: null })).toBe("0 notes");
    expect(librarySummary({ artifacts: null, notes: null, saved: null, visits: null })).toBe("");
  });
});
