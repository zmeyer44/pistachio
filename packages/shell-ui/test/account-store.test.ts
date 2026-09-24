/**
 * The store actions Settings → Account runs (src/store.ts), which is
 * where "what this Mac still shows about the account" is decided. The rest of
 * the account page is pure and lives in account-ui.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AccountState, ChannelInfo, DeviceInfo } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { DEFAULT_ACCOUNT } from "../src/lib/account";
import { useAppStore } from "../src/store";

const ENROLLED: AccountState = {
  ...DEFAULT_ACCOUNT,
  state: "enrolled",
  email: "someone@example.com",
  userId: "user-1",
  deviceId: "11111111-1111-4111-8111-111111111111",
  encryptionAvailable: true,
};

const DEVICE: DeviceInfo = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Studio",
  platform: "macos",
  devicePublicKey: "ZGV2",
  agreementPublicKey: "YWdy",
  fingerprint: "aaaa bbbb cccc dddd eeee ffff 0000 1111",
  createdAt: "2026-08-01T00:00:00.000Z",
  lastSeenAt: "2026-09-02T11:55:00.000Z",
  revokedAt: null,
  isThisDevice: true,
  isPinnedCloudDevice: false,
};

const CHANNEL: ChannelInfo = {
  linkId: "link-1",
  name: "Inbox",
  spaceId: "work",
  outboundUrl: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  revokedAt: null,
};

/** The bridge the store calls through, with only the calls the action makes. */
function bridge(pistachio: Record<string, unknown>): void {
  setShellApi(pistachio as unknown as ShellApiBridge);
}

afterEach(() => {
  bridge({});
  useAppStore.setState({ account: DEFAULT_ACCOUNT, devices: [], channels: [] });
});

describe("signing out", () => {
  it("forgets the devices AND the channels of the account that left", async () => {
    // Both lists belong to the account, not to this Mac: `refreshChannels`
    // only ever sets the list when an answer arrives, so anything left here
    // stays on screen — under the next account's name if its listing fails.
    useAppStore.setState({ account: ENROLLED, devices: [DEVICE], channels: [CHANNEL] });
    bridge({ signOut: () => Promise.resolve(DEFAULT_ACCOUNT) });

    await expect(useAppStore.getState().signOut()).resolves.toBeNull();

    const state = useAppStore.getState();
    expect(state.account).toEqual(DEFAULT_ACCOUNT);
    expect(state.devices).toEqual([]);
    expect(state.channels).toEqual([]);
  });

  it("keeps them when main refused, because the account is still signed in", async () => {
    useAppStore.setState({ account: ENROLLED, devices: [DEVICE], channels: [CHANNEL] });
    bridge({ signOut: () => Promise.reject(new Error("the keychain is locked")) });

    await expect(useAppStore.getState().signOut()).resolves.toBe("the keychain is locked");

    const state = useAppStore.getState();
    expect(state.account).toEqual(ENROLLED);
    expect(state.devices).toEqual([DEVICE]);
    expect(state.channels).toEqual([CHANNEL]);
  });
});
