"use client";

import type { ReactNode } from "react";
import type { ReminderRecord } from "@pistachio/sync-protocol";
import { Empty, Intro, Page, Section, Status, Table, useSession, When } from "@pistachio/web-account";

/** Say when it repeats in words, in the reminder's own zone. */
function cadence(reminder: ReminderRecord): string {
  const schedule = reminder.schedule;
  switch (schedule.kind) {
    case "once":
      return "Once";
    case "interval":
      return `Every ${String(schedule.everyMinutes)} min`;
    case "daily":
      return `Daily at ${schedule.time}`;
    case "weekly": {
      const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const days = schedule.days.map((day) => names[day] ?? "?").join(", ");
      return `${days} at ${schedule.time}`;
    }
    case "monthly":
      return `Day ${String(schedule.day)} at ${schedule.time}`;
    default:
      return "Scheduled";
  }
}

const what = (reminder: ReminderRecord): string =>
  reminder.action.kind === "agent" ? reminder.action.prompt : reminder.action.text;

export default function RemindersPage(): ReactNode {
  const { workspace, hubState } = useSession();
  const active = workspace.reminders
    .filter((reminder) => reminder.status === "active")
    .sort((a, b) => (a.nextFireAt ?? "\uffff").localeCompare(b.nextFireAt ?? "\uffff"));
  const rest = workspace.reminders.filter((reminder) => reminder.status !== "active");

  return (
    <Page>
      <Intro
        title="Reminders"
        lede="What your agent is going to do, and when. Scheduled on a Mac and readable here; the times are shown in each reminder's own zone."
      />

      {workspace.reminders.length === 0 ? (
        <Empty title={hubState === "connected" ? "Nothing scheduled" : "Waiting for your devices"}>
          <p>
            Ask the agent for something recurring — &ldquo;every Sunday at 8am, summarise my week&rdquo; — and it shows up
            here.
          </p>
        </Empty>
      ) : null}

      {active.length === 0 ? null : (
        <Section heading="Active">
          <Table
            caption={`${String(active.length)} active reminder${active.length === 1 ? "" : "s"}, next to fire first.`}
            head={
              <>
                <th scope="col">Reminder</th>
                <th scope="col">Repeats</th>
                <th scope="col">Zone</th>
                <th scope="col" className="pa-n">Next</th>
              </>
            }
          >
            {active.map((reminder) => (
              <tr key={reminder.id}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  {reminder.title === "" ? what(reminder) : reminder.title}
                  {reminder.action.kind === "agent" ? <span className="pa-caption"> · agent task</span> : null}
                </th>
                <td className="pa-caption">{cadence(reminder)}</td>
                <td className="pa-metadata">{reminder.timezone}</td>
                <td className="pa-n">
                  <When iso={reminder.nextFireAt} relative />
                </td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      {rest.length === 0 ? null : (
        <Section heading="Paused and finished">
          <Table
            caption={`${String(rest.length)} reminder${rest.length === 1 ? "" : "s"} no longer firing.`}
            head={
              <>
                <th scope="col">Reminder</th>
                <th scope="col">State</th>
                <th scope="col" className="pa-n">Fired</th>
                <th scope="col" className="pa-n">Last</th>
              </>
            }
          >
            {rest.map((reminder) => (
              <tr key={reminder.id}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  {reminder.title === "" ? what(reminder) : reminder.title}
                </th>
                <td>
                  <Status>{reminder.status}</Status>
                </td>
                <td className="pa-n">{reminder.fireCount}</td>
                <td className="pa-n">
                  <When iso={reminder.lastFiredAt} relative />
                </td>
              </tr>
            ))}
          </Table>
        </Section>
      )}
    </Page>
  );
}
