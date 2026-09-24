/**
 * The credential vault: sensitive values a person handed to a cloud run once
 * and chose to keep for the next run on the same site.
 *
 * An entry is sealed under its Space seal key, so control stores ciphertext
 * and only devices (the person's browser, the Mac, and the assigned cloud
 * device) can open it. Everything here is the part every party shares in
 * the clear: which fields an entry holds and how a runner's request is
 * matched against them. Values never appear in these shapes.
 */

import type { CredentialAutocomplete, CredentialFieldType } from "./index.js";

export const VAULT_ENTRY_SOURCES = ["capture", "manual"] as const;
export type VaultEntrySource = (typeof VAULT_ENTRY_SOURCES)[number];

/** One field of an entry: what it is, never what it holds. */
export interface VaultEntryField {
  id: string;
  label: string;
  type: CredentialFieldType;
  autocomplete?: CredentialAutocomplete;
}

/** An entry as control lists it: metadata plus the sealed values. */
export interface VaultEntry {
  id: string;
  spaceId: string;
  siteOrigin: string;
  siteName: string;
  fields: VaultEntryField[];
  source: VaultEntrySource;
  /** Base64 of `seal(spaceSealKey, VaultEntryPayload, vaultEntrySealAad(spaceId, id))`. */
  sealedPayload: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

/** The plaintext an entry's sealed payload opens to. */
export interface VaultEntryPayload {
  version: 1;
  /** Keyed by `VaultEntryField.id`. */
  values: Record<string, string>;
}

export const MAX_VAULT_ENTRY_FIELDS = 12;
export const MAX_VAULT_FIELD_VALUE_LENGTH = 4096;

/** A field the vault keeps. One-time codes are spent the moment they are typed. */
export function isVaultStorableField(field: { type: CredentialFieldType; autocomplete?: string | undefined }): boolean {
  return field.type !== "otp" && field.autocomplete !== "one-time-code";
}

function normalizeLabel(label: string): string {
  return label.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, " ").trim();
}

/**
 * The purpose a field serves, so a request and a saved entry agree on
 * "the sign-in email" whether the runner called it `username`, `email`, or
 * just an email input labelled "Email address". A password with no purpose
 * is the site's one password; every other unhinted field is its type and
 * label.
 */
export function vaultFieldKey(field: Pick<VaultEntryField, "type" | "label" | "autocomplete">): string {
  const purpose = field.autocomplete;
  if (purpose === "username" || purpose === "email") return "login-id";
  if (purpose === "current-password" || purpose === "new-password") return "password";
  if (purpose !== undefined && purpose !== "off") return `ac:${purpose}`;
  if (field.type === "password") return "password";
  if (field.type === "email") return "login-id";
  return `${field.type}:${normalizeLabel(field.label)}`;
}

/** The sorted, de-duplicated purposes an entry (or a request) covers. */
export function vaultFieldKeys(fields: ReadonlyArray<Pick<VaultEntryField, "type" | "label" | "autocomplete">>): string[] {
  return [...new Set(fields.map(vaultFieldKey))].sort();
}

/**
 * Map a runner's requested fields onto an entry's saved ones. Every
 * requested field must find exactly one saved field of the same purpose;
 * the entry may hold more than was asked for. Returns null when the entry
 * cannot fill the whole request — the vault fills all of a form or none of
 * it, so the person is never asked for half.
 */
export function matchVaultEntry<Requested extends Pick<VaultEntryField, "type" | "label" | "autocomplete">>(
  requested: ReadonlyArray<Requested>,
  saved: ReadonlyArray<VaultEntryField>,
): Array<{ requested: Requested; saved: VaultEntryField }> | null {
  if (requested.length === 0) return null;
  const byKey = new Map<string, VaultEntryField[]>();
  for (const field of saved) {
    const key = vaultFieldKey(field);
    byKey.set(key, [...(byKey.get(key) ?? []), field]);
  }
  const seen = new Set<string>();
  const pairs: Array<{ requested: Requested; saved: VaultEntryField }> = [];
  for (const field of requested) {
    if (!isVaultStorableField(field)) return null;
    const key = vaultFieldKey(field);
    if (seen.has(key)) return null;
    seen.add(key);
    const candidates = byKey.get(key);
    if (candidates === undefined || candidates.length !== 1 || candidates[0] === undefined) return null;
    pairs.push({ requested: field, saved: candidates[0] });
  }
  return pairs;
}

/**
 * Pick the entry to fill a request from: the most recently updated one that
 * covers every requested field and is not excluded (an entry this run has
 * already tried and found wanting).
 */
export function selectVaultEntry<Requested extends Pick<VaultEntryField, "type" | "label" | "autocomplete">>(
  requested: ReadonlyArray<Requested>,
  entries: ReadonlyArray<VaultEntry>,
  excluded: ReadonlySet<string> = new Set(),
): { entry: VaultEntry; pairs: Array<{ requested: Requested; saved: VaultEntryField }> } | null {
  const ordered = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const entry of ordered) {
    if (excluded.has(entry.id)) continue;
    const pairs = matchVaultEntry(requested, entry.fields);
    if (pairs !== null) return { entry, pairs };
  }
  return null;
}

/**
 * Whether a saved entry is made redundant by a newer one: same origin, and
 * the newer entry covers every purpose the older one did. The site's
 * password changed and was captured again; the old row would otherwise
 * keep matching and keep failing.
 */
export function vaultEntrySuperseded(
  older: Pick<VaultEntry, "fields">,
  newer: Pick<VaultEntry, "fields">,
): boolean {
  const covered = new Set(vaultFieldKeys(newer.fields));
  return vaultFieldKeys(older.fields).every((key) => covered.has(key));
}
