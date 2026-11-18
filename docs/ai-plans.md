# A person's own AI plan

Pistachio's models come with the account and are metered. A person who already pays for ChatGPT can sign in with it, and the agent's turns then run on their plan instead: the same agent, the same tools, the same chat — billed to a plan they already have.

Desktop only: the sign-in and its tokens are this Mac's. One plan today, ChatGPT; every shape is keyed by plan, so another is an entry (§8 says why there is no second one yet). Builds on `docs/console-routing.md` (turns) and `docs/desk-agent.md` (where the person talks to the agent).

## 1. What a person does

- Opens **Settings → AI plan** (or presses *Continue with ChatGPT* beside the model meter in Settings → Account). The card is **Use your ChatGPT plan**.
- Presses **Continue with ChatGPT**. Their browser opens OpenAI's sign-in page; they sign in and allow it; the tab says *You're signed in* and Pistachio comes to the front.
- The first time ever, a sheet: **You're using your ChatGPT plan** — *Got it*. Never again after that.
- Asks the agent anything, as before. Beside the composer: **Using ChatGPT plan** · *Manage usage*.
- When the plan's limit is reached, the turn stops on a sentence that says so. The line by the composer becomes **Usage limit reached** · *Manage usage* · *Try again* · *Use Pistachio's models*; a notice says it once, wherever they are.
- Signs out under Settings → AI plan. Signing in again is one step: the registration is remembered.

## 2. Signing in

OpenAI's *Sign in with ChatGPT* with **ChatGPT plan usage** (developers.openai.com/siwc, the open-source/local flow): OAuth 2.0 with PKCE for a public client that OpenAI registers for the person as they first sign in. `apps/desktop/src/main/ai-plans/siwc.ts` is the whole of it, pure over the endpoints and the fetch it is handed.

- **The page** is opened in the person's default browser (`shell.openExternal`), never in a view of Pistachio's own: the first sign-in asks with `client_id=dynamic_agent_client`, `agent_name_hint=Pistachio` and this install's `ext_agent_host_id` (a `urn:uuid:` made once and kept for good); a later one asks with the client id OpenAI issued, the kept ID token as `id_token_hint` and the email as `login_hint`, and never sends the name again. Scopes: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`; `resource=https://api.openai.com/v1`.
- **The callback** is a loopback listener (`callback.ts`) on `127.0.0.1` alone, a port the system picks, path `/auth/callback`. It is up only while a page is out, answers one request and closes. A callback counts only if its `state` is this attempt's; a first registration must come back with an issued client id; a returning sign-in that comes back naming another is refused.
- **The exchange** is under the issued id, with the attempt's verifier and its exact callback address. The **ID token** is verified before anything is kept — signature against OpenAI's published keys (taken only from the issuer's own origin), issuer, audience, expiry, nonce — and `sub` is who signed in. A registration is one account's: signing in to it as someone else is refused, and *Use a different account* registers anew.
- **Plan usage is a scope**, not a sign-in: without `chatgpt.tokens.use.direct` in the grant nothing is ever sent on the plan. The tokens of such a sign-in are ended rather than kept, and the next try — which the person asks for — asks for consent.
- **Refresh**: an hour's access token is renewed five minutes before it lapses, one refresh at a time (the refresh token is spent by its use; two would race for its replacement), and the replacement is written before it is used. A network that is down concludes nothing: a token still in date is used as it is.
- **Sign-out** revokes the session at OpenAI's revocation endpoint (a few tries), then clears the tokens whether or not it was confirmed; when it was not, the card says so and where to finish it (ChatGPT's settings).

**What is kept** (`store.ts`): `<userData>/ai-plans.json`, written whole and atomically, mode 0600. The host id and the registration (client id, subject, email) are in the clear and outlive a sign-out. The session — access, refresh and ID tokens — is sealed with the Mac's keychain (Electron `safeStorage`, as the account's own secrets are); where the keychain cannot seal, sign-in is refused and nothing is written. A session this Mac can no longer open (a restored profile) is a sign-in owed, not a session. No token is in any snapshot, log or address but the authorize URL's `id_token_hint`, which is opened and never logged.

## 3. A turn on the plan

The agent's loop is unchanged. `RunController` asks `ownModel()` as each turn begins (main: `AiPlanService.turn()`):

- **null** — the chat is not on a plan: Pistachio's models, as ever.
- **a model** — the AI SDK's OpenAI provider (`@ai-sdk/openai`, the Responses API) at `https://api.openai.com/v1`, through `planFetch` (`plan-request.ts`). Asked once per turn, so a turn that hands off from the answer path to the browser path stays on what it began on.
- **blocked** — the plan is chosen and cannot serve the turn. The turn stops on that sentence, before the router or a model step is spent.

