import { describe, expect, it } from "vitest";
import * as hub from "../src/index.js";

describe("package exports", () => {
  it("exposes exactly the §4 surface at runtime", () => {
    expect(Object.keys(hub).sort()).toEqual([
      "CLOSE_MALFORMED",
      "CLOSE_REVOKED",
      "CLOSE_UNAUTHENTICATED",
      "HubCore",
      "MemoryHubStorage",
      "SqlHubStorage",
      "attachSyncHub",
    ]);
    expect(hub.CLOSE_REVOKED).toBe(4003);
    expect(hub.CLOSE_UNAUTHENTICATED).toBe(4001);
    expect(hub.CLOSE_MALFORMED).toBe(4400);
  });
});
