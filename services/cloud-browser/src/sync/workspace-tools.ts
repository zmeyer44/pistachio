/**
 * The cloud agent's encrypted personal-data store. It consumes the same
 * account workspace documents as desktop sync and publishes device-signed
 * LWW updates through the existing hub socket. Control and the hub only see
 * ciphertext.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ArtifactToolHost,
  BookmarkToolHost,
  MemoryToolHost,
  NoteToolHost,
  ReminderToolHost,
} from "@pistachio/agent-runtime";
import {
  activeMemories,
  effectiveTimezone,
  looksSensitive,
  memoryPrompt,
  memoryToolView,
  rankMemories,
  profileView,
  sanitizeMemoryAddInput,
  sanitizeMemoryEntry,
  sanitizeMemoryUpdateInput,
  type MemoryAddInput,
  type MemoryEntry,
  type MemoryReview,
  type MemorySnapshot,
  type MemorySource,
  type MemoryUpdateInput,
} from "@pistachio/agent-runtime/memory";
import {
  isExhausted,
  nextOccurrence,
  reminderToolView,
  sanitizeReminder,
  sanitizeReminderInput,
  sanitizeReminderPatch,
  type Reminder,
  type ReminderInput,
  type ReminderPatch,
  type ReminderSnapshot,
  type ReminderSource,
} from "@pistachio/agent-runtime/reminders";
import {
  BOOKMARK_EDITABLE_FIELDS,
  MAX_BOOKMARKS,
  bookmarkHost,
  bookmarkToolView,
  cleanBookmarkUrl,
  sanitizeBookmark,
  sanitizeBookmarkInput,
  sanitizeBookmarkPatch,
  searchBookmarks,
  type Bookmark,
  type BookmarkInput,
  type BookmarkPatch,
  type BookmarkSnapshot,
  type BookmarkSource,
} from "@pistachio/agent-runtime/bookmarks";
import {
  MAX_NOTE_BLOB_BYTES,
  MAX_NOTE_BLOBS_PER_NOTE,
  MAX_NOTE_MARKDOWN_BYTES,
  MAX_NOTES,
  noteBlobIdsIn,
  sanitizeNote,
  sanitizeNoteBlob,
  sanitizeNoteInput,
  sanitizeNotePatch,
  searchNotes,
  summaryOf,
  type Note,
  type NoteBlob,
  type NoteBlobMediaType,
  type NoteInput,
  type NotePatch,
  type NoteSource,
  type NoteSummary,
} from "@pistachio/agent-runtime/notes";
import {
  MAX_ARTIFACT_BRIEF,
  MAX_ARTIFACT_HTML_BYTES,
  MAX_ARTIFACT_TITLE,
  MAX_ARTIFACTS,
  artifactToolView,
  sanitizeArtifactDocument,
  type ArtifactSource,
} from "@pistachio/agent-runtime/artifacts";
import type { DeviceRegistryVerifier, HubTransport } from "@pistachio/sync-engine";
import { EMPTY_BROWSER_SESSION_STATE, sanitizeTabSession, type BrowserSessionState } from "@pistachio/shell-contracts/tab-session";
import {
  HlcClock,
  compareHlc,
  fromBase64,
  fromUtf8,
  open,
  seal,
  toBase64,
  utf8,
  workspaceKeyFor,
  workspaceSealAad,
  workspaceSigningBytes,
  SHELL_SETTINGS_KEY,
  type ArtifactDoc,
  type ArtifactRecord,
  type BookmarkDoc,
  type Hlc,
  type BrowserSessionDoc,
  type BrowserSessionRecord,
  type DeviceWorkspaceDoc,
  type ShellSettingsDoc,
  type ShellSettingsRecord,
  type MemoryDoc,
  type NoteBlobDoc,
  type NoteDoc,
  type ReminderDoc,
  type SpaceDoc,
  type SpaceKeys,
  type WorkspaceRecordWire,
} from "@pistachio/sync-protocol";

type PersonalDoc = BookmarkDoc | ReminderDoc | MemoryDoc | ArtifactDoc | NoteDoc | NoteBlobDoc;

/**
 * Everything this store keeps a register for. Beyond the agent's personal
 * records it now holds the two workspace docs the shell host needs to answer
 * for a browser session (docs/web-browser-design.md §6.3, §9): the account's
 * Spaces, and each Space's durable session state.
 */
type StoredDoc = PersonalDoc | SpaceDoc | BrowserSessionDoc | ShellSettingsDoc | DeviceWorkspaceDoc;

/** Key prefixes this store keeps; anything else on the socket is another reader's. */
const KEPT_PREFIXES = [
  "memory:",
  "reminder:",
  "bookmark:",
  "artifact:",
  "note:",
  "note-blob:",
  "space:",
  "browser-session:",
  "shell-settings:",
  "device-workspace:",
] as const;

/**
 * Registers whose writes the shell is not told about. A browser session is
 * this host's own state, and a note-blob is an immutable picture: the note
 * that references it is published in the same breath, and a megabyte of
 * base64 has nothing in it for a snapshot to render (docs/notes.md N3, §6).
 */
const SILENT_PREFIXES = ["browser-session:", "note-blob:"] as const;

