import type { Experimental_CompositionEvaluator, Spec } from "@json-render/core";
import type { Experimental_EvaluationModel } from "ai";
import { describe, expect, it } from "vitest";
import { buildBriefDraft, templateHeadline, toneOf } from "../src/brief/candidates.js";
import { composeBrief, defaultSpec, guardLayout } from "../src/brief/compose.js";
import { generateBrief } from "../src/brief/generate.js";
import { briefTitle, localDay, senderName, sortEvents } from "../src/brief/materials.js";
import { triageByRules, triageMail } from "../src/brief/triage.js";
import { sanitizeHeadline } from "../src/brief/writer.js";
import { briefUrl, briefUrlDate, isTickPath, tickPath } from "../src/contract.js";
import { validateReportSpec } from "../src/validate.js";
import { monday } from "./fixtures.js";

function rules(materials = monday()) {
  return new Map(materials.messages.map((message) => [message.id, triageByRules(message)]));
}

function slotsOf(spec: Spec): Record<string, string[]> {
  return (spec.elements[spec.root]?.slots ?? {}) as Record<string, string[]>;
}

function typesIn(spec: Spec, slot: string): string[] {
  return (slotsOf(spec)[slot] ?? []).map((id) => spec.elements[id]?.type ?? "?");
}

/** Answers every question with the option a rule picks; records what it was asked. */
function scripted(pick: (id: string, options: string[]) => string, asked: string[][] = []): Experimental_CompositionEvaluator {
  return ({ questions }) => {
    asked.push(Object.keys(questions));
    return Promise.resolve({
      answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, { choice: pick(id, Object.keys(question.criteria)), confidence: 0.9 }])),
    });
  };
}

type EvaluationModelV4 = Exclude<Experimental_EvaluationModel, string>;
type EvaluationCall = Parameters<EvaluationModelV4["doEvaluate"]>[0];

/** A stand-in for Jev: answers every choice question as told, with the winner at `weight`. */
function fakeJev(pick: (id: string, options: string[]) => string, weight = 0.9): { model: EvaluationModelV4; calls: EvaluationCall[] } {
  const calls: EvaluationCall[] = [];
  return {
    calls,
    model: {
      specificationVersion: "v4",
      provider: "typesafe-ai",
      modelId: "jev",
      supportedQuestionTypes: ["choice", "score", "boolean"],
      doEvaluate(options) {
        calls.push(options);
        const answers = Object.fromEntries(
          Object.entries(options.questions).map(([id, question]) => {
            const keys = Object.keys((question as { criteria: Record<string, unknown> }).criteria);
            const choice = pick(id, keys);
            const rest = keys.length > 1 ? (1 - weight) / (keys.length - 1) : 0;
            return [id, { type: "choice" as const, choice, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? weight : rest])) }];
          }),
        );
        return Promise.resolve({ answers, warnings: [] });
      },
    },
  };
}

describe("materials", () => {
  it("names the brief after the reader's own weekday, not UTC's", () => {
    // 02:00 UTC on Tuesday is still Monday evening in New York.
    expect(briefTitle(new Date("2026-09-22T02:00:00.000Z"), { locale: "en-US", timezone: "America/New_York" })).toBe("The Monday Brief");
    expect(localDay(new Date("2026-09-22T02:00:00.000Z"), "America/New_York")).toBe("2026-09-21");
  });

  it("reads a sender's name out of a mailbox", () => {
    expect(senderName('"Dana Whitfield" <dana@example.com>')).toBe("Dana Whitfield");
    expect(senderName("dana@example.com")).toBe("dana@example.com");
  });
});

describe("mail triage", () => {
  it("falls back to Gmail's labels without a model", async () => {
    const result = await triageMail(monday().messages, { model: null });
    expect(result.by).toBe("rules");
    expect([...result.verdicts.values()].map((verdict) => verdict.role)).toEqual(["reply", "update", "skip"]);
  });

  it("lets the model re-sort mail but never promotes a labelled promotion to reply", async () => {
    const jev = fakeJev((id) => (id === "mail_0" ? "update" : "reply"));
    const result = await triageMail(monday().messages, { model: jev.model });
    expect(result.by).toBe("jev");
    expect(result.verdicts.get("m1")).toMatchObject({ role: "update", by: "jev" });
    expect(result.verdicts.get("m2")).toMatchObject({ role: "reply", by: "jev" });
    expect(result.verdicts.get("m3")).toMatchObject({ role: "skip", by: "rules" });
    // The model saw senders and opening lines, never a body or an address book.
    expect(JSON.stringify(jev.calls[0]?.state)).toContain("Finance is waiting on it");
  });

  it("keeps the rules' verdict when the model is unsure or fails", async () => {
    const unsure = await triageMail(monday().messages, { model: fakeJev(() => "skip", 0.4).model });
    expect(unsure.by).toBe("rules");
    expect(unsure.verdicts.get("m1")?.role).toBe("reply");
    const broken = await triageMail(monday().messages, { model: fakeJev(() => { throw new Error("spend cap"); }).model });
    expect(broken.by).toBe("rules");
  });
});

