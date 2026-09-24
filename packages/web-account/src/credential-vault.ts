/**
 * The credential vault, opened and sealed in the browser.
 *
 * Control lists an entry's fields and its ciphertext; only a device holding
 * the Space seal key can read the values or write new ones. The AAD binds a
 * payload to its Space and entry id, so a ciphertext cannot be re-filed
 * under another entry, and the same key that opens run content opens this.
 */

import {
  fromBase64,
  fromUtf8,
  open,
  seal,
  toBase64,
  utf8,
  vaultEntrySealAad,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import type { VaultEntry, VaultEntryPayload } from "@pistachio/protocol";

/** The values of an entry, keyed by field id. Throws when the key does not open it. */
export async function openVaultEntry(keys: SpaceKeys, entry: Pick<VaultEntry, "id" | "spaceId" | "sealedPayload">): Promise<Record<string, string>> {
  const plaintext = await open(keys.sealKey, fromBase64(entry.sealedPayload), vaultEntrySealAad(entry.spaceId, entry.id));
  try {
    const payload = JSON.parse(fromUtf8(plaintext)) as Partial<VaultEntryPayload>;
    if (payload.version !== 1 || typeof payload.values !== "object" || payload.values === null) {
      throw new Error("unrecognized vault payload");
    }
    return Object.fromEntries(Object.entries(payload.values).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
  } finally {
    plaintext.fill(0);
  }
}

/** Seal values for an entry. `entryId` must be the id the entry is (or will be) filed under. */
export async function sealVaultValues(keys: SpaceKeys, spaceId: string, entryId: string, values: Record<string, string>): Promise<string> {
  const payload: VaultEntryPayload = { version: 1, values };
  const plaintext = utf8(JSON.stringify(payload));
  try {
    return toBase64(await seal(keys.sealKey, plaintext, vaultEntrySealAad(spaceId, entryId)));
  } finally {
    plaintext.fill(0);
  }
}
