/**
 * Settings → About: what is installed, where its data lives, and the one
 * destructive action — resetting every setting on this page to its default.
 *
 * Updates are checked on a schedule (@pistachio/shell-contracts/updates) and applied only on
 * request: this page is where the full state shows and where a person can
 * check, download, or restart by hand. A dev run says so instead of
 * pretending to check.
 */

import { useEffect, useState } from "react";
import type { AppInfo } from "@pistachio/shell-contracts/ipc";
import { aboutRowsFor } from "../../../lib/about-rows";
import { copyFor } from "../../../lib/surface-copy";
import { useAppStore } from "../../../store";
import { useSurface } from "../../../surface";
import { Button } from "../../ui/button";
import { Note } from "../../ui/note";
import { Block, Group, Page, Row } from "../parts";
import { UpdatesGroup } from "./updates";
import { shellApi } from "../../../api";

function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let live = true;
    shellApi()
      .getAppInfo()
      .then((next) => {
        if (live) setInfo(next);
      })
      .catch(() => {
        // The row shows "…" and the rest of the page still works.
      });
    return () => {
      live = false;
    };
  }, []);
  return info;
}

export function AboutPage() {
  const info = useAppInfo();
  const resetSettings = useAppStore((s) => s.resetSettings);
  const openOnboarding = useAppStore((s) => s.openOnboarding);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const surface = useSurface().kind;
  const copy = copyFor(surface).about;
  // Which rows this shell can honestly show, and what they say
  // (lib/about-rows.ts). The page renders the list rather than deciding.
  const rows = aboutRowsFor(info, surface);

  return (
    <Page
      title="About"
      description="Pistachio is an open-source, agent-native browser for handing authenticated work to an agent without handing over a human identity."
    >
      <Group title="This app" note={copy.thisApp}>
        {/* Facts, not settings: one line each, label beside value, rather than
            a full-height Row apiece. */}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 px-5 py-3.5 @max-md:px-4">
          {rows.map((row) => (
            <div key={row.key} className="contents">
              <dt className="text-label-13 leading-4.5 text-gray-900">{row.label}</dt>
              <dd className="text-copy-13 leading-4.5 text-gray-1000">
                {row.mono ? <code className="font-mono text-[11.5px] break-all">{row.note}</code> : row.note}
              </dd>
            </div>
          ))}
        </dl>
      </Group>

      <UpdatesGroup />

      <Group
        title="Welcome tour"
        note="The setup that ran the first time Pistachio opened: introduce yourself, bring a browser over, pick favorites, choose a look."
        footer="Running it again adds to what is here — nothing is removed."
        footerAction={
          <Button
            variant="secondary"
            size="sm"
            data-testid="replay-onboarding"
            onClick={() => {
              closeSettings();
              openOnboarding();
            }}
          >
            Run setup again
          </Button>
        }
      >
        <Row label="Welcome pages" note={<>The lessons it opens are always at <code className="font-mono text-[11.5px]">pistachio://welcome</code>.</>} />
      </Group>

      <Group
        title="Reset"
        note="Return every section of Settings to its default. Runs, evidence, and site data are untouched."
        footer="This cannot be undone."
        footerHighlight
        footerAction={
          <Button
            variant="error"
            size="sm"
            onClick={() => {
              if (window.confirm("Restore every setting to its default?")) void resetSettings();
            }}
          >
            Restore defaults
          </Button>
        }
      >
        <Block>
          <Note type="warning" size="sm" label="Heads up">
            Layout, appearance, shortcuts, and approvals all return to how they shipped.
          </Note>
        </Block>
      </Group>
    </Page>
  );
}
