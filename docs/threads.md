# Threads and long-running tasks

The agent console holds one open **thread**: a conversation the person and the agent
share across as many turns as the work takes. A thread is two things kept together
(`apps/desktop/src/main/run-controller.ts`):

- the `RunSummary` the console renders — messages, tool trace, notes, context meter;
- the model history (`ModelMessage[]`) the next turn continues from — real user,
  assistant, and tool messages, exactly as the SDK returned them, never a flattened
  transcript.

## Turns

A turn is one call into the runner (`ai-agent-runner.ts`, `runAiBrowserAgent`). It
takes the thread's history ending in the new user message, loops the model with its
tools, and ends in one of three ways:

- `final` — the model answered; the run is `completed`. A follow-up message continues
  the same thread with everything it learned still in context.
- `paused` — it asked for a fixed choice (`ask_user`), requested a verbatim
  text value (`ask_user_text`), or handed the browser back (`request_takeover`);
  the answer or the resume is the next turn.
- `budget` — it worked past every checkpoint (see below); the run is `interrupted` with
  an honest message and the person decides whether to go on.

A turn that ends with no answer is also `interrupted`, never dressed up as completion.
A step the provider cuts short (`length`, `content-filter`) never ran its tools; the runner
answers those calls with an error result and asks the model to repeat what it still needs.

The person's words become the model's user message; the controller adds one line of
situation the model cannot see for itself (`[The person answered your question]`,
`[The person finished the browser step you asked for…]`). Interrupting a turn aborts
the model call; the history is left at the last finished step with every tool call
answered, so a resume continues cleanly.

## Checkpoints and the step budget

Each `generate` call allows `stepsPerCall` model steps (default 40). When a call runs
out with work still going, the runner appends a **checkpoint** user message asking the
agent to rewrite its notes and continue, and calls again — up to `continuations` times
(default 5, so 240 steps a turn). Past the last one the turn pauses for the person.

## Context management

`thread-context.ts` keeps the history within a token budget without a model in the
loop where it can:

1. **Trimming** — the newest tool message stays whole (the model has not read it yet);
   before it, every tool result but the last three becomes a short stub (page inspections
   keep their title and URL; screenshots are dropped; anything over ~1.2k characters keeps
   a preview). Attachments in older user messages become a line naming the file. Counted
   per result, since one step may read several pages. A screenshot's bytes never ride in
   the tool result (some providers serialise results as JSON text): the result is a stub
   and the picture follows as a user message with an image part, attached once.
2. **Compaction** — when the context still exceeds `compactAt` (default half the
   window; `PISTACHIO_AGENT_CONTEXT_TOKENS`, `PISTACHIO_AGENT_COMPACT_AT`), everything
   between the task message and the last six messages is summarised by the model and
   attached to the task message. The summariser reads the task and the earlier summary
   too, so each compaction is cumulative. If the kept tail alone is over budget, only the
   newest tool message stays whole.

Both run in the SDK's `prepareStep`, so they apply before every model call. The size
used for the decision is the model's own input-token count from the previous step
plus an estimate for what was added since. The console shows the live count and the
number of compactions; a compaction also appears in the thread as a system line.

## Notes

The agent has working notes per thread — plan, progress, ids and values to keep —
rewritten with the `task_notes` tool and shown to it at the end of the system prompt on
every step. They live outside the history, so they survive trimming, compaction,
pauses, and restarts; the compaction prompt reads them too, so the summary does not
repeat what they already hold. The console shows them as "Plan & notes".

## Persistence

`thread-store.ts` writes one JSON per thread under `<userData>/threads/` plus an
index. The open thread is saved after every step (coalesced, written asynchronously) and
synchronously at turn boundaries, when it is set aside, when the window closes, and on
quit. The record also carries the run's evidence entries, the chain's signing key (a
local demo key — production keys belong in a KMS), and how far the memory learner has
read; a reopened thread's chain continues from those entries under that key, with a
`thread.reopened` entry marking the seam, so later turns stay in one verifiable run. A
thread waiting on an approval that is set aside loses the approval and comes back paused:
an approval is a decision about the page as it was. On launch
the controller reopens the latest thread; a turn that was running when the app quit or
the window closed is marked `interrupted` with a note, its history repaired, and a resume
continues it. The console's history button lists saved threads; "New conversation" clears
the console without losing the current one. A run is scoped to its tab's space only while
the agent is driving that tab; otherwise the thread shows wherever the person is.

A scheduled reminder's task is its own thread. It may take the console when no thread
is running or waiting on the person — a paused (`interrupted`) thread is not busy and
stays in the list. If a reminder's turn pauses (budget, interruption) or the thread is set
aside, the reminder's occurrence is recorded as failed with that reason so the scheduler
moves on; a follow-up on that thread is an ordinary conversation, not part of the reminder.

## Testing

- `test/thread-context.test.ts`, `test/thread-store.test.ts` — the pure helpers and the store.
- `test/agent-turns.test.ts`, `test/run-controller.test.ts` — the runner and controller
  driven by a scripted `MockLanguageModelV4`: history carried across turns, notes in the
  prompt, checkpoints, budget pauses, silent turns, compaction, aborts, restore.
- `test/agent-live.test.ts` — the real model against real pages through a fetch-backed
  browser, skipped unless `PISTACHIO_AGENT_LIVE=1`:
  `PISTACHIO_AGENT_LIVE=1 pnpm vitest run test/agent-live.test.ts`.
- `e2e/tests/agent-threads.spec.ts` — the thread list, new conversation, reopen, and
  restart in the built app (demo agent).
