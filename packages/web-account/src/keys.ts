/**
 * Space keys, unwrapped in the browser.
 *
 * The control plane stores each Space's root secret only as ciphertext, sealed
 * under a key derived from the account password (§2, `key_wrappers`). This
 * module does the same thing a second Mac does when it signs in: derive the
 * wrapping key from the password, unwrap the root secret, and derive the seal
 * and id keys from it.
 *
 * The password and the root secrets it unwraps stay in this tab's memory:
 * never sent to the Next server, never written down anywhere, and gone when
 * the tab is. By default the keys DERIVED from them go the same way, so a
 * reload asks to unlock again — the same trade a password manager makes, and
 * the reason the server can hold this data at all.
 *
 * A reader who opts into staying unlocked keeps those derived keys, and only
 * those, in this browser's vault as non-extractable handles. `vault.ts` owns
 * that and says what it costs. Nothing here changes: the password and the
 * root secrets are not part of the bargain, and neither is `localStorage`.
 */

import {
  WORKSPACE_PSEUDO_SPACE_ID,
  deriveKekFromPassphrase,
  deriveSpaceKeys,
  fromBase64,
  generateSpaceRootSecret,
  toBase64,
  unwrapRootSecret,
  wrapRootSecret,
  wrapRootSecretToDevice,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import {
  changePassword as changeAccountPassword,
  enableCloud,
  listSpaces,
  listWrappers,
  provisionAccount,
  putWrappers,
  type ControlSpace,
  type ControlWrapper,
} from "./control";
import type { DeviceIdentity } from "./device";

/** The credentialId every password wrapper carries (§14). */
const PASSWORD_CREDENTIAL = "password";

export interface UnlockedKeys {
  /** Space id (and `__workspace__`) to its derived keys. */
  spaces: Map<string, SpaceKeys>;
  /** The account-global key personal records and Space metadata are sealed under. */
  workspace: SpaceKeys | null;
  /**
   * Root secrets recovered during this password ceremony. They stay in this
   * tab only and let a web device wrap a Space for the cloud browser. The
   * remembered-key vault deliberately reconstructs this as an empty map.
   */
  rootSecrets: Map<string, Uint8Array>;
  /** Spaces whose wrapper could not be opened, so the reader is told rather than shown nothing. */
  unopened: string[];
  /**
   * Whether this account has any password wrapper at all. False means nobody
   * has generated the Space root secrets yet — a brand-new account that has
   * not been provisioned on another device. That is different from a wrong
   * password, and saying so is the difference between "go set this up" and
   * "you typed it wrong".
   */
  provisioned: boolean;
}

async function unwrapOne(
  password: string,
  spaceId: string,
  wrappers: ControlWrapper[],
  keks: Map<string, CryptoKey>,
): Promise<{ keys: SpaceKeys; secret: Uint8Array } | null> {
  for (const wrapper of wrappers) {
    if (wrapper.kind !== "password" || wrapper.credentialId !== PASSWORD_CREDENTIAL) continue;
    try {
      let kek = keks.get(wrapper.salt);
      if (kek === undefined) {
        // 600k PBKDF2 rounds: about a second, once, on unlock.
        kek = await deriveKekFromPassphrase(password, fromBase64(wrapper.salt));
        keks.set(wrapper.salt, kek);
      }
      const secret = await unwrapRootSecret(kek, fromBase64(wrapper.wrapped), spaceId);
      return { keys: await deriveSpaceKeys(spaceId, secret), secret };
    } catch {
      // A wrapper from a rotated password or an older secret. Try the next.
    }
  }
  return null;
}

/**
 * Open every Space this account has, plus the workspace pseudo-space that
 * bookmarks, reminders, memory and Space metadata are sealed under.
 */
export async function unlock(token: string, password: string): Promise<UnlockedKeys> {
  const { spaces } = await listSpaces(token);
  const ids = [...spaces.map((space) => space.id), WORKSPACE_PSEUDO_SPACE_ID];
  const keks = new Map<string, CryptoKey>();
  const opened = new Map<string, SpaceKeys>();
  const rootSecrets = new Map<string, Uint8Array>();
  const unopened: string[] = [];
  let anyWrapper = false;

  for (const spaceId of ids) {
    let wrappers: ControlWrapper[];
    try {
      wrappers = (await listWrappers(token, spaceId)).wrappers;
    } catch {
      unopened.push(spaceId);
      continue;
    }
    if (wrappers.some((w) => w.kind === "password" && w.credentialId === PASSWORD_CREDENTIAL)) anyWrapper = true;
    const value = await unwrapOne(password, spaceId, wrappers, keks);
    if (value === null) unopened.push(spaceId);
    else {
      opened.set(spaceId, value.keys);
      rootSecrets.set(spaceId, value.secret);
    }
  }

  return {
    spaces: opened,
    workspace: opened.get(WORKSPACE_PSEUDO_SPACE_ID) ?? null,
    rootSecrets,
    unopened: unopened.filter((id) => id !== WORKSPACE_PSEUDO_SPACE_ID),
    provisioned: anyWrapper,
  };
}

/**
 * Create a brand-new account's root secrets in the browser and atomically
 * upload only their password-sealed wrappers. No plaintext key material or
 * password crosses the control API.
 */
export async function provisionKeys(
  token: string,
  password: string,
  spaces: ControlSpace[],
): Promise<UnlockedKeys> {
  const ids = [...new Set([...spaces.map((space) => space.id), WORKSPACE_PSEUDO_SPACE_ID])];
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await deriveKekFromPassphrase(password, salt);
  const saltWire = toBase64(salt);
  const roots = new Map<string, Uint8Array>();
  const derived = new Map<string, SpaceKeys>();
  const wrappers: Array<{ spaceId: string; salt: string; wrapped: string }> = [];

  for (const spaceId of ids) {
    const root = generateSpaceRootSecret();
    roots.set(spaceId, root);
    derived.set(spaceId, await deriveSpaceKeys(spaceId, root));
    wrappers.push({
      spaceId,
      salt: saltWire,
      wrapped: toBase64(await wrapRootSecret(kek, root, spaceId)),
    });
  }
  await provisionAccount(token, wrappers);
  return {
    spaces: derived,
    workspace: derived.get(WORKSPACE_PSEUDO_SPACE_ID) ?? null,
    rootSecrets: roots,
    unopened: [],
    provisioned: true,
  };
}

/** Wrap this browser's in-memory keys to the account's hosted cloud device. */
export async function enableCloudForSpace(
  token: string,
  identity: DeviceIdentity,
  keys: UnlockedKeys,
  spaceId: string,
): Promise<void> {
  const root = keys.rootSecrets.get(spaceId);
  const workspaceRoot = keys.rootSecrets.get(WORKSPACE_PSEUDO_SPACE_ID);
  if (root === undefined || workspaceRoot === undefined) {
    throw new Error("Unlock with your password again before turning on the cloud browser.");
  }
  const { device } = await enableCloud(token, spaceId);
  if (device.platform !== "cloud") throw new Error("Control returned an invalid cloud device.");
  const recipient = { deviceId: device.id, agreementPublicKeyRaw: fromBase64(device.agreementPublicKey) };
  const sender = { deviceId: identity.deviceId, signingKey: identity.signingKey };

  // Workspace first: `spaceCloudEnabled` keys off the ordinary Space wrapper,
  // so a partially uploaded pair can never make a task runnable too early.
  for (const [id, secret] of [
    [WORKSPACE_PSEUDO_SPACE_ID, workspaceRoot],
    [spaceId, root],
  ] as const) {
    const wrapper = await wrapRootSecretToDevice(secret, id, recipient, sender);
    await putWrappers(token, id, [{
      kind: wrapper.kind,
      credentialId: wrapper.credentialId,
      salt: wrapper.salt,
      wrapped: wrapper.wrapped,
      ...(wrapper.senderDeviceId === undefined ? {} : { senderDeviceId: wrapper.senderDeviceId }),
      ...(wrapper.signature === undefined ? {} : { signature: wrapper.signature }),
    }]);
  }
}

/**
 * Change the account password and re-seal every root secret this tab holds
 * under the new one, the way a Mac does (§10.1). Wrappers sealed under the
 * old password can never open again, and only a device holding the secrets
 * can mint replacements — which is why this needs the secrets from a
 * password unlock in this tab, not the remembered vault's derived keys.
 * The upload upserts per Space, so the stale seal is replaced in place.
 */
export async function changePasswordAndRewrap(
  token: string,
  keys: UnlockedKeys,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (keys.rootSecrets.size === 0) {
    throw new Error("Unlock with your password again before changing it, so this browser can re-seal your Spaces.");
  }
  await changeAccountPassword(token, currentPassword, newPassword);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await deriveKekFromPassphrase(newPassword, salt);
  const saltWire = toBase64(salt);
  for (const [spaceId, root] of keys.rootSecrets) {
    await putWrappers(token, spaceId, [{
      kind: "password",
      credentialId: PASSWORD_CREDENTIAL,
      salt: saltWire,
      wrapped: toBase64(await wrapRootSecret(kek, root, spaceId)),
    }]);
  }
}

/** True when the password opened nothing that exists — the wrong password. */
export const openedNothing = (keys: UnlockedKeys): boolean => keys.provisioned && keys.spaces.size === 0;
