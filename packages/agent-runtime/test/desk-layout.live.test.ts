/**
 * Live check of the desk's layout model: the real evaluation model through
 * the real gateway, on desks shaped like real ones. Skipped unless
 * PISTACHIO_LAYOUT_LIVE=1 and the workspace has a gateway key in `.env`.
 * Costs a few thousandths of a cent and sends only the synthetic titles below.
 *
 *   PISTACHIO_LAYOUT_LIVE=1 pnpm vitest run test/desk-layout.live.test.ts
 *
 * What it guards is the WORDING of the questions in `desk-layout.ts`: that a
 * new window opened for another window goes beside it, that peers compared
 * with one another are tiled, that one window of real work among references
 * gets the main place, that a split closes up when one side goes, and that a
 * quick look or a loose desk is left alone. The tally is printed; the
 * assertion is the floor.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createGateway } from "ai";
import { describe, expect, it } from "vitest";
import { decideDeskLayout, evaluateDeskLayout, type DeskLayoutMove, type DeskLayoutRequest, type DeskLayoutWindow } from "../src/desk-layout.js";

const envPath = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find((path) => existsSync(path));
const live = process.env["PISTACHIO_LAYOUT_LIVE"] === "1";
if (envPath !== undefined && live) process.loadEnvFile(envPath);
const key = process.env["AI_GATEWAY_API_KEY"];
const modelId = process.env["PISTACHIO_INTENT_MODEL"]?.trim() || "typesafe-ai/jev";

/** A window by title, site and place; `id` is its title's first word, lower-cased, for the expectations. */
function win(title: string, site: string, place: string, extra: Partial<DeskLayoutWindow> = {}): DeskLayoutWindow {
  return { id: title.split(/\W+/)[0]!.toLowerCase(), title, site, kind: "page", place, inUse: false, opened: false, ...extra };
}

interface Case {
  name: string;
  request: DeskLayoutRequest;
  /** The decisions that are right: a move, and for focus or pair the window by id. */
  expect: Array<{ move: DeskLayoutMove; main?: string; partner?: string }>;
}

const OPENED: DeskLayoutRequest["moves"] = ["keep", "pair", "tile", "focus"];
const CLOSED_TILED: DeskLayoutRequest["moves"] = ["keep", "fill", "tile", "focus"];
const CLOSED_LOOSE: DeskLayoutRequest["moves"] = ["keep", "tile", "focus"];
const ASKED: DeskLayoutRequest["moves"] = ["tile", "focus"];

