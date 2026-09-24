/**
 * Settings → Memory: everything the agent knows about the person, and the
 * one place it is kept.
 *
 * The page is a view over main's memory file (@pistachio/shell-contracts/memory). The quick
 * fields at the top — name, about, time zone, locations, projects — are not
 * a form of their own: each is a KEYED memory, so saving a name writes the
 * same kind of record the agent writes when it learns one, and the two can
 * supersede each other. Below the quick fields sits the whole list, with
 * history, and what the learner is not sure of waits at the top for a yes
 * or a no.
 *
 * Prose commits with a Save, because a half-typed sentence is not a fact;
 * a fact row commits when it is left, the way the new-tab address does.
 */

import { useMemo, useState } from "react";
import { Check, Plus, Trash2, X } from "lucide-react";
import { create } from "zustand";
import {
  activeMemories,
  effectiveTimezone,
  factKey,
  MAX_MEMORY_CONTENT,
  MAX_MEMORY_LABEL,
  memoryPrompt,
  profileView,
  PROFILE_KEY,
  rekeyedFor,
  systemTimezone,
  type MemoryBucket,
  type MemoryEntry,
  type MemoryProfileView,
} from "@pistachio/shell-contracts/memory";
import { copyFor, type CopySurface } from "../../../lib/surface-copy";
import { useAppStore } from "../../../store";
import { useSurface } from "../../../surface";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  Fieldset,
  FieldsetContent,
  FieldsetFooter,
  FieldsetFooterActions,
  FieldsetFooterStatus,
  FieldsetSubtitle,
  FieldsetTitle,
} from "../../ui/fieldset";
import { Input } from "../../ui/input";
import { Note } from "../../ui/note";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import { Block, Group, Page, Row } from "../parts";
import { MemoryList } from "./memory-list";

/** How a forget from this page is recorded, so the history says where it came from. */
const CLEARED = "Cleared in Settings";

/**
 * Every zone the runtime's own database knows, with "" for "whatever the
 * host this is running on says". A native select carries a list this long
 * without help, and a short curated list would be wrong for whoever is not
 * on it. Only the first row's words differ by surface (`lib/surface-copy.ts`):
 * a browser tab has no Mac to follow, it follows the browser.
 */
function timezoneItems(surface: CopySurface): ReadonlyArray<{ value: string; label: string }> {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [
    { value: "", label: copyFor(surface).memory.followSystemZone(systemTimezone()) },
    ...zones.map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") })),
  ];
}

/** Both lists, built once at module load: the zone database is long. */
const TIMEZONES: Record<CopySurface, ReadonlyArray<{ value: string; label: string }>> = {
  native: timezoneItems("native"),
  stream: timezoneItems("stream"),
};

/* ------------------------------- review -------------------------------- */

/** What the learner was not sure of. A yes lifts it; a no hides it. */
function ReviewFieldset({ pending }: { pending: MemoryEntry[] }) {
  const reviewMemory = useAppStore((state) => state.reviewMemory);
  return (
    <Group
      title="Needs your review"
      note="Facts the agent picked up from a conversation but was not sure about. Until you decide, they count for less and are not shown to the agent as settled."
      footer={`${String(pending.length)} waiting.`}
    >
      {pending.map((entry) => (
        <Row
          key={entry.id}
          label={entry.label === null ? entry.content : `${entry.label}: ${entry.content}`}
          note={`Learned ${new Date(entry.createdAt).toLocaleDateString()} · ${String(Math.round(entry.confidence * 100))}% sure`}
        >
          <span className="flex items-center gap-1.5">
            <Button variant="secondary" size="sm" prefix={<Check aria-hidden="true" />} onClick={() => void reviewMemory(entry.id, "approved")}>
              Keep
            </Button>
            <Button variant="tertiary" size="sm" prefix={<X aria-hidden="true" />} onClick={() => void reviewMemory(entry.id, "declined")}>
              Not true
            </Button>
          </span>
        </Row>
      ))}
    </Group>
  );
}

/* -------------------------------- about -------------------------------- */

type ProfileDraft = Pick<MemoryProfileView, "name" | "about" | "timezone">;

/**
 * The profile's unsaved draft, kept OUTSIDE the section: the settings page
 * remounts a section whenever the rail changes, and a half-written
 * introduction must survive a look at General. It is one draft, not one
 * per section, because only this fieldset commits with a Save.
 */
