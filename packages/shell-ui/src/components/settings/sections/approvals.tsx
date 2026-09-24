/**
 * Settings → Approvals: what a pause does while it waits for you.
 *
 * An approval is a one-use capability — exact origin, method, adapter,
 * action, and path — consumed on the wire. The only knobs are how long the
 * pause is held open and how loudly this Mac says so.
 */

import { APPROVAL_EXPIRY_MINUTES } from "@pistachio/shell-contracts/settings";
import { copyFor } from "../../../lib/surface-copy";
import { useAppStore } from "../../../store";
import { useSurface } from "../../../surface";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Fixed, Group, Page, Row } from "../parts";

const EXPIRY_ITEMS = APPROVAL_EXPIRY_MINUTES.map((m) => ({ value: m, label: `${String(m)} minutes` }));

export function ApprovalsPage() {
  const approvals = useAppStore((s) => s.settings.approvals);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const copy = copyFor(useSurface().kind).approvals;

  return (
    <Page
      title="Approvals & notifications"
      description="A consequential action pauses the run with evidence of what is about to change. These decide how long it waits, and how you hear about it."
    >
      <Group title="Pauses" note="What a paused run does while it waits for your answer.">
        <Row
          label="Approval window"
          note="How long a pause stays open. When it lapses the request is rejected and the run fails safe — nothing is submitted for you."
        >
          <Select
            aria-label="Approval window"
            value={approvals.expiryMinutes}
            items={EXPIRY_ITEMS}
            onValueChange={(expiryMinutes) => void updateSettings({ approvals: { expiryMinutes } })}
            className="w-33"
          />
        </Row>
        <Row
          label="Open the console on a pause"
          note="Bring the agent chat into view when work stops for approval, so the decision is on screen without a click."
        >
          <Switch
            checked={approvals.focusConsoleOnPause}
            label="Open the console on a pause"
            onChange={(focusConsoleOnPause) => void updateSettings({ approvals: { focusConsoleOnPause } })}
          />
        </Row>
      </Group>

      <Group
        title="Alerts"
        note={copy.alerts}
        footer="Every alert is idempotent — a redelivery never re-asks a question you already answered."
      >
        <Row
          label="Desktop notifications"
          note={copy.desktopNotifications}
        >
          <Switch
            checked={approvals.desktopNotifications}
            label="Desktop notifications"
            onChange={(desktopNotifications) => void updateSettings({ approvals: { desktopNotifications } })}
          />
        </Row>
        <Row
          label="Bounce the Dock icon"
          note="Flash the app in the Dock when a run needs you and the window is behind something."
        >
          <Switch
            checked={approvals.flashDock}
            label="Bounce the Dock icon"
            onChange={(flashDock) => void updateSettings({ approvals: { flashDock } })}
          />
        </Row>
      </Group>

      <Group title="Guarantees" note="Properties of the approval design rather than preferences. There is nothing here to turn off.">
        <Fixed
          label="One approval, one request"
          note="Approving mints a capability for that exact origin, method, action, and path. It is consumed the moment the request goes out and cannot be replayed."
        />
        <Fixed
          label="Re-checked at approval time"
          note="Policy runs again when you approve, not only when the agent asked. A grant that expired or narrowed in between is refused."
        />
      </Group>
    </Page>
  );
}
