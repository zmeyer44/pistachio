/**
 * Settings → Evidence: the record a run leaves behind, and how it is shown.
 *
 * The chain itself is not a preference — every entry is Ed25519-signed and
 * hash-linked whether or not you look at it — so this page is mostly the
 * signing identity stated plainly, with one knob for the replay view.
 */

import { useAppStore } from "../../../store";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { Fixed, Group, Page, Row } from "../parts";

export function EvidencePage() {
  const evidence = useAppStore((s) => s.settings.evidence);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const run = useAppStore((s) => s.snapshot?.run ?? null);
  const loadEvidence = useAppStore((s) => s.loadEvidence);
  const closeSettings = useAppStore((s) => s.closeSettings);

  return (
    <Page
      title="Evidence"
      description="Every run writes a signed, hash-chained record of what the agent did, who sponsored it, and what was approved. Replay it from the console at any time."
    >
      <Group
        title="Replay"
        note="How the record reads when you open it."
        footer={
          run === null
            ? "Delegate a task and its record appears here."
            : run.result === null
              ? `${String(run.activity.length)} events so far · ${run.status.replaceAll("_", " ")}`
              : `${String(run.result.evidenceEntries)} signed events · root ${run.result.rootHash.slice(0, 16)}…`
        }
        footerAction={
          <Button
            variant="secondary"
            size="sm"
            disabled={run === null}
            onClick={() => {
              closeSettings();
              void loadEvidence();
            }}
          >
            {run === null ? "Open replay" : `Replay “${run.purpose}”`}
          </Button>
        }
      >
        <Row
          label="Show signed payloads"
          note="Expand each entry's payload in the replay. Off, the replay lists only event types, times, and hashes."
        >
          <Switch
            checked={evidence.showPayloads}
            label="Show signed payloads"
            onChange={(showPayloads) => void updateSettings({ evidence: { showPayloads } })}
          />
        </Row>
      </Group>

      <Group
        title="Attribution"
        note="Who each entry names. Attribution is a chain: the agent acted, you sponsored it, this task authorized it."
      >
        <Row label="Actor" note="The principal that signed each entry.">
          <code className="font-mono text-label-12 text-gray-900">pistachio-browser-agent</code>
        </Row>
        <Row label="Sponsor" note="The person the actor worked for. Local builds run under a single fixed identity.">
          <code className="font-mono text-label-12 text-gray-900">local-user</code>
        </Row>
      </Group>

      <Group title="Guarantees" note="Properties of the chain rather than preferences. There is nothing here to turn off.">
        <Fixed
          label="Ed25519 signatures, SHA-256 chain"
          note="Each entry binds actor, sponsor, task, payload, and the previous entry's hash. Verification checks every link and the external root."
        />
        <Fixed
          label="Authority ends before completion is claimed"
          note="The capsule key is destroyed and egress is cut, then the completion entry is written — a completed run cannot still hold its grant."
        />
      </Group>
    </Page>
  );
}