const CASES: Case[] = [
  // ── A window came out ─────────────────────────────────────────────────────
  {
    name: "a vendor record opened while the inbox was in use goes beside the vendor's invoice",
    request: {
      trigger: "opened",
      windows: [
        win("Inbox (12) - Gmail", "mail.google.com", "the top-left quarter of the desk"),
        win("Invoice #2048 from Atlas Medical Supply - QuickBooks", "app.qbo.intuit.com", "the right half of the desk"),
        win("Atlas Medical Supply - Vendor record", "northstar.demo", "the bottom-left quarter of the desk, beside \"Inbox (12) - Gmail\", the two sharing what was its place", { opened: true, inUse: true }),
      ],
      gone: [],
      moves: OPENED,
      fillers: [],
    },
    expect: [{ move: "pair", partner: "invoice" }],
  },
  {
    name: "a third headphone page joins two being compared: tile them",
    request: {
      trigger: "opened",
      windows: [
        win("Sony WH-1000XM5 Wireless Noise Canceling Headphones - Amazon.com", "www.amazon.com", "the top-left quarter of the desk"),
        win("Bose QuietComfort Ultra Headphones - Amazon.com", "www.amazon.com", "the right half of the desk"),
        win("AirPods Max - Apple", "www.apple.com", "the bottom-left quarter of the desk, beside \"Sony WH-1000XM5 Wireless Noise Can…\", the two sharing what was its place", { opened: true, inUse: true }),
      ],
      gone: [],
      moves: OPENED,
      fillers: [],
    },
    expect: [{ move: "tile" }],
  },
  {
    name: "a second paper opened while writing the thesis: the thesis is the main work",
    request: {
      trigger: "opened",
      windows: [
        win("Thesis draft – Chapter 3 - Overleaf", "www.overleaf.com", "the top-left quarter of the desk"),
        win("Attention Is All You Need - arXiv", "arxiv.org", "the right half of the desk"),
        win("BERT: Pre-training of Deep Bidirectional Transformers - arXiv", "arxiv.org", "the bottom-left quarter of the desk, beside \"Thesis draft – Chapter 3 - Overleaf\", the two sharing what was its place", { opened: true, inUse: true }),
      ],
      gone: [],
      moves: OPENED,
      fillers: [],
    },
    // (Laying the whole desk out on its own takes a sure opinion; left as it is, ⌘⌥L gives the thesis the main place.)
    expect: [{ move: "focus", main: "thesis" }, { move: "pair", partner: "attention" }, { move: "keep" }],
  },
  {
    name: "a quick weather search is left where it came out",
    request: {
      trigger: "opened",
      windows: [
        win("Q3 roadmap - Linear", "linear.app", "the top-left quarter of the desk"),
        win("Checkout redesign - Figma", "www.figma.com", "the right half of the desk"),
        win("weather san francisco - Google Search", "www.google.com", "the bottom-left quarter of the desk, beside \"Q3 roadmap - Linear\", the two sharing what was its place", { opened: true, inUse: true }),
      ],
      gone: [],
      moves: OPENED,
      fillers: [],
    },
    expect: [{ move: "keep" }],
  },
  {
    name: "a hotel page opened from the trip plan already sits beside it",
    request: {
      trigger: "opened",
      windows: [
        win("Lisbon trip plan - Google Docs", "docs.google.com", "the top-left quarter of the desk"),
        win("Inbox (3) - Gmail", "mail.google.com", "the right half of the desk"),
        win("Memmo Alfama Hotel, Lisbon - Booking.com", "www.booking.com", "the bottom-left quarter of the desk, beside \"Lisbon trip plan - Google Docs\", the two sharing what was its place", { opened: true, inUse: true }),
      ],
      gone: [],
      moves: OPENED,
      fillers: [],
    },
    expect: [{ move: "keep" }, { move: "pair", partner: "lisbon" }],
  },
  // ── A window left ─────────────────────────────────────────────────────────
  {
    name: "one side of a split closed: the other takes the desk",
    request: {
      trigger: "closed",
      windows: [win("Fix race in session refresh by ana · Pull Request #412 - GitHub", "github.com", "the left half of the desk", { inUse: true })],
      gone: [{ title: "CI run #8812 - GitHub Actions", site: "github.com", place: "the right half of the desk", how: "closed" }],
      moves: CLOSED_TILED,
      fillers: ["Fix race in session refresh by ana · Pull Request #412 - GitHub"],
    },
    expect: [{ move: "fill" }, { move: "tile" }, { move: "focus", main: "fix" }],
  },
  {
    name: "the chat beside a contract and its template closed: the template grows into its place",
    request: {
      trigger: "closed",
      windows: [
        win("Services contract – Acme draft - Google Docs", "docs.google.com", "the left half of the desk", { inUse: true }),
        win("Master services agreement template - Google Docs", "docs.google.com", "the top-right quarter of the desk"),
      ],
      gone: [{ title: "legal | Slack", site: "app.slack.com", place: "the bottom-right quarter of the desk", how: "closed" }],
      moves: CLOSED_TILED,
      fillers: ["Master services agreement template - Google Docs"],
    },
    expect: [{ move: "fill" }, { move: "focus", main: "services" }],
  },
  {
    name: "one of four listings closed: the three left share the desk evenly",
    request: {
      trigger: "closed",
      windows: [
        win("2 bed apartment, Mission District - Zillow", "www.zillow.com", "the top-left quarter of the desk"),
        win("Sunny 2BR near Dolores Park - Zillow", "www.zillow.com", "the top-right quarter of the desk", { inUse: true }),
        win("Renovated 2 bedroom in Noe Valley - Zillow", "www.zillow.com", "the bottom-left quarter of the desk"),
      ],
      gone: [{ title: "Bernal Heights 2BR with garden - Zillow", site: "www.zillow.com", place: "the bottom-right quarter of the desk", how: "closed" }],
      moves: CLOSED_TILED,
      fillers: ["Sunny 2BR near Dolores Park - Zillow"],
    },
    expect: [{ move: "tile" }, { move: "fill" }],
  },
  {
    name: "a loose, overlapping desk is left alone when a window goes",
    request: {
      trigger: "closed",
      windows: [
        win("Hacker News", "news.ycombinator.com", "a medium window in the middle of the desk, overlapping others"),
        win("The Verge", "www.theverge.com", "a medium window at the top left, overlapping others", { inUse: true }),
        win("YouTube", "www.youtube.com", "a small window at the bottom right"),
      ],
      gone: [{ title: "Reddit - Dive into anything", site: "www.reddit.com", place: "a medium window at the top right, overlapping others", how: "collapsed" }],
      moves: CLOSED_LOOSE,
      fillers: [],
    },
    expect: [{ move: "keep" }],
  },
  // ── Asked ─────────────────────────────────────────────────────────────────
  {
    name: "a blog post being written among its sources: the post is the main work",
    request: {
      trigger: "asked",
      windows: [
        win("Why we moved off Kubernetes - draft - Notion", "www.notion.so", "a large window in the middle of the desk", { inUse: true }),
        win("Kubernetes cost analysis 2025 - Datadog", "www.datadoghq.com", "a medium window at the top right, overlapping others"),
        win("ECS vs EKS pricing - AWS", "aws.amazon.com", "a medium window at the bottom left, overlapping others"),
        win("Our infra spend (Q1–Q3) - Google Sheets", "docs.google.com", "a small window at the bottom right"),
      ],
      gone: [],
      moves: ASKED,
      fillers: [],
    },
    expect: [{ move: "focus", main: "why" }],
  },
  {
    name: "three flights compared: tile them",
    request: {
      trigger: "asked",
      windows: [
        win("SFO to JFK, Nov 12 - United Airlines", "www.united.com", "a medium window at the top left, overlapping others", { inUse: true }),
        win("San Francisco to New York - Delta", "www.delta.com", "a medium window in the middle, overlapping others"),
        win("JetBlue: SFO → JFK flights", "www.jetblue.com", "a medium window at the bottom right, overlapping others"),
      ],
      gone: [],
      moves: ASKED,
      fillers: [],
    },
    expect: [{ move: "tile" }],
  },
  {
    name: "code with its docs and an answer: the code is the main work",
    request: {
      trigger: "asked",
      windows: [
        win("HashMap in std::collections - Rust", "doc.rust-lang.org", "the left half of the desk"),
        win("src/cache.rs - shop-api - GitHub Codespaces", "github.dev", "the right half of the desk", { inUse: true }),
        win("How do I iterate a HashMap while mutating it? - Stack Overflow", "stackoverflow.com", "a small window at the top left, overlapping others"),
      ],
      gone: [],
      moves: ASKED,
      fillers: [],
    },
    expect: [{ move: "focus", main: "src" }],
  },
];

