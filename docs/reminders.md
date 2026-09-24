# Reminders

The agent can schedule things for later: a message to show the person at a
time, or a task it runs itself when the time comes. "Remind me to take the
cookies out in 20 minutes" and "every Sunday at 8am send me a summary of my
week" are both reminders; they differ in what fires, not in how they are
kept.

## Model

A **reminder** (`apps/desktop/src/shared/reminders.ts`) pairs a schedule
with an action, in a time zone.

| Schedule   | Meaning                                                    |
| ---------- | ---------------------------------------------------------- |
| `once`     | One instant.                                               |
| `interval` | Every _N_ minutes from an anchor instant.                  |
| `daily`    | Every day at a wall-clock time (`"07:00"`).                |
| `weekly`   | On the given weekdays at a wall-clock time.                |
| `monthly`  | On a day of the month (clamped to its length) at a time.   |

Wall-clock kinds are read in the reminder's IANA zone, so "7am" stays 7am
across a DST change. A reminder may end at an instant (`until`) or after a
number of fires (`maxFires`).

| Action    | What fires                                                                         |
| --------- | ---------------------------------------------------------------------------------- |
| `message` | The text is shown: a card in the agent chat and a desktop notification.           |
| `agent`   | A new console run starts with the prompt and every tool the agent has; its final answer is the output. |

Each fire leaves an **occurrence**: when it was due, when it ran, what came
out, and its status — `delivered` (message), `completed` / `failed` (agent
task), `queued` / `running` (agent task in progress), or `missed`. The
person dismisses occurrences from the chat; the page keeps them.

## Where it lives

- **`main/reminder-store.ts`** — `<userData>/reminders.json`, read once,
  rewritten whole on every change, listeners notified, the way memory and
  settings are. It computes `nextFireAt` from a schedule and hands out what
  is due; it does not own the clock.
- **`main/reminder-scheduler.ts`** — the clock. One timer armed for the
  earliest fire (never longer than a 30 s tick), plus ticks on power resume,
  when settings turn reminders back on, and when the console frees up. A
  fire is _claimed_ (the store advances the reminder, an occurrence is
  opened) before anything happens, so a crash mid-fire leaves a record and
  never a double delivery.
- **`main/run-controller.ts`** — `startScheduled` runs an agent task as a
  visible console run carrying `origin: { kind: "reminder", … }`; the
  scheduler is told the outcome when the run reaches a terminal state.
- **`main/ai-agent-runner.ts`** — the `reminder_create` / `reminder_list` /
  `reminder_update` / `reminder_cancel` tools and the rules for using them.
  The prompt carries the current time and zone so relative times need no
  arithmetic (`inMinutes`) and clock times are unambiguous.
- **Renderer** — `pistachio://reminders` (⌘⇧R, the toolbar button, the
  command palette, or the address bar) opens a chrome page over the content
  hole: a calendar of fired and upcoming items — a week strip by default,
  every item timed, or a month grid, the choice remembered on this Mac —
  one day's detail with outputs, and the list of every reminder to run,
  pause, edit, cancel, or delete. A divider between calendar and detail
  (drag, arrow keys, double-click to reset) sets how much of the page each
  takes; the week strip scrolls inside when compact. Both calendars are ARIA grids with one
  tab stop: arrows walk days, Up/Down turn the week, PageUp/PageDown the
  month, Home/End reach the week's ends. Fired reminders also appear as cards at the top of the agent chat
  (`components/reminders/ReminderInbox.tsx`) until dismissed or snoozed.
- **Settings → Reminders** — fire at all, desktop notifications, open the
  chat on fire.

## Lateness and the console

Reminders fire while Pistachio is open. A fire that comes due more than 15
minutes late — the Mac was asleep, the app was closed — is recorded as
`missed` and shown as such rather than fired late; a recurring reminder
then continues from _now_, so a week away does not wake to seven mornings
of the same reminder.

The console holds one run at a time. An agent task due while another run is
live is `queued` and retried every tick and whenever a run ends; queued
tasks run one at a time in the order they came due. One that waits more
than three hours is recorded as `missed` with the reason. Message reminders
never wait: an agent task runs off the clock loop, so a message due while a
task has the console for an hour is still delivered on time.

On launch the scheduler picks up what the previous session left in flight:
`queued` tasks go back in the queue (or are `missed` if their reminder was
cancelled meanwhile), and a task that was `running` when Pistachio quit is
settled as `failed` — its run is gone and cannot be resumed.

One-off times the agent gives without a UTC offset are read in the
reminder's zone, never this Mac's; a wall-clock time that falls in a DST
gap fires at the first instant after the gap, and one in the repeated hour
fires at its first occurrence.

## Trust

Reminders are local to this Mac, like memory. The agent writes them through
the same audited tool path as browser actions: every call lands in the run's
tool trace and the evidence chain (`reminder.tool.started`,
`reminder.action`). A scheduled run is a run like any other — visible,
interruptible, steerable — and the person can end it from the console.
