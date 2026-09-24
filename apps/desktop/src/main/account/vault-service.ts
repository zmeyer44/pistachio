/**
 * The credential vault from this Mac's side (docs/cloud-sync-design.md
 * D28): list what control holds for a Space, open an entry with the Space
 * key when the person asks to see it, and seal what they add or change
 * before it leaves the machine.
 *
 * Values are opened only on an explicit reveal or edit, never as part of a
 * listing, so the renderer holds a value for exactly as long as the person
 * is looking at it.
 */

import { randomUUID } from "node:crypto";
import { isVaultStorableField, MAX_VAULT_ENTRY_FIELDS, type VaultEntry, type VaultEntryField, type VaultEntryPayload } from "@pistachio/protocol";
import {
  deriveSpaceKeys,
  fromBase64,
  fromUtf8,
  open,
  seal,
  toBase64,
  utf8,
  vaultEntrySealAad,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import type { VaultEntryDraft, VaultEntryInfo } from "@pistachio/shell-contracts/ipc";
import type { ControlClient } from "./control-client";

export interface VaultServiceDeps {
  control: () => ControlClient;
  /** The Space root secret this Mac holds, or null when it has none for the Space. */
  spaceSecret: (spaceId: string) => Uint8Array | null;
}

const MAX_VALUE_LENGTH = 4096;

export function vaultEntryInfo(entry: VaultEntry): VaultEntryInfo {
  return {
    id: entry.id,
    spaceId: entry.spaceId,
    siteOrigin: entry.siteOrigin,
    siteName: entry.siteName,
    fields: entry.fields,
    source: entry.source,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastUsedAt: entry.lastUsedAt,
  };
}

export class VaultService {
  readonly #deps: VaultServiceDeps;

  constructor(deps: VaultServiceDeps) {
    this.#deps = deps;
  }

  async list(spaceId: string): Promise<VaultEntryInfo[]> {
    return (await this.#deps.control().listVault(spaceId)).map(vaultEntryInfo);
  }

  async reveal(spaceId: string, entryId: string): Promise<Record<string, string>> {
    const entry = (await this.#deps.control().listVault(spaceId)).find((row) => row.id === entryId);
    if (entry === undefined) throw new Error("That entry is no longer in the vault.");
    const keys = await this.#keysFor(spaceId);
    const plaintext = await open(keys.sealKey, fromBase64(entry.sealedPayload), vaultEntrySealAad(spaceId, entryId));
    try {
      const payload = JSON.parse(fromUtf8(plaintext)) as Partial<VaultEntryPayload>;
      if (payload.version !== 1 || typeof payload.values !== "object" || payload.values === null) {
        throw new Error("The entry could not be read.");
      }
      return Object.fromEntries(
        Object.entries(payload.values).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
      );
    } finally {
      plaintext.fill(0);
    }
  }

  async save(spaceId: string, entryId: string | null, draft: VaultEntryDraft): Promise<VaultEntryInfo> {
    const origin = parseOrigin(draft.siteOrigin);
    if (draft.fields.length === 0 || draft.fields.length > MAX_VAULT_ENTRY_FIELDS) {
      throw new Error(`An entry holds between 1 and ${String(MAX_VAULT_ENTRY_FIELDS)} fields.`);
    }
    const fields: VaultEntryField[] = [];
    const values: Record<string, string> = {};
    for (const field of draft.fields) {
      const label = field.label.trim();
      if (label === "" || field.value === "") throw new Error("Every field needs a label and a value.");
      if (field.value.length > MAX_VALUE_LENGTH) throw new Error("A value is too long.");
      if (!isVaultStorableField(field)) throw new Error("One-time codes cannot be kept: they are spent as soon as they are used.");
      const id = /^[0-9a-f-]{36}$/u.test(field.id) ? field.id : randomUUID();
      fields.push({ id, label, type: field.type, ...(field.autocomplete === undefined ? {} : { autocomplete: field.autocomplete }) });
      values[id] = field.value;
    }
    const id = entryId ?? randomUUID();
    const keys = await this.#keysFor(spaceId);
    const payload: VaultEntryPayload = { version: 1, values };
    const plaintext = utf8(JSON.stringify(payload));
    let sealedPayload: string;
    try {
      sealedPayload = toBase64(await seal(keys.sealKey, plaintext, vaultEntrySealAad(spaceId, id)));
    } finally {
      plaintext.fill(0);
    }
    const siteName = draft.siteName.trim() === "" ? new URL(origin).hostname : draft.siteName.trim();
    return vaultEntryInfo(await this.#deps.control().putVaultEntry(spaceId, id, { siteOrigin: origin, siteName, fields, sealedPayload }));
  }

  async delete(spaceId: string, entryId: string): Promise<void> {
    await this.#deps.control().deleteVaultEntry(spaceId, entryId);
  }

  // Derived fresh every time rather than cached: a sign-out swaps the
  // secrets underneath, and the derivation is one HKDF.
  #keysFor(spaceId: string): Promise<SpaceKeys> {
    const secret = this.#deps.spaceSecret(spaceId);
    if (secret === null) {
      return Promise.reject(new Error("This Mac does not hold the key for that Space, so its vault cannot be opened here."));
    }
    return deriveSpaceKeys(spaceId, secret);
  }
}

function parseOrigin(input: string): string {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http");
    return url.origin;
  } catch {
    throw new Error("Enter the site's address, like amazon.com or https://accounts.example.com.");
  }
}
