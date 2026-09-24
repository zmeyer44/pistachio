"use client";

/**
 * Settings → Vault: what the agent may type for you on each site, kept
 * sealed under the Space key. The list, the reveal, the edit, and the add
 * all happen in this browser with the unlocked Space keys; control sees the
 * field names and the ciphertext, and the agent sees neither.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { CREDENTIAL_AUTOCOMPLETE_VALUES, isVaultStorableField, type CredentialAutocomplete, type CredentialFieldType } from "@pistachio/protocol";
import type { SpaceKeys } from "@pistachio/sync-protocol";
import {
  Button,
  ControlError,
  deleteVaultEntry,
  Empty,
  Field,
  listVaultEntries,
  Note,
  openVaultEntry,
  putVaultEntry,
  sealVaultValues,
  Section,
  Status,
  useSession,
  type VaultEntry,
  type VaultEntryField,
  When,
} from "@pistachio/web-account";

const FIELD_TYPES: Array<{ value: CredentialFieldType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "email", label: "Email" },
  { value: "password", label: "Password" },
];

/** Purposes a person can pick for a field they add by hand; a one-time code is never kept. */
const PURPOSES = CREDENTIAL_AUTOCOMPLETE_VALUES.filter((value) => value !== "one-time-code" && value !== "off");

function messageOf(error: unknown): string {
  if (error instanceof ControlError) {
    if (error.code === "not_found") return "That entry is no longer in the vault.";
    if (error.status === 400) return "The entry could not be saved as entered.";
  }
  if (error instanceof DOMException && error.name === "OperationError") {
    return "This browser's key does not open that entry. It may have been sealed under a Space key this browser has not unlocked.";
  }
  return error instanceof Error ? error.message : "The vault could not be updated.";
}

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function purposeLabel(purpose: CredentialAutocomplete | undefined): string | null {
  if (purpose === undefined || purpose === "off") return null;
  return purpose.replace(/-/gu, " ");
}

interface DraftField {
  id: string;
  label: string;
  type: CredentialFieldType;
  autocomplete: CredentialAutocomplete | "";
  value: string;
}

const blankField = (): DraftField => ({ id: crypto.randomUUID(), label: "", type: "text", autocomplete: "", value: "" });

function toEntryFields(draft: DraftField[]): VaultEntryField[] {
  return draft.map((field) => ({
    id: field.id,
    label: field.label.trim(),
    type: field.type,
    ...(field.autocomplete === "" ? {} : { autocomplete: field.autocomplete }),
  }));
}

