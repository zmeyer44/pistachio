import { describe, expect, it } from "vitest";
import type { Entry } from "../src/components/address-palette";
import { entryFieldText } from "../src/lib/use-field-preview";

describe("what the address field shows for the active row", () => {
  it("shows a page row's address, whichever list the page came from", () => {
    const site = { host: "github.com", url: "https://github.com/pulls", title: "Pull requests" } as Extract<Entry, { kind: "history" }>["site"];
    const rows: Entry[] = [
      { kind: "history", id: "h", url: site.url, site },
      { kind: "shelf", id: "s", url: "https://github.com/pulls", anchorId: "a", title: "Pulls", faviconUrl: null, note: "Favorite" },
      { kind: "paste", id: "p", url: "https://github.com/pulls", title: "Paste and Go", subtitle: "github.com/pulls" },
      { kind: "recent", id: "r", url: "https://github.com/pulls", label: "github.com", host: "github.com", faviconUrl: null },
    ];
    for (const row of rows) expect(entryFieldText(row, "gi")).toBe("https://github.com/pulls");
  });

  it("keeps the typed text for the rows that ARE the typed text", () => {
    const search: Entry = {
      kind: "suggestion",
      id: "search",
      url: "https://www.google.com/search?q=gi",
      item: { id: "search", kind: "search", title: "Search Google for “gi”", url: "https://www.google.com/search?q=gi" },
    };
    expect(entryFieldText(search, "gi ")).toBe("gi ");
  });

  it("names a command, which has no address", () => {
    const action: Entry = { kind: "action", id: "chrome:reload", title: "Reload page", category: "Action", icon: null, run: () => undefined };
    expect(entryFieldText(action, "rel")).toBe("Reload page");
  });

  it("falls back to the typed text for a page with no address yet", () => {
    const blank: Entry = { kind: "shelf", id: "s", url: "", anchorId: "a", title: "Untitled", faviconUrl: null, note: "Pinned" };
    expect(entryFieldText(blank, "un")).toBe("un");
  });
});
