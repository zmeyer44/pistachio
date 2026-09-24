/**
 * Settings → Tabs: the switches around Tidy (docs/tab-tidy.md) — when idle
 * tabs are archived, whether related ones are grouped, whether favorites go
 * home. What was archived lives on its own page, which this one points at.
 */

import { useEffect } from "react";
import { Archive, Sparkles } from "lucide-react";
import { shellApi } from "../../../api";
import { useAppStore } from "../../../store";
import { Button } from "../../ui/button";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Fixed, Group, Page, Row, probeRefusal, useUnavailable } from "../parts";

const DESCRIPTION =
  "Tabs pile up. Tidy archives the ones you have not looked at in a while, gathers the ones that belong together into groups, and sends your favorites back to their home pages. Nothing is lost: archived tabs can be restored, and every tidy can be undone.";

const ARCHIVE_AFTER = [
  { value: 12, label: "12 hours" },
  { value: 24, label: "24 hours" },
  { value: 168, label: "7 days" },
  { value: 720, label: "30 days" },
  { value: 0, label: "Never" },
] as const;

const KEEP_FOR = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
] as const;

export function TabsSettingsPage() {
  const tabs = useAppStore((state) => state.settings.tabs);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const setOverlay = useAppStore((state) => state.setOverlay);
  const tidyTabs = useAppStore((state) => state.tidyTabs);
  const tidyRunning = useAppStore((state) => state.tidyRunning);
  const unavailable = useUnavailable("tidy");

  // The page has nothing else to ask Tidy for, so it asks only to learn
  // whether this host keeps tabs tidy at all (a cloud session does not yet).
  useEffect(() => {
    void probeRefusal("tidy", () => shellApi().tidy({ type: "status" }));
  }, []);

  if (unavailable !== null) {
    return (
      <Page title="Tabs" description={DESCRIPTION}>
        <Group>
          <Row label="Not available here" note={unavailable} />
        </Group>
      </Page>
    );
  }

  return (
    <Page title="Tabs" description={DESCRIPTION}>
      <Group
        title="Tidy"
        note="Runs on its own when tabs have gone idle, and whenever you ask. Tabs you can see, tabs playing sound, pinned tabs, favorites, split views, and groups you made yourself are never archived."
        footer="Pin a tab, or put it in a group of your own, to keep it."
        footerAction={
          <Button variant="secondary" size="sm" prefix={<Sparkles aria-hidden="true" />} disabled={tidyRunning} onClick={() => void tidyTabs()} data-testid="settings-tidy-now">
            {tidyRunning ? "Tidying…" : "Tidy now"}
          </Button>
        }
      >
        <Row label="Archive idle tabs after" note="How long a tab may go unlooked-at before it is archived. Looking at a tab starts its clock again. Never turns the automatic tidy off.">
          <Select
            aria-label="Archive idle tabs after"
            value={tabs.archiveAfterHours}
            items={ARCHIVE_AFTER}
            onValueChange={(archiveAfterHours) => void updateSettings({ tabs: { archiveAfterHours } })}
            className="w-36"
          />
        </Row>
        <Row
          label="Group related tabs"
          note="Asks the model which tabs belong to the same task, and names the group — a group you make yourself is named from its tabs too, unless you type a name first. It is sent the tabs' titles and addresses — without query strings — and nothing else. Off, tabs are archived by the clock alone, a new group starts as “New group”, and nothing leaves this device."
        >
          <Switch checked={tabs.groupRelated} onChange={(groupRelated) => void updateSettings({ tabs: { groupRelated } })} label="Group related tabs with the model" />
        </Row>
        <Row
          label="Return favorites to their home page"
          note="A favorite that wandered — X on a single post, mail on one message — goes back to the address you saved. Back still returns to where it was."
        >
          <Switch checked={tabs.resetFavorites} onChange={(resetFavorites) => void updateSettings({ tabs: { resetFavorites } })} label="Return favorites to their home page" />
        </Row>
      </Group>
      <Group
        title="Archive"
        footerAction={
          <Button variant="secondary" size="sm" prefix={<Archive aria-hidden="true" />} onClick={() => setOverlay("archive")}>
            Open archive
          </Button>
        }
      >
        <Row label="Keep archived tabs for" note="After this an archived tab is forgotten. Its page in your history is not.">
          <Select
            aria-label="Keep archived tabs for"
            value={tabs.archiveRetentionDays}
            items={KEEP_FOR}
            onValueChange={(archiveRetentionDays) => void updateSettings({ tabs: { archiveRetentionDays } })}
            className="w-36"
          />
        </Row>
        <Fixed label="What an archived tab keeps" note="Its address, title and icon, its back and forward history, and where you had scrolled to — so restoring one puts you back where you were." />
        <Fixed label="Closed groups" note="Closing a tab group files the whole group here, to be restored together or one tab at a time." />
      </Group>
    </Page>
  );
}
