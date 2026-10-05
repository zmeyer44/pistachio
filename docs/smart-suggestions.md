# Smart suggestions: an intent model behind the address bar

Status: implemented on branch `smart-suggestions` (September 2026).

## 1. What this is

The address bar (`packages/shell-ui/src/components/UrlBar.tsx`, and the home
page's search, which shares `address-palette.tsx`) ranks its typed face with
string heuristics: `isProbablyUrl` decides "go to" versus "search", a fuzzy
ranker orders tabs, kept pages, recents, chrome actions and settings sections,
and the web search always precedes the AI prompt.

Heuristics cannot read meaning. Four readings of typed prose look identical to
a regex:

| Typed | Meant |
| --- | --- |
| `best pistachio gelato` | a web search |
| `explain how a tls handshake works step by step` | a prompt for the AI assistant |
| `my email` | the Gmail tab that is already open |
| `change theme color` | Settings → Appearance |

This feature asks a System One evaluation model which reading is likeliest and
uses the answer to put the right row under ↵.

## 2. The model

Jev (TypeSafe AI) is not a language model. It generates no text. It takes one
`state` (string / object / array) and a set of typed `questions`, and returns
a calibrated probability distribution per question in a single parallel pass:

- `choice` — one option from a named set; `criteria` is `{optionId: description}`;
  answer is `{choice, probabilities}`.
- `score` — position on ordered levels.
- `boolean` — `{probability}` = P(true).

Reached through the Vercel AI Gateway as `typesafe-ai/jev` with
`experimental_evaluate` from `ai` (needs `ai >= 7.0.107`; the repo was on
7.0.79). The gateway wire call is `POST <base>/evaluation-model` with
`ai-evaluation-model-specification-version: 4` and `ai-model-id`, which the
control plane's `/v1/ai/*` proxy already forwards (it passes every `ai-*`
header). A per-question confidence arrives at
`providerMetadata.typesafe.confidence[questionId]`.

Measured from this repo's gateway key: ~170 ms at the provider, ~440 ms cold
from a laptop, 364 input tokens, $0.000015 per call. Adding questions barely
moves latency, so everything is asked in ONE request.

Documented weaknesses that shape the design (docs.typesafe.ai
`model-jaggedness/jev-1.13`): literal reading; poor with double negatives and
indirection; a large state full of irrelevant detail acts as a distractor;
vulnerable to hostile framing inside `state`; English is best. So: small
state, atomic questions, plain positive option descriptions, and the model is
never trusted with anything but ORDER.

## 3. Division of labour

**Heuristics keep every decision they can make alone.** No model call when:

- the text reads as an address (`isProbablyUrl`) — typed or pasted URLs go
  where they say, exactly as today;
- fewer than 3 characters (a prefix, not an intent);
- the bar is still browsing (unedited prefill);
- one unbroken token longer than 32 characters (a pasted token or key, never
  an intent — and never something to send anywhere);
- `settings.search.smartSuggestions` is off, or no model is reachable
  (signed out, budget cap reached, offline): the host answers `null`.

**The model ranks; the shell decides.** The shell sends the candidate set it
could offer; the model returns probabilities over exactly those ids; a pure
policy function turns probabilities into an order. The model cannot introduce
a row, an address, or an action.

## 4. The request