const useProfileDraft = create<{ draft: ProfileDraft | null; setDraft: (draft: ProfileDraft | null) => void }>((set) => ({
  draft: null,
  setDraft: (draft) => set({ draft }),
}));

/** Name, prose, and zone: one draft, one Save, three keyed memories. */
function useProfileEditor(profile: MemoryProfileView, entries: MemoryEntry[]) {
  const addMemory = useAppStore((state) => state.addMemory);
  const forgetMemory = useAppStore((state) => state.forgetMemory);
  const draft = useProfileDraft((state) => state.draft);
  const setDraft = useProfileDraft((state) => state.setDraft);
  const current = draft ?? { name: profile.name, about: profile.about, timezone: profile.timezone };
  const dirty =
    draft !== null &&
    (draft.name !== profile.name || draft.about !== profile.about || draft.timezone !== profile.timezone);
  const edit = (patch: Partial<ProfileDraft>) => setDraft({ ...current, ...patch });
  const revert = () => setDraft(null);

  const save = async () => {
    if (draft === null) return;
    const slots = [
      { key: PROFILE_KEY.name, label: "Name", next: draft.name.trim(), was: profile.name },
      { key: PROFILE_KEY.about, label: "About", next: draft.about.trim(), was: profile.about },
      { key: PROFILE_KEY.timezone, label: "Time zone", next: draft.timezone, was: profile.timezone },
    ];
    for (const slot of slots) {
      if (slot.next === slot.was) continue;
      const existing = entries.find((entry) => entry.key === slot.key);
      if (slot.next === "") {
        if (existing !== undefined) await forgetMemory(existing.id, CLEARED);
      } else {
        await addMemory({ key: slot.key, label: slot.label, content: slot.next, kind: "static", bucket: "profile" });
      }
    }
    setDraft(null);
  };

  return { current, dirty, edit, revert, save };
}

/**
 * The Save that is always in view. The fieldset's own footer can be off the
 * screen while the rail stays clickable, so a draft with nowhere visible to
 * go looks like it was never there. This bar sits last in the column and
 * sticks to the foot of the pane for as long as the draft differs from the
 * file — the foot, because the close button owns the top corner.
 */
function UnsavedBar({ profile, entries }: { profile: MemoryProfileView; entries: MemoryEntry[] }) {
  const { dirty, revert, save } = useProfileEditor(profile, entries);
  if (!dirty) return null;
  return (
    <div
      role="status"
      data-testid="memory-unsaved-bar"
      className="sticky bottom-2 z-10 flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-100/95 px-3 py-2 shadow-small backdrop-blur"
    >
      <span className="text-label-13 text-gray-1000">Unsaved changes to About you.</span>
      <span className="flex items-center gap-1.5">
        <Button variant="tertiary" size="sm" onClick={revert}>
          Revert
        </Button>
        <Button size="sm" onClick={() => void save()}>
          Save
        </Button>
      </span>
    </div>
  );
}

function AboutFieldset({ profile, entries }: { profile: MemoryProfileView; entries: MemoryEntry[] }) {
  const { current, dirty, edit, revert, save } = useProfileEditor(profile, entries);
  const timezones = TIMEZONES[useSurface().kind];

  return (
    <Fieldset>
      <FieldsetContent>
        <FieldsetTitle>About you</FieldsetTitle>
        <FieldsetSubtitle>
          Who the agent is working for. Keep it to what changes how a task should be done — a nickname it should use,
          what you do, how you like results.
        </FieldsetSubtitle>
        <div className="mt-4 flex flex-col gap-4">
          <Input
            label="Preferred name"
            placeholder="Alex"
            maxLength={MAX_MEMORY_LABEL}
            value={current.name}
            onChange={(event) => edit({ name: event.target.value })}
            containerClassName="max-w-72"
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="memory-about" className="text-label-13 text-gray-1000">
              About you
            </label>
            <Textarea
              id="memory-about"
              placeholder="Product designer in her thirties. Runs most mornings, cooks on weekends, and reads a lot of science fiction."
              maxLength={MAX_MEMORY_CONTENT}
              value={current.about}
              onChange={(event) => edit({ about: event.target.value })}
              className="min-h-24 text-copy-13"
            />
            <p className="text-label-12 text-gray-900">
              Age, occupation, hobbies, household — whatever you would tell a new assistant on day one.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="memory-timezone" className="text-label-13 text-gray-1000">
              Time zone
            </label>
            <Select
              id="memory-timezone"
              aria-label="Time zone"
              value={current.timezone}
              items={timezones}
              onValueChange={(timezone) => edit({ timezone })}
              className="max-w-72"
            />
            <p className="text-label-12 text-gray-900">
              What “tomorrow morning” means. Used for dates, hours, and anything a page shows in local time.
            </p>
          </div>
        </div>
      </FieldsetContent>
      <FieldsetFooter highlight={dirty}>
        <FieldsetFooterStatus>{dirty ? "Unsaved changes." : "Each field is a memory of its own, with its history."}</FieldsetFooterStatus>
        <FieldsetFooterActions>
          <Button variant="tertiary" size="sm" disabled={!dirty} onClick={revert}>
            Revert
          </Button>
          <Button size="sm" disabled={!dirty} onClick={() => void save()}>
            Save
          </Button>
        </FieldsetFooterActions>
      </FieldsetFooter>
    </Fieldset>
  );
}

