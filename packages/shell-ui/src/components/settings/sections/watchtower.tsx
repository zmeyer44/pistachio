/**
 * Settings → Watchtower: how saving behaves. What was saved lives on its own
 * page (pistachio://watchtower), which this one points at.
 *
 * These settings are not in the settings file: the archive keeps them beside
 * the data they govern, in its own process, so a switch here and the thing
 * it switches can never disagree. `useWatchtower` is that conversation.
 */

import { useEffect, useState } from "react";
import { Bookmark, FileClock, FolderDown } from "lucide-react";
import { WATCHTOWER_COPY } from "../../../lib/surface-copy";
import { useAppStore } from "../../../store";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Kbd } from "../../ui/kbd";
import { Note } from "../../ui/note";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import { ForgetDialog, forgetRequest, type ForgetScope } from "../../watchtower/ForgetDialog";
import { formatBytes } from "../../watchtower/format";
import { useWatchtower } from "../../watchtower/use-watchtower";
import { Block, Fixed, Group, Page, Row, useUnavailable } from "../parts";

const RETENTION = [
  { value: 0, label: "Until I forget it" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "1 year" },
] as const;

const DESCRIPTION =
  "Watchtower saves the readable text of pages you view, so you can search by what you remember and open the version you saw. It keeps text only — no page code, images or form input — and never saves the same paragraph twice.";

export function WatchtowerSettingsPage() {
  const unavailable = useUnavailable("watchtower");
  if (unavailable !== null)
    return (
      <Page title="Watchtower" description={DESCRIPTION}>
        <Group>
          <Row label="Not available here" note={unavailable} />
        </Group>
      </Page>
    );
  return <Available />;
}