describe("the draft", () => {
  it("offers presentations of one block as alternatives under one resource", () => {
    const draft = buildBriefDraft(monday(), rules());
    const schedule = draft.candidates.filter((candidate) => candidate.resource === "schedule");
    expect(schedule.map((candidate) => candidate.element.type)).toEqual(["Timeline", "AgendaList"]);
    expect(draft.candidates.filter((candidate) => candidate.resource === "focus").length).toBeGreaterThanOrEqual(2);
    expect(new Set(draft.candidates.map((candidate) => candidate.id)).size).toBe(draft.candidates.length);
  });

  it("puts noise nowhere and mail that needs a reply in its own block", () => {
    const draft = buildBriefDraft(monday(), rules());
    const text = JSON.stringify(draft.candidates);
    expect(text).not.toContain("40% off");
    const reply = draft.candidates.find((candidate) => candidate.id === "reply_cards");
    expect(JSON.stringify(reply?.element.props)).toContain("Finance is waiting on it");
  });

  it("gives every Prep me prompt real identifiers to look up", () => {
    const draft = buildBriefDraft(monday(), rules());
    const timeline = draft.candidates.find((candidate) => candidate.id === "schedule_timeline");
    const prompts = JSON.stringify(timeline?.element.props);
    expect(prompts).toContain("Where to look:");
    expect(prompts).toContain("https://calendar.google.com/e1");
    const focus = draft.candidates.find((candidate) => candidate.id === "focus_mail_0");
    expect(JSON.stringify(focus?.element.props)).toContain("Gmail thread t1");
  });

  it("tells the composer how many pages were read but not their titles unless that is allowed", () => {
    const hidden = buildBriefDraft(monday(), rules()).candidates.find((candidate) => candidate.id === "reading_cards");
    expect(hidden?.description).not.toContain("Local-first");
    const shared = buildBriefDraft(monday({ pagesShareable: true }), rules()).candidates.find((candidate) => candidate.id === "reading_cards");
    expect(shared?.description).toContain("Local-first");
  });

  it("reads the day's shape from the calendar", () => {
    expect(toneOf(monday(), 1)).toBe("clear");
    expect(toneOf(monday({ events: [] }), 1)).toBe("focus");
    expect(toneOf(monday({ events: [], todos: [] }), 0)).toBe("quiet");
    expect(templateHeadline(monday(), 1)).toBe("3 meetings ahead, next at 9:30 AM · 1 email waiting on you · 2 to-dos open.");
  });

  it("finds the next meeting across calendars that each answered in their own order", () => {
    // 08:00 in New York. The primary calendar's 3 PM comes first in the list; a shared calendar's 8:30 AM after it.
    const events = [
      { id: "late", title: "Board prep", start: "2026-09-21T19:00:00.000Z", end: "2026-09-21T20:00:00.000Z", allDay: false, location: "", meetingUrl: null, webUrl: "https://calendar.google.com/late" },
      { id: "soon", title: "Standup", start: "2026-09-21T12:30:00.000Z", end: "2026-09-21T12:45:00.000Z", allDay: false, location: "", meetingUrl: null, webUrl: "https://calendar.google.com/soon" },
      { id: "day", title: "Offsite", start: "2026-09-21", end: "2026-09-22", allDay: true, location: "", meetingUrl: null, webUrl: "https://calendar.google.com/day" },
    ];
    const materials = monday({ events, messages: [] });
    expect(templateHeadline(materials, 0)).toContain("next at 8:30 AM");
    const draft = buildBriefDraft(materials, new Map());
    expect(draft.candidates.find((candidate) => candidate.id === "focus_meeting")?.description).toContain("Standup");
    expect(draft.context["minutes_until_next_meeting"]).toBe(30);
    const agenda = draft.candidates.find((candidate) => candidate.id === "schedule_agenda")?.element.props as { items: { title: string }[] };
    expect(agenda.items.map((item) => item.title)).toEqual(["Offsite", "Standup", "Board prep", "Send the deck"]);
    expect(sortEvents(events).map((event) => event.id)).toEqual(["day", "soon", "late"]);
  });

  it("asks for a connection only where connecting is possible", () => {
    const sources = [
      { source: "calendar" as const, state: "not_connected" as const, connectable: true, accountLabel: null, count: 0 },
      { source: "gmail" as const, state: "not_connected" as const, connectable: false, accountLabel: null, count: 0 },
    ];
    const ids = buildBriefDraft(monday({ sources, events: [], messages: [] }), new Map()).candidates.map((candidate) => candidate.id);
    expect(ids).toContain("notice_calendar");
    expect(ids).not.toContain("notice_gmail");
  });
});

