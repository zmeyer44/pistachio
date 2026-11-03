import { describe, expect, it } from "vitest";
import { EXT_METHOD_NAMES, EXT_RATE_LIMITS } from "@pistachio/extension-api/wire";
import { dispatch, EXT_METHODS } from "../src/main/extensions/methods";
import { matchesHostPattern } from "../src/main/extensions/hosts";
import { harness, manifestOf, recordOf, tabOf } from "./extensions-harness";

const EVERY_CAPABILITY = ["tabs:read", "tabs:write", "desk", "pages:read", "capture:tab", "input:events", "files:data", "clipboard:write", "clipboard:read", "notifications", "notes:read", "notes:write", "agent:tools", "agent:ask", "power"];

describe("the scope", () => {
  it("has a row for every method of the API", () => {
    expect(Object.keys(EXT_METHODS).sort()).toEqual([...EXT_METHOD_NAMES].sort());
  });

  it("refuses every capability-needing row with an empty grant, before reading its arguments", async () => {
    // The manifest asks for everything; the person granted nothing (a paused, or a never-approved, extension).
    const h = harness({ manifest: manifestOf({ permissions: EVERY_CAPABILITY }), record: recordOf({ capabilities: [] }) });
    const rows = Object.entries(EXT_METHODS).filter(([, spec]) => typeof spec.needs === "string");
    expect(rows.length).toBeGreaterThan(30);
    for (const [method, spec] of rows) {
      const reply = await dispatch(method, {}, h.scope, h.ctx(), h.runtime);
      expect(reply, method).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
      if (!reply.ok) expect(reply.message, method).toContain(`"${spec.needs as string}"`);
    }
  });

  it("refuses a capability granted but no longer asked for (a manifest that narrowed applies at once)", async () => {
    const h = harness({ manifest: manifestOf({ permissions: [] }), record: recordOf({ capabilities: ["tabs:read"] }) });
    expect(await dispatch("tabs.query", {}, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });

  it("answers the judged rows by their arguments: pages.read needs a host or a gesture", async () => {
    const tabs = [tabOf("t1", "https://github.com/zach/repo"), tabOf("t2", "https://news.example.org/")];
    const h = harness({ manifest: manifestOf({ permissions: ["pages:read"], hosts: ["https://github.com/*"] }), record: recordOf({ capabilities: ["pages:read"], hosts: ["https://github.com/*"] }), tabs });
    expect(await dispatch("pages.read", { tabId: "t1", format: "text" }, h.scope, h.ctx(), h.runtime)).toEqual({ ok: true, v: { text: "the page's words" } });
    expect(await dispatch("pages.read", { tabId: "t2", format: "text" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });

  it("refuses a read or a screenshot whose page went to another site while it was being read", async () => {
    const tabs = [tabOf("t1", "https://github.com/zach/repo")];
    const h = harness({ manifest: manifestOf({ permissions: ["pages:read"], hosts: ["https://github.com/*"] }), record: recordOf({ capabilities: ["pages:read"], hosts: ["https://github.com/*"] }), tabs });
    // Allowed when asked; by the time the page is read, the tab shows a site the grant does not cover.
    h.browser.inspect = (async () => {
      tabs[0]!.url = "https://mail.example.com/inbox";
      return { title: "Inbox", url: "https://mail.example.com/inbox", text: "the inbox's words", controls: [] };
    }) as typeof h.browser.inspect;
    expect(await dispatch("pages.read", { tabId: "t1", format: "text" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    tabs[0]!.url = "https://github.com/zach/repo";
    h.browser.screenshot = (async () => {
      tabs[0]!.url = "https://mail.example.com/inbox";
      return new Uint8Array([137, 80, 78, 71]);
    }) as typeof h.browser.screenshot;
    expect(await dispatch("pages.screenshot", { tabId: "t1" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    // Another page of the same site meanwhile is still the site that was granted.
    tabs[0]!.url = "https://github.com/zach/repo";
    h.browser.inspect = (async () => {
      tabs[0]!.url = "https://github.com/zach/other";
      return { title: "Other", url: "https://github.com/zach/other", text: "other words", controls: [] };
    }) as typeof h.browser.inspect;
    expect(await dispatch("pages.read", { tabId: "t1", format: "text" }, h.scope, h.ctx(), h.runtime)).toEqual({ ok: true, v: { text: "other words" } });
  });

  it("keeps a gesture grant until the tab goes to another site", async () => {
    const tabs = [tabOf("t1", "https://news.example.org/a")];
    const h = harness({ record: recordOf({ capabilities: [] }), tabs });
    const read = () => dispatch("pages.read", { tabId: "t1", format: "text" }, h.scope, h.ctx(), h.runtime);
    expect(await read()).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    h.scope.grantTab("t1");
    expect(await read()).toMatchObject({ ok: true });
    // Another page of the same site: still granted.
    tabs[0]!.url = "https://news.example.org/b";
    h.scope.tabNavigated("t1", tabs[0]!.url);
    expect(await read()).toMatchObject({ ok: true });
    // Another site: gone, and gone for good (coming back does not restore it).
    tabs[0]!.url = "https://elsewhere.example.com/";
    expect(await read()).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    tabs[0]!.url = "https://news.example.org/a";
    expect(await read()).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });

  it("never reads Pistachio's own pages or another Profile's tabs", async () => {
    const tabs = [tabOf("home", "pistachio://home/"), tabOf("other", "https://github.com/", "profile-b")];
    const h = harness({
      manifest: manifestOf({ permissions: ["pages:read", "tabs:read"], hosts: ["<all_urls>"] }),
      record: recordOf({ capabilities: ["pages:read", "tabs:read"], hosts: ["<all_urls>"] }, { profiles: ["profile-a"] }),
      tabs,
    });
    h.scope.grantTab("home");
    expect(await dispatch("pages.read", { tabId: "home", format: "text" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(await dispatch("pages.read", { tabId: "other", format: "text" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const listed = await dispatch("tabs.query", {}, h.scope, h.ctx(), h.runtime);
    expect(listed.ok && (listed.v as { id: string }[]).map((tab) => tab.id)).toEqual(["home"]);
  });

  it("never lists an agent's hidden tab or another extension's page", async () => {
    const tabs = [tabOf("mine", "pistachio-ext://dev.test.harness/page.html", "profile-a", { extensionId: "dev.test.harness" }), tabOf("theirs", "pistachio-ext://dev.other.ext/page.html", "profile-a", { extensionId: "dev.other.ext" }), tabOf("hidden", "https://a.example/", "profile-a", { hiddenFor: "run-1", unlisted: true })];
    const h = harness({ manifest: manifestOf({ permissions: ["tabs:read"] }), record: recordOf({ capabilities: ["tabs:read"] }), tabs });
    const listed = await dispatch("tabs.query", {}, h.scope, h.ctx(), h.runtime);
    expect(listed.ok && (listed.v as { id: string; kind: string }[]).map((tab) => [tab.id, tab.kind])).toEqual([["mine", "extension"]]);
  });

  it("limits a method to its calls a minute, refilling with time", async () => {
    const h = harness({ record: recordOf({ capabilities: [] }) });
    const limit = EXT_RATE_LIMITS["ui.toast"]!;
    for (let i = 0; i < limit; i += 1) expect(await dispatch("ui.toast", { title: "hi" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: true });
    expect(await dispatch("ui.toast", { title: "hi" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    h.setNow(1_000_000 + 60_000 / limit + 1);
    expect(await dispatch("ui.toast", { title: "hi" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: true });
  });

  it("subscribes to an event only with its capability", async () => {
    const h = harness({ record: recordOf({ capabilities: [] }) });
    expect(await dispatch("events.on", { event: "tabs.created" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(await dispatch("events.on", { event: "storage.changed" }, h.scope, h.ctx(), h.runtime)).toEqual({ ok: true, v: { subscriptionId: 7 } });
    expect(await dispatch("events.on", { event: "nope" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
  });

  it("acts in the Profile in front for a call with no tab, and refuses one it is off in", async () => {
    const h = harness({ manifest: manifestOf({ permissions: ["tabs:read"] }), record: recordOf({ capabilities: ["tabs:read"] }, { profiles: ["profile-b"] }) });
    expect(await dispatch("spaces.current", {}, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    // A worker invocation made in profile-b carries it.
    h.scope.beginInvocation(1, "profile-b");
    expect(await dispatch("spaces.current", {}, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: true, v: { id: "space-profile-b" } });
    h.scope.endInvocation(1);
  });

  it("acts in the Profile a space names, and — invocations of two Profiles in flight — in the Profile in front", async () => {
    const h = harness({ manifest: manifestOf({ permissions: ["tabs:read"] }), record: recordOf({ capabilities: ["tabs:read"] }, { profiles: ["profile-a", "profile-b"] }) });
    h.scope.beginInvocation(1, "profile-a");
    h.scope.beginInvocation(2, "profile-b");
    // The newest alone would say profile-b; the person is in profile-a, and the call names no space.
    expect(await dispatch("spaces.current", {}, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: true, v: { id: "space-profile-a" } });
    h.scope.endInvocation(1);
    expect(await dispatch("spaces.current", {}, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: true, v: { id: "space-profile-b" } });
    // A space named is its Profile named, whatever is in flight.
    expect(h.scope.pagePlace("space-profile-a")).toEqual({ profileId: "profile-a", space: "space-profile-a" });
    expect(h.scope.pagePlace("space-profile-b")).toEqual({ profileId: "profile-b", space: "space-profile-b" });
    expect(() => h.scope.pagePlace("space-nowhere")).toThrow(/no space/);
    h.scope.endInvocation(2);
  });

  it("answers an unknown method and bad arguments in words, never by throwing", async () => {
    const h = harness({ record: recordOf({ capabilities: [] }) });
    expect(await dispatch("tabs.teleport", {}, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    expect(await dispatch("ui.setBadge", { text: "toolong" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
  });

  it("answers capture.sources only with capture:tab (extensions-capture.test.ts has the rest)", async () => {
    const h = harness({ manifest: manifestOf({ permissions: ["capture:tab"], worker: { type: "web", main: "w.js" } }), record: recordOf({ capabilities: [] }) });
    expect(await dispatch("capture.sources", {}, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });
});

describe("match patterns", () => {
  it("reads Chrome's grammar", () => {
    expect(matchesHostPattern("https://api.github.com/*", "https://api.github.com/repos/x")).toBe(true);
    expect(matchesHostPattern("https://api.github.com/*", "http://api.github.com/repos/x")).toBe(false);
    expect(matchesHostPattern("https://api.github.com/*", "https://api.github.com.evil.com/")).toBe(false);
    expect(matchesHostPattern("*://*.example.com/*", "http://a.b.example.com/x")).toBe(true);
    // A pattern that spells the scheme's own port matches the address that leaves it out, and the other way round.
    expect(matchesHostPattern("https://api.example.com:443/*", "https://api.example.com/v1")).toBe(true);
    expect(matchesHostPattern("http://api.example.com:80/*", "http://api.example.com/")).toBe(true);
    expect(matchesHostPattern("https://api.example.com/*", "https://api.example.com:443/v1")).toBe(true);
    expect(matchesHostPattern("https://api.example.com:8443/*", "https://api.example.com/")).toBe(false);
    expect(matchesHostPattern("https://api.example.com:443/*", "https://api.example.com:8443/")).toBe(false);
    expect(matchesHostPattern("*://*.example.com/*", "https://example.com/")).toBe(true);
    expect(matchesHostPattern("*://*.example.com/*", "https://notexample.com/")).toBe(false);
    expect(matchesHostPattern("https://example.com:8443/api/*", "https://example.com:8443/api/v1")).toBe(true);
    expect(matchesHostPattern("https://example.com:8443/api/*", "https://example.com/api/v1")).toBe(false);
    expect(matchesHostPattern("<all_urls>", "wss://socket.example.com/")).toBe(true);
    expect(matchesHostPattern("<all_urls>", "file:///etc/passwd")).toBe(false);
    expect(matchesHostPattern("https://a.com/exact", "https://a.com/exact?x=1")).toBe(false);
  });
});
