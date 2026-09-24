/**
 * Settings → About → Updates: the whole update state, and the controls the
 * chrome pill abbreviates. Every transition here is the person's: check,
 * download, restart.
 */

import { useAppStore } from "../../../store";
import { Button } from "../../ui/button";
import { Note } from "../../ui/note";
import { Block, Group, Row } from "../parts";

function when(iso: string | null): string {
  if (iso === null) return "not yet";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function UpdatesGroup() {
  const update = useAppStore((s) => s.update);
  const check = useAppStore((s) => s.checkForUpdates);
  const download = useAppStore((s) => s.downloadUpdate);
  const install = useAppStore((s) => s.installUpdate);

  if (update.status === "unsupported") {
    return (
      <Group title="Updates" note="New releases are checked for every few hours and applied only when you choose.">
        <Row label="This run" note={update.reason} />
      </Group>
    );
  }

  const checking = update.status === "checking";
  const status = (() => {
    switch (update.status) {
      case "idle":
        return { label: "Not checked yet", note: `Last check: ${when(update.checkedAt)}.` };
      case "checking":
        return { label: "Checking…", note: "Asking the release feed for a newer version." };
      case "up-to-date":
        return { label: "Up to date", note: `Last check: ${when(update.checkedAt)}.` };
      case "available":
        return {
          label: `Version ${update.version} is available`,
          note: update.releaseDate === null ? "Download it in the background; nothing changes until you restart." : `Released ${when(update.releaseDate)}. Download it in the background; nothing changes until you restart.`,
        };
      case "downloading":
        return { label: `Downloading ${update.version}`, note: `${update.percent}% — you can keep browsing.` };
      case "ready":
        return { label: `Version ${update.version} is ready`, note: "Restart to finish. Tabs and Spaces come back as they are." };
      case "error":
        return { label: "Could not check", note: `Last successful check: ${when(update.checkedAt)}.` };
    }
  })();

  const action = (() => {
    switch (update.status) {
      case "available":
        return (
          <Button size="sm" data-testid="update-download" onClick={() => void download()}>
            Download
          </Button>
        );
      case "downloading":
        return (
          <Button size="sm" disabled>
            Downloading…
          </Button>
        );
      case "ready":
        return (
          <Button size="sm" data-testid="update-install" onClick={install}>
            Restart to update
          </Button>
        );
      default:
        return (
          <Button variant="secondary" size="sm" disabled={checking} data-testid="update-check" onClick={() => void check()}>
            {checking ? "Checking…" : "Check now"}
          </Button>
        );
    }
  })();

  return (
    <Group
      title="Updates"
      note="New releases are checked for every few hours and applied only when you choose."
      footer="A downloaded update also installs the next time Pistachio quits."
      footerAction={action}
    >
      {/* One stable live region: checking, progress, completion, and failure
          are announced even as the footer control is disabled or replaced. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="divide-y divide-alpha-400">
        <Row label={status.label} note={status.note} />
        {update.status === "error" ? (
          <Block>
            <Note type="warning" size="sm" label="Update check failed">
              {update.message}
            </Note>
          </Block>
        ) : null}
      </div>
    </Group>
  );
}
