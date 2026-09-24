/**
 * The backend contract, run against the in-memory fake: proves the suite
 * itself — its fixture, its expected inspection, its interaction cases —
 * before the desktop and the cloud browser run it against real pages.
 */

import { describe, expect, it } from "vitest";
import { browserBackendContract, fixtureInspection } from "../src/testing/browser-backend-contract.js";
import { FakeBrowserBackend } from "./fake-backend.js";

const FIXTURE_URL = "http://fixture.test/backend.html";

browserBackendContract("in-memory fake", async () => new FakeBrowserBackend(), FIXTURE_URL);

describe("the fixture inspection", () => {
  it("normalises the fixture URL the way a page reports it", () => {
    expect(fixtureInspection("http://fixture.test").url).toBe("http://fixture.test/");
    expect(fixtureInspection(FIXTURE_URL).url).toBe(FIXTURE_URL);
  });

  it("is an untouched page: nothing typed, nothing open", () => {
    const page = fixtureInspection(FIXTURE_URL);
    expect(page.controls.map((item) => item.selector)).toEqual(["#query", "#go", "#notes", "#editor", "#typeahead", "#toggle", "#link"]);
    expect(page.controls.every((item) => !item.disabled)).toBe(true);
    expect(page.text).not.toContain("Suggestion");
  });
});

describe("the fake backend", () => {
  it("starts blank and only serves the fixture once navigated", async () => {
    const backend = new FakeBrowserBackend("cloud");
    const tabId = await backend.openTab();
    expect(backend.kind).toBe("cloud");
    expect(await backend.inspect(tabId)).toEqual({ title: "", url: "about:blank", text: "", controls: [] });
    await expect(backend.click(tabId, "Toggle")).rejects.toThrow("page control not found: Toggle");
    await backend.navigate(tabId, FIXTURE_URL);
    expect(backend.listTabs()).toEqual([
      expect.objectContaining({ id: tabId, url: FIXTURE_URL, title: "Backend fixture", canGoBack: true, canGoForward: false }),
    ]);
  });

  it("reloads to a fresh page", async () => {
    const backend = new FakeBrowserBackend();
    const tabId = await backend.openTab(FIXTURE_URL);
    await backend.type(tabId, "#query", "kept?");
    await backend.click(tabId, "#toggle");
    await backend.reload(tabId);
    expect(await backend.inspect(tabId)).toEqual(fixtureInspection(FIXTURE_URL));
  });
});