**While the plan is chosen, a turn never runs on Pistachio's models instead.** OpenAI does not move a request to another way of paying, and neither does Pistachio: the switch is the person's, one press.

**The request, as the plan's route takes it** (`planRequestBody`; OpenAI's "Preview limitations"). The route is the public Responses API with a preview's rules, kept in one place whatever the provider library sends:

- `store: false` and `stream: true`, always; the context rides in `input`. A call that did not ask for a stream — a compaction summary, a model scripted for a test — still gets one from the route, and `collectPlanResponse` hands back the finished response it closes with.
- System text is `instructions` (a system-role item is rejected).
- Function tools are grouped in one namespace, `pistachio`; a function call played back as history names it.
- The fields the route refuses are left out (`temperature`, `max_output_tokens`, `metadata`, `previous_response_id`, …).
- Never ChatGPT's own backend, only `POST /v1/responses` and `GET /v1/models`.

**What comes back**: the stream is read on its way to the library (`watchPlanStream`) for a finished response's usage and for a late failure — a limit can arrive after the first words. A failure the plan explains is a `PlanError`, whose message is one of Pistachio's own sentences picked by the error's code (`planFailure`); the provider's text is never shown, logged or put in a snapshot — its bodies can name the account. A failure the plan does not explain (a malformed request, a server error) reaches the library as a copy with the same status and the provider's code and parameter where they are plain words, under a plain sentence of Pistachio's (`plainErrorResponse`) — so what the library retries it still retries, and nothing of the provider's wording is kept with the thread. The library may wrap a `PlanError` on the way; `findPlanError` looks down the chain of causes.

**A thread that changes hands** (`history.ts`). A thread can go on under the plan after turns on Pistachio's models, and back. Reasoning travels sealed for the route that wrote it, and the item ids the library keeps are that route's: `portableHistory` drops both, once, at the turn where the source changes (`ThreadRecord.source`); what was said, called and answered stays. A thread that stays on one source is never touched.

**What the plan covers**: the agent's turns — the Bar, the home chat, a reminder's task, the builder a turn commissions. The small things around them stay on Pistachio's models and its meter: the router, address-bar intent, Tidy, memory, embeddings, read-aloud and dictation, the brief, pages the agent builds. Cloud runs are the cloud browser's and use Pistachio's models.

## 4. The states

`AiPlanStatus` (`packages/shell-contracts/src/ai-plans.ts`), each with the way out the person can take:

| State | Means | A turn | The way out |
| --- | --- | --- | --- |
| `off` | not connected | Pistachio's models | *Continue with ChatGPT* |
| `connecting` | the sign-in page is out | as before it | finish it, or *Cancel* (given up after 10 minutes) |
| `ready` | signed in, plan usage granted | **the plan** (when chosen) | — |
| `limit` | a usage limit was reached — the plan's, or the one set for Pistachio | stops: *paused* | *Manage usage*, then *Try again*; or *Use Pistachio's models* |
| `signIn` | the session is over (expired, revoked, disconnected in ChatGPT) | stops: *sign in again* | *Continue with ChatGPT* — the same registration |
| `ineligible` | plan usage is not available to this account, workspace or policy | stops: *not available* | *Use Pistachio's models*, or another account |

Codes → states: `subscription_sharing_usage_limit_exceeded` (and the workspace variant) → `limit`; `…_user_not_eligible` → `ineligible`; `…_invalid_user`, a 401 that a fresh token does not cure, any terminal refresh error → `signIn`; `…_usage_unavailable`, `…_user_unavailable`, 503 → said, nothing changed; `…_unsupported_capability`, `…_route_not_supported`, `chatpass_v2_*` → said, with the parameter refused.

A limit **pauses**: the next turn is not sent. Nothing is known of when a limit lifts and nothing is guessed; *Try again* is the person's, and what the next request says decides.

**The check.** OpenAI does not tell an app when it is disconnected in ChatGPT's settings. The account's models are read shortly after launch, every six hours, and whenever Settings → AI plan opens; that renews the sign-in when due and finds an ended one before a turn does.

## 5. What the person sees