function Available() {
  const status = useWatchtower();
  const { settings, stats } = status;
  const setOverlay = useAppStore((state) => state.setOverlay);
  const space = useAppStore((state) => state.snapshot?.spaces.find((candidate) => candidate.id === state.snapshot?.activeSpaceId) ?? null);
  const [forgetting, setForgetting] = useState<ForgetScope | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  if (settings === null || stats === null)
    return (
      <Page title="Watchtower" description={DESCRIPTION}>
        {status.error === null ? null : (
          <Note type="error" size="sm">
            {status.error}
          </Note>
        )}
      </Page>
    );

  const spaceId = space?.id ?? "";
  const spaceName = space?.name ?? "this Profile";
  const spaceExcluded = settings.excludedSpaces.includes(spaceId);
  return (
    <Page title="Watchtower" description={DESCRIPTION}>
      {status.error === null || forgetting !== null ? null : (
        <Note type="error" size="sm">
          {status.error}
        </Note>
      )}

      <Group
        title="Saving"
        note="A page is saved once you have looked at it for a moment. Pages in the background, pages with a password field, and pages the agent opens are never saved."
        footer={`${stats.visits.toLocaleString()} ${stats.visits === 1 ? "visit" : "visits"} · ${stats.snapshots.toLocaleString()} saved ${stats.snapshots === 1 ? "version" : "versions"} in ${spaceName}.`}
        footerAction={
          <Button variant="secondary" size="sm" prefix={<FileClock aria-hidden="true" />} onClick={() => setOverlay("watchtower")}>
            Open Watchtower
          </Button>
        }
      >
        <Row label="Save what I read" note="Off stops saving. What is already saved stays readable and searchable until you forget it.">
          <Switch checked={settings.enabled} disabled={status.busy} onChange={(enabled) => void status.configure({ enabled })} label="Save what I read" />
        </Row>
        <Row label="Pause" note="A temporary stop, also on the Watchtower page. The toolbar button shows when saving is paused.">
          <Switch checked={settings.paused} disabled={status.busy || !settings.enabled} onChange={(paused) => void status.configure({ paused })} label="Pause Watchtower" />
        </Row>
        <Row label={`Save in ${spaceName}`} note="Each Profile has its own archive. Off leaves this Profile out entirely.">
          <Switch
            checked={!spaceExcluded}
            disabled={status.busy || spaceId === ""}
            onChange={(included) =>
              void status.configure({
                excludedSpaces: included ? settings.excludedSpaces.filter((id) => id !== spaceId) : [...settings.excludedSpaces, spaceId],
              })
            }
            label={`Save in ${spaceName}`}
          />
        </Row>
      </Group>

      <SavingOnPurpose />

      <Group title="What is sent to a model" note="Searching and saving happen on your computer. These four are the exceptions, each off unless you choose it.">
        <Row
          label="Leave out ads, sidebars and menus with Jev"
          note={`The first time a site’s layout is seen, short excerpts of the page’s regions go to the Jev decision model through your Pistachio account, ${WATCHTOWER_COPY.filterMemory}. Excluded sites are never sent. ${WATCHTOWER_COPY.filterOff}`}
        >
          <Switch checked={settings.smartFilter} disabled={status.busy} onChange={(smartFilter) => void status.configure({ smartFilter })} label="Filter ads and page furniture with Jev" />
        </Row>
        <Row
          label="Index people, companies and ideas with Jev"
          note={`Files saved pages under what they are about, so “Stripe” read on three sites is one entry with three sources. Names found on a page and the sentence around each go to the Jev decision model through your Pistachio account, with the names already in your index they might match. Excluded sites are never sent. ${WATCHTOWER_COPY.indexOff}`}
        >
          <Switch checked={settings.smartIndex} disabled={status.busy} onChange={(smartIndex) => void status.configure({ smartIndex })} label="Index people, companies and ideas with Jev" />
        </Row>
        <Row label="Let the agent search what you saved" note="Only when you ask it to, and only in the Profile the run belongs to. Text it retrieves is sent to your agent’s model and stays in that conversation.">
          <Switch checked={settings.agentAccess} disabled={status.busy} onChange={(agentAccess) => void status.configure({ agentAccess })} label="Let the agent search saved pages" />
        </Row>
        <Row label="Offer Improve matches" note="Adds a button beside a search. Pressing it sends your words and up to 20 saved titles and excerpts to the Jev decision model to reorder the results.">
          <Switch checked={settings.remoteRerank} disabled={status.busy} onChange={(remoteRerank) => void status.configure({ remoteRerank })} label="Offer enhanced search with Jev" />
        </Row>
      </Group>

      <ExcludedSites hosts={settings.excludedHosts} busy={status.busy} onSave={(excludedHosts) => status.configure({ excludedHosts })} />

      <Group
        title="Storage"
        note="Saving pauses at the limit; nothing already saved is removed to make room."
        footer={`${formatBytes(stats.databaseBytes)} of ${formatBytes(stats.budgetBytes)} used ${WATCHTOWER_COPY.storage}, across all Profiles.`}
        type={stats.nearFull ? "warning" : undefined}
      >
        <StorageLimit megabytes={settings.maxSizeMb} busy={status.busy} onSave={(maxSizeMb) => status.configure({ maxSizeMb })} />
        <Row label="Keep saved text for" note="After this, a visit keeps its title, address and date, and its saved text is removed. Text a newer visit still uses is kept.">
          <Select aria-label="Retention" value={settings.retentionDays} items={RETENTION} onValueChange={(retentionDays) => void status.configure({ retentionDays })} disabled={status.busy} className="w-44" />
        </Row>
        <Fixed label="Encryption" note="The archive is an ordinary file in your data folder. It is protected by your computer’s account and disk encryption, not by the app." badge="Not encrypted" tone="gray" />
      </Group>

      <Group title="Export" note="A folder of Markdown: one file per saved version, an index, links between saved pages, and every visit’s date.">
        <Row label="Export this Profile as Markdown" note={exported === null ? "Exports are separate copies: forgetting later does not reach them." : `Exported to ${exported}`}>
          <Button
            variant="secondary"
            size="sm"
            prefix={<FolderDown aria-hidden="true" />}
            loading={status.busy && forgetting === null}
            onClick={() => void status.exportMarkdown().then((path) => setExported(path))}
          >
            Export Markdown
          </Button>
        </Row>
      </Group>

      <Group title="Forget" note="Removes saved visits and the text only they used. To forget one page or one site, open it in Watchtower." type="error">
        <Row label="The last hour">
          <Button variant="secondary" size="sm" onClick={() => setForgetting({ kind: "since", since: Date.now() - 3600000, label: "the last hour" })}>
            Forget…
          </Button>
        </Row>
        <Row label="The last 24 hours">
          <Button variant="secondary" size="sm" onClick={() => setForgetting({ kind: "since", since: Date.now() - 86400000, label: "the last 24 hours" })}>
            Forget…
          </Button>
        </Row>
        <Row label={`Everything in ${spaceName}`}>
          <Button variant="secondary" size="sm" onClick={() => setForgetting({ kind: "space", space: spaceName })}>
            Forget…
          </Button>
        </Row>
        <Row label="The whole archive" note="Every Profile.">
          <Button variant="error" size="sm" onClick={() => setForgetting({ kind: "everything" })} data-testid="watchtower-forget-everything">
            Forget everything…
          </Button>
        </Row>
      </Group>

      {forgetting === null ? null : (
        <ForgetDialog
          scope={forgetting}
          busy={status.busy}
          error={status.error}
          onClose={() => {
            status.clearError();
            setForgetting(null);
          }}
          onConfirm={() => {
            void status.forget(forgetRequest(forgetting)).then((done) => {
              if (done) setForgetting(null);
            });
          }}
        />
      )}
    </Page>
  );
}