describe("composition", () => {
  it("builds a valid page with no model at all", async () => {
    const brief = await generateBrief(monday(), { decide: null, write: null });
    expect(brief.builtWith).toMatchObject({ composer: "default", writer: null, triage: "rules", evaluations: 0 });
    expect(brief.title).toBe("The Monday Brief");
    expect(validateReportSpec(brief.spec).ok).toBe(true);
    expect(typesIn(brief.spec, "header")).toEqual(["Masthead"]);
    expect(typesIn(brief.spec, "main")).toEqual(["FocusCard", "Timeline", "MessageCards", "SourceList", "LinkCards"]);
    expect(typesIn(brief.spec, "aside")).toEqual(["Checklist", "SourceList", "StatPanel", "SourceList"]);
  });

  it("lets the evaluator choose presentations and placement", async () => {
    const asked: string[][] = [];
    const draft = buildBriefDraft(monday(), rules());
    const result = await composeBrief(draft, {
      model: null,
      evaluate: scripted((id, options) => {
        if (id === "root") return "page";
        if (id.startsWith("select_")) return options.find((option) => option === "use:schedule_agenda" || option === "use:reply_rows") ?? options[1] ?? "omit";
        if (id.startsWith("parent_")) return options.find((option) => option.endsWith(":main")) ?? options[0] ?? "";
        return options[0] ?? "";
      }, asked),
    });
    expect(result.composer).toBe("jev");
    expect(asked).toHaveLength(2);
    const types = Object.values(result.spec.elements).map((element) => element.type);
    expect(types).toContain("AgendaList");
    expect(types).not.toContain("Timeline");
    expect(validateReportSpec(result.spec).ok).toBe(true);
    // Everything was sent to main; the guard put the masthead back on top.
    expect(typesIn(result.spec, "header")).toEqual(["Masthead"]);
    expect(result.guard.moved.length).toBeGreaterThan(0);
  });

  it("restores blocks with content that the evaluator left out, and keeps wide blocks out of the aside", async () => {
    const draft = buildBriefDraft(monday(), rules());
    const result = await composeBrief(draft, {
      model: null,
      evaluate: scripted((id, options) => {
        if (id === "root") return "page";
        if (id.startsWith("select_")) return options.includes("use:numbers") || options.includes("use:schedule_timeline") ? (options[1] ?? "omit") : "omit";
        if (id.startsWith("parent_")) return options.find((option) => option.endsWith(":aside")) ?? "";
        return options[0] ?? "";
      }),
    });
    expect(result.guard.restored).toEqual(expect.arrayContaining(["masthead_clear", "todos", "reply_cards"]));
    expect(typesIn(result.spec, "aside")).not.toContain("Timeline");
    expect(typesIn(result.spec, "main")).toContain("Timeline");
    expect(typesIn(result.spec, "header")).toEqual(["Masthead"]);
    expect(validateReportSpec(result.spec).ok).toBe(true);
  });

  it("runs end to end through the AI SDK with an evaluation model", async () => {
    const jev = fakeJev((id, options) => {
      if (id === "root") return "page";
      if (id.startsWith("mail_")) return id === "mail_0" ? "reply" : "skip";
      if (id.startsWith("select_")) return options[1] ?? "omit";
      if (id.startsWith("parent_")) return options.find((option) => option.endsWith(":main")) ?? "";
      return options[0] ?? "";
    });
    const brief = await generateBrief(monday(), { decide: { id: "typesafe-ai/jev", model: jev.model }, write: null });
    expect(brief.builtWith).toMatchObject({ composer: "jev", composerModel: "typesafe-ai/jev", triage: "jev", evaluations: 3 });
    expect(jev.calls).toHaveLength(3);
    // The composer reads descriptions and counts; it is never handed the blocks' props.
    const sent = JSON.stringify(jev.calls.slice(1).map((call) => call.state));
    expect(sent).toContain("emails_waiting_on_reader");
    expect(sent).not.toContain("Finance is waiting on it");
    expect(validateReportSpec(brief.spec).ok).toBe(true);
  });

  it("falls back to the built-in layout when the evaluator misbehaves", async () => {
    const errors: unknown[] = [];
    const draft = buildBriefDraft(monday(), rules());
    const result = await composeBrief(draft, { model: null, evaluate: scripted(() => "not an option"), onError: (error) => errors.push(error) });
    expect(result.composer).toBe("default");
    expect(errors).toHaveLength(1);
    expect(result.spec).toEqual(defaultSpec(draft));
  });

  it("guards a spec whose root is not the page", () => {
    const draft = buildBriefDraft(monday(), rules());
    const guarded = guardLayout({ root: "x", elements: { x: { type: "Prose", props: { title: null, text: "hi" }, children: [] } } } as Spec, draft);
    expect(guarded.spec.elements[guarded.spec.root]?.type).toBe("ReportPage");
  });
});

