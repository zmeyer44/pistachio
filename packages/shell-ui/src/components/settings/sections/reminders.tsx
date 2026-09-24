/**
 * Settings → Reminders: the switches around the schedule. The schedule
 * itself lives on its own page (pistachio://reminders), which this one
 * points at.
 */

import { AlarmClock } from "lucide-react";
import { useAppStore } from "../../../store";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { Fixed, Group, Page, Row } from "../parts";

export function RemindersSettingsPage() {
  const reminders = useAppStore((state) => state.settings.reminders);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const openReminders = useAppStore((state) => state.openReminders);
  const scheduled = useAppStore((state) => state.reminders.reminders.filter((reminder) => reminder.status === "active").length);
  return (
    <Page
      title="Reminders"
      description="Ask the agent to remind you of something, or to do something later — once, or on a schedule. Messages land in the agent chat; agent tasks run as conversations of their own."
    >
      <Group
        title="Scheduling"
        note="Reminders fire while Pistachio is open. One that comes due while it was closed or asleep is shown as missed rather than fired late."
        footer={`${String(scheduled)} ${scheduled === 1 ? "reminder is" : "reminders are"} scheduled.`}
        footerAction={
          <Button variant="secondary" size="sm" prefix={<AlarmClock aria-hidden="true" />} onClick={() => openReminders()}>
            Open reminders
          </Button>
        }
      >
        <Row label="Fire reminders" note="Off pauses every reminder without cancelling any.">
          <Switch checked={reminders.enabled} onChange={(enabled) => void updateSettings({ reminders: { enabled } })} label="Fire reminders" />
        </Row>
        <Row label="Desktop notifications" note="A native notification when a reminder fires or a scheduled task finishes.">
          <Switch
            checked={reminders.desktopNotifications}
            onChange={(desktopNotifications) => void updateSettings({ reminders: { desktopNotifications } })}
            label="Desktop notifications for reminders"
          />
        </Row>
        <Row label="Open the agent chat" note="Bring the chat forward when a reminder fires, so the card is in view.">
          <Switch
            checked={reminders.openConsoleOnFire}
            onChange={(openConsoleOnFire) => void updateSettings({ reminders: { openConsoleOnFire } })}
            label="Open the agent chat when a reminder fires"
          />
        </Row>
      </Group>
      <Group title="What the agent can schedule">
        <Fixed label="Messages" note="A fixed text shown at a time: “Take the cookies out.”" />
        <Fixed
          label="Agent tasks"
          note="A prompt the agent runs at that time in your browser session, with every tool it has now. One runs at a time; a task due while another conversation is live waits for it."
        />
        <Fixed label="Schedules" note="Once, every few minutes, daily, on chosen weekdays, or monthly — in your time zone." />
      </Group>
    </Page>
  );
}