/* -------------------------------- facts -------------------------------- */

/** The active fact in `facts` whose key `key` is, other than `except`. */
function holderOf(facts: readonly MemoryEntry[], key: string | null, except: string | null): MemoryEntry | null {
  if (key === null) return null;
  return facts.find((fact) => fact.id !== except && fact.key === key) ?? null;
}

/**
 * One labelled fact, editable in place. The draft lives in the row so
 * typing never writes the file; leaving the field (or Enter) commits, and
 * a row emptied of its label is forgotten rather than saved nameless.
 *
 * A place is keyed by its label (`location.home`), so renaming it moves
 * its key with it — otherwise "Home" renamed to "Office" would still be
 * `location.home`, and the next "Home" added would version Office away.
 * Renaming onto a label a sibling already has is refused in the row.
 */
function FactRow({
  fact,
  siblings,
  labelPlaceholder,
  detailPlaceholder,
}: {
  fact: MemoryEntry;
  /** The bucket's other active facts, for the rename clash check. */
  siblings: readonly MemoryEntry[];
  labelPlaceholder: string;
  detailPlaceholder: string;
}) {
  const updateMemory = useAppStore((state) => state.updateMemory);
  const forgetMemory = useAppStore((state) => state.forgetMemory);
  const [draft, setDraft] = useState<{ label: string; content: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const current = draft ?? { label: fact.label ?? "", content: fact.content };

  const commit = () => {
    if (draft === null) return;
    const next = { label: draft.label.trim(), content: draft.content.trim() };
    if (next.label === (fact.label ?? "") && next.content === fact.content) {
      setDraft(null);
      return;
    }
    if (next.label === "" || next.content === "") {
      setDraft(null);
      void forgetMemory(fact.id, CLEARED);
      return;
    }
    const key = rekeyedFor(fact, fact.bucket, next.label);
    const holder = holderOf(siblings, key, fact.id);
    if (holder !== null) {
      // Keep the draft so the label can be changed; the file is untouched.
      setProblem(`There is already one called “${holder.label ?? next.label}”. Edit that one, or choose another name.`);
      return;
    }
    setDraft(null);
    setProblem(null);
    void updateMemory(fact.id, { ...next, key });
  };

  const keys = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      {/* The row wraps rather than squeezing: in a narrow pane the name takes
          a line of its own and the detail keeps a readable width beside its
          controls, instead of shrinking to a sliver with the buttons cut off. */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={labelPlaceholder}
          placeholder={labelPlaceholder}
          maxLength={MAX_MEMORY_LABEL}
          value={current.label}
          onChange={(event) => {
            setProblem(null);
            setDraft({ ...current, label: event.target.value });
          }}
          onBlur={commit}
          onKeyDown={keys}
          className="w-40 shrink-0 @max-md:w-full"
        />
        <Input
          aria-label={detailPlaceholder}
          placeholder={detailPlaceholder}
          maxLength={MAX_MEMORY_CONTENT}
          value={current.content}
          onChange={(event) => setDraft({ ...current, content: event.target.value })}
          onBlur={commit}
          onKeyDown={keys}
          className="min-w-32 flex-1 basis-32"
        />
        {fact.source.kind === "user" ? null : (
          <Badge variant="blue-subtle" size="sm" title="Added by the agent">
            {fact.source.kind === "agent" ? "Agent" : "Learned"}
          </Badge>
        )}
        <Button
          variant="tertiary"
          size="sm"
          svgOnly
          aria-label={`Remove ${fact.label ?? fact.content}`}
          onClick={() => void forgetMemory(fact.id, CLEARED)}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      {problem === null ? null : (
        <Note role="alert" type="error" size="sm">
          {problem}
        </Note>
      )}
    </div>
  );
}

/**
 * A bucket of labelled facts: the rows already stored, then a row for the
 * next one. Nothing is stored until it has both a name and a detail — a
 * place called "Home" with nothing after it tells the agent nothing.
 */
function FactsFieldset({
  bucket,
  title,
  note,
  facts,
  labelPlaceholder,
  detailPlaceholder,
  emptyNote,
}: {
  bucket: Extract<MemoryBucket, "location" | "project">;
  title: string;
  note: string;
  facts: MemoryEntry[];
  labelPlaceholder: string;
  detailPlaceholder: string;
  emptyNote: string;
}) {
  const addMemory = useAppStore((state) => state.addMemory);
  const [label, setLabel] = useState("");
  const [detail, setDetail] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const canAdd = label.trim() !== "" && detail.trim() !== "";

  const add = async () => {
    if (!canAdd) return;
    const key = factKey(bucket, label.trim());
    // A keyed add versions whatever holds the key. That is right for a
    // profile slot and wrong here: a second "Home" would silently replace
    // the first, so the clash is named and the row above is the place to edit.
    const holder = holderOf(facts, key, null);
    if (holder !== null) {
      setProblem(`There is already one called “${holder.label ?? label.trim()}”. Edit it above, or choose another name.`);
      return;
    }
    setProblem(null);
    await addMemory({
      content: detail.trim(),
      label: label.trim(),
      key,
      kind: "static",
      bucket,
    });
    setLabel("");
    setDetail("");
  };

  return (
    <Group title={title} note={note} footer={`${String(facts.length)} ${facts.length === 1 ? "entry" : "entries"}.`}>
      <Block>
        {facts.length === 0 ? (
          <Note type="secondary" size="sm">
            {emptyNote}
          </Note>
        ) : (
          <div className="flex flex-col gap-2">
            {facts.map((fact) => (
              <FactRow
                key={fact.id}
                fact={fact}
                siblings={facts}
                labelPlaceholder={labelPlaceholder}
                detailPlaceholder={detailPlaceholder}
              />
            ))}
          </div>
        )}
      </Block>
      <Block>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`${title} name`}
              placeholder={labelPlaceholder}
              maxLength={MAX_MEMORY_LABEL}
              value={label}
              onChange={(event) => {
                setProblem(null);
                setLabel(event.target.value);
              }}
              className="w-40 shrink-0 @max-md:w-full"
            />
            <Input
              aria-label={`${title} detail`}
              placeholder={detailPlaceholder}
              maxLength={MAX_MEMORY_CONTENT}
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              className="min-w-32 flex-1 basis-32"
            />
            <Button type="submit" variant="secondary" size="sm" disabled={!canAdd} prefix={<Plus aria-hidden="true" />}>
              Add
            </Button>
          </div>
          {problem === null ? null : (
            <Note role="alert" type="error" size="sm">
              {problem}
            </Note>
          )}
        </form>
      </Block>
    </Group>
  );
}