- **Settings → AI plan** (`sections/ai-plan.tsx`): the card *Use your ChatGPT plan* — the account and its state, *Use it for the chat*, the model (the account's own catalog, `visibility: "list"`, the server's order; Pistachio's default model when the account lists it), what is wrong and what to do, *Sign out of ChatGPT*. *ChatGPT plan usage*: Pistachio's own count over 30 days — total, peak per day, active days — with *Manage usage*. *Pistachio's models*: what the chat is on, and what never moves to the plan.
- **Beside the composer** (`chat/PlanLine.tsx`, in the Bar and the home chat): *Using ChatGPT plan* · *Manage usage*; or the stalled state with its actions. Nothing when the chat is on Pistachio's models.
- **Notices** (`lib/ai-plans/use-ai-plans.ts`, `planNotice`): a change of state is said once, when it happens — connected, a limit reached (*Manage usage*), a sign-in needed (*Sign in*), usage not available, a sign-in that did not finish. Never for what was already so when the window opened.
- **Settings → Account**: beside the model meter, an invitation while no plan is connected, and where the chat stands once one is.
- **The agent** knows the page exists and opens it when asked (`PISTACHIO_GUIDE`); it cannot connect a plan — the sign-in is the person's.

The words are OpenAI's where it asks for them (its UI/UX guidelines for ChatGPT plan usage): **Continue with ChatGPT**, **You're using your ChatGPT plan** / **Got it** (once), **Using ChatGPT plan**, **Usage limit reached** with **Manage usage** as the first action and Pistachio's own models as the second.

## 6. What is left of a plan

**Pistachio does not know, and does not pretend to.** On this route OpenAI gives an app no remaining-usage number, no percentage and no reset time, and asks apps not to infer one. What the person is shown is therefore:

- the connection's state, the moment a request or the check says it;
- that a limit was reached, when it is;
- Pistachio's own count of what it sent (requests and tokens by day, this Mac only);
- *Manage usage*, wherever usage is mentioned, to `https://chatgpt.com/settings/usage` — in the browser they signed in with — where ChatGPT shows the plan's usage and the limit they can set for Pistachio.

## 7. Files and tests

- `apps/desktop/src/main/ai-plans/`: `siwc.ts` (the OAuth flow), `callback.ts` (the loopback listener), `store.ts` (what is kept), `plan-request.ts` (the request, the errors, the stream), `model.ts` (the model and the catalog), `history.ts` (a thread changing hands), `service.ts` (the state and the seam).
- `packages/shell-contracts/src/ai-plans.ts` (the snapshot and the requests; `aiPlans` / `onAiPlans` in `ipc.ts`), `packages/shell-ui/src/lib/ai-plans/use-ai-plans.ts`, `components/settings/sections/ai-plan.tsx`, `components/chat/PlanLine.tsx`.
- `run-controller.ts`: `ownModel`, `OwnModelTurn`, the source switch; `thread-store.ts`: `source`.
- **A stand-in for OpenAI** (`apps/desktop/test/support/openai-standin.ts`) checks what the real service checks — PKCE, the exact loopback address, the issued client id, a refresh token that works once, a really signed ID token, the bearer on each request — so a flow that passes was done properly.
- Unit: `apps/desktop/test/ai-plans.test.ts` (sign-in, request shape, errors, refresh, states), `test/run-controller.test.ts` ("the person's own plan in a turn"), `packages/shell-ui/test/ai-plans.test.ts` (notices, the fold, the contract).
- E2E: `apps/desktop/e2e/tests/ai-plan.spec.ts` — the real app against the stand-in over HTTP (`PISTACHIO_E2E_AI_PLAN`): sign in, a turn, a limit, switching, back, sign out. Under a test run no browser is opened (main walks the redirect itself) and nothing is sealed in the keychain.

## 8. Whose rules these are

- **OpenAI.** ChatGPT plan usage is offered to "open-source tools and personal projects that run locally"; a paid or remotely hosted app is asked to join a waitlist. Whether Pistachio as shipped qualifies is OpenAI's call and the project's to settle with them — the flow needs no pre-registration, so it works either way, which is not the same as being permitted. Its guidelines also ask that an app's pricing page say which of its plans support ChatGPT plan usage: Settings says "works with every Pistachio plan"; the website does not say anything yet. OpenAI's own Electron example (`openai/sign-in-with-chatgpt-devkit`) is under a noncommercial licence and was read for reference only; nothing is copied from it.
- **Why there is no Claude plan.** Anthropic's terms do not let a third-party app offer Claude.ai sign-in or route requests through a person's Pro/Max plan without Anthropic's prior approval — including agents built on the Claude Agent SDK. Other projects drive the person's installed Claude Code instead and consider that within the terms; that is a judgement for the project to make with Anthropic, not one to build past. The shapes here (`AiPlanProvider`, a view per plan, `OwnModelTurn.source`) take a second plan as an entry.

## 9. Not done

- Verified against a stand-in and against OpenAI's public discovery document, not against a real ChatGPT account: the first real sign-in is the person's to do. Two things the docs leave open are handled both ways and worth watching then: whether the route wants function tools in a namespace (they are sent in one) and whether `response.completed` carries the whole response for a call that did not ask to stream (it is assumed to, as on the public API).
- One account at a time; no picker of saved accounts.
- The plan's model list is the account's; reasoning effort and speed are not offered.
- No onboarding step for it, and nothing on the website's pricing page.
- The web app and cloud runs use Pistachio's models.