/**
 * Shift, shift: a page saved on purpose. The saved record syncs to the
 * person's other devices; Watchtower keeps the page's text here and files
 * it under what it is about. These switches are the app's settings (they
 * sync), not the archive's.
 */
function SavingOnPurpose() {
  const bookmarks = useAppStore((state) => state.settings.bookmarks);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const openBookmarks = useAppStore((state) => state.openBookmarks);
  const saved = useAppStore((state) => state.bookmarks.bookmarks.length);
  return (
    <Group
      title="Saving on purpose"
      note={`Tap shift twice on any page to save it. The save syncs to your other devices; Watchtower keeps the page’s text ${WATCHTOWER_COPY.storage}, whether or not it saves what you read, and files it under the people, companies and products it is about.`}
      footer={`${saved.toLocaleString()} ${saved === 1 ? "page" : "pages"} saved.`}
      footerAction={
        <Button variant="secondary" size="sm" prefix={<Bookmark aria-hidden="true" />} onClick={() => openBookmarks()}>
          Open saved pages
        </Button>
      }
    >
      <Row
        label={
          <span className="inline-flex items-center gap-1.5">
            Save with <Kbd>⇧</Kbd> <Kbd>⇧</Kbd>
          </span>
        }
        note="A double tap of shift, with nothing else held. Off leaves the Save button in Watchtower, the command palette and the agent as the ways to save."
      >
        <Switch checked={bookmarks.doubleShift} onChange={(doubleShift) => void updateSettings({ bookmarks: { doubleShift } })} label="Save with a double tap of shift" />
      </Row>
      <Row
        label="Read saved pages with the model"
        note="The page’s text goes to your agent’s model, which names the thing it is about for the saved card and every person, company, product, place and idea it covers for the index — each fact a sentence copied from the page. Off, a save keeps what the page declares about itself."
      >
        <Switch checked={bookmarks.enrichWithModel} onChange={(enrichWithModel) => void updateSettings({ bookmarks: { enrichWithModel } })} label="Read saved pages with the model" />
      </Row>
    </Group>
  );
}

/**
 * A draft, kept here: status is re-read every few seconds, and a list being
 * typed must not be replaced by the saved one underneath the cursor.
 */
function ExcludedSites({ hosts, busy, onSave }: { hosts: string[]; busy: boolean; onSave(hosts: string[]): Promise<boolean> }) {
  const saved = hosts.join("\n");
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const parsed = [...new Set(value.split(/[\s,]+/u).map((host) => host.trim().toLowerCase()).filter(Boolean))];
  const dirty = draft !== null && parsed.join("\n") !== saved;
  return (
    <Group
      title="Excluded sites"
      note="Never saved, and never sent to Jev. A domain covers its subdomains. Excluding a site does not remove what was already saved from it."
      footer={dirty ? "Unsaved changes." : `${String(hosts.length)} ${hosts.length === 1 ? "site" : "sites"} excluded.`}
      footerAction={
        <Button
          size="sm"
          disabled={!dirty || busy}
          onClick={() =>
            void onSave(parsed).then((done) => {
              if (done) setDraft(null);
            })
          }
        >
          Save
        </Button>
      }
    >
      <Block>
        <Textarea
          aria-label="Excluded sites"
          data-testid="watchtower-excluded"
          rows={Math.min(10, Math.max(4, value.split("\n").length + 1))}
          placeholder={"mail.example.com\nbank.example.com"}
          spellCheck={false}
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          className="font-mono text-[13px]"
        />
      </Block>
    </Group>
  );
}

function StorageLimit({ megabytes, busy, onSave }: { megabytes: number; busy: boolean; onSave(megabytes: number): Promise<boolean> }) {
  const [draft, setDraft] = useState(String(megabytes));
  useEffect(() => setDraft(String(megabytes)), [megabytes]);
  const value = Number(draft);
  const valid = Number.isInteger(value) && value >= 16 && value <= 102400;
  return (
    <Row label="Storage limit" note="In megabytes, 16 to 102,400. The default is 2,048.">
      <span className="flex items-start gap-2">
        <Input
          size="sm"
          aria-label="Storage limit in megabytes"
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.target.value.replace(/[^\d]/gu, ""))}
          error={valid ? null : "16 – 102400"}
          suffix="MB"
          className="w-28"
        />
        <Button size="sm" variant="secondary" disabled={!valid || value === megabytes || busy} onClick={() => void onSave(value)}>
          Save
        </Button>
      </span>
    </Row>
  );
}
