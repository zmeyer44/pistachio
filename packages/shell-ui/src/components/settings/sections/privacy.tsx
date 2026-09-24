/**
 * The Settings → Privacy & security menu: site data, spaces, and agent
 * isolation.
 *
 * Each Space has a human partition that persists like a browser profile.
 * The agent partition is created per
 * run, never persisted, and cleared the moment authority ends — which is a
 * rule of the trust design, so the isolation page states it rather than
 * offering it.
 */

import { useState } from "react";
import { useAppStore } from "../../../store";
import { Button } from "../../ui/button";
import { Note } from "../../ui/note";
import { Switch } from "../../ui/switch";
import { Block, Fixed, Group, Page, Row } from "../parts";
import { shellApi } from "../../../api";
import { copyFor } from "../../../lib/surface-copy";
import { useSurface } from "../../../surface";

export function SiteDataPage() {
  const privacy = useAppStore((s) => s.settings.privacy);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const recentsCount = useAppStore((s) => s.recents.length);
  const clearRecents = useAppStore((s) => s.clearRecents);
  const [clearing, setClearing] = useState<"idle" | "busy" | "done">("idle");
  const copy = copyFor(useSurface().kind).privacy;

  const clearSiteData = async () => {
    if (!window.confirm("Sign out of every site and clear cookies, storage, and cache for the active Space?")) return;
    setClearing("busy");
    try {
      await shellApi().clearBrowsingData();
      setClearing("done");
    } catch {
      setClearing("idle");
    }
  };

  return (
    <Page title="Site data" description={copy.siteData}>
      <Group
        title="Recent sites"
        note={copy.recents}
        footer={
          recentsCount === 0
            ? "Nothing remembered."
            : recentsCount === 1
              ? "1 site remembered."
              : `${String(recentsCount)} sites remembered.`
        }
        footerAction={
          <Button variant="secondary" size="sm" disabled={recentsCount === 0} onClick={clearRecents}>
            Clear recents
          </Button>
        }
      >
        <Row label="Remember recent sites" note="Turning this off clears what is already remembered.">
          <Switch
            checked={privacy.rememberRecents}
            label="Remember recent sites"
            onChange={(rememberRecents) => {
              void updateSettings({ privacy: { rememberRecents } });
              if (!rememberRecents) clearRecents();
            }}
          />
        </Row>
      </Group>

      <Group
        title="Sign-ins for the active Space"
        note="Cookies, local storage, and cache for this Space. Other Spaces and agent partitions are not involved."
        footer={
          clearing === "done"
            ? "Cleared. Open tabs may need a reload to notice."
            : "You will be signed out of every site in this Space. This cannot be undone."
        }
        footerHighlight={clearing === "done"}
        footerAction={
          <Button variant="secondary" size="sm" loading={clearing === "busy"} onClick={() => void clearSiteData()}>
            Clear site data…
          </Button>
        }
      >
        {clearing === "done" ? (
          <Block>
            <Note type="success" size="sm">
              Cookies, storage, and cache for this Space were cleared. Your Spaces, favorites, and settings were not
              touched.
            </Note>
          </Block>
        ) : null}
      </Group>
    </Page>
  );
}

export function SpacesPage() {
  const spaces = useAppStore((s) => s.snapshot?.spaces ?? []);
  const activeSpaceId = useAppStore((s) => s.snapshot?.activeSpaceId ?? null);
  const tabs = useAppStore((s) => s.snapshot?.tabs ?? []);
  const switchSpace = useAppStore((s) => s.switchSpace);
  const openSpaceFork = useAppStore((s) => s.openSpaceFork);
  const copy = copyFor(useSurface().kind).privacy;

  return (
    <Page
      title="Spaces"
      description="Spaces are durable, isolated contexts inside your Organization. Fork one to branch a related task without changing its parent."
    >
      <Group title="Your Spaces" note="Each Space keeps its own cookie jar. Switching one never signs you out of another.">
        {spaces.map((space) => {
          const count = space.id === activeSpaceId ? tabs.filter((tab) => tab.kind === "human").length : null;
          const parent = space.parentSpaceId === null ? null : spaces.find((candidate) => candidate.id === space.parentSpaceId) ?? null;
          return (
            <Row
              key={space.id}
              label={space.name}
              note={`${parent === null ? "Root Space" : `Forked from ${parent.name}`}${space.purpose === "" ? "" : ` · ${space.purpose}`}${count === null ? "" : ` · ${count === 1 ? "1 tab" : `${String(count)} tabs`}`} `}
            >
              <span className="flex items-center gap-2 text-label-12 text-gray-900">
                <span className="size-2.5 rounded-full" style={{ background: space.color }} aria-hidden="true" />
                {space.id === activeSpaceId ? (
                  <Button variant="secondary" size="sm" onClick={openSpaceFork}>
                    Fork…
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => void switchSpace(space.id)}>
                    Switch
                  </Button>
                )}
              </span>
            </Row>
          );
        })}
      </Group>
      <Group title={copy.betweenDevicesTitle} note={copy.betweenDevices}>
        <Fixed
          label="Sessions travel only under your own keys"
          note={copy.sessions}
          badge="End-to-end encrypted"
        />
        <Fixed
          label={copy.preferencesLabel}
          note={copy.preferences}
        />
      </Group>
    </Page>
  );
}

export function IsolationPage() {
  const copy = copyFor(useSurface().kind).privacy;
  return (
    <Page
      title="Agent isolation"
      description="The agent works in the same tabs and signed-in sessions you do — that is what lets it act on your accounts. What is bounded is its authority: when it may act, and when that ends."
    >
      <Group
        title="In your live tabs"
        note={copy.liveTabs}
      >
        <Fixed
          label="It uses your sessions, and leaves them as it found them"
          note="Tool calls act on your existing tabs and sign-ins. There is no separate partition: cookies, logins, and anything a page saved persist afterwards exactly as if you had done it yourself. Clear a site's state in Site data, not by ending a run."
          badge="Live tabs"
          tone="gray"
        />
        <Fixed
          label="Its authority ends with the run"
          note="Completion, rejection of an approval, revocation, interruption, or failure stops further actions at once; the agent cannot touch a tab again until you hand it another task. What it already did on a site is not undone — approvals exist so that the consequential steps wait for you."
          badge="Enforced"
        />
        <Fixed
          label="Approval gates the consequential"
          note="A request that would change something outside the browser waits for your yes, and a rejected one is cancelled rather than retried. Approvals & notifications says what counts."
        />
        <Fixed label="Only http, https, and pistachio: load" note="A tab refuses any other scheme, whoever is driving it." />
      </Group>
      <Group
        title="In the cloud browser"
        note="A run you hand to the cloud browser (Settings → Cloud browser) works on a machine of its own, and these apply there instead."
      >
        <Fixed
          label="It holds only the Spaces you enable"
          note="The cloud browser is a device of your account: it signs in from sealed copies of an enabled Space's sessions, unwrapped under a key issued to it alone. A Space you leave off stays unreadable to it, and the device can be revoked in Settings → Devices."
          badge="Cloud runs"
          tone="gray"
        />
        <Fixed
          label="Its network identity is per run"
          note={copy.cloudEgress}
          badge="Cloud runs"
          tone="gray"
        />
      </Group>
    </Page>
  );
}
