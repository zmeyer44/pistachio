/**
 * The contract every `BrowserBackend` must meet, as a vitest suite a
 * backend's own test file runs against itself: the desktop backend over a
 * real Electron tab, the cloud backend over a Playwright page, and an
 * in-memory fake in this package. The same fixture page is served at
 * `fixtureUrl` by the caller — `BROWSER_BACKEND_FIXTURE_HTML`, byte for
 * byte — so `inspect()` has one right answer and the interaction cases
 * exercise the parts a synthetic path gets wrong: a typeahead that reacts
 * only to trusted keystrokes, a form that submits on a real Enter.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { executeBrowserTool, type BrowserBackend, type PageInspection } from "../browser-backend.js";

/** The page a contract run serves at `fixtureUrl`. */
export const BROWSER_BACKEND_FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Backend fixture</title>
<style>
  #editor { min-height: 1.5em; border: 1px solid #999; }
</style>
</head>
<body>
<h1>Backend fixture</h1>
<p>A page for the browser backend contract.</p>
<form id="search">
  <input id="query" name="q" type="text" placeholder="Search" autocomplete="off">
  <button id="go" type="submit">Go</button>
</form>
<textarea id="notes" name="notes" placeholder="Notes"></textarea>
<div id="editor" contenteditable="true" role="textbox" aria-label="Editor"></div>
<input id="typeahead" type="text" placeholder="Typeahead" autocomplete="off">
<ul id="suggestions" hidden>
  <li id="suggestion-1" role="option">Suggestion one</li>
  <li id="suggestion-2" role="option">Suggestion two</li>
</ul>
<button id="toggle" type="button">Toggle</button>
<p id="status">idle</p>
<a id="link" href="https://example.com/next">Next page</a>
<script>
  const status = document.getElementById("status");
  document.getElementById("search").addEventListener("submit", (event) => {
    event.preventDefault();
    status.textContent = "submitted " + document.getElementById("query").value;
  });
  document.getElementById("toggle").addEventListener("click", () => {
    status.textContent = status.textContent === "toggled" ? "idle" : "toggled";
  });
  // A typeahead that opens only for real keystrokes: a synthetic value
  // setter plus an input event — what a backend falls back to when its
  // keys do not land — leaves it closed.
  document.getElementById("typeahead").addEventListener("keydown", (event) => {
    if (event.isTrusted) document.getElementById("suggestions").hidden = false;
  });