describe.skipIf(!live || key === undefined)("the desk's layout model, live", () => {
  it(
    "lays desks out the way a person would",
    async () => {
      const model = createGateway({ apiKey: key! }).evaluationModel(modelId);
      let right = 0;
      const lines: string[] = [];
      for (const testCase of CASES) {
        const evaluation = await evaluateDeskLayout({ model, request: testCase.request });
        const decision = decideDeskLayout(testCase.request, evaluation);
        const ok = testCase.expect.some(
          (want) =>
            want.move === decision.move &&
            (want.main === undefined || want.main === decision.main) &&
            (want.partner === undefined || want.partner === decision.partner),
        );
        if (ok) right += 1;
        const spread = evaluation === null ? "no answer" : Object.entries(evaluation.moves).filter(([, p]) => p > 0).map(([move, p]) => `${move} ${p.toFixed(2)}`).join(", ");
        const main = evaluation === null ? "" : Object.entries(evaluation.main).sort((a, b) => b[1] - a[1])[0];
        const partner = evaluation?.partner == null ? "" : ` partner ${Object.entries(evaluation.partner).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id, p]) => `${id || "none"} ${p.toFixed(2)}`).join(", ")}`;
        lines.push(
          `${ok ? "✓" : "✗"} ${testCase.name}\n    → ${decision.move}${decision.main !== null ? ` main=${decision.main}` : ""}${decision.partner !== null ? ` partner=${decision.partner}` : ""}  [${spread}] main ${main === "" ? "" : `${main![0]} ${main![1].toFixed(2)}`}${partner}  ${String(evaluation?.latencyMs ?? "")}ms`,
        );
      }
      console.log(`\n${lines.join("\n")}\n\n${String(right)}/${String(CASES.length)} right\n`);
      expect(right).toBeGreaterThanOrEqual(Math.ceil(CASES.length * 0.75));
    },
    120_000,
  );
});