/** The editable rows of an entry: labels, purposes, and values. */
function FieldRows({
  fields,
  onChange,
  allowStructure,
}: {
  fields: DraftField[];
  onChange: (fields: DraftField[]) => void;
  allowStructure: boolean;
}): ReactNode {
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const update = (id: string, patch: Partial<DraftField>): void => {
    onChange(fields.map((field) => (field.id === id ? { ...field, ...patch } : field)));
  };
  return (
    <div className="flex flex-col gap-3">
      {fields.map((field, index) => (
        <div key={field.id} className="rounded-lg border border-alpha-400 p-3 flex flex-col gap-2" data-testid="vault-field-row">
          {allowStructure ? (
            <div className="grid gap-2 sm:grid-cols-3">
              <Field
                id={`vault-label-${field.id}`}
                label={`Field ${String(index + 1)} label`}
                value={field.label}
                placeholder="Email"
                maxLength={120}
                required
                onChange={(event) => update(field.id, { label: event.target.value })}
              />
              <div className="pa-field">
                <label htmlFor={`vault-type-${field.id}`}>Type</label>
                <select
                  id={`vault-type-${field.id}`}
                  className="pa-input"
                  value={field.type}
                  onChange={(event) => update(field.id, { type: event.target.value as CredentialFieldType })}
                >
                  {FIELD_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>{type.label}</option>
                  ))}
                </select>
              </div>
              <div className="pa-field">
                <label htmlFor={`vault-purpose-${field.id}`}>Purpose</label>
                <select
                  id={`vault-purpose-${field.id}`}
                  className="pa-input"
                  value={field.autocomplete}
                  onChange={(event) => update(field.id, { autocomplete: event.target.value as CredentialAutocomplete | "" })}
                >
                  <option value="">Match by label</option>
                  {PURPOSES.map((purpose) => (
                    <option key={purpose} value={purpose}>{purpose.replace(/-/gu, " ")}</option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <p className="pa-label">
              {field.label}
              {purposeLabel(field.autocomplete === "" ? undefined : field.autocomplete) === null ? null : (
                <span className="pa-caption"> · {purposeLabel(field.autocomplete === "" ? undefined : field.autocomplete)}</span>
              )}
            </p>
          )}
          <div className="flex items-end gap-2">
            <div className="grow">
              <Field
                id={`vault-value-${field.id}`}
                label={allowStructure ? `Field ${String(index + 1)} value` : `${field.label} value`}
                type={field.type === "password" && visible[field.id] !== true ? "password" : "text"}
                value={field.value}
                maxLength={4096}
                required
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => update(field.id, { value: event.target.value })}
              />
            </div>
            {field.type === "password" ? (
              <Button type="button" variant="quiet" onClick={() => setVisible((current) => ({ ...current, [field.id]: current[field.id] !== true }))}>
                {visible[field.id] === true ? "Hide" : "Show"}
              </Button>
            ) : null}
            {allowStructure && fields.length > 1 ? (
              <Button type="button" variant="quiet" aria-label={`Remove field ${String(index + 1)}`} onClick={() => onChange(fields.filter((item) => item.id !== field.id))}>
                Remove
              </Button>
            ) : null}
          </div>
        </div>
      ))}
      {allowStructure ? (
        <div>
          <Button type="button" variant="quiet" onClick={() => onChange([...fields, blankField()])}>
            Add another field
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function EntryCard({
  entry,
  keys,
  token,
  onChanged,
}: {
  entry: VaultEntry;
  keys: SpaceKeys;
  token: string;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<DraftField[] | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<Record<string, string>> => {
    if (values !== null) return values;
    const opened = await openVaultEntry(keys, entry);
    setValues(opened);
    return opened;
  }, [entry, keys, values]);

  const reveal = async (fieldId: string): Promise<void> => {
    setError(null);
    try {
      await load();
      setRevealed((current) => ({ ...current, [fieldId]: current[fieldId] !== true }));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const beginEdit = async (): Promise<void> => {
    setError(null);
    try {
      const opened = await load();
      setEditing(entry.fields.map((field) => ({
        id: field.id,
        label: field.label,
        type: field.type,
        autocomplete: field.autocomplete ?? "",
        value: opened[field.id] ?? "",
      })));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (editing === null || busy) return;
    if (editing.some((field) => field.value === "")) {
      setError("Every field needs a value.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextValues = Object.fromEntries(editing.map((field) => [field.id, field.value]));
      const sealedPayload = await sealVaultValues(keys, entry.spaceId, entry.id, nextValues);
      await putVaultEntry(token, entry.spaceId, entry.id, {
        siteOrigin: entry.siteOrigin,
        siteName: entry.siteName,
        fields: toEntryFields(editing),
        sealedPayload,
      });
      setValues(nextValues);
      setEditing(null);
      setRevealed({});
      await onChanged();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteVaultEntry(token, entry.spaceId, entry.id);
      await onChanged();
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };

  return (
    <div className="pa-section rounded-lg border border-alpha-400 p-4" data-testid="vault-entry">
      <div className="pa-row">
        <div>
          <p className="pa-heading-16">{entry.siteName}</p>
          <p className="pa-caption pa-mono">{entry.siteOrigin}</p>
        </div>
        <Status tone="good">{entry.source === "capture" ? "Saved from a run" : "Added by you"}</Status>
      </div>
      {error === null ? null : <Note tone="alert">{error}</Note>}
      {editing === null ? (
        <>
          <dl className="pa-facts">
            {entry.fields.map((field) => (
              <div key={field.id}>
                <dt>
                  {field.label}
                  {purposeLabel(field.autocomplete) === null ? null : <span className="pa-caption"> · {purposeLabel(field.autocomplete)}</span>}
                </dt>
                <dd className="flex items-center gap-2">
                  <span className="pa-mono" data-testid="vault-value">
                    {revealed[field.id] === true && values !== null ? values[field.id] ?? "" : "••••••••"}
                  </span>
                  <Button type="button" variant="quiet" onClick={() => void reveal(field.id)}>
                    {revealed[field.id] === true ? "Hide" : "Show"}
                  </Button>
                </dd>
              </div>
            ))}
            <div>
              <dt>Last used by the agent</dt>
              <dd><When iso={entry.lastUsedAt} relative /></dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd><When iso={entry.updatedAt} /></dd>
            </div>
          </dl>
          <div className="pa-row">
            <Button type="button" disabled={busy} onClick={() => void beginEdit()}>Edit values</Button>
            {confirmingDelete ? (
              <span className="flex items-center gap-2">
                <span className="pa-caption">Remove this entry? The agent will ask you again next time.</span>
                <Button type="button" variant="alert" disabled={busy} onClick={() => void remove()}>Remove</Button>
                <Button type="button" variant="quiet" disabled={busy} onClick={() => setConfirmingDelete(false)}>Keep</Button>
              </span>
            ) : (
              <Button type="button" variant="quiet" disabled={busy} onClick={() => setConfirmingDelete(true)}>Remove</Button>
            )}
          </div>
        </>
      ) : (
        <form onSubmit={(event) => void save(event)} className="flex flex-col gap-3" autoComplete="off" data-testid="vault-edit-form">
          <FieldRows fields={editing} onChange={setEditing} allowStructure={false} />
          <div className="pa-row">
            <Button type="submit" variant="primary" disabled={busy}>{busy ? "Encrypting…" : "Save changes"}</Button>
            <Button type="button" variant="quiet" disabled={busy} onClick={() => { setEditing(null); setError(null); }}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function AddEntryForm({
  spaceId,
  keys,
  token,
  onAdded,
}: {
  spaceId: string;
  keys: SpaceKeys;
  token: string;
  onAdded: () => Promise<void>;
}): ReactNode {
  const [siteUrl, setSiteUrl] = useState("");
  const [siteName, setSiteName] = useState("");
  const [fields, setFields] = useState<DraftField[]>(() => [
    { ...blankField(), label: "Email", type: "email", autocomplete: "email" },
    { ...blankField(), label: "Password", type: "password", autocomplete: "current-password" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setSiteUrl("");
    setSiteName("");
    setFields([
      { ...blankField(), label: "Email", type: "email", autocomplete: "email" },
      { ...blankField(), label: "Password", type: "password", autocomplete: "current-password" },
    ]);
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    let origin: string;
    try {
      const url = new URL(siteUrl.includes("://") ? siteUrl : `https://${siteUrl}`);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http");
      origin = url.origin;
    } catch {
      setError("Enter the site's address, like amazon.com or https://accounts.example.com.");
      return;
    }
    if (fields.some((field) => field.label.trim() === "" || field.value === "")) {
      setError("Every field needs a label and a value.");
      return;
    }
    if (!fields.every((field) => isVaultStorableField({ type: field.type, ...(field.autocomplete === "" ? {} : { autocomplete: field.autocomplete }) }))) {
      setError("One-time codes cannot be kept: they are spent as soon as they are used.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const entryId = crypto.randomUUID();
      const sealedPayload = await sealVaultValues(keys, spaceId, entryId, Object.fromEntries(fields.map((field) => [field.id, field.value])));
      await putVaultEntry(token, spaceId, entryId, {
        siteOrigin: origin,
        siteName: siteName.trim() === "" ? hostnameOf(origin) : siteName.trim(),
        fields: toEntryFields(fields),
        sealedPayload,
      });
      reset();
      await onAdded();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3" autoComplete="off" data-testid="vault-add-form">
      {error === null ? null : <Note tone="alert">{error}</Note>}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field
          label="Site"
          help="The agent uses these only on pages from this exact site."
          value={siteUrl}
          placeholder="https://www.amazon.com"
          required
          onChange={(event) => setSiteUrl(event.target.value)}
        />
        <Field
          label="Name"
          help="How it is listed here."
          value={siteName}
          placeholder="Amazon"
          maxLength={160}
          onChange={(event) => setSiteName(event.target.value)}
        />
      </div>
      <FieldRows fields={fields} onChange={setFields} allowStructure />
      <div className="pa-row">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Encrypting…" : "Add to vault"}</Button>
      </div>
    </form>
  );
}

export function VaultSection(): ReactNode {
  const { token, keys, spaces } = useSession();
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const activeSpaceId = spaceId ?? spaces[0]?.id ?? null;
  const spaceKeys = activeSpaceId === null ? null : keys?.spaces.get(activeSpaceId) ?? null;

  const refresh = useCallback(async (): Promise<void> => {
    if (token === null || activeSpaceId === null) return;
    try {
      setEntries((await listVaultEntries(token, activeSpaceId)).entries);
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [activeSpaceId, token]);

  useEffect(() => {
    setEntries(null);
    void refresh();
  }, [refresh]);

  const grouped = useMemo(() => {
    const bySite = new Map<string, VaultEntry[]>();
    for (const entry of entries ?? []) bySite.set(entry.siteOrigin, [...(bySite.get(entry.siteOrigin) ?? []), entry]);
    return [...bySite.entries()];
  }, [entries]);

  return (
    <>
      <Section note="When a cloud run needs a password or another sensitive field for a site listed here, the agent types the saved value into the page without seeing it. Values are encrypted with your Space key before they leave this browser; Pistachio's servers store only the ciphertext.">
        {spaces.length > 1 ? (
          <div className="pa-field">
            <label htmlFor="vault-space">Space</label>
            <select
              id="vault-space"
              className="pa-input"
              value={activeSpaceId ?? ""}
              onChange={(event) => setSpaceId(event.target.value)}
            >
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>{space.name}</option>
              ))}
            </select>
          </div>
        ) : null}
        {error === null ? null : <Note tone="alert">{error}</Note>}
        {keys === null ? (
          <Note>Unlock with your password to read or change the vault. Entries stay sealed until then.</Note>
        ) : activeSpaceId !== null && spaceKeys === null ? (
          <Note tone="alert">This browser has not unlocked the key for this Space, so its entries cannot be opened here.</Note>
        ) : null}
        {entries === null && error === null ? (
          <p className="pa-caption">Reading the vault…</p>
        ) : entries !== null && entries.length === 0 ? (
          <Empty title="Nothing kept yet">
            <p>When you fill in a secure form for a cloud run and leave “keep in my vault” on, the details land here. You can also add them by hand below.</p>
          </Empty>
        ) : (
          <div className="flex flex-col gap-4" data-testid="vault-entries">
            {grouped.map(([origin, group]) => (
              <div key={origin} className="flex flex-col gap-2">
                <p className="pa-label">{hostnameOf(origin)}</p>
                {group.map((entry) => (
                  spaceKeys === null || token === null ? (
                    <div key={entry.id} className="pa-section rounded-lg border border-alpha-400 p-4" data-testid="vault-entry">
                      <p className="pa-heading-16">{entry.siteName}</p>
                      <p className="pa-caption">{entry.fields.map((field) => field.label).join(", ")}</p>
                    </div>
                  ) : (
                    <EntryCard key={entry.id} entry={entry} keys={spaceKeys} token={token} onChanged={refresh} />
                  )
                ))}
              </div>
            ))}
          </div>
        )}
      </Section>
      {spaceKeys !== null && token !== null && activeSpaceId !== null ? (
        <Section
          heading="Add an entry"
          note="Give the site, then each field the agent should be able to fill. A purpose helps it recognise the same field on a page whatever the page calls it."
          action={adding ? null : <Button type="button" onClick={() => setAdding(true)}>Add by hand</Button>}
        >
          {adding ? (
            <AddEntryForm
              spaceId={activeSpaceId}
              keys={spaceKeys}
              token={token}
              onAdded={async () => {
                setAdding(false);
                await refresh();
              }}
            />
          ) : null}
        </Section>
      ) : null}
      <Section heading="How it stays private">
        <div className="pa-section pa-body">
          <p>The agent never reads a value. The cloud browser opens the entry with the Space key, types it straight into the page, and records only that it did.</p>
          <p>A saved value that a site rejects is not retried in the same run: the agent asks you for a fresh one, and your answer replaces what was kept.</p>
          <p>One-time codes are never kept. Removing an entry here means the agent asks you next time.</p>
        </div>
      </Section>
    </>
  );
}