</script>
</body>
</html>
`;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function control(fields: Partial<PageInspection["controls"][number]> & Pick<PageInspection["controls"][number], "role" | "name" | "selector">) {
  return { href: null, type: null, value: null, disabled: false, ...fields };
}

/** What `inspect()` returns for the untouched fixture page at `url`. */
export function fixtureInspection(url: string): PageInspection {
  return {
    title: "Backend fixture",
    url: new URL(url).href,
    text: "Backend fixture A page for the browser backend contract. Go Toggle idle Next page",
    controls: [
      control({ role: "input", name: "Search", selector: "#query", type: "text", value: "" }),
      control({ role: "button", name: "Go", selector: "#go" }),
      control({ role: "textarea", name: "Notes", selector: "#notes", value: "" }),
      control({ role: "textbox", name: "Editor", selector: "#editor", value: "" }),
      control({ role: "input", name: "Typeahead", selector: "#typeahead", type: "text", value: "" }),
      control({ role: "button", name: "Toggle", selector: "#toggle" }),
      control({ role: "a", name: "Next page", selector: "#link", href: "https://example.com/next" }),
    ],
  };
}

function valueOf(page: PageInspection, selector: string): string | null {
  return page.controls.find((item) => item.selector === selector)?.value ?? null;
}

/**
 * Run the contract against one backend. `make` builds a fresh backend per
 * case; each case opens a tab and navigates it to `fixtureUrl`, which must
 * serve `BROWSER_BACKEND_FIXTURE_HTML` and be the URL the page reports as
 * `location.href`.
 */
export function browserBackendContract(name: string, make: () => Promise<BrowserBackend>, fixtureUrl: string): void {
  describe(`BrowserBackend contract: ${name}`, () => {
    let backend: BrowserBackend;
    let tabId: string;

    beforeEach(async () => {
      backend = await make();
      tabId = await backend.openTab();
      await backend.navigate(tabId, fixtureUrl);
    });

    it("lists the tab it opened", () => {
      expect(backend.kind === "desktop" || backend.kind === "cloud").toBe(true);
      expect(backend.listTabs().some((tab) => tab.id === tabId)).toBe(true);
    });

    it("inspects the fixture page identically", async () => {
      expect(await backend.inspect(tabId)).toEqual(fixtureInspection(fixtureUrl));
    });

    it("clicks by selector and by visible text", async () => {
      await backend.click(tabId, "#toggle");
      expect((await backend.inspect(tabId)).text).toContain("Toggle toggled Next page");
      await backend.click(tabId, "Toggle");
      expect((await backend.inspect(tabId)).text).toContain("Toggle idle Next page");
    });

    it("rejects a click target it cannot find", async () => {
      await expect(backend.click(tabId, "#no-such-control")).rejects.toThrow("page control not found: #no-such-control");
      await expect(backend.click(tabId, "Nothing here")).rejects.toThrow("page control not found: Nothing here");
    });

    it("types into an input, a textarea, and a contenteditable, and reads each back", async () => {
      expect(await backend.type(tabId, "#query", "hello world")).toBe("hello world");
      expect(await backend.type(tabId, "#notes", "a line of notes")).toBe("a line of notes");
      expect(await backend.type(tabId, "#editor", "Hello editor")).toBe("Hello editor");
      const page = await backend.inspect(tabId);
      expect(valueOf(page, "#query")).toBe("hello world");
      expect(valueOf(page, "#notes")).toBe("a line of notes");
      expect(valueOf(page, "#editor")).toBe("Hello editor");
      expect(page.text).toContain("Hello editor");
    });

    it("replaces what a control already holds", async () => {
      await backend.type(tabId, "#query", "first");
      expect(await backend.type(tabId, "#query", "second")).toBe("second");
      expect(valueOf(await backend.inspect(tabId), "#query")).toBe("second");
    });

    it("finds an editable control by its label", async () => {
      expect(await backend.type(tabId, "Notes", "by label")).toBe("by label");
      expect(valueOf(await backend.inspect(tabId), "#notes")).toBe("by label");
    });

    it("rejects typing into a control it cannot find", async () => {
      await expect(backend.type(tabId, "#no-such-field", "x")).rejects.toThrow("editable page control not found: #no-such-field");
    });

    it("opens a typeahead that reacts only to trusted keystrokes", async () => {
      expect((await backend.inspect(tabId)).controls.some((item) => item.role === "option")).toBe(false);
      expect(await backend.type(tabId, "#typeahead", "sug")).toBe("sug");
      const page = await backend.inspect(tabId);
      expect(page.text).toContain("Suggestion one Suggestion two");
      expect(page.controls.filter((item) => item.role === "option")).toEqual([
        control({ role: "option", name: "Suggestion one", selector: "#suggestion-1" }),
        control({ role: "option", name: "Suggestion two", selector: "#suggestion-2" }),
      ]);
    });

    it("submits a form with Enter", async () => {
      await backend.type(tabId, "#query", "hello");
      await backend.press(tabId, "Enter");
      expect((await backend.inspect(tabId)).text).toContain("Toggle submitted hello Next page");
    });

    it("captures a PNG screenshot as a data URL", async () => {
      const dataUrl = await backend.screenshot(tabId);
      const prefix = "data:image/png;base64,";
      expect(dataUrl.startsWith(prefix)).toBe(true);
      const bytes = Buffer.from(dataUrl.slice(prefix.length), "base64");
      expect([...bytes.subarray(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);
    });

    it("dispatches page.type through executeBrowserTool with the read-back value", async () => {
      const result = await executeBrowserTool(backend, { name: "page.type", tabId, target: "#query", value: "dispatched" });
      expect(result.data).toEqual({ value: "dispatched" });
      expect(result.summary).toContain('"dispatched"');
      const inspected = await executeBrowserTool(backend, { name: "page.inspect", tabId });
      expect(valueOf(inspected.data as PageInspection, "#query")).toBe("dispatched");
    });
  });
}
