/**
 * Settings → Vault: sign-in details and other sensitive values a cloud run
 * may type for you on a site, kept sealed under the Space key
 * (docs/cloud-sync-design.md D28).
 *
 * The list arrives without values. A value crosses from the main process
 * only when the person reveals or edits it, and goes back sealed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { CREDENTIAL_AUTOCOMPLETE_VALUES, type CredentialAutocomplete, type CredentialFieldType } from "@pistachio/protocol";
import type { VaultEntryDraft, VaultEntryInfo } from "@pistachio/shell-contracts/ipc";
import { useAsyncAction } from "../../../lib/action";
import { useAppStore } from "../../../store";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Note } from "../../ui/note";
import { Select } from "../../ui/select";
import { Block, Group, LoadFailed, Page, probe, probeRefusal, Row, Unavailable, useLoadFailure, useUnavailable } from "../parts";
import { shellApi } from "../../../api";

const FIELD_TYPES: ReadonlyArray<{ value: CredentialFieldType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "email", label: "Email" },
  { value: "password", label: "Password" },
];

const PURPOSES: ReadonlyArray<{ value: CredentialAutocomplete | "none"; label: string }> = [
  { value: "none", label: "Match by label" },
  ...CREDENTIAL_AUTOCOMPLETE_VALUES.filter((value) => value !== "one-time-code" && value !== "off").map((value) => ({
    value,
    label: value.replace(/-/gu, " "),
  })),
];

interface DraftField {
  id: string;
  label: string;
  type: CredentialFieldType;
  autocomplete: CredentialAutocomplete | "none";
  value: string;
}

const draftField = (patch: Partial<DraftField> = {}): DraftField => ({
  id: crypto.randomUUID(),
  label: "",
  type: "text",
  autocomplete: "none",
  value: "",
  ...patch,
});

const loginDraft = (): DraftField[] => [
  draftField({ label: "Email", type: "email", autocomplete: "email" }),
  draftField({ label: "Password", type: "password", autocomplete: "current-password" }),
];

function toDraft(fields: DraftField[], siteOrigin: string, siteName: string): VaultEntryDraft {
  return {
    siteOrigin,
    siteName,
    fields: fields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type,
      ...(field.autocomplete === "none" ? {} : { autocomplete: field.autocomplete }),
      value: field.value,
    })),
  };
}

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function usedLabel(iso: string | null): string {
  if (iso === null) return "Not used by the agent yet";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Used" : `Used ${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

export function VaultPage() {
  // W12: a host that cannot answer for this page says why, and the page
  // says it back — never a screen of controls that all refuse. The page
  // body is a component of its own so its hooks are never skipped.
  // `vaultList` is not in the initial load's probe set — it needs a Space,
  // and a startup round trip that decrypts entries is not worth one — so the
  // page records how it answered at FIRST USE (`probe` below). Before that
  // this guard could never fire, and the web rendered a vault page whose
  // every control the host refuses.
  const unavailable = useUnavailable("vaultList");
  const failed = useLoadFailure("vaultList");
  if (unavailable !== null) {
    return <Unavailable title="Passwords" description="Sign-ins this account keeps, sealed under each Space's key." reason={unavailable} section="vault" />;
  }
  if (failed !== null) {
    return <LoadFailed title="Passwords" description="Sign-ins this account keeps, sealed under each Space's key." reason={failed} />;
  }
  return <VaultPageBody />;
}

function VaultPageBody() {

  const spaces = useAppStore((s) => s.snapshot?.spaces ?? []);
  const activeSpaceId = useAppStore((s) => s.snapshot?.activeSpaceId ?? null);
  const enrolled = useAppStore((s) => s.account.state === "enrolled");
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [entries, setEntries] = useState<VaultEntryInfo[] | null>(null);
  const [adding, setAdding] = useState(false);
  const { error, run } = useAsyncAction();

  const selected = spaceId ?? activeSpaceId ?? spaces[0]?.id ?? null;

  const refresh = useCallback(async () => {
    if (!enrolled || selected === null) {
      setEntries([]);
      // Ask once even with nothing to list. `vaultList` is the only way this
      // page learns the host refuses the whole subject (W12) — a cloud host
      // does, because the vault is the web app's own page — and a page that
      // never asks can never show the reason, so the browser app rendered an
      // empty vault with an Add button the host would turn down.
      if (selected !== null) await probeRefusal("vaultList", () => shellApi().vaultList(selected));
      return;
    }
    await run(async () => {
      setEntries(await probe("vaultList", () => shellApi().vaultList(selected)));
      return null;
    });
  }, [enrolled, run, selected]);

  useEffect(() => {
    setEntries(null);
    void refresh();
  }, [refresh]);

  const grouped = useMemo(() => {
    const bySite = new Map<string, VaultEntryInfo[]>();
    for (const entry of entries ?? []) bySite.set(entry.siteOrigin, [...(bySite.get(entry.siteOrigin) ?? []), entry]);
    return [...bySite.entries()];
  }, [entries]);

  return (
    <Page
      title="Vault"
      description="Sign-in details and other sensitive values the agent may type for you on a site, without ever seeing them. Encrypted with the Space key before they leave this Mac; the servers keep only the ciphertext."
    >
      <Group
        title="Kept for the agent"
        note="When a cloud run needs one of these fields on the site, the cloud browser types the saved value straight into the page and records only that it did."
        footerAction={
          spaces.length > 1 ? (
            <Select
              aria-label="Space"
              value={selected ?? ""}
              items={spaces.map((space) => ({ value: space.id, label: space.name }))}
              onValueChange={(value) => setSpaceId(value)}
            />
          ) : undefined
        }
        footer={
          !enrolled
            ? "Sign in and enroll this Mac to see the vault."
            : entries === null
              ? "Reading the vault…"
              : entries.length === 1
                ? "1 entry kept."
                : `${String(entries.length)} entries kept.`
        }
      >
        {error === null ? null : (
          <Block>
            <Note type="error">{error}</Note>
          </Block>
        )}
        {entries !== null && entries.length === 0 ? (
          <Block>
            <p className="text-copy-13 text-gray-900">
              Nothing kept yet. When you fill in a secure form for a cloud run and leave &ldquo;keep in my vault&rdquo; on, the
              details land here. You can also add them by hand below.
            </p>
          </Block>
        ) : (
          grouped.map(([origin, group]) => (
            <div key={origin}>
              <div className="px-5 pt-3.5 text-label-12 text-gray-900 @max-md:px-4">{hostnameOf(origin)}</div>
              {group.map((entry) => (
                <EntryRow key={entry.id} entry={entry} onChanged={refresh} />
              ))}
            </div>
          ))
        )}
      </Group>

      {enrolled && selected !== null ? (
        <Group
          title="Add by hand"
          note="Give the site, then each field the agent should be able to fill. A purpose helps it recognise the same field on a page whatever the page calls it."
          footerAction={adding ? undefined : (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
              Add an entry
            </Button>
          )}
        >
          {adding ? (
            <Block>
              <EntryEditor
                spaceId={selected}
                entryId={null}
                initialOrigin=""
                initialName=""
                initialFields={loginDraft()}
                allowStructure
                onDone={async (saved) => {
                  setAdding(false);
                  if (saved) await refresh();
                }}
              />
            </Block>
          ) : null}
        </Group>
      ) : null}

      <Group title="How it stays private">
        <Row
          label="The agent never reads a value"
          note="The cloud browser opens the entry with the Space key, types it into the page, and the model learns only that the fields were filled."
        >
          <Badge variant="green-subtle" size="sm">
            <ShieldCheck aria-hidden="true" /> Always
          </Badge>
        </Row>
        <Row
          label="A rejected value is not retried"
          note="If a site turns a saved value down, the agent asks you for a fresh one in the same run, and your answer replaces what was kept."
        >
          <Badge variant="green-subtle" size="sm">
            <KeyRound aria-hidden="true" /> Always
          </Badge>
        </Row>
        <Row label="One-time codes are never kept" note="They are spent the moment they are typed; removing an entry here means the agent asks you next time." />
      </Group>
    </Page>
  );
}

/* ------------------------------- one entry ------------------------------ */

