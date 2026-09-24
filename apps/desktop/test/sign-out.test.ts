/**
 * Sign-out and revocation as the sync service sees them (docs/cloud-sync-design.md
 * §10.1, §10.2): a sign-out stops the hub, detaches capture, frees every
 * hydration gate, and forgets the account's queues, registers, and HLC clocks;
 * a revocation (hub close 4003, or control refusing the device) keeps them,
 * reports `revoked`, and never dials again until re-enrollment.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OFF_SYNC_STATUS } from "../src/main/feature-handlers";
import { connected, cookieOf, sleep, syncHarness, waitFor, type SyncHarness } from "./sync-harness";

const harnesses: SyncHarness[] = [];

async function harness(): Promise<SyncHarness> {
  const h = await syncHarness();
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.service.stop();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

describe("sign-out", () => {
  it("stops the hub, detaches capture, frees the gate, and forgets the account's sync files", async () => {
    const h = await harness();
    const transport = await connected(h);
    const syncDir = join(h.dir, "sync");
    expect(existsSync(join(syncDir, "workspace.json"))).toBe(true);
    // A publish stamps the Space's clock, which lands in its queue file.
    h.browser.jar("work").changed(cookieOf("user_session", "github.com"));
    await waitFor(() => transport.published.length === 1, 4_000, "the publish");
    await waitFor(() => existsSync(join(syncDir, "work.queue.json")), 4_000, "the queue file");

    h.service.stop("sign-out");

    expect(transport.stops).toBe(1);
    expect(existsSync(syncDir)).toBe(false);
    expect(h.service.status()).toEqual(OFF_SYNC_STATUS);
    expect(h.statuses.at(-1)).toEqual(OFF_SYNC_STATUS);
    expect(h.workspaceStatuses.at(-1)?.state).toBe("off");
    // The gate is open for every Space the service held.
    expect(h.browser.ready.at(-1)).toBe("work");
    // Capture is gone: a later cookie change reaches no engine.
    h.browser.jar("work").changed(cookieOf("other", "github.com"));
    await sleep(30);
    expect(transport.published).toHaveLength(1);
    expect(readdirSync(h.dir)).not.toContain("sync");
  });

  it("does not dial again after sign-out until this Mac is enrolled once more", async () => {
    const h = await harness();
    await connected(h);
    h.service.stop("sign-out");
    h.enrolled = false;
    h.service.start();
    await sleep(30);
    expect(h.transports).toHaveLength(1);
    expect(h.service.started).toBe(false);
    expect(h.service.status().state).toBe("off");
    // Re-enrolled: a fresh transport and a fresh hydration.
    h.enrolled = true;
    h.service.start();
    await waitFor(() => h.transports.length === 2 && h.transport().started !== null, 4_000, "the second dial");
    expect(h.transport().started).toEqual(["work"]);
  });
});

describe("revocation", () => {
  it("keeps the queues, reports revoked, and refuses to re-dial on retry", async () => {
    const h = await harness();
    const transport = await connected(h);
    const syncDir = join(h.dir, "sync");
    transport.revoke();
    await waitFor(() => h.statuses.some((status) => status.revoked), 4_000, "the revoked status");
    expect(h.service.status()).toMatchObject({ state: "off", revoked: true });
    expect(h.browser.ready.at(-1)).toBe("work");
    expect(existsSync(syncDir)).toBe(true);

    expect(await h.service.retry()).toMatchObject({ state: "off", revoked: true });
    expect(transport.reconnects).toBe(0);
    expect(h.transports).toHaveLength(1);

    h.service.stop("revoked");
    expect(existsSync(join(syncDir, "workspace.json"))).toBe(true);
    expect(h.service.status()).toMatchObject({ state: "off", revoked: true, queueDepth: 0 });
  });

  it("control refusing the device stops sync the same way and keeps the files", async () => {
    const h = await harness();
    await connected(h);
    h.service.stop("revoked");
    expect(existsSync(join(h.dir, "sync"))).toBe(true);
    expect(h.service.status().revoked).toBe(true);
    expect(h.transport().stops).toBe(1);
  });
});
