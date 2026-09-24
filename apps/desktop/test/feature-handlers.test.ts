import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

const {
  featureHandlers,
  installFeatureHandlers,
  OFF_CLOUD_LIVE_STATUS,
  OFF_SYNC_STATUS,
  OFF_WORKSPACE_SYNC_STATUS,
  resetFeatureHandlers,
} = await import("../src/main/feature-handlers");

afterEach(() => resetFeatureHandlers());

describe("featureHandlers (the §10.5 seam)", () => {
  it("answers off statuses and refuses actions until the services install", async () => {
    expect(featureHandlers.sync.status()).toEqual(OFF_SYNC_STATUS);
    expect(featureHandlers.workspaceSync.status()).toEqual(OFF_WORKSPACE_SYNC_STATUS);
    expect(featureHandlers.cloud.status()).toEqual(OFF_CLOUD_LIVE_STATUS);
    expect(await featureHandlers.channels.list()).toEqual([]);
    expect(await featureHandlers.sync.originInfo("work", "example.com")).toMatchObject({ spaceId: "work", host: "example.com", synced: false });
    await expect(featureHandlers.sync.setOriginOverride("work", "example.com", "never")).rejects.toThrow(/not available/);
    await expect(featureHandlers.workspaceSync.run({ kind: "push" })).rejects.toThrow(/not available/);
    await expect(featureHandlers.cloud.startRun({ intent: "x" })).rejects.toThrow(/not available/);
    await expect(featureHandlers.channels.create({ name: "n", spaceId: "work" })).rejects.toThrow(/not available/);
    expect(() => featureHandlers.lifecycle.onEnrolled()).not.toThrow();
    expect(() => featureHandlers.lifecycle.flush()).not.toThrow();
  });

  it("swaps one feature in place so handlers reading the registry see it", async () => {
    const status = { ...OFF_SYNC_STATUS, state: "connected" as const, queueDepth: 2 };
    installFeatureHandlers({
      sync: { ...featureHandlers.sync, status: () => status, retry: async () => status },
    });
    expect(featureHandlers.sync.status()).toEqual(status);
    expect(await featureHandlers.sync.retry()).toEqual(status);
    // The others keep their defaults.
    expect(featureHandlers.cloud.status()).toEqual(OFF_CLOUD_LIVE_STATUS);
    resetFeatureHandlers();
    expect(featureHandlers.sync.status()).toEqual(OFF_SYNC_STATUS);
  });
});
