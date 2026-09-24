/**
 * Live check of the console router: the real evaluation model through the
 * real gateway, on requests shaped like a real sidebar's. Skipped unless
 * PISTACHIO_ROUTE_LIVE=1 and the workspace has a gateway key in `.env`.
 * Costs a few thousandths of a cent and sends only the synthetic text below.
 *
 *   PISTACHIO_ROUTE_LIVE=1 pnpm vitest run test/turn-route.live.test.ts
 *
 * What it guards is the WORDING of the question in `turn-route.ts`: that a
 * reply-shaped request (explain, shorten, write, what did you say) stays
 * off the browser path, that anything needing a live page or the web goes
 * to it, and that the traps — a general question that happens to mention
 * a site, a browser-ish verb used figuratively — land where a person would
 * expect. The tally is printed; the assertions are the floor.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createGateway } from "ai";
import { describe, expect, it } from "vitest";
import { evaluateTurnRoute } from "../src/turn-route.js";
import { decideTurnRoute, type TurnRoute, type TurnRouteRequest } from "../src/turn-route-contract.js";

const envPath = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find((path) => existsSync(path));
const live = process.env["PISTACHIO_ROUTE_LIVE"] === "1";
if (envPath !== undefined && live) process.loadEnvFile(envPath);
const key = process.env["AI_GATEWAY_API_KEY"];
const modelId = process.env["PISTACHIO_INTENT_MODEL"]?.trim() || "typesafe-ai/jev";

interface Case {
  message: string;
  expect: TurnRoute;
  /** Overrides on the base request: a thread with history, a page in view. */
  request?: Partial<TurnRouteRequest>;
}

const FRESH: TurnRouteRequest = {
  message: "",
  attachments: [],
  conversation: [],
  browserUsed: false,
  currentPage: { title: "Inbox (3) - Gmail", host: "mail.google.com" },
  tools: ["recall and remember things about the person", "set reminders", "read the person's Google Calendar"],
};

const RETURNS_THREAD: Partial<TurnRouteRequest> = {
  browserUsed: true,
  currentPage: { title: "Returns & Refunds | Example Store", host: "www.example-store.com" },
  conversation: [
    { who: "person", said: "what does this page say about returns?" },
    { who: "assistant", said: "Returns are accepted within 30 days of delivery with the receipt. Refunds go to the original payment method within 5-7 business days. Sale items are final." },
  ],
};

