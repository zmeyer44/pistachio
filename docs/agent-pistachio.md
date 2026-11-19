# The agent and Pistachio itself

The agent could operate any page on the web and knew nothing of the browser it lives in. "How can I customize the appearance of Pistachio?" was a browser task: it listed the tabs and went looking for a manual, or answered with directions to a menu. Now it knows what Pistachio is, and it changes Pistachio for the person: a setting at once, or — for what no setting does — an extension it builds in the conversation (`docs/extensions.md`, `docs/primitives.md`), which lands waiting for the person to turn on.

Desktop only: the cloud browser has no such app around a run. Builds on `docs/console-routing.md` (turns), `docs/desk-agent.md` (where the person talks to it) and `docs/extensions.md` §8 (the author).

## 1. What a person does

Asks, in the Bar, as they would ask anything.

- *"How can I customize the appearance of Pistachio?"* The reply is a few lines: an offer, what a setting does at once (dark mode, a colour wash, the glass, rounder corners), what an extension adds (a backdrop behind their spaces, a look for one space or for certain days, something of theirs beside the Bar), and a question back — *what should we change?* Nothing is touched, and no page is opened.
- *"Make it dark, with a purple and pink wash."* It is dark. The trace has two steps (*Read settings*, *Change settings — appearance.scheme: light → dark; …*), and the reply says what changed and that it can be put back.
- *"What's the shortcut for a new space? Make it ⌘⇧N."* Read from the settings, not from memory — the person may have changed it — and rebound; a key another command holds is refused in the Settings page's own sentence.
- *"Turn off the ad blocker."* Not the agent's to change (§3): it says so, and opens Settings → Ads & trackers for them.
- *"Give every space a starry night backdrop."* No setting does that: the agent builds an extension. The trace shows *Build an extension* and, under it, the builder's own steps (*Write a file*, *Check the extension*). Under the reply is a card — *Starry night · Extension · Waiting for you to turn it on* — which is the approval itself: what the extension can do, in the sheet's words, then *Not now* and *Turn it on*, with no sheet to open first; the Ledge shows the amber dot. Nothing runs until the person presses *Turn it on*. Then the card reads *On*.
- *"A bit darker."* The same extension, changed: it lands paused (*Pistachio changed it*), for the person to approve again — in the card under that reply; the first reply's card is a row again.

## 2. What the agent is told

`pistachioRules` (`packages/agent-runtime/src/pistachio-tools.ts`), in the prompt of both paths whenever the host supplies `AiAgentRunInput.pistachio`:

