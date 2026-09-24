import { describe, expect, it } from "vitest";
import {
  INTEGRATION_ACCESS_LEVELS,
  INTEGRATION_CATALOG,
  INTEGRATION_PROVIDERS,
  integrationAccessAllows,
  integrationAccessLevel,
  integrationOfToolName,
  integrationScopesCover,
  isIntegrationAccess,
  isIntegrationProvider,
} from "../src/index.js";

describe("integration catalog", () => {
  it("lists every provider's access levels in ascending order, each covering the scopes of the one before", () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      const entry = INTEGRATION_CATALOG[provider];
      expect(entry.id).toBe(provider);
      const order = entry.accessLevels.map((level) => INTEGRATION_ACCESS_LEVELS.indexOf(level.id));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      for (let i = 1; i < entry.accessLevels.length; i += 1) {
        const lower = entry.accessLevels[i - 1]!;
        const higher = entry.accessLevels[i]!;
        // A higher level's grant must let the agent do everything the lower
        // one does, or moving up would silently lose tools.
        expect(integrationScopesCover(provider, higher.scopes, lower.id)).toBe(true);
      }
    }
  });

  it("orders access so a grant covers every level below it", () => {
    expect(integrationAccessAllows("send", "read")).toBe(true);
    expect(integrationAccessAllows("write", "write")).toBe(true);
    expect(integrationAccessAllows("read", "write")).toBe(false);
    expect(integrationAccessAllows("write", "send")).toBe(false);
  });

  it("knows which levels a grant's scopes can be moved to without a new consent", () => {
    const read = integrationAccessLevel("gmail", "read")!;
    const write = integrationAccessLevel("gmail", "write")!;
    expect(integrationScopesCover("gmail", read.scopes, "read")).toBe(true);
    expect(integrationScopesCover("gmail", read.scopes, "write")).toBe(false);
    // Gmail has no drafts-without-send scope: `write` and `send` share one,
    // so the send level is a Pistachio-side gate on the same grant.
    expect(integrationScopesCover("gmail", write.scopes, "send")).toBe(true);
    expect(integrationScopesCover("gmail", [], "read")).toBe(false);
  });

  it("can read calendars and availability and edit events without permission to manage calendars", () => {
    const read = integrationAccessLevel("google_calendar", "read")!;
    const write = integrationAccessLevel("google_calendar", "write")!;
    const prefix = "https://www.googleapis.com/auth/calendar";
    const common = [`${prefix}.calendarlist.readonly`, `${prefix}.calendars.readonly`, `${prefix}.events.freebusy`];
    expect(read.scopes).toEqual([...common, `${prefix}.events.readonly`]);
    expect(write.scopes).toEqual([...common, `${prefix}.events`]);
    for (const scope of common) {
      // Missing any supporting permission would break listing calendars,
      // time-zone lookup, or availability checks after consent succeeds.
      expect(integrationScopesCover("google_calendar", write.scopes.filter((s) => s !== scope), "write")).toBe(false);
    }
    expect(integrationScopesCover("google_calendar", read.scopes, "write")).toBe(false);
    // Inviting guests is a Pistachio-side gate on the grant `write` already
    // holds, so moving between the two never opens the consent page.
    expect(integrationScopesCover("google_calendar", write.scopes, "send")).toBe(true);
    expect(integrationScopesCover("google_calendar", write.scopes, "read")).toBe(true);
    // The events-only scope cannot list calendars or read free/busy, so it covers no level.
    expect(integrationScopesCover("google_calendar", ["https://www.googleapis.com/auth/calendar.events"], "read")).toBe(false);
    // A calendar grant says nothing about mail, and the other way round.
    expect(integrationScopesCover("gmail", write.scopes, "read")).toBe(false);
    // One Google client may serve both: the calendar consent must not pick up mail scopes granted before.
    expect(INTEGRATION_CATALOG.google_calendar.oauth.authorizationParams).not.toHaveProperty("include_granted_scopes");
  });

  it("keeps existing Calendar grants usable after narrowing the permissions requested", () => {
    const prefix = "https://www.googleapis.com/auth/calendar";
    expect(integrationScopesCover("google_calendar", [prefix], "send")).toBe(true);
    expect(integrationScopesCover("google_calendar", [`${prefix}.readonly`], "read")).toBe(true);
    expect(integrationScopesCover("google_calendar", [`${prefix}.readonly`], "write")).toBe(false);
    expect(integrationScopesCover("google_calendar", [`${prefix}.readonly`, `${prefix}.events`], "write")).toBe(true);
  });

  it("guards provider and access names from other processes", () => {
    expect(isIntegrationProvider("gmail")).toBe(true);
    expect(isIntegrationProvider("google_calendar")).toBe(true);
    expect(isIntegrationProvider("outlook")).toBe(false);
    expect(isIntegrationProvider(42)).toBe(false);
    expect(isIntegrationAccess("send")).toBe(true);
    expect(isIntegrationAccess("admin")).toBe(false);
  });

  it("reads the provider off a trace name", () => {
    expect(integrationOfToolName("gmail.search")).toBe("gmail");
    expect(integrationOfToolName("google_calendar.events")).toBe("google_calendar");
    expect(integrationOfToolName("memory.search")).toBeNull();
    // The reminders family is not an integration, whatever a calendar-ish name suggests.
    expect(integrationOfToolName("reminder.create")).toBeNull();
    expect(integrationOfToolName("gmail")).toBeNull();
  });
});
