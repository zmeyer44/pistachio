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

- **Search versus AI.** The AI row takes ↵ from the web search only when
  `P(ai_prompt) ≥ 0.55` and it leads `P(web_search)` by `≥ 0.15`. Otherwise
  the web search stays first. Hints are rewritten so ↵ is always on row one.
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

- an answer applies only if its `query` equals what is typed now;
- once the person has moved the selection (arrows or mouse), the order is
  frozen for that query;
- if ↵ lands within 150 ms of a model-driven change to the list — a
  reorder, or a row the fuzzy pass never matched arriving on top — it acts
  on the row that was there BEFORE it, the one they were looking at when
  they decided;
- requests are debounced (120 ms), de-duplicated through a small LRU, and
  only the latest is awaited (a sequence number; the host aborts the rest).

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
| Asking, and stability under the hands | `packages/shell-ui/src/lib/use-address-intent.ts`, wired in `components/address-palette.tsx`, `UrlBar.tsx`, `home/HomeSearch.tsx` |
| Live accuracy check | `packages/shell-ui/test/address-intent.live.test.ts` |
| End to end in the app, over a scripted model | `apps/desktop/e2e/tests/smart-suggestions.spec.ts` |

Model id: `PISTACHIO_INTENT_MODEL`, default `typesafe-ai/jev`; `off` disables.

## 10. Checking it

**Live accuracy** — the real model, catalog, request builder and policy;
measures which row ends up under ↵ for 53 labeled queries, eight of them
traps that name a row without asking for it:

```
cd packages/shell-ui
PISTACHIO_INTENT_LIVE=1 pnpm vitest run test/address-intent.live.test.ts
```

As of 2026-09-19: heuristics alone 31/53, with the model 50/53, no plain
web search made worse, median 257 ms (p90 354 ms) from a laptop straight to
the gateway. The three misses are ambiguous phrasings ("sign out of my
account", "which version am i on", "sync my tabs"). The test asserts a floor
(≥ 75%, better than the heuristics, at most one search broken, a destructive
row never first), not the measured figure. Descriptions are what the model
reads — a miss is usually fixed in `settings-intents.ts` or
`action-intents.ts`, not in a threshold.

**In the app** — `PISTACHIO_INTENT_SCRIPT` (with `PISTACHIO_E2E=1`) replaces
the model with a scripted stand-in (`main/address-intent.ts`), so the spec
tests the address bar rather than a model's opinion. Specs that do not set
it run with no intent model at all, as before.