function EntryRow({ entry, onChanged }: { entry: VaultEntryInfo; onChanged: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState<DraftField[] | null>(null);
  const [removing, setRemoving] = useState(false);
  const { busy, error, run } = useAsyncAction();

  const load = async (): Promise<Record<string, string> | null> => {
    if (values !== null) return values;
    let opened: Record<string, string> | null = null;
    await run(async () => {
      opened = await shellApi().vaultReveal(entry.spaceId, entry.id);
      setValues(opened);
      return null;
    });
    return opened;
  };

  const toggleReveal = async (): Promise<void> => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    if ((await load()) !== null) setRevealed(true);
  };

  const beginEdit = async (): Promise<void> => {
    const opened = await load();
    if (opened === null) return;
    setEditing(entry.fields.map((field) => draftField({
      id: field.id,
      label: field.label,
      type: field.type,
      autocomplete: field.autocomplete ?? "none",
      value: opened[field.id] ?? "",
    })));
  };

  const remove = async (): Promise<void> => {
    const ok = await run(async () => {
      await shellApi().vaultDelete(entry.spaceId, entry.id);
      return null;
    });
    if (ok) await onChanged();
  };

  if (editing !== null) {
    return (
      <Block label={entry.siteName} note={entry.siteOrigin}>
        <EntryEditor
          spaceId={entry.spaceId}
          entryId={entry.id}
          initialOrigin={entry.siteOrigin}
          initialName={entry.siteName}
          initialFields={editing}
          allowStructure={false}
          onDone={async (saved) => {
            setEditing(null);
            setValues(null);
            setRevealed(false);
            if (saved) await onChanged();
          }}
        />
      </Block>
    );
  }

  return (
    <Row
      label={
        <span className="flex items-center gap-2">
          {entry.siteName}
          <Badge variant={entry.source === "capture" ? "green-subtle" : "gray-subtle"} size="sm">
            {entry.source === "capture" ? "Saved from a run" : "Added by you"}
          </Badge>
        </span>
      }
      note={
        <span className="flex flex-col gap-1">
          <span className="font-mono text-[11px]">{entry.siteOrigin}</span>
          {entry.fields.map((field) => (
            <span key={field.id}>
              {field.label}
              {field.autocomplete === undefined ? null : <span className="text-gray-700"> · {field.autocomplete.replace(/-/gu, " ")}</span>}
              {": "}
              <span className="font-mono" data-testid="vault-value">
                {revealed && values !== null ? values[field.id] ?? "" : "••••••••"}
              </span>
            </span>
          ))}
          <span className="text-gray-700">{usedLabel(entry.lastUsedAt)}</span>
          {error === null ? null : <span className="text-red-900">{error}</span>}
        </span>
      }
    >
      <span className="flex items-center gap-1.5">
        {removing ? (
          <>
            <Button variant="error" size="sm" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
            <Button variant="tertiary" size="sm" disabled={busy} onClick={() => setRemoving(false)}>
              Keep
            </Button>
          </>
        ) : (
          <>
            <Button variant="tertiary" size="sm" disabled={busy} onClick={() => void toggleReveal()}>
              {revealed ? "Hide" : "Show"}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void beginEdit()}>
              Edit
            </Button>
            <Button variant="tertiary" size="sm" disabled={busy} onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </>
        )}
      </span>
    </Row>
  );
}

