/**
 * Forgetting, said the way the app says anything irreversible: what it
 * removes, and what it leaves — the half a person cannot infer. One dialog
 * for every scope, so the page and Settings → Watchtower ask the same way.
 */

import { Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { Note } from "../ui/note";
import { ConsequenceList, SettingsDialog } from "../settings/dialogs";
import type { ForgetRequest } from "./use-watchtower";

export type ForgetScope =
  | { kind: "page"; pageId: number; title: string }
  | { kind: "site"; host: string }
  | { kind: "since"; since: number; label: string }
  | { kind: "space"; space: string }
  | { kind: "everything" };

const COPIES = "Markdown you exported, text the agent already retrieved into a conversation, and device backups are separate copies.";

export function forgetRequest(scope: ForgetScope): ForgetRequest {
  switch (scope.kind) {
    case "page":
      return { type: "forget", pageId: scope.pageId };
    case "site":
      return { type: "forget", host: scope.host };
    case "since":
      return { type: "forget", since: scope.since };
    case "space":
      return { type: "forget", all: true };
    case "everything":
      return { type: "forget", all: true, everySpace: true };
  }
}

function wording(scope: ForgetScope): { title: string; confirm: string; does: string[]; doesNot: string[] } {
  switch (scope.kind) {
    case "page":
      return {
        title: "Forget this page?",
        confirm: "Forget page",
        does: [`Removes every saved visit and version of “${scope.title}” in this Profile.`, "Removes its text from search, and from the index what only this page named."],
        doesNot: ["Other pages on the same site are kept.", COPIES],
      };
    case "site":
      return {
        title: `Forget ${scope.host}?`,
        confirm: "Forget site",
        does: [`Removes every saved visit to ${scope.host} and its subdomains in this Profile.`, "Forgets what Watchtower learned about that site’s layout.", "Removes from the index what only that site named."],
        doesNot: ["The site is not excluded: a new visit is saved again. Exclude it in Settings to stop that.", COPIES],
      };
    case "since":
      return {
        title: `Forget ${scope.label}?`,
        confirm: "Forget visits",
        does: [`Removes visits from ${scope.label} in this Profile.`, "Text that only those visits used is deleted, with what the index learned from it."],
        doesNot: ["The same content seen at another time stays with that other visit.", COPIES],
      };
    case "space":
      return {
        title: `Forget everything in ${scope.space}?`,
        confirm: "Forget this Profile",
        does: [`Removes every saved visit in ${scope.space}.`, "Empties its index."],
        doesNot: ["Other Profiles keep their archives.", "Capture stays as it is: new visits are saved again.", COPIES],
      };
    case "everything":
      return {
        title: "Forget the whole archive?",
        confirm: "Forget everything",
        does: ["Removes every saved visit, in every Profile.", "Forgets every site layout Watchtower learned, and empties every index."],
        doesNot: ["Capture stays as it is: new visits are saved again. Turn Watchtower off to stop.", COPIES],
      };
  }
}

export function ForgetDialog({
  scope,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  scope: ForgetScope;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onConfirm(): void;
}) {
  const copy = wording(scope);
  return (
    <SettingsDialog
      icon={<Trash2 aria-hidden="true" />}
      title={copy.title}
      tone="danger"
      busy={busy}
      onClose={onClose}
      testId="watchtower-forget"
      footer="This cannot be undone."
      actions={
        <>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="error" size="sm" loading={busy} onClick={onConfirm} data-testid="watchtower-forget-confirm">
            {copy.confirm}
          </Button>
        </>
      }
    >
      <ConsequenceList heading="What this does" items={copy.does} tone="does" />
      <ConsequenceList heading="What this does not do" items={copy.doesNot} tone="does-not" />
      {error === null ? null : (
        <Note type="error" size="sm">
          {error}
        </Note>
      )}
    </SettingsDialog>
  );
}
