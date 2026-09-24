/**
 * Revocation teardown must not block on work that needs the lock it holds.
 *
 * `DeviceIdentityService` serializes per user. Its revocation listeners run
 * while it holds that chain, and one of them calls `SessionManager.closeUser`.
 * If `closeUser` waits for an in-flight `#createUser` — which needs the same
 * chain for `identityFor`/`tokenFor` — the two wait on each other: the device
 * keys are never zeroized, `device.json` is never deleted, and the browser
 * context and hub transport stay alive for a device that was just revoked.
 */

import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/sync/session-manager.js";
import type { DeviceIdentityService } from "../src/identity/provision.js";
import type { ControlClient } from "../src/control-client.js";
import type { PlaywrightBrowserRuntime } from "../src/browser/runtime.js";
import type { BrowserNetworkPolicy } from "../src/browser/network-policy.js";

const USER = "11111111-1111-4111-8111-111111111111";

/** Fails loudly instead of hanging the suite when teardown blocks. */
async function withinTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms (deadlock)`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("revocation teardown", () => {
  it("closes a user while a session is still being built, without waiting on it", async () => {
    // `identityFor` never settles: it stands in for a creation parked behind
    // the identity chain that the caller of `closeUser` is holding.
    let released: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => {
      released = resolve;
    });
    const identityFor = vi.fn(async () => {
      await parked;
      return null;
    });
    const identity = { identityFor, tokenFor: vi.fn() } as unknown as DeviceIdentityService;

    const sessions = new SessionManager({
      identity,
      runtime: {} as unknown as PlaywrightBrowserRuntime,
      control: {} as unknown as ControlClient,
      policy: {} as unknown as BrowserNetworkPolicy,
      onRevoked: () => undefined,
      egressMode: "direct",
    });

    // A run starts building this user's session and parks.
    const building = sessions.acquire(USER, "work", { kind: "run", runId: "run-1" });
    building.catch(() => undefined); // settles once the creation is discarded
    await vi.waitFor(() => expect(identityFor).toHaveBeenCalled());

    // The revocation listener runs here, holding the identity chain.
    await withinTimeout(sessions.closeUser(USER), 5_000, "closeUser during an in-flight creation");
    expect(sessions.users.has(USER)).toBe(false);

    // The parked creation is discarded rather than resurrecting the user.
    released?.();
    await expect(building).rejects.toThrow();
    expect(sessions.users.has(USER)).toBe(false);
  });
});
