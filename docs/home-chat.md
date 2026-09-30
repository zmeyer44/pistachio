# The home page as a chat

Status: implemented on `main` (September 2026), desktop; the shell-ui
pieces render on the web surface too, but only a desktop turn streams.

## 1. What this is

The home page's search used to hand a question to the AI provider chosen in
Settings: "Ask ChatGPT “…”" opened `chatgpt.com/?q=…` in the tab. Now the
page answers the question itself. The row reads "Ask Pistachio “…”" (the
address bar's row still names the provider), and choosing it turns the
page into a conversation in place: the search pill flies to the foot of the
pane and becomes the composer, the greeting and cards step aside, the
question lands as the first bubble, and the reply streams in under it —
what the model is thinking, what it is doing, then its words a few at a
time, with the pages it read as sources. It is the sidebar console's
conversation with the whole pane, drawn from the same components.

## 2. The conversation is the console's

There is one open thread (docs/threads.md), and a home tab that asks a
question makes it that thread: `askHome` (shell-ui `store.ts`) sets the
console's thread aside with `newThread`, starts a fresh one with
`startDelegation(prompt, [], { page: false })`, and binds the tab to the run
the moment main publishes it (`homeChats[tabId] = { runId, prompt }`). Until
then the tab shows the question and "Thinking…" itself, so nothing waits
on the round trip. The sidebar shows the same run; "Open in the sidebar" in
the chat's header just opens it.

Consequences that follow from that one fact:

- **Busy means no.** A question typed into a new tab while the agent is
  acting on another conversation is neither a steer of it nor a reason to
  stop it. `askHome` answers false, the page says so under the search, and
  the sidebar opens on the conversation that is running.
- **The tab stays a home tab.** Its address is still `pistachio://home/`;
  which conversation it shows is the store's (`homeChats`), so a switch
  away and back finds the chat again, and a restart finds the home page
  (the console still holds the thread).
- **The console moving on ends the chat.** Reopening another thread or
  starting one in the sidebar replaces the open run; a home tab whose run
  is no longer the open one goes back to being the home page.
- **A browse turn may take the tab.** The run works in the person's tab
  (`humanTabId` is the home tab), so a task routed to the browser can
  navigate it away. The store opens the sidebar when that happens while the
  run is live (`homeChatLeftHome`, on the tab publish — the home page
  itself is unmounted by then), so the conversation stays in view beside
  the page the agent is driving. Only the step off home opens it; a sidebar
  closed after that stays closed.
- **A window with no tabs gets one.** `#startFresh` needs an active human
  tab, so the tabless home page creates a home tab first and asks from it.

The router (docs/console-routing.md) decides as it does for the console:
a knowledge question takes the answer path with no browser tools; a task
takes the browser. The home page sends `page: false` — there is no page in
view to attach.

## 3. Streaming (`RunSummary.draft`)

The runner asks the model for a stream whenever the host implements any
of `stepStarted`, `textDelta`, `reasoningDelta`, `reasoningEnded`
(`AiAgentRunCallbacks`); without them it generates whole, which is what
every scripted test drives. The desktop controller implements them
(`RunController` option `stream`, on for the configured model) and keeps
the words on a draft beside the run — `{ turn, text, reasoning, thinking,
thinkingSince, thinkingMs }` — folded into `peek()`/`snapshot()` for the
shell only. The thread store and the cloud mirror never see half a
sentence. Deltas go out coalesced, at most every 40 ms, over the ordinary
run publish.

A step's words reset on the next step (`stepStarted`): only the final
step's text is the reply, as on the generated path. Reasoning accumulates
across the turn and, with how long it took, is kept on the finished
message (`AgentMessage.reasoning`, `thinkingMs`) so "Thought for 4s" still
folds above the reply later. Reasoning summaries are requested from the
provider with `providerOptions.openai.reasoningSummary = "auto"`; a
provider that shares none simply shows no block.

The reply is now kept as the model wrote it — Markdown — and rendered.
`#plainModelText` still makes the plain form for the thread's summary, the
completion notification and iMessage. Both prompts ask for light Markdown
and for citations as links to pages the thread read (`FORMAT_RULES`).

## 4. What the shell draws (`packages/shell-ui/src/components/chat`)

| Piece | What it is |
| --- | --- |
| `Markdown.tsx` + `lib/markdown.ts` | marked's lexer to React elements — never HTML, so the model's text cannot become markup. Streaming: an open fence still draws as code (`closeOpenFence`), an unfinished link/code span/emphasis is held back until it closes (`holdUnfinished`), and each word that lands is wrapped so it resolves into place (`chat-word`). |
| `use-smooth-text.ts` + `lib/smooth-text.ts` | The prefix shown trails the draft and closes the gap a frame at a time, faster the further behind, never below a reading pace; lands on word boundaries. |
| `ReasoningBlock.tsx` | "Thinking · 3s" shimmering over a two-line ticker of the latest reasoning; folds to "Thought for 4s"; opens to the whole. |
| `ThinkingStatus.tsx` | The status line before any words — "Thinking…", "Searching saved pages…", "Working in your browser…" — swapping states with the rise-out/rise-in motion. |
| `Sources.tsx` + `lib/chat-sources.ts` | `AgentToolCall.source` (a `page.inspect`, a `watchtower.read`) gathered per turn, numbered, as cards under the reply; a link to one of them draws as a citation chip, and the parentheses the model wraps it in are dropped. |
| `LiveReply.tsx` | The in-progress turn: reasoning, then status or streaming words. |
| `parts.tsx`, `use-thread-layout.ts` | The message rows, trace, cards and grouping the console and the home chat share, at `panel` or `page` density. |
| `home/HomeChat.tsx` | The page: header, thread, composer, and the pill-to-composer flight (one WAAPI transform from the pill's box). The whole page is a drop zone: files let go anywhere on it are staged in the composer for the next message. |
| `attachment-drop.tsx` | The staged files and the drop zone that stages them (`useAttachmentDrop`), and the veil shown while files are held over it — the console's panel and the home chat's page each use one. |

The motion follows the transitions.dev recipes for streaming text,
reasoning stream and thinking states, tuned to the shell; every animation
is off under `prefers-reduced-motion`.

## 5. Checking it

- Unit: `packages/shell-ui/test/{markdown,chat-sources,smooth-text,search-suggestions,home-chat}.test.ts`;
  `packages/agent-runtime/test/agent-turns.test.ts` ("streamed turns");
  `apps/desktop/test/run-controller.test.ts` ("a streamed reply").
- App: `apps/desktop/e2e/tests/home-chat.spec.ts` drives the demo
  executor from the home page — the row, the flight, the trace, the
  approval, the sidebar mirror, files dropped on the page and on the
  panel, and the way back. `search-providers.spec.ts`
  covers the row's wording beside the address bar's.
- Live: the same journey with a model, from a new tab — a knowledge
  question streams with a reasoning block; "find the cheapest …" goes to
  the browser and the sidebar opens as the tab navigates.