function silentKey(key: string): boolean {
  return SILENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

interface Register {
  doc: StoredDoc | null;
  hlc: Hlc;
}

export interface WorkspaceToolStoreOptions {
  deviceId: string;
  privateKey: CryptoKey;
  keys: Promise<SpaceKeys>;
  transport: HubTransport;
  verifier: (refresh: boolean) => Promise<DeviceRegistryVerifier>;
  artifactWebUrl?: string;
  onArtifactChanged?: (artifact: ArtifactRecord) => void;
  now?: () => Date;
}

function storedDoc(value: unknown, key: string): StoredDoc | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const id = key.slice(key.indexOf(":") + 1);
  if (raw["kind"] === "deviceWorkspace" && key.startsWith("device-workspace:")) {
    if (raw["deviceId"] !== id || (raw["deviceKind"] !== "desktop" && raw["deviceKind"] !== "cloud")) return undefined;
    if (typeof raw["savedAtMs"] !== "number" || !Number.isFinite(raw["savedAtMs"]) || raw["savedAtMs"] < 0) return undefined;
    return {
      kind: "deviceWorkspace", deviceId: id, deviceKind: raw["deviceKind"],
      name: typeof raw["name"] === "string" ? raw["name"].slice(0, 120) : "",
      savedAtMs: raw["savedAtMs"], session: sanitizeTabSession(raw["session"]),
    };
  }
  if (raw["kind"] === "memory" && key.startsWith("memory:")) {
    const entry = sanitizeMemoryEntry(raw["memory"]);
    return entry?.id === id ? { kind: "memory", memory: entry } : undefined;
  }
  if (raw["kind"] === "reminder" && key.startsWith("reminder:")) {
    const reminder = sanitizeReminder(raw["reminder"]);
    return reminder?.id === id ? { kind: "reminder", reminder } : undefined;
  }
  if (raw["kind"] === "bookmark" && key.startsWith("bookmark:")) {
    const bookmark = sanitizeBookmark(raw["bookmark"]);
    return bookmark?.id === id ? { kind: "bookmark", bookmark } : undefined;
  }
  if (raw["kind"] === "note" && key.startsWith("note:")) {
    const note = sanitizeNote(raw["note"]);
    return note?.id === id ? { kind: "note", note } : undefined;
  }
  if (raw["kind"] === "noteBlob" && key.startsWith("note-blob:")) {
    const blob = sanitizeNoteBlob(raw["blob"]);
    // base64 is four characters per three bytes; anything longer than the
    // cap allows is not a picture this account wrote (N4).
    if (blob === null || blob.id !== id || blob.data.length > Math.ceil(MAX_NOTE_BLOB_BYTES / 3) * 4 + 4) return undefined;
    return { kind: "noteBlob", blob };
  }
  if (raw["kind"] === "space" && key.startsWith("space:")) {
    return typeof raw["id"] === "string" && raw["id"] === id && typeof raw["name"] === "string"
      ? (raw as unknown as SpaceDoc)
      : undefined;
  }
  if (raw["kind"] === "shellSettings" && key === SHELL_SETTINGS_KEY) {
    const settings = raw["settings"];
    if (typeof settings !== "object" || settings === null) return undefined;
    return raw as unknown as ShellSettingsDoc;
  }
  if (raw["kind"] === "browserSession" && key.startsWith("browser-session:")) {
    const session = raw["session"];
    if (typeof session !== "object" || session === null) return undefined;
    return (session as { spaceId?: unknown }).spaceId === id ? (raw as unknown as BrowserSessionDoc) : undefined;
  }
  if (raw["kind"] === "artifact" && key.startsWith("artifact:")) {
    const record = raw["artifact"];
    if (typeof record !== "object" || record === null || typeof (record as { html?: unknown }).html !== "string") return undefined;
    const html = (record as { html: string }).html;
    if (Buffer.byteLength(html, "utf8") > MAX_ARTIFACT_HTML_BYTES) return undefined;
    const artifact = sanitizeArtifactDocument({ version: 1, artifacts: [record] }).artifacts[0];
    return artifact?.id === id ? { kind: "artifact", artifact: { ...artifact, html } } : undefined;
  }
  return undefined;
}

/**
 * A body over the cap is refused, never quietly cut: `sanitizeNoteMarkdown`
 * clamps so a hostile register cannot grow past it, but a person's own save
 * must come back as a refusal the editor can show, the way the desktop store
 * answers it. Read off the raw value, before sanitizing has a chance to hide it.
 */
function requireNoteMarkdownFits(value: unknown): void {
  const markdown = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["markdown"] : undefined;
  if (typeof markdown !== "string") return;
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > MAX_NOTE_MARKDOWN_BYTES) {
    throw new Error(`that note is ${String(bytes)} bytes; a note holds at most ${String(MAX_NOTE_MARKDOWN_BYTES)}`);
  }
  const pictures = (markdown.match(/note-blob:[a-f0-9]{24}/gu) ?? []).length;
  if (pictures > MAX_NOTE_BLOBS_PER_NOTE) {
    throw new Error(`a note holds at most ${String(MAX_NOTE_BLOBS_PER_NOTE)} images; this one references ${String(pictures)}`);
  }
}

export class WorkspaceToolStore {
  readonly #options: WorkspaceToolStoreOptions;
  readonly #clock: HlcClock;
  readonly #registers = new Map<string, Register>();
  readonly #recordListeners = new Set<() => void>();
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();
  #hydrated = false;
  #resolveReady: () => void = () => undefined;
  readonly ready: Promise<void>;