One `evaluate` call, two `choice` questions (the docs' "speculative fan-out"):

`state` (kept small on purpose):

```json
{ "typed": "change theme color",
  "current_page": { "title": "…", "host": "…" },
  "recent_pages": [{ "title": "…", "host": "…" }] }
```

Titles and hosts only. Never full URLs, paths, or query strings.

`intent` — options `web_search`, `ai_prompt`, `open_page`, `browser_command`.
The line between the first two is drawn by what comes BACK, not by the
subject: a page of results, or a question whose answer is one live or local
fact (the weather, a score, opening hours), is the web's; an explanation —
how or why, reasons, differences, pros and cons, advice, ideas — or a task
handed over is the assistant's. The first wording gave the web "a fact, a
company, any thing they want to find pages about", and open questions about
a company or a cause read as searches or sat at 50/50 (§10).

`target` — one option per candidate the shell sent, plus `none`. Candidates:

- **command**: enabled chrome actions, Space switches, and the *settings
  intents* (§5);
- **page**: a handful of open tabs, kept pages and recent sites (the fuzzy
  ranker's best plus the most recent), so "my email" can find Gmail.

Bounds are enforced by the host, not trusted from the caller
(`sanitizeAddressIntentRequest`): ≤ 48 candidates, ≤ 6 recent pages, clipped
strings, 1.5 s timeout, no retries.

## 5. Settings intents — the paths the model can choose

`SETTINGS_SECTIONS` names 21 pages with captions like "Themes, gradients,
material". That is not enough for "change theme color", "make the sidebar
smaller", or "stop asking before closing tabs". A new catalog
(`packages/shell-ui/src/lib/settings-intents.ts`) lists the things a person
can CHANGE, each pointing at the section that changes it:

```ts
{ id: "theme", section: "appearance", title: "Theme & colors",
  description: "Change the theme, accent color, gradient and window material",
  keywords: ["dark mode", "light mode", "color", "background", "wallpaper"] }
```

Several intents may share a section. Each becomes a palette row
("Theme & colors — Settings › Appearance") that opens that section. The
keywords also feed the fuzzy ranker, so the rows are useful with no model.
A test asserts every `SettingsSection` is reachable from at least one intent,
so a new settings page cannot be added without a way to find it.

## 6. The ordering policy (`lib/intent-ranking.ts`, pure)

Inputs: the heuristic entry list, the full candidate map, the ranking.
Confidence-gated, per the model's own guidance:

- **Search versus AI.** The AI row takes ↵ from the web search when
  `P(ai_prompt) ≥ 0.55` and it leads `P(web_search)` by `≥ 0.15`. Having
  taken it, it keeps it until the web search leads IT by 0.15, or
  `P(ai_prompt)` falls under 0.4 (`aiLeadsSearch`): two lines rather than
  one, because successive answers about a sentence being typed are noisy
  readings of one intent, and a single line is crossed on the noise. Which
  side it is on belongs to the sentence, not the keystroke (§7). Hints are
  rewritten so ↵ is always on row one.
- **A target.** When `P(open_page) + P(browser_command) ≥ 0.5` and the best
  target (not `none`) has `P ≥ 0.5`, that row moves to the top. Other targets
  with `P ≥ 0.15` follow in probability order, then the rest of the heuristic
  list in its own order. A target between 0.25 and 0.5 is shown second —
  visible, never the default.
- **A near-certain target overrides the intent.** The two questions are
  answered independently and sometimes disagree: "my email" reads as a web
  search (0.73) while naming the open Gmail tab (0.84). A target with
  `P ≥ 0.8` leads whatever `intent` said. Ordinary searches put 0.95+ on
  `none`, and the trap queries in the live check ("youtube video about
  sourdough starter", "is it safe to clear cookies") stay searches.
- **A target row need not have fuzzy-matched.** "change theme color" shares
  no letters with "Appearance"; the policy pulls the entry from the candidate
  map.
- **Never promoted to ↵ by the model:** rows that destroy something (close
  tab, clear unpinned tabs). They may rise to second.
- **A typed address is untouched.** (No request is made at all.)
- **A strong fuzzy match still wins** over the model's search/AI order, as
  today; the model's target, when confident, goes above it.

## 7. Stability under the person's hands

The heuristic list paints immediately; the model's answer arrives 200–500 ms
later and may reorder it. Rules so that ↵ never does something the person did
not see:

- the rows an answer NAMES apply only if its `query` equals what is typed
  now: "amazon" names the Amazon tab, and ↵ on "amazon stock" a moment later
  must not open it;
- the choice between the two searches is held for the sentence. Typing on
  from words already answered ("how does this" → "how does this c") keeps
  the AI row where it was while the next answer is awaited, instead of
  handing ↵ back to the web search on every keystroke and taking it again
  300 ms later; a paste over the lot, or a new thought, starts from the
  heuristics;
- one question is in flight at a time, and when it comes back the next one
  is whatever is typed by then (`IntentAsker`). Every answer lands, at the
  model's own rate. Asking on each pause and dropping what was overtaken
  meant that at an ordinary typing speed nothing landed until the hands
  stopped — a question typed straight through and sent was a web search;
- an answer to EARLIER words of the same sentence, landing while the words
  as they stand are still unanswered, may move the search/AI choice and
  nothing else;
- answers are kept in a small LRU; a null (superseded, timed out, no model)
  is not an answer and is never kept, so the same words typed again are
  asked about again;
- once the person has moved the selection (arrows or mouse), the order is
  frozen for that query;
- if ↵ lands within 150 ms of a model-driven change to the list for the
  same words — a reorder, or a row the fuzzy pass never matched arriving on
  top — it acts on the row that was there BEFORE it, the one they were
  looking at when they decided.

The hosts still keep one live question per window and abort the one before
it; with one asker per bar that is a backstop, not the mechanism.

## 8. Privacy and abuse

Until now nothing typed in the address bar left the device before ↵. This
changes that, so:

- a setting, Settings → General → Search → "Smart suggestions"
  (`settings.search.smartSuggestions`, default on), with copy that says what
  is sent;
- addresses, short prefixes and long unbroken tokens are never sent (§3);
- history goes as title + host, six at most;
- desktop requests ride the device token through control's `/v1/ai/*` proxy,
  metered per account as `evaluation-model`, under the account's spend cap;
- page titles are untrusted input to the model. The blast radius is one
  wrong row order, bounded further by the no-destructive-promotion rule.

## 9. Where the code lives

| Piece | Place |
| --- | --- |
| Wire shapes, bounds, sanitizer | `packages/shell-contracts/src/address-intent.ts` |
| `ShellApi.rankAddressIntent(request) → ranking \| null` | `shell-contracts/src/ipc.ts`, desktop preload + main, cloud-browser `shell-host.ts` |
| The evaluator (questions, state, answer → ranking) | `packages/agent-runtime/src/address-intent.ts` |
| Desktop model handle | `apps/desktop/src/main/model-provider.ts` (`configuredIntentModel`) |
| Usage kind | `services/control/src/ai-usage.ts` |
| Settings intents, action descriptions, policy | `packages/shell-ui/src/lib/{settings-intents,action-intents,intent-ranking}.ts` |
| Asking (`IntentAsker`), and stability under the hands | `packages/shell-ui/src/lib/use-address-intent.ts`, wired in `components/address-palette.tsx`, `UrlBar.tsx`, `home/HomeSearch.tsx` |
| Live accuracy check | `packages/shell-ui/test/address-intent.live.test.ts` |
| End to end in the app, over a scripted model | `apps/desktop/e2e/tests/smart-suggestions.spec.ts` |

Model id: `PISTACHIO_INTENT_MODEL`, default `typesafe-ai/jev`; `off` disables.

## 10. Checking it

**Live accuracy** — the real model, catalog, request builder and policy.
Three measurements: which row ends up under ↵ for 55 labeled queries, eight
of them traps that name a row without asking for it; which of the two
searches leads for 149 open questions and lookups (65 of them written after
the option wording was fixed, to check it had not learned the rest); and how
often that choice changes while eight sentences are typed a character at a
time:

```
cd packages/shell-ui
PISTACHIO_INTENT_LIVE=1 pnpm vitest run test/address-intent.live.test.ts
```

As of 2026-10-05: heuristics alone 31/55, with the model 50/55, no plain
web search made worse, median 253 ms (p90 387 ms) from a laptop straight to
the gateway. The misses are ambiguous phrasings ("sign out of my account",
"which version am i on", "sync my tabs", "delete my browsing history",
"write something down"). Open questions that reach the assistant: 75/76
(the miss is a bare noun phrase, "advantages of nuclear power"); lookups
that stay web searches: 73/73. Typed out, each question changes sides once —
when the words become a question — and each lookup never: 5 changes over the
eight sentences, where every answer read alone gives 7.

The same test over the wording before it (2026-09-19 to 2026-10-05): 48/55,
26/76 open questions, 73/73 lookups, and 17 changes read alone — "how does
this company work" crossed the line seven times on its way to being typed.

The test asserts floors (≥ 75% and better than the heuristics, at most one
search broken, ≥ 85% of open questions and ≥ 95% of lookups, about one
change per sentence, a destructive row never first), not the measured
figures. Descriptions are what the model reads — a miss is usually fixed in
the option wording (`agent-runtime/src/address-intent.ts`),
`settings-intents.ts` or `action-intents.ts`, not in a threshold.

**In the app** — `PISTACHIO_INTENT_SCRIPT` (with `PISTACHIO_E2E=1`) replaces
the model with a scripted stand-in (`main/address-intent.ts`), so the spec
tests the address bar rather than a model's opinion. Specs that do not set
it run with no intent model at all, as before.