/* ------------------------------- the editor ----------------------------- */

function EntryEditor({
  spaceId,
  entryId,
  initialOrigin,
  initialName,
  initialFields,
  allowStructure,
  onDone,
}: {
  spaceId: string;
  entryId: string | null;
  initialOrigin: string;
  initialName: string;
  initialFields: DraftField[];
  /** Whether labels, types, and purposes may change (a new entry) or only values (an existing one). */
  allowStructure: boolean;
  onDone: (saved: boolean) => Promise<void>;
}) {
  const [origin, setOrigin] = useState(initialOrigin);
  const [name, setName] = useState(initialName);
  const [fields, setFields] = useState(initialFields);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const { busy, error, run } = useAsyncAction();

  const update = (id: string, patch: Partial<DraftField>): void => {
    setFields((current) => current.map((field) => (field.id === id ? { ...field, ...patch } : field)));
  };

  const save = async (): Promise<void> => {
    const ok = await run(async () => {
      if (fields.some((field) => field.label.trim() === "" || field.value === "")) {
        return "Every field needs a label and a value.";
      }
      await shellApi().vaultSave(spaceId, entryId, toDraft(fields, origin, name));
      return null;
    });
    if (ok) await onDone(true);
  };

  return (
    <form
      className="flex flex-col gap-3"
      autoComplete="off"
      data-testid="vault-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {allowStructure ? (
        <div className="grid gap-3 @md:grid-cols-2">
          <Input
            label="Site"
            description="The agent uses these only on pages from this exact site."
            value={origin}
            placeholder="https://www.amazon.com"
            required
            onChange={(event) => setOrigin(event.target.value)}
          />
          <Input
            label="Name"
            description="How it is listed here."
            value={name}
            placeholder="Amazon"
            maxLength={160}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      ) : null}
      {fields.map((field, index) => (
        <div key={field.id} className="flex flex-col gap-2 rounded-md border border-alpha-400 p-3">
          {allowStructure ? (
            <div className="grid gap-2 @md:grid-cols-3">
              <Input
                label={`Field ${String(index + 1)}`}
                value={field.label}
                placeholder="Email"
                maxLength={120}
                required
                onChange={(event) => update(field.id, { label: event.target.value })}
              />
              <label className="flex flex-col gap-1 text-label-13 text-gray-1000">
                Type
                <Select value={field.type} items={FIELD_TYPES} onValueChange={(value) => update(field.id, { type: value })} />
              </label>
              <label className="flex flex-col gap-1 text-label-13 text-gray-1000">
                Purpose
                <Select value={field.autocomplete} items={PURPOSES} onValueChange={(value) => update(field.id, { autocomplete: value })} />
              </label>
            </div>
          ) : (
            <p className="text-label-13 text-gray-1000">
              {field.label}
              {field.autocomplete === "none" ? null : <span className="text-gray-700"> · {field.autocomplete.replace(/-/gu, " ")}</span>}
            </p>
          )}
          <div className="flex items-end gap-2">
            <Input
              containerClassName="grow"
              label="Value"
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
            {field.type === "password" ? (
              <Button
                type="button"
                variant="tertiary"
                size="sm"
                onClick={() => setVisible((current) => ({ ...current, [field.id]: current[field.id] !== true }))}
              >
                {visible[field.id] === true ? "Hide" : "Show"}
              </Button>
            ) : null}
            {allowStructure && fields.length > 1 ? (
              <Button
                type="button"
                variant="tertiary"
                size="sm"
                aria-label={`Remove field ${String(index + 1)}`}
                onClick={() => setFields((current) => current.filter((item) => item.id !== field.id))}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </div>
      ))}
      {allowStructure ? (
        <div>
          <Button type="button" variant="tertiary" size="sm" onClick={() => setFields((current) => [...current, draftField()])}>
            Add another field
          </Button>
        </div>
      ) : null}
      {error === null ? null : <Note type="error">{error}</Note>}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Encrypting…" : entryId === null ? "Add to vault" : "Save changes"}
        </Button>
        <Button type="button" variant="tertiary" size="sm" disabled={busy} onClick={() => void onDone(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