  constructor(options: WorkspaceToolStoreOptions) {
    this.#options = options;
    this.#clock = new HlcClock(options.deviceId, () => this.#now().getTime());
    this.#now = options.now ?? (() => new Date());
    // Accounts created before workspace tools existed may not have wrapped
    // the pseudo-Space yet. Browser execution remains available; enabling
    // cloud again supplies the key and unlocks these tools.
    void options.keys.catch(() => undefined);
    this.ready = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
  }

  receive(records: WorkspaceRecordWire[]): void {
    this.#queue = this.#queue.then(() => this.#receive(records)).catch(() => undefined);
  }

  hydrated(): void {
    this.#queue = this.#queue.then(() => {
      if (!this.#hydrated) {
        this.#hydrated = true;
        this.#resolveReady();
      }
    });
  }

  async settled(): Promise<void> {
    await this.#queue;
  }

  /** The account's Spaces, as the shell's Space menu lists them (§6.3). */
  spaces(): SpaceDoc[] {
    return [...this.#registers.values()].flatMap((entry) => (entry.doc?.kind === "space" ? [entry.doc] : []));
  }

  /**
   * Publish a Space's own record, sealed under the workspace key exactly as
   * the desktop's `SpaceStore` publishes it (`main/sync/workspace-map.ts`).
   *
   * The host needs it for one thing the walkthrough does: naming the first
   * Space after the person (§14). The name is account-global — it is what
   * every device's Space menu reads — so it is written here rather than
   * kept in the session, and `spaces()` reads it straight back.
   */
  putSpace(space: SpaceDoc): void {
    this.#put({ ...space, kind: "space" });
  }

  /** One Space's durable browser-session state (§9), or null when none is stored. */
  browserSession(spaceId: string): BrowserSessionRecord | null {
    const entry = this.#registers.get(`browser-session:${spaceId}`);
    return entry?.doc?.kind === "browserSession" ? entry.doc.session : null;
  }

  /** Seed a Space's first cloud session from its newest desktop restore point. */
  desktopSession(spaceId: string): BrowserSessionState | null {
    const candidates = [...this.#registers.values()].filter(
      (entry): entry is Register & { doc: DeviceWorkspaceDoc } =>
        entry.doc?.kind === "deviceWorkspace" && entry.doc.deviceKind === "desktop" &&
        (entry.doc.session.spaces[spaceId]?.tabs.length ?? 0) > 0,
    ).sort((a, b) => (b.doc.session.spaces[spaceId]?.updatedAt ?? b.doc.savedAtMs) - (a.doc.session.spaces[spaceId]?.updatedAt ?? a.doc.savedAtMs) || compareHlc(b.hlc, a.hlc));
    const source = candidates[0]?.doc;
    const space = source?.session.spaces[spaceId];
    if (source === undefined || space === undefined) return null;
    return {
      ...structuredClone(EMPTY_BROWSER_SESSION_STATE), spaceId,
      tabs: space.tabs.map((tab) => ({
        id: tab.id, url: tab.url, title: tab.title, favicon: tab.faviconUrl,
        kind: "human", lastActiveAt: tab.lastActiveAt,
        ...(tab.resume ? { resume: tab.resume } : {}),
        ...(tab.anchorId ? { pinnedAnchor: tab.anchorId } : {}),
      })),
      activeTabId: space.activeTabId,
      splitGroups: structuredClone(space.splitGroups), updatedAt: space.updatedAt ?? source.savedAtMs,
    };
  }

  /** Publish a Space's session state, sealed under the workspace key like everything else. */
  putBrowserSession(session: BrowserSessionRecord): void {
    this.#put({ kind: "browserSession", session });
  }

  /**
   * The shell's settings, account-global (§6.3), or null when nothing has
   * been written yet — a Mac that has never synced them, a brand new account.
   */
  shellSettings(): ShellSettingsRecord | null {
    const entry = this.#registers.get(SHELL_SETTINGS_KEY);
    return entry?.doc?.kind === "shellSettings" ? entry.doc.settings : null;
  }

  /** Publish the shell's settings, sealed under the workspace key. */
  putShellSettings(settings: ShellSettingsRecord): void {
    this.#put({ kind: "shellSettings", settings });
  }

  timezone(): string {
    return effectiveTimezone(profileView(this.#memories(), this.#now()));
  }

  memory(runId: string, query: string): { prompt: string; host: MemoryToolHost } {
    const source: MemorySource = { kind: "agent", runId };
    const recalled = rankMemories(this.#memories(), query, { now: this.#now(), limit: 8 });
    return {
      prompt: memoryPrompt(this.#memories(), { now: this.#now(), recalled }),
      host: {
        search: async (text) => rankMemories(this.#memories(), text, { now: this.#now(), limit: 8 }).map(memoryToolView),
        add: (input) => memoryToolView(this.#addMemory(input, source)),
        update: (id, patch) => memoryToolView(this.#updateMemory(id, patch, source)),
        forget: (id, reason) => memoryToolView(this.#forgetMemory(id, reason, source)),
      },
    };
  }

  reminders(runId: string): ReminderToolHost {
    const source: ReminderSource = { kind: "agent", runId };
    return {
      list: () => this.#reminders().filter((item) => item.status === "active" || item.status === "paused").map(reminderToolView),
      create: (input) => reminderToolView(this.#addReminder(input, source)),
      update: (id, patch) => reminderToolView(this.#updateReminder(id, patch, source)),
      cancel: (id) => reminderToolView(this.#cancelReminder(id, source)),
    };
  }

  bookmarks(runId: string, enrich: (input: BookmarkInput) => Promise<Partial<Bookmark>>): BookmarkToolHost {
    const source: BookmarkSource = { kind: "agent", runId };
    return {
      search: (query, kind) => searchBookmarks(this.#bookmarks(), query, { kind, limit: 12 }).map(bookmarkToolView),
      create: async (input) => bookmarkToolView(this.#addBookmark(input, source, await enrich(input))),
      update: (id, patch) => bookmarkToolView(this.#updateBookmark(id, patch, source)),
      remove: (id) => this.#removeBookmark(id),
    };
  }

  /**
   * The agent's window onto the person's notes (docs/notes.md §6), the same
   * `NoteToolHost` the desktop builds over its own store: one search, one
   * edit model, one set of tools wherever the run happens to be.
   */
  notes(runId: string): NoteToolHost {
    const source: NoteSource = { kind: "agent", runId };
    return {
      list: () => searchNotes(this.#notes(), "", { limit: 50 }).map(summaryOf),
      search: (query, limit) => searchNotes(this.#notes(), query, { limit }).map(summaryOf),
      get: (id) => this.#note(id),
      create: (input) => this.#addNote(input, source),
      update: (id, patch) => this.#updateNote(id, patch, source),
      remove: (id) => this.#removeNote(id),
    };
  }

  artifacts(
    runId: string,
    build: (input: { title: string; brief: string; content: string; priorHtml: string | null }) => Promise<{ html: string; model: string }>,
  ): ArtifactToolHost {
    const source: ArtifactSource = { kind: "agent", runId };
    return {
      list: () => this.#artifacts().map((artifact) => artifactToolView(artifact, this.#options.artifactWebUrl)),
      create: async ({ title, brief, content }) => {
        const built = await build({ title, brief, content, priorHtml: null });
        const artifact = this.#addArtifact({ title, brief, ...built }, source);
        this.#options.onArtifactChanged?.(structuredClone(artifact));
        return artifactToolView(artifact, this.#options.artifactWebUrl);
      },
      update: async (id, { title, instructions, content }) => {
        const current = this.#artifacts().find((entry) => entry.id === id);
        if (current === undefined) throw new Error(`no artifact ${id}; artifact_list shows what exists`);
        const nextTitle = title ?? current.title;
        const built = await build({
          title: nextTitle,
          brief: `${current.brief}\n\nThis refresh: ${instructions}`,
          content,
          priorHtml: current.html,
        });
        const artifact = this.#updateArtifact(current, nextTitle, built, source);
        this.#options.onArtifactChanged?.(structuredClone(artifact));
        return artifactToolView(artifact, this.#options.artifactWebUrl);
      },
    };
  }

  /**
   * The person's own half of this store (docs/web-browser-design.md §11).
   *
   * Until S6 the store was the AGENT's: every write carried a run id, and the
   * only way in was a tool host. But the shell in a browser tab is the person
   * sitting in front of their own records — the memory audit page, the
   * reminder schedule, the bookmark they just saved — and those writes are
   * theirs, sourced `user` with no run, exactly as the desktop's stores
   * source them. Same registers, same seals, same LWW: a memory the person
   * corrects here is the same document their Mac corrects.
   *
   * Reads are whole snapshots because that is what the shell renders: the
   * settings page filters versions itself, so hiding history here would only
   * lose the audit trail.
   */
  person(options: { enrich?: (input: BookmarkInput) => Promise<Partial<Bookmark>> } = {}): WorkspacePersonHost {
    const source = { kind: "user", runId: null } as const;
    const enrich = options.enrich ?? (async (): Promise<Partial<Bookmark>> => ({}));
    return {
      memory: () => ({ entries: this.#memories().map((entry) => structuredClone(entry)) }),
      addMemory: (input) => this.#addMemory(input, source),
      updateMemory: (id, patch) => this.#updateMemory(id, patch, source),
      forgetMemory: (id, reason) => this.#forgetMemory(id, reason.slice(0, 400), source),
      restoreMemory: (id) => this.#reviseMemory(id, (current) => ({
        ...current,
        isForgotten: false,
        forgottenAt: null,
        forgetReason: null,
        // A memory that expired on its own would be forgotten again on the
        // next sweep; restoring it means the person wants it kept.
        forgetAfter: current.forgetAfter !== null && Date.parse(current.forgetAfter) <= this.#now().getTime() ? null : current.forgetAfter,
        source,
      })),
      reviewMemory: (id, decision) => this.#reviseMemory(id, (current) => ({
        ...current,
        review: decision,
        confidence: decision === "approved" ? Math.max(current.confidence, 0.9) : current.confidence,
        source,
      })),
      forgetAllMemory: () => {
        const active = activeMemories(this.#memories(), this.#now());
        for (const entry of active) this.#forgetMemory(entry.id, "Forgotten from Settings", source);
        return active.length;
      },
      reminders: () => ({
        reminders: this.#reminders().map((reminder) => structuredClone(reminder)),
        // Occurrences are the firing host's own log and carry no workspace
        // record (§9), so a session has none to show.
        occurrences: [],
      }),
      addReminder: (input) => this.#addReminder(input, source),
      updateReminder: (id, patch) => this.#updateReminder(id, patch, source),
      cancelReminder: (id) => this.#cancelReminder(id, source),
      deleteReminder: (id) => {
        const current = this.#reminders().find((entry) => entry.id === id);
        if (current === undefined) throw new Error("reminder not found");
        this.#putKey(`reminder:${id}`, null);
      },
      runReminderNow: (id) => {
        const current = this.#reminders().find((entry) => entry.id === id);
        if (current === undefined) throw new Error("reminder not found");
        // The schedule is what fires a reminder, and the schedule lives with
        // whichever host is running it. Bringing the next occurrence forward
        // is how this session asks for it now without pretending to be that
        // host.
        const next: Reminder = {
          ...structuredClone(current),
          status: "active",
          nextFireAt: this.#now().toISOString(),
          source,
          updatedAt: this.#now().toISOString(),
        };
        this.#put({ kind: "reminder", reminder: next });
      },
      bookmarks: () => ({ bookmarks: this.#bookmarks().map((bookmark) => structuredClone(bookmark)) }),
      addBookmark: async (input) => this.#addBookmark(input, source, await enrich(input)),
      updateBookmark: (id, patch) => this.#updateBookmark(id, patch, source),
      deleteBookmark: (id) => {
        this.#removeBookmark(id);
      },
      refreshBookmark: async (id) => {
        const current = this.#bookmarks().find((entry) => entry.id === id);
        if (current === undefined) throw new Error("bookmark not found");
        const read = await enrich({ url: current.url });
        // What the person edited is theirs; the rest is refilled.
        const edited = new Set<string>(current.editedFields);
        const patch = Object.fromEntries(
          Object.entries(read).filter(([key, value]) => !edited.has(key) && value !== undefined && key !== "id"),
        );
        return this.#updateBookmark(id, patch, source);
      },
      artifacts: () => this.#artifacts().map((artifact) => structuredClone(artifact)),
      listNotes: () => searchNotes(this.#notes(), "", {}).map(summaryOf),
      searchNotes: (query, limit) => searchNotes(this.#notes(), query, { limit }).map(summaryOf),
      getNote: (id) => this.#note(id),
      createNote: (input) => this.#addNote(input ?? {}, source),
      updateNote: (id, patch) => this.#updateNote(id, patch, source),
      deleteNote: (id) => {
        this.#removeNote(id);
      },
      putNoteBlob: (data, mediaType) => this.#putNoteBlob(data, mediaType),
      getNoteBlob: (id) => this.#noteBlob(id),
    };
  }

  /**
   * Every register write, whoever made it: the shell publishes a fresh
   * snapshot from here rather than guessing which of its own calls changed
   * what, so a correction another device made lands in this session too.
   */
  onRecordsChanged(listener: () => void): () => void {
    this.#recordListeners.add(listener);
    return () => this.#recordListeners.delete(listener);
  }

  #notifyRecords(): void {
    for (const listener of [...this.#recordListeners]) {
      try {
        listener();
      } catch {
        // A listener that throws is the shell's problem, not the store's.
      }
    }
  }

  /** Rewrite the latest version of a memory chain in place. */
  #reviseMemory(id: string, revise: (current: MemoryEntry) => MemoryEntry): MemoryEntry {
    const entries = this.#memories();
    const named = entries.find((entry) => entry.id === id);
    const current =
      named === undefined
        ? undefined
        : entries.filter((entry) => entry.rootId === named.rootId).sort((a, b) => b.version - a.version)[0];
    if (current === undefined) throw new Error("memory not found");
    const next = revise(structuredClone(current));
    this.#put({ kind: "memory", memory: next });
    return structuredClone(next);
  }

  #memories(): MemoryEntry[] {
    return [...this.#registers.values()].flatMap((entry) => entry.doc?.kind === "memory" ? [entry.doc.memory] : []);
  }

  #reminders(): Reminder[] {
    return [...this.#registers.values()].flatMap((entry) => entry.doc?.kind === "reminder" ? [entry.doc.reminder] : []);
  }

  #bookmarks(): Bookmark[] {
    return [...this.#registers.values()].flatMap((entry) => entry.doc?.kind === "bookmark" ? [entry.doc.bookmark] : []);
  }

  #artifacts(): ArtifactRecord[] {
    return [...this.#registers.values()].flatMap((entry) => entry.doc?.kind === "artifact" ? [entry.doc.artifact] : []);
  }

  #notes(): Note[] {
    return [...this.#registers.values()].flatMap((entry) => entry.doc?.kind === "note" ? [entry.doc.note] : []);
  }

  #noteBlobs(): NoteBlob[] {
    return [...this.#registers.values()].flatMap((entry) => entry.doc?.kind === "noteBlob" ? [entry.doc.blob] : []);
  }

  #note(id: string): Note | null {
    const note = this.#notes().find((entry) => entry.id === id);
    return note === undefined ? null : structuredClone(note);
  }

  #addNote(value: unknown, source: NoteSource): Note {
    requireNoteMarkdownFits(value);
    const input = sanitizeNoteInput(value);
    if (this.#notes().length >= MAX_NOTES) throw new Error(`no more than ${String(MAX_NOTES)} notes can be kept`);
    const at = this.#now().toISOString();
    const markdown = input.markdown ?? "";
    const note: Note = {
      id: randomBytes(6).toString("hex"),
      title: input.title ?? "",
      markdown,
      icon: input.icon ?? null,
      blobIds: noteBlobIdsIn(markdown),
      createdAt: at,
      updatedAt: at,
      revision: 1,
      source,
    };
    this.#put({ kind: "note", note });
    return structuredClone(note);
  }

  #updateNote(id: string, value: unknown, source: NoteSource): Note {
    requireNoteMarkdownFits(value);
    const patch = sanitizeNotePatch(value);
    const current = this.#notes().find((entry) => entry.id === id);
    if (current === undefined) throw new Error("note not found");
    const markdown = patch.markdown ?? current.markdown;
    const next: Note = {
      ...structuredClone(current),
      ...patch,
      markdown,
      blobIds: noteBlobIdsIn(markdown),
      revision: current.revision + 1,
      source,
      updatedAt: this.#now().toISOString(),
    };
    this.#put({ kind: "note", note: next });
    return structuredClone(next);
  }

  /** Tombstone a note, and with it every picture no other note still names (N3). */
  #removeNote(id: string): Note {
    const current = this.#notes().find((entry) => entry.id === id);
    if (current === undefined) throw new Error("note not found");
    this.#putKey(`note:${id}`, null);
    const kept = new Set(this.#notes().flatMap((note) => note.blobIds));
    for (const blobId of current.blobIds) if (!kept.has(blobId)) this.#putKey(`note-blob:${blobId}`, null);
    return structuredClone(current);
  }

  /**
   * Store one image for a note, content-addressed: the same bytes twice are
   * the same register, written once. `data` is the raw bytes or their base64.
   */
  #putNoteBlob(data: Uint8Array | string, mediaType: NoteBlobMediaType): NoteBlob {
    const bytes = typeof data === "string" ? Buffer.from(data, "base64") : Buffer.from(data);
    if (bytes.byteLength === 0) throw new Error("an image needs bytes");
    if (bytes.byteLength > MAX_NOTE_BLOB_BYTES) throw new Error(`an image must be under ${String(MAX_NOTE_BLOB_BYTES)} bytes`);
    const id = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
    const existing = this.#noteBlobs().find((blob) => blob.id === id);
    if (existing !== undefined) return structuredClone(existing);
    const blob: NoteBlob = {
      id,
      mediaType,
      byteLength: bytes.byteLength,
      data: bytes.toString("base64"),
      createdAt: this.#now().toISOString(),
    };
    this.#put({ kind: "noteBlob", blob });
    return structuredClone(blob);
  }

  #noteBlob(id: string): NoteBlob | null {
    const blob = this.#noteBlobs().find((entry) => entry.id === id);
    return blob === undefined ? null : structuredClone(blob);
  }

  #addMemory(value: unknown, source: MemorySource): MemoryEntry {
    const input = sanitizeMemoryAddInput(value);
    if (input === null) throw new Error("memory needs content");
    if (looksSensitive(input.content)) throw new Error("secrets, payment details, and authentication codes cannot be saved to memory");
    const active = activeMemories(this.#memories(), this.#now());
    if (input.key != null) {
      const current = active.find((entry) => entry.key === input.key);
      if (current !== undefined) return this.#updateMemory(current.id, input, source);
    }
    const id = randomUUID();
    const entry: MemoryEntry = {
      id,
      rootId: id,
      parentId: null,
      version: 1,
      isLatest: true,
      content: input.content,
      label: input.label ?? null,
      key: input.key ?? null,
      kind: input.kind ?? "dynamic",
      bucket: input.bucket ?? "other",
      source,
      confidence: input.confidence ?? 0.9,
      review: input.review ?? "approved",
      mentions: 1,
      createdAt: this.#now().toISOString(),
      lastRecalledAt: null,
      isForgotten: false,
      forgottenAt: null,
      forgetAfter: input.forgetAfter ?? null,
      forgetReason: input.forgetReason ?? null,
    };
    this.#put({ kind: "memory", memory: entry });
    return structuredClone(entry);
  }

  #updateMemory(id: string, value: unknown, source: MemorySource): MemoryEntry {
    const patch = sanitizeMemoryUpdateInput(value);
    const entries = this.#memories();
    const named = entries.find((entry) => entry.id === id);
    const current = named === undefined ? undefined : entries.filter((entry) => entry.rootId === named.rootId).sort((a, b) => b.version - a.version)[0];
    if (current === undefined) throw new Error("memory not found");
    if (patch.content !== undefined && looksSensitive(patch.content)) throw new Error("secrets cannot be saved to memory");
    const previous = { ...current, isLatest: false };
    const next: MemoryEntry = {
      ...structuredClone(current),
      ...patch,
      id: randomUUID(),
      parentId: current.id,
      version: current.version + 1,
      isLatest: true,
      source,
      createdAt: this.#now().toISOString(),
      lastRecalledAt: null,
      isForgotten: false,
      forgottenAt: null,
    };
    this.#put({ kind: "memory", memory: previous });
    this.#put({ kind: "memory", memory: next });
    return structuredClone(next);
  }

  #forgetMemory(id: string, reason: string, source: MemorySource): MemoryEntry {
    const entries = this.#memories();
    const named = entries.find((entry) => entry.id === id);
    const current = named === undefined ? undefined : entries.filter((entry) => entry.rootId === named.rootId).sort((a, b) => b.version - a.version)[0];
    if (current === undefined) throw new Error("memory not found");
    const next = { ...current, isForgotten: true, forgottenAt: this.#now().toISOString(), forgetReason: reason, source };
    this.#put({ kind: "memory", memory: next });
    return structuredClone(next);
  }

  #addReminder(value: unknown, source: ReminderSource): Reminder {
    const input = sanitizeReminderInput(value);
    if (input === null) throw new Error("invalid reminder");
    const now = this.#now();
    const timezone = input.timezone ?? "UTC";
    const next = nextOccurrence(input.schedule, now, timezone);
    const limits = { until: input.until ?? null, maxFires: input.maxFires ?? null, fireCount: 0 };
    if (next === null || isExhausted(limits, next)) throw new Error("That schedule never fires.");
    const reminder: Reminder = {
      id: randomUUID(), title: input.title, schedule: structuredClone(input.schedule), action: structuredClone(input.action), timezone,
      status: "active", source, createdAt: now.toISOString(), updatedAt: now.toISOString(), nextFireAt: next.toISOString(),
      lastFiredAt: null, until: limits.until, maxFires: limits.maxFires, fireCount: 0,
    };
    this.#put({ kind: "reminder", reminder });
    return structuredClone(reminder);
  }

  #updateReminder(id: string, value: unknown, source: ReminderSource): Reminder {
    const patch = sanitizeReminderPatch(value);
    const current = this.#reminders().find((entry) => entry.id === id);
    if (current === undefined) throw new Error("reminder not found");
    const next = { ...structuredClone(current), ...patch, source, updatedAt: this.#now().toISOString() };
    const rescheduled = patch.schedule !== undefined || patch.timezone !== undefined || patch.until !== undefined || patch.maxFires !== undefined || patch.status === "active";
    if (rescheduled) {
      const fire = nextOccurrence(next.schedule, this.#now(), next.timezone);
      if (fire === null || isExhausted(next, fire)) throw new Error("That schedule never fires.");
      next.nextFireAt = fire.toISOString();
    }
    if (next.status === "paused") next.nextFireAt = null;
    this.#put({ kind: "reminder", reminder: next });
    return structuredClone(next);
  }

  #cancelReminder(id: string, source: ReminderSource): Reminder {
    const current = this.#reminders().find((entry) => entry.id === id);
    if (current === undefined) throw new Error("reminder not found");
    const next: Reminder = { ...current, status: "cancelled", nextFireAt: null, source, updatedAt: this.#now().toISOString() };
    this.#put({ kind: "reminder", reminder: next });
    return structuredClone(next);
  }

  #addBookmark(value: unknown, source: BookmarkSource, enriched: Partial<Bookmark>): Bookmark {
    const input = sanitizeBookmarkInput(value);
    if (input === null) throw new Error("Only http(s) pages can be bookmarked.");
    const existing = this.#bookmarks().find((entry) => entry.url === cleanBookmarkUrl(input.url));
    if (existing !== undefined) return this.#updateBookmark(existing.id, input, source);
    if (this.#bookmarks().length >= MAX_BOOKMARKS) throw new Error(`No more than ${String(MAX_BOOKMARKS)} bookmarks can be kept.`);
    const at = this.#now().toISOString();
    const url = cleanBookmarkUrl(input.url);
    const bookmark = sanitizeBookmark({
      id: randomUUID(), url, kind: input.kind ?? enriched.kind ?? "website", title: input.title ?? enriched.title ?? (bookmarkHost(url) || url),
      description: input.description ?? enriched.description ?? "", imageUrl: input.imageUrl ?? enriched.imageUrl ?? null,
      faviconUrl: input.faviconUrl ?? enriched.faviconUrl ?? null, siteName: input.siteName ?? enriched.siteName ?? "",
      keywords: input.keywords ?? enriched.keywords ?? [], details: input.details ?? enriched.details ?? [], note: input.note ?? "",
      status: "ready", provenance: enriched.provenance ?? "page", editedFields: Object.keys(input).filter((key) => BOOKMARK_EDITABLE_FIELDS.includes(key as never)),
      source, createdAt: at, updatedAt: at,
    });
    if (bookmark === null) throw new Error("invalid bookmark");
    this.#put({ kind: "bookmark", bookmark });
    return structuredClone(bookmark);
  }

  #updateBookmark(id: string, value: unknown, source: BookmarkSource): Bookmark {
    const patch = sanitizeBookmarkPatch(value);
    const current = this.#bookmarks().find((entry) => entry.id === id);
    if (current === undefined) throw new Error("bookmark not found");
    const editedFields = [...new Set([...current.editedFields, ...Object.keys(patch)])].filter((key) => BOOKMARK_EDITABLE_FIELDS.includes(key as never)) as Bookmark["editedFields"];
    const next = { ...structuredClone(current), ...patch, editedFields, source, updatedAt: this.#now().toISOString() };
    this.#put({ kind: "bookmark", bookmark: next });
    return structuredClone(next);
  }

  #removeBookmark(id: string): Bookmark {
    const current = this.#bookmarks().find((entry) => entry.id === id);
    if (current === undefined) throw new Error("bookmark not found");
    this.#putKey(`bookmark:${id}`, null);
    return structuredClone(current);
  }

  #addArtifact(input: { title: string; brief: string; html: string; model: string }, source: ArtifactSource): ArtifactRecord {
    if (this.#artifacts().length >= MAX_ARTIFACTS) throw new Error(`the library already holds ${String(MAX_ARTIFACTS)} artifacts`);
    const at = this.#now().toISOString();
    const artifact: ArtifactRecord = {
      id: randomBytes(6).toString("hex"), title: input.title.trim().slice(0, MAX_ARTIFACT_TITLE), brief: input.brief.trim().slice(0, MAX_ARTIFACT_BRIEF),
      html: input.html, builtWith: input.model, source, createdAt: at, updatedAt: at, revision: 1,
    };
    if (artifact.title === "" || Buffer.byteLength(artifact.html, "utf8") > MAX_ARTIFACT_HTML_BYTES) throw new Error("invalid artifact");
    this.#put({ kind: "artifact", artifact });
    return structuredClone(artifact);
  }

  #updateArtifact(current: ArtifactRecord, title: string, built: { html: string; model: string }, source: ArtifactSource): ArtifactRecord {
    if (Buffer.byteLength(built.html, "utf8") > MAX_ARTIFACT_HTML_BYTES) throw new Error("artifact is too large");
    const next: ArtifactRecord = { ...current, title: title.trim().slice(0, MAX_ARTIFACT_TITLE), html: built.html, builtWith: built.model, source, revision: current.revision + 1, updatedAt: this.#now().toISOString() };
    this.#put({ kind: "artifact", artifact: next });
    return structuredClone(next);
  }

  #put(doc: StoredDoc): void {
    this.#putKey(workspaceKeyFor(doc), doc);
  }

  #putKey(key: string, doc: StoredDoc | null): void {
    const hlc = this.#clock.send();
    this.#registers.set(key, { doc: structuredClone(doc), hlc });
    if (!silentKey(key)) this.#notifyRecords();
    this.#queue = this.#queue.then(async () => {
      const keys = await this.#options.keys;
      const sealedValue = doc === null ? null : toBase64(await seal(keys.sealKey, utf8(JSON.stringify(doc)), workspaceSealAad(key)));
      const signature = await crypto.subtle.sign("Ed25519", this.#options.privateKey, workspaceSigningBytes(key, sealedValue, hlc) as BufferSource);
      this.#options.transport.publishWorkspace([{ key, sealedValue, hlc, deviceSig: toBase64(new Uint8Array(signature)) }]);
    }).catch(() => undefined);
  }

  async #receive(records: WorkspaceRecordWire[]): Promise<void> {
    let verifier = await this.#options.verifier(false);
    let refreshed = false;
    let changed = false;
    const keys = await this.#options.keys;
    for (const wire of records) {
      if (!KEPT_PREFIXES.some((prefix) => wire.key.startsWith(prefix))) continue;
      if (wire.key.startsWith("device-workspace:") && wire.key !== `device-workspace:${wire.hlc.deviceId}`) continue;
      if (!(await verifier.verifyWorkspace(wire))) {
        if (!refreshed && !verifier.hasDevice(wire.hlc.deviceId)) {
          verifier = await this.#options.verifier(true);
          refreshed = true;
        }
        if (!(await verifier.verifyWorkspace(wire))) continue;
      }
      this.#clock.receive(wire.hlc);
      const current = this.#registers.get(wire.key);
      if (current !== undefined && compareHlc(current.hlc, wire.hlc) >= 0) continue;
      let value: unknown = null;
      try {
        if (wire.sealedValue !== null) {
          value = JSON.parse(fromUtf8(await open(keys.sealKey, fromBase64(wire.sealedValue), workspaceSealAad(wire.key)))) as unknown;
        }
      } catch {
        continue;
      }
      const doc = storedDoc(value, wire.key);
      if (doc === undefined) continue;
      this.#registers.set(wire.key, { doc, hlc: wire.hlc });
      if (!silentKey(wire.key)) changed = true;
    }
    if (changed) this.#notifyRecords();
  }
}

/**
 * What the shell asks of this store on the person's behalf (§6.3). Every
 * write here is sourced `{kind: "user", runId: null}`, which is what the
 * memory audit page, the reminder schedule and the bookmark list mean by
 * "you saved this".
 */
export interface WorkspacePersonHost {
  memory(): MemorySnapshot;
  addMemory(input: MemoryAddInput): MemoryEntry;
  updateMemory(id: string, patch: MemoryUpdateInput): MemoryEntry;
  forgetMemory(id: string, reason: string): MemoryEntry;
  restoreMemory(id: string): MemoryEntry;
  reviewMemory(id: string, decision: Exclude<MemoryReview, "pending">): MemoryEntry;
  forgetAllMemory(): number;
  reminders(): ReminderSnapshot;
  addReminder(input: ReminderInput): Reminder;
  updateReminder(id: string, patch: ReminderPatch): Reminder;
  cancelReminder(id: string): Reminder;
  deleteReminder(id: string): void;
  runReminderNow(id: string): void;
  bookmarks(): BookmarkSnapshot;
  addBookmark(input: BookmarkInput): Promise<Bookmark>;
  updateBookmark(id: string, patch: BookmarkPatch): Bookmark;
  deleteBookmark(id: string): void;
  refreshBookmark(id: string): Promise<Bookmark>;
  artifacts(): ArtifactRecord[];
  /** The person's notes, bodies left behind, most recently edited first (docs/notes.md §4). */
  listNotes(): NoteSummary[];
  searchNotes(query: string, limit: number): NoteSummary[];
  getNote(id: string): Note | null;
  createNote(input?: NoteInput): Note;
  updateNote(id: string, patch: NotePatch): Note;
  deleteNote(id: string): void;
  /** One picture, by its bytes or their base64; the same bytes twice are one record (N3). */
  putNoteBlob(data: Uint8Array | string, mediaType: NoteBlobMediaType): NoteBlob;
  getNoteBlob(id: string): NoteBlob | null;
}
