/**
 * Settings → Agent: the instructions every conversation starts from, and
 * what the agent can reach in the browser.
 *
 * The instructions are a Geist fieldset in full: the field in the content,
 * what it is for in the footer, and the save beside it — so an edit is never
 * saved out from under you by a keystroke.
 */

import { useState } from "react";
import { useAppStore } from "../../../store";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import {
  Fieldset,
  FieldsetContent,
  FieldsetFooter,
  FieldsetFooterActions,
  FieldsetFooterStatus,
  FieldsetSubtitle,
  FieldsetTitle,
} from "../../ui/fieldset";
import { Fixed, Group, Page } from "../parts";

function DefaultInstructionsFieldset() {
  const configured = useAppStore((state) => state.settings.delegation.defaultIntent);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const [draft, setDraft] = useState<string | null>(null);
  const dirty = draft !== null && draft !== configured;

  return (
    <Fieldset>
      <FieldsetContent>
        <FieldsetTitle>Default instructions</FieldsetTitle>
        <FieldsetSubtitle>
          Prefilled in a new conversation. You can replace it before sending, or steer the agent at any time.
        </FieldsetSubtitle>
        <Textarea
          aria-label="Default agent instructions"
          value={draft ?? configured}
          placeholder="For example: Be concise and ask before submitting anything."
          onChange={(event) => setDraft(event.target.value)}
          className="mt-3.5 min-h-24 text-copy-13"
        />
      </FieldsetContent>
      <FieldsetFooter highlight={dirty}>
        <FieldsetFooterStatus>
          {dirty ? "Unsaved changes." : "Applies to the next conversation you start."}
        </FieldsetFooterStatus>
        <FieldsetFooterActions>
          <Button variant="tertiary" size="sm" disabled={!dirty} onClick={() => setDraft(null)}>
            Revert
          </Button>
          <Button
            size="sm"
            disabled={!dirty}
            onClick={() => {
              if (draft === null) return;
              void updateSettings({ delegation: { defaultIntent: draft.trim() } });
              setDraft(null);
            }}
          >
            Save
          </Button>
        </FieldsetFooterActions>
      </FieldsetFooter>
    </Fieldset>
  );
}

export function DelegationPage() {
  return (
    <Page
      title="Agent"
      description="Pistachio works directly in your browser, keeps its actions visible in chat, and yields immediately when you interrupt."
    >
      <DefaultInstructionsFieldset />

      <Group
        title="Browser access"
        note="The agent uses the same live tabs and signed-in sessions you use. These capabilities are available to the primary agent and its subagents."
      >
        <Fixed label="Tabs and navigation" note="List, open, focus, navigate, go back, go forward, and reload." />
        <Fixed label="Page interaction" note="Inspect visible content, click controls, type, scroll, and capture screenshots." />
        <Fixed
          label="Collaborative control"
          note="Stream tool activity, ask structured questions, delegate specialists, and pause instantly when interrupted."
        />
      </Group>

      <Group title="Guardrails">
        <Fixed
          label="Per-action controls are coming next"
          note="A future settings update will let you constrain sites, actions, data movement, and approval thresholds without changing the chat workflow."
          badge="Planned"
          tone="gray"
        />
      </Group>
    </Page>
  );
}