- **It is part of Pistachio and can change it.** A question about the app is answered from the guide and the tools: never the web, never how other browsers work, never a menu or a key the guide and the tools do not show. It needs no tab (the browser path's "begin by listing the tabs" says so too).
- **Help directly; do not give directions.** Open with the offer, name a few concrete possibilities, ask what they would like. A broad question names both kinds of change — a setting, an extension — or the half a person never hears of is the extensions. A request already specific is done without asking.
- **Three ways, the first that does the job**: a setting; a tool it already has (spaces, the desk, reminders, notes, bookmarks, memory); an extension it builds. Building one is ordinary work, not a last resort (`docs/primitives.md`: Pistachio is shaped a person at a time).
- **`PISTACHIO_GUIDE`**: the app as a map, in the UI's own words — Home and spaces, the desk, the sidebar, the Bar and its `/` commands, the address bar, what is built in, protection, the account — then how it is made to look and work differently: what Settings → Appearance holds, what the other pages hold, and what an extension can do, with four wishes as examples. A map, not a manual: anything that is a *value* (a setting, a shortcut) is left to `settings_read`.

A run without the host — a cloud run, a turn a reminder started — has none of this and none of the tools.

## 3. The tools

Group `pistachio` (`tool-groups.ts`), host-supplied (`PistachioToolHost`), each a step in the trace (`settings.read`, `settings.change`, `app.open`, `ext.list`, `ext.build`; family `app` for the first three — *Changing Pistachio* — and `extension` for the last two).

| Tool | Does |
| --- | --- |
| `settings_read(section)` | `null`: the pages of settings and what each holds. A page's id: every setting on it — key, what it is, value now, what it accepts, and `locked` with the reason when it is the person's alone. |
| `settings_change(changes)` | Changes settings, all or none, through the settings store — so every view hears it as it hears the Settings page. Answers each setting's value before and after. |
| `pistachio_open(page)` | Shows the person one of Pistachio's own pages: each page of Settings (`settings`, `settings/appearance`, …) and `extensions`, `notes`, `bookmarks`, `reminders`, `archive`, `watchtower`, `downloads`, `brief`. Only when they ask, or when the next step is theirs to take there. |
| `extensions_list()` | What is installed: where each stands, what it adds, what it has Pistachio showing — and, for one a build may change, its slug. |
| `extension_build(name, brief, extension)` | §4. |

**The catalog** (`apps/desktop/src/main/pistachio-agent.ts`, pure). Every field of `DesktopSettings` is one of three things, and a test holds the table to that, so a new setting cannot be added without deciding which:

- *The agent's to change*: how Pistachio looks and behaves — `appearance` (and `appearance.preset`, a named look as one setting), `layout`, `general`, `search`, `tabs`, `media`, `reminders`, `bookmarks`, `memory`, `privacy.rememberRecents`, `evidence.showPayloads`, and every keyboard shortcut the Mac's window offers.
- *The person's alone* (`locked`; read, never written): `delegation` (what the agent itself may do, and the instructions every conversation starts with), `approvals`, `shields`, `extensions` (Developer mode), `cloud` (where conversations run). A change is refused with why, and the page to offer.
- *Not shown* (`HIDDEN_SETTINGS`): the walkthrough's record, an organization's links, a switch for a panel the desktop no longer draws, the deep end of Shields.

`planSettingsChange` checks a change whole before any of it is written — every key known, none locked, every value one the setting takes (a refusal says what it accepts), then the file's own sanitizer run over the result, which must agree and which refuses a key two commands would hold. A key is taken as a person writes it (`⌘⇧N`, `Cmd+Shift+N`). What is already so is left out, and then nothing is written.

## 4. Building an extension in a conversation

`extension_build(name, brief, extension?)` commissions a **builder**: the author turn of `docs/extensions.md` §8, run by the runner itself as a nested turn (`ExtensionAuthorInput.commissioned`).

- **The builder reads the brief and nothing else.** Its history is one message — the brief, written by the conversation's agent — and its prompt is the author's with the API's guide: no conversation, no page, no memory, no desk. It has the three draft tools alone; nobody is there to ask, so where the brief leaves a choice open it makes the plain one and says so in its report.
- **Its steps join the conversation's trace** under the build that asked for them; its history, its usage and its words do not join the thread's. It has one call of forty steps; cut short, the build's answer says so and the same slug goes on.
- **The folder**: a new, empty one in the dev folder named for `name` (Developer mode on from then, said in a notice) — or, with `extension`, one that exists: a draft of this session's, or one of the person's own Pistachio extensions in the dev folder, by its slug or id. Never a Chrome extension, one of Pistachio's own, or a folder loaded from elsewhere. Main takes the folder for its builder at once (`DraftFolders.adopt`): no message stands between the folder's making and the turn that writes it, so there is no token to carry.
- **It lands waiting**, as every draft does (`docs/extensions.md` §6.2 *Approving*): a new one needs its sheet; an approved one a build writes to is paused first (*Pistachio changed it*). The agent has no install or approve tool, and is told never to say a thing is on.
- **What comes back** (`buildOutcome`): the extension's name and id, whether it waits, what its sheet will say it adds, asks and when it runs by itself, any errors still stopping it from loading, and the builder's report. The reply says the step that is the person's.
- **The card** (`AgentToolOutput` kind `extension`): under the reply, where it stands *now*. While it waits, the card **is the approval** (2026-11-18; until then it was a row whose *Review* opened the sheet, a press before the answer could be given): the sheet in its compact form — *Pistachio changed it* when it was; *Adds*; *Runs by itself*; *Can*, at most four lines broadest first, in main's words and never the agent's; *See everything it declares*, which opens the sheet itself; *Agent can use it* when it declares tools — then **Not now** and **Turn it on**, which names the manifest those lines describe and asks a second time for a Critical line. The card and the sheet answer through one piece (`components/extensions/approval.tsx`: `extensionSubject`, `useApproval`), so neither can ask less than the other. *On* once it is, a row that opens the extensions page.
  - **Not now** folds the card to a row — *Waiting for you to turn it on · Review* — and the extension goes on waiting; *Review* asks again, in the card. The fold is the window's (`useExtensions.notNow`, by the manifest it was said of) and lapses when what waits is no longer what was declined: a manifest that asks differently, the agent writing to the folder again, an approval (`stillNotNow`).
  - **Asked once in a thread.** A later turn that changes the extension carries the approval under its own reply; the earlier turn's card is a row whose *Review* opens the sheet (`threadOutputs` marks it `earlier`). While that later turn is still writing, the button waits (*Pistachio is still writing it…*): main would refuse.
  - A window with no snapshot of the extension (the web) shows the row, as before.
- **What would only fail once it ran is said at the save.** A draft is checked for what stops it loading, and a theme is set when the person turns the extension on — so an accent a shade too pale (`#79b8ff` is 1.99:1 on the light ground) loaded, was approved, and then showed nothing: the first build a live model made did exactly this. `DraftFolders.write` refuses a file with an accent `theme.set` would reject (`draftRuntimeRefusal`), in `theme.set`'s own words; `/extension`'s author gets the same.

## 5. A wish is the person's

A change to Pistachio is made because the person asked, never because a page said to.

- **A turn that has read untrusted content does not build, and does not set an address a tab opens.** The runner marks the turn the moment a tool that reads text the person did not write is called (`readsUntrusted`: a page, a screenshot, a saved page, a bookmark, a note, mail, a calendar, an extension's answer, a file of the space's context) — or from its start, when the person's message carries the page in view. Then `extension_build` refuses before a folder is made, and `settings_change` tells the host, which refuses `general.homeUrl` and `general.newTabUrl`. The agent says what it would do; the person's next message is a turn that starts clean.
- **Not held back**: how the window looks. "Use this page's colours" is a fair wish, and nothing a page gains by.
- **What this is not.** `/extension` starts a thread of its own, so nothing a page ever said is in the author's history. A build is commissioned from a conversation, so the *brief* is written by an agent whose thread may have read pages on earlier turns. What holds then: the builder reads only the brief; the turn that wrote the brief read nothing untrusted; a manifest naming every site is refused at the save; and nothing built runs until the person has read its sheet and turned it on.

## 6. Routing

At a desk every turn is the browser path's, so the rules of §2 are what keep a question about the app off the web. Where the router is asked (`docs/console-routing.md`), the quick path's abilities gain a line — *explain how this browser, Pistachio, works, and change its settings, its look, its keyboard shortcuts and its extensions* — so such a request is a reply; and the answer path is told a question about Pistachio is not a reason to call `use_browser`.

## 7. Files

- Runtime: `packages/agent-runtime/src/pistachio-tools.ts` (the guide, the rules, the five tools, `PistachioToolHost`), `tool-groups.ts` (`pistachio`, `readsUntrusted`), `runner.ts` (`AiAgentRunInput.pistachio`, the turn's mark, the nested build, `builderCallbacks`), `extension-tools.ts` (`commissioned`).
- Protocol: `PistachioToolRequest`, the five call names, `AgentToolOutput` kind `extension`, `toolOutputOf`; `packages/run-view` (family `app`).
- Main: `pistachio-agent.ts` (the catalog, a change's plan, the pages, the extension views), `index.ts` (`pistachioForRuns`), `run-controller.ts` (`#pistachioInput`, `answerPathTools`), `extensions/agent.ts` (`adopt`, `folderOf`, `draftRuntimeRefusal`), `extensions/service.ts` (`agentExtensions`, `agentDraft`, `agentOutcome`, `setBuilding`).
- Shell: `ShellCommand` `openExtensions`, `components/OutputCard.tsx` (the card, `ExtensionApproval`, `extensionCardStanding`), `components/extensions/approval.tsx` (what the card and the sheet share), `components/chat/use-thread-layout.ts` (`threadOutputs`), `lib/extensions/use-extensions.ts` (`notNow`), `components/chat/trace.tsx`.
- Tests: `packages/agent-runtime/test/pistachio-tools.test.ts`; `packages/shell-ui/test/extensions-ledge.test.ts` (*an approval asked in the conversation*); `apps/desktop/test/pistachio-agent.test.ts`, `extensions-agent.test.ts`, `run-controller.test.ts` (*Pistachio itself in a turn*); `apps/desktop/e2e/tests/agent-pistachio.spec.ts` (`@agent`, the journey of §1 in the real app on a scripted model).

## 8. Checking it with a real model

`PISTACHIO_SELF_LIVE=1 pnpm vitest run test/pistachio-agent.live.test.ts` in `apps/desktop`: the agent's real model through the gateway and the real runner, over the real catalog and a draft folder read by the real loader. It prints each reply. Measured 2026-11-17 on `openai/gpt-5.6-terra`: the question of §1 answered in 3.4 s with no tool call, both kinds of change named and a question back; the dark-and-purple wish done in 6 s (`settings_read`, `settings_change`); the locked setting left alone with its page opened; the shortcut read, then rebound; the backdrop built in 46 s — a manifest asking only `theme`, a worker that sets it as it is turned on, an SVG — and loading.

## 9. Not done

- **A notice with Undo for a setting the agent changed.** The trace and the reply say it, and the answer carries the values before; a person who was not watching the conversation is told nothing else.
- **A brief from a thread that read pages earlier** (§5) is not asked about first. Stricter would be the host asking the person to confirm the brief itself in such a thread.
- **The builder's usage** is not in the thread's context meter.
- **Turning an extension off, pinning it, removing what it shows**: the person's, on the extensions page (`pistachio_open extensions`).
- **Runtime errors after approval** reach the agent only when it next lists the extensions (`broken: …`). Nothing tells the conversation that built it.
- **The web**: its console has no such app around it.