/* ------------------------------- preview ------------------------------- */

function PreviewFieldset({ entries, now, enabled }: { entries: MemoryEntry[]; now: Date; enabled: boolean }) {
  const [show, setShow] = useState(false);
  const preview = useMemo(() => memoryPrompt(entries, { now }), [entries, now]);
  const zone = effectiveTimezone(profileView(entries, now));
  return (
    <Group
      title="What the agent sees"
      note="The block added to the system prompt at the start of a run: your profile, lasting facts, current context. Facts recalled for a specific task are added on top."
      footer={enabled ? `Time zone in use: ${zone}.` : "Memory is off, so none of this is sent right now."}
      footerAction={
        <Button variant="secondary" size="sm" disabled={preview === ""} onClick={() => setShow(!show)}>
          {show ? "Hide" : "Show"}
        </Button>
      }
    >
      <Block>
        {preview === "" ? (
          <Note type="secondary" size="sm">
            There is nothing to send yet. Add anything above and it appears here, word for word.
          </Note>
        ) : show ? (
          <pre
            data-testid="memory-prompt-preview"
            className="scroll-thin max-h-96 overflow-auto rounded-sm bg-background-200 p-3 font-mono text-[11.5px] leading-5 whitespace-pre-wrap text-gray-900 shadow-border"
          >
            {preview}
          </pre>
        ) : (
          <Note type="secondary" size="sm">
            Sent as background about you, labelled as context rather than as instructions. Facts waiting for review are
            left out of your profile, and marked unconfirmed if a task recalls them.
          </Note>
        )}
      </Block>
    </Group>
  );
}