const CASES: Case[] = [
  // Replies on a fresh thread: general knowledge, writing, small talk.
  { message: "what is a hash map?", expect: "answer" },
  { message: "explain the difference between TCP and UDP in simple terms", expect: "answer" },
  { message: "write a polite email declining a meeting invitation", expect: "answer" },
  { message: "translate 'where is the train station' into Portuguese", expect: "answer" },
  { message: "give me a regex that matches a US phone number", expect: "answer" },
  { message: "what's 18% of 245?", expect: "answer" },
  { message: "hey, thanks for the help earlier!", expect: "answer" },
  { message: "draft a three-day itinerary outline for Lisbon, I'll fill in the details", expect: "answer" },
  { message: "remember that I prefer window seats", expect: "answer" },
  { message: "remind me at 5pm to call the dentist", expect: "answer" },
  { message: "what's on my calendar tomorrow?", expect: "answer" },
  // Replies on a thread that already read a page.
  { message: "shorten that to two sentences", expect: "answer", request: RETURNS_THREAD },
  { message: "so can I return a sale item?", expect: "answer", request: RETURNS_THREAD },
  { message: "what did you say the refund window was?", expect: "answer", request: RETURNS_THREAD },
  { message: "write that up as a note I can send my roommate", expect: "answer", request: RETURNS_THREAD },
  { message: "is 30 days typical for online stores?", expect: "answer", request: RETURNS_THREAD },
  // About the page in view: read once, no action.
  { message: "what does this page say?", expect: "page" },
  { message: "summarize this article", expect: "page" },
  { message: "what is this page about?", expect: "page" },
  { message: "tl;dr", expect: "page" },
  { message: "translate this page to spanish", expect: "page" },
  { message: "what's the return window on this page?", expect: "page", request: { currentPage: RETURNS_THREAD.currentPage! } },
  { message: "who wrote this?", expect: "page", request: { currentPage: { title: "Why we sleep — a review | The Atlantic", host: "www.theatlantic.com" } } },
  { message: "is this a good deal?", expect: "page", request: { currentPage: { title: "UPLIFT V2 Standing Desk – UPLIFT Desk", host: "www.upliftdesk.com" } } },
  // "Does this mention…" — a question with no other subject is about the attached page (§5.1).
  { message: "does this mention rules around typography?", expect: "page", request: { currentPage: { title: "Brand Guidelines 2026 – Acme", host: "acme.notion.site" } } },
  { message: "is there anything in here about refunds?", expect: "page", request: { currentPage: { title: "Terms of Service | Example Store", host: "www.example-store.com" } } },
  { message: "does it say when the sale ends?", expect: "page", request: { currentPage: { title: "Labor Day Sale – Up to 40% off | Example Store", host: "www.example-store.com" } } },
  { message: "does this cover server components?", expect: "page", request: { currentPage: { title: "What's new in React 19 – React Blog", host: "react.dev" } } },
  { message: "any mention of pricing?", expect: "page", request: { currentPage: { title: "Linear – Plan and build products", host: "linear.app" } } },
  { message: "what's the catch?", expect: "page", request: { currentPage: { title: "UPLIFT V2 Standing Desk – UPLIFT Desk", host: "www.upliftdesk.com" } } },
  // Browser work on a fresh thread.
  { message: "what's the weather in Denver this weekend?", expect: "browse" },
  { message: "find me a standing desk under $400", expect: "browse" },
  { message: "open my github notifications", expect: "browse" },
  { message: "click the reviews tab and tell me what people say", expect: "browse", request: { currentPage: { title: "UPLIFT V2 Standing Desk – UPLIFT Desk", host: "www.upliftdesk.com" } } },
  { message: "scroll down and read me the comments", expect: "browse" },
  { message: "book a table for two at 7 tonight at Nopa", expect: "browse" },
  { message: "check if the 9am flight to Chicago tomorrow still has seats", expect: "browse" },
  { message: "how much is bitcoin right now?", expect: "browse" },
  { message: "reply to the top email in my inbox saying I'll be there", expect: "browse" },
  { message: "what are the latest headlines about the fed?", expect: "browse" },
  { message: "log in to my bank and tell me my checking balance", expect: "browse" },
  { message: "fill in the shipping form with my home address", expect: "browse" },
  // Browser work on a thread that already read a page.
  { message: "now check what their shipping policy says", expect: "browse", request: RETURNS_THREAD },
  { message: "start the return for my last order", expect: "browse", request: RETURNS_THREAD },
  { message: "does the FAQ page say anything about exchanges?", expect: "browse", request: RETURNS_THREAD },
  // The returns page is the one in view: re-checking it is one fresh read of the attached page.
  { message: "is that still the policy? re-check the page", expect: "page", request: RETURNS_THREAD },
  // Traps: browser words used figuratively, a site named in a general question.
  { message: "how does google's pagerank algorithm work?", expect: "answer" },
  { message: "what does 'navigate' mean in the context of react router?", expect: "answer" },
  { message: "explain how cookies work in a browser", expect: "answer" },
  { message: "search my memory: what did I say my shirt size was?", expect: "answer" },
];

describe.skipIf(!live || key === undefined)("console router (live model)", () => {
  it("sends replies off the browser path and browser work onto it", { timeout: 120_000 }, async () => {
    const model = createGateway({ apiKey: key! }).evaluationModel(modelId);
    const rows: string[] = [];
    let right = 0;
    let latencyTotal = 0;
    const misses: string[] = [];
    for (const item of CASES) {
      const request: TurnRouteRequest = { ...FRESH, ...item.request, message: item.message };
      const evaluation = await evaluateTurnRoute({ model, request });
      const decision = decideTurnRoute(evaluation);
      const ok = decision.route === item.expect;
      if (ok) right += 1;
      else misses.push(item.message);
      latencyTotal += evaluation?.latencyMs ?? 0;
      rows.push(
        evaluation === null
          ? `${ok ? "✓" : "✗"} ${item.expect.padEnd(6)} got ${decision.route.padEnd(6)} NO OPINION (null: timeout, refusal or error)  ${item.message}`
          : `${ok ? "✓" : "✗"} ${item.expect.padEnd(6)} got ${decision.route.padEnd(6)} answer=${evaluation.routes.answer.toFixed(2)} conf=${evaluation.confidence.toFixed(2)} ${String(evaluation.latencyMs).padStart(4)}ms  ${item.message}`,
      );
    }
    console.log(`[route live] ${modelId}: ${String(right)}/${String(CASES.length)} right, mean ${String(Math.round(latencyTotal / CASES.length))} ms\n${rows.join("\n")}`);
    // The floor: nine in ten, and never a browse case answered from memory
    // about something that changes — a miss there is a wrong answer (or,
    // routed to the page, one short call before the hand-off), a miss the
    // other way is a slow one.
    expect(right / CASES.length).toBeGreaterThanOrEqual(0.9);
    for (const item of CASES) {
      if (item.expect === "browse" && misses.includes(item.message)) {
        expect(item.message, "a live-page request must not be answered from memory").toBe("");
      }
    }
  });
});