describe("validation", () => {
  const good = (): Spec => defaultSpec(buildBriefDraft(monday(), rules()));

  it("refuses props the component does not accept", () => {
    const spec = good();
    (spec.elements["todos"]?.props as Record<string, unknown>)["title"] = 5;
    expect(validateReportSpec(spec).ok).toBe(false);
  });

  it("refuses unknown components, unknown actions, cycles and hidden logic", () => {
    const unknown = good();
    (unknown.elements["todos"] as { type: string }).type = "Script";
    expect(validateReportSpec(unknown).ok).toBe(false);

    const action = good();
    (action.elements["numbers"] as unknown as Record<string, unknown>)["on"] = { press: { action: "run_shell", params: {} } };
    expect(validateReportSpec(action).ok).toBe(false);

    const cycle = good();
    (cycle.elements["page"]?.slots as Record<string, string[]>)["main"]?.push("page");
    expect(validateReportSpec(cycle).ok).toBe(false);

    const hidden = good();
    (hidden.elements["numbers"] as unknown as Record<string, unknown>)["visible"] = { $state: "/x" };
    expect(validateReportSpec(hidden).ok).toBe(false);
  });

  it("accepts a headline bound to state and rejects a spec that is not one", () => {
    expect(validateReportSpec(good()).ok).toBe(true);
    expect(validateReportSpec(null).ok).toBe(false);
    expect(validateReportSpec({ root: "a", elements: {} }).ok).toBe(false);
  });
});

describe("contract", () => {
  it("reads brief URLs", () => {
    expect(briefUrlDate("pistachio://brief/")).toBeNull();
    expect(briefUrlDate("pistachio://brief")).toBeNull();
    expect(briefUrlDate("pistachio://brief/2026-09-21")).toBe("2026-09-21");
    expect(briefUrlDate("pistachio://brief/yesterday")).toBeUndefined();
    expect(briefUrlDate("pistachio://brief/?x=1")).toBeUndefined();
    expect(briefUrlDate("pistachio://home/")).toBeUndefined();
    expect(briefUrl("2026-09-21")).toBe("pistachio://brief/2026-09-21");
  });

  it("keeps ticks to one plain segment", () => {
    expect(tickPath("mail:a/b~c")).toBe("/ticks/mail:a_b_c");
    expect(isTickPath(tickPath("todo:1"))).toBe(true);
    expect(isTickPath("/text/headline")).toBe(false);
    expect(isTickPath("/ticks/a/b")).toBe(false);
  });

  it("cleans a written headline", () => {
    expect(sanitizeHeadline('"Three meetings and Dana is waiting on the budget."')).toBe("Three meetings and Dana is waiting on the budget.");
    expect(sanitizeHeadline("ok")).toBeNull();
    expect(sanitizeHeadline(4)).toBeNull();
  });
});