/* --------------------------------- page -------------------------------- */

export function MemoryPage() {
  const settings = useAppStore((state) => state.settings.memory);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const entries = useAppStore((state) => state.memory.entries);
  const forgetAllMemory = useAppStore((state) => state.forgetAllMemory);
  const copy = copyFor(useSurface().kind).memory;
  // One clock per change of the list, so every derived view agrees on "now".
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [entries]);
  const active = useMemo(() => activeMemories(entries, now), [entries, now]);
  const profile = useMemo(() => profileView(entries, now), [entries, now]);
  const pending = active.filter((entry) => entry.review === "pending");

  return (
    <Page
      title="Memory"
      description="Everything the agent knows about you, in one place. You can write it here, the agent can add to it as you work, and every change keeps its history."
    >
      <Group
        title="Use memory"
        note={copy.useMemory}
        footer={
          settings.enabled
            ? active.length === 0
              ? "Nothing remembered yet."
              : `${String(active.length)} ${active.length === 1 ? "fact" : "facts"} in use.`
            : "Memory is off. Runs start with no context about you, and the agent cannot add to it."
        }
      >
        <Row
          label="Include memory in every run"
          note="Your profile and the facts that bear on the task go into the agent's prompt, and it can remember and forget things as it works. Off leaves everything stored but unused."
        >
          <Switch
            checked={settings.enabled}
            label="Include memory in every run"
            onChange={(enabled) => void updateSettings({ memory: { enabled } })}
          />
        </Row>
        <Row
          label="Learn from conversations"
          note="When a task finishes, read the conversation for facts about you worth keeping. Anything it is unsure of waits here for your review."
        >
          <Switch
            checked={settings.enabled && settings.learnFromRuns}
            disabled={!settings.enabled}
            label="Learn from conversations"
            onChange={(learnFromRuns) => void updateSettings({ memory: { learnFromRuns } })}
          />
        </Row>
      </Group>

      {pending.length === 0 ? null : <ReviewFieldset pending={pending} />}

      <AboutFieldset profile={profile} entries={active} />

      <FactsFieldset
        bucket="location"
        title="Locations"
        note="Where you are and where things happen. The agent uses these for maps, stores, delivery, and anything local."
        facts={profile.locations}
        labelPlaceholder="Home"
        detailPlaceholder="Denver, Colorado"
        emptyNote="No locations yet. Add one and the agent stops asking which city you mean."
      />

      <FactsFieldset
        bucket="project"
        title="Projects"
        note="Ongoing work a request is likely to be about, so a bare “the migration” lands somewhere."
        facts={profile.projects}
        labelPlaceholder="Northstar"
        detailPlaceholder="Invoice reconciliation pilot, launching in March"
        emptyNote="No projects yet. Name the ones you refer to by shorthand."
      />

      <MemoryList entries={entries} now={now} />

      <PreviewFieldset entries={entries} now={now} enabled={settings.enabled} />

      <Group
        title="Forget everything"
        note={copy.forgetEverything}
        footer="Each fact would need restoring one by one."
        footerAction={
          <Button
            variant="error"
            size="sm"
            disabled={active.length === 0}
            onClick={() => {
              if (window.confirm("Forget every fact the agent knows about you?")) void forgetAllMemory();
            }}
          >
            Forget everything
          </Button>
        }
      >
        {null}
      </Group>

      <UnsavedBar profile={profile} entries={active} />
    </Page>
  );
}
