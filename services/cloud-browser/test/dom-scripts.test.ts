/**
 * The shared page-side scripts (`@pistachio/agent-runtime` dom-scripts) run
 * here against real Chromium, because their two hazards only exist in a real
 * HTML document: a label that is also an element name — `querySelector`
 * matches type selectors case-insensitively, so "Search" would find the
 * `<search>` landmark — and a label that is merely contained in an earlier
 * control's text.
 */

import { clickPageScript, typePrepareScript, typeReadBackScript } from "@pistachio/agent-runtime";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { PlaywrightBrowserRuntime } from "../src/browser/runtime.js";
import { CHROMIUM, describeChromium } from "./helpers/chromium.js";
import { startFixture, type FixtureServer } from "./helpers/fixture-server.js";

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Labels</title></head>
<body>
<main id="main-region">
  <search id="search-region">
    <input id="query" placeholder="Search" autocomplete="off">
    <button id="run-search" type="button">Search</button>
  </search>
  <a id="promo" href="#promo">Add to cart and save 10%</a>
  <a id="discard" href="#discard">Discard this cart</a>
  <button id="cart" type="button">Add to cart</button>
  <button id="open-cart" type="button">Open cart page</button>
  <p id="status">idle</p>
</main>
<script>
  for (const id of ["run-search", "cart", "open-cart", "promo", "discard"]) {
    document.getElementById(id).addEventListener("click", (event) => {
      event.preventDefault();
      document.getElementById("status").textContent = "clicked " + id;
    });
  }
</script>
</body>
</html>
`;

describeChromium("shared page scripts", () => {
  const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
  let fixture: FixtureServer;
  let page: Page;

  beforeAll(async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE);
    });
    const browser = await runtime.browser();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await runtime.close();
    await fixture.close();
  });

  beforeEach(async () => {
    await page.goto(`${fixture.origin}/`);
  });

  const clicked = async (target: string): Promise<{ found: boolean; status: string }> => ({
    found: (await page.evaluate(clickPageScript(target))) as boolean,
    status: (await page.evaluate(`document.getElementById("status").textContent`)) as string,
  });

  it("clicks the control labelled like an element name, not the element", async () => {
    expect(await clicked("Search")).toEqual({ found: true, status: "clicked run-search" });
  });

  it("prefers an exact label over an earlier control that merely contains it", async () => {
    expect(await clicked("Add to cart")).toEqual({ found: true, status: "clicked cart" });
  });

  it("prefers a whole-word label over one that contains the word inside another", async () => {
    // "Discard this cart" comes first and contains "cart", but so does the
    // word in "Open cart page" — and there it stands on its own.
    expect(await clicked("cart page")).toEqual({ found: true, status: "clicked open-cart" });
  });

  it("still takes a CSS selector as a selector", async () => {
    expect(await clicked("#promo")).toEqual({ found: true, status: "clicked promo" });
  });

  it("reports a target nothing matches", async () => {
    expect((await clicked("no such control")).found).toBe(false);
  });

  it("types into the input labelled like an element name and leaves the landmark alone", async () => {
    expect(await page.evaluate(typePrepareScript("Search"))).toBe(true);
    expect(await page.evaluate(`document.activeElement?.id`)).toBe("query");
    await page.keyboard.type("running shoes");
    expect(await page.evaluate(typeReadBackScript("Search", "running shoes"))).toBe("running shoes");
    expect(await page.evaluate(`document.getElementById("query")?.value`)).toBe("running shoes");
    expect(await page.evaluate(`document.getElementById("search-region")?.querySelectorAll("input").length`)).toBe(1);
  });

  it("never writes the typed value into a container the target names", async () => {
    // A selector for a region is the model's own instruction, but the value
    // still may not replace what the region holds.
    expect(await page.evaluate(typePrepareScript("#main-region"))).toBe(true);
    expect(await page.evaluate(typeReadBackScript("#main-region", "running shoes"))).not.toBe("running shoes");
    expect(await page.evaluate(`document.getElementById("query") !== null`)).toBe(true);
  });
});
