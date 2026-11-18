/**
 * The chat is its space's (docs/desk-agent.md §1, "The chat is its space's";
 * §3, "Conversations stay in their space"), as the shell keeps it: what a
 * space's chat held when the person left (lib/desk/space-chat.ts), and the
 * store's word of whose conversation it holds — the tabs and the run travel
 * on separate channels, so for a moment after a change of space the snapshot
 * has the new space beside the last one's run, and a desk must draw none of
 * it (`selectSpaceRun`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellRunSnapshot, ShellSnapshot, ShellTabsSnapshot } from "@pistachio/shell-contracts/ipc";
import type { RunSummary } from "@pistachio/protocol";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { beginCloudStart, CLOUD_ARRIVAL_MS, cloudStartArrived, cloudStartContext, cloudStarting, cloudStartTaken, hearCloudStart, resetCloudStarts, settleCloudStart, watchCloudStarts, type CloudStart } from "../src/lib/desk/cloud-start";
import { chatUpOnArrival, insertInSpace, keepSpaceChat, newSinceLeft, queueSpaceSend, resetSpaceChats, spaceChat, stageInSpace, takeStagedFor, takeTextFor } from "../src/lib/desk/space-chat";
import { chatInsertElsewhere, selectRunIsOfTab, selectRunSettled, selectSpaceRun, useAppStore } from "../src/store";

describe("a space's chat, as it was left", () => {
  afterEach(resetSpaceChats);

  it("is nothing for a space never left, and each space's own once kept", () => {
    // (Whether its card was up is not said for a space never left: neither up nor put away.)
    expect(spaceChat("g1")).toEqual({ whole: false, draft: "", staged: [] });
    expect(spaceChat("g1").open).toBeUndefined();
    keepSpaceChat("g1", { open: true, draft: "half a thought" });
    keepSpaceChat("g2", { whole: true });
    expect(spaceChat("g1")).toEqual({ open: true, whole: false, draft: "half a thought", staged: [] });
    expect(spaceChat("g2")).toEqual({ whole: true, draft: "", staged: [] });
    // Kept again in part: the rest stays as it was.
    keepSpaceChat("g1", { draft: "" });
    expect(spaceChat("g1").open).toBe(true);
    expect(spaceChat("g1").draft).toBe("");
  });

  it("keeps how its conversation was when the person left, to tell what was said since", () => {
    expect(spaceChat("g1").left).toBeUndefined();
    keepSpaceChat("g1", { left: { runId: "run-1", messages: 3 } });
    expect(spaceChat("g1").left).toEqual({ runId: "run-1", messages: 3 });
    // (No conversation there when it was left: said so, not forgotten.)
    keepSpaceChat("g1", { left: null });
    expect(spaceChat("g1").left).toBeNull();
  });
});

describe("whether a space's chat is up as the desk comes to it", () => {
  afterEach(resetSpaceChats);

  const SIDE = { floating: true, zone: "chat" as const };
  const HOME = "home:profile-1";

  it("is as the person left it, this run: up, or put away — and one they closed stays closed, wherever it stands", () => {
    keepSpaceChat("g1", { open: true });
    expect(chatUpOnArrival("g1", "g1", null)).toBe(true);
    expect(chatUpOnArrival("g1", "g1", { ...SIDE, shut: true })).toBe(true);
    // Closed at the side: the side is where it would come up, not a word that it does.
    keepSpaceChat("g1", { open: false });
    expect(chatUpOnArrival("g1", "g1", SIDE)).toBe(false);
  });

  it("not left yet this run, is up only at its own space's side, where it stood when Pistachio was last open", () => {
    expect(chatUpOnArrival("g1", "g1", SIDE)).toBe(true);
    // Closed there by the person before: it waits to be asked for.
    expect(chatUpOnArrival("g1", "g1", { ...SIDE, shut: true })).toBe(false);
    // Docked, floating free, in a tile, or never taken off its Bar: nothing brings it up.
    expect(chatUpOnArrival("g1", "g1", { floating: false })).toBe(false);
    expect(chatUpOnArrival("g1", "g1", { floating: true })).toBe(false);
    expect(chatUpOnArrival("g1", "g1", { floating: true, zone: "left" })).toBe(false);
    expect(chatUpOnArrival("g1", "g1", null)).toBe(false);
    // (Something staged for it from a page meanwhile is no word about its card.)
    keepSpaceChat("g2", { staged: [] });
    expect(chatUpOnArrival("g2", "g2", SIDE)).toBe(true);
  });

  it("a tab of Home's never has its chat brought up by where Home's stands: a change of tab opens nothing", () => {
    // Home's chat stands at the side (taken there beside another tab): this tab's was never opened.
    expect(chatUpOnArrival("tab-b", HOME, SIDE)).toBe(false);
    // The tab it is up beside keeps it, there and back; the next tab still has none.
    keepSpaceChat("tab-a", { open: true });
    expect(chatUpOnArrival("tab-a", HOME, SIDE)).toBe(true);
    expect(chatUpOnArrival("tab-b", HOME, SIDE)).toBe(false);
    // Closed beside that tab, it is closed there when the person is back.
    keepSpaceChat("tab-a", { open: false });
    expect(chatUpOnArrival("tab-a", HOME, SIDE)).toBe(false);
  });
});

describe("a conversation come back to", () => {
  const was = { runId: "run-1", messages: 4, asking: null };

  it("brings its card up for more said since, or something newly asked", () => {
    expect(newSinceLeft(was, { runId: "run-1", messages: 4, asking: null })).toBe(false);
    expect(newSinceLeft(was, { runId: "run-1", messages: 6, asking: null })).toBe(true);
    expect(newSinceLeft(was, { runId: "run-1", messages: 4, asking: "q-1" })).toBe(true);
    // Another conversation is this space's now, with something asked: new to the person.
    expect(newSinceLeft(was, { runId: "run-2", messages: 2, asking: "q-9" })).toBe(true);
    expect(newSinceLeft(was, { runId: "run-2", messages: 9, asking: null })).toBe(false);
    // A space with no conversation when it was left, or never left.
    expect(newSinceLeft(null, { runId: "run-1", messages: 4, asking: null })).toBe(false);
    expect(newSinceLeft(null, { runId: "run-1", messages: 4, asking: "q-1" })).toBe(true);
  });

  it("does not ask again, by every return, what already stood asked when the person left", () => {
    const asked = { runId: "run-1", messages: 4, asking: "q-1" };
    expect(newSinceLeft(asked, { runId: "run-1", messages: 4, asking: "q-1" })).toBe(false);
    // Another question since is new.
    expect(newSinceLeft(asked, { runId: "run-1", messages: 4, asking: "q-2" })).toBe(true);
    // (Kept before the question was part of what is kept: asked as before.)
    expect(newSinceLeft({ runId: "run-1", messages: 4 }, { runId: "run-1", messages: 4, asking: "q-1" })).toBe(true);
  });
});

describe("something added to a space's chat from a page", () => {
  afterEach(resetSpaceChats);

  it("is staged for a space the person has left, with what it was left with, up to what one message holds", () => {
    const file = (name: string) => ({ id: name, name }) as never;
    keepSpaceChat("g1", { staged: [file("first.png")] });
    expect(stageInSpace("g1", file("late.png"), 2)).toBe(true);
    expect(spaceChat("g1").staged.map((item) => item.name)).toEqual(["first.png", "late.png"]);
    expect(stageInSpace("g1", file("one-too-many.png"), 2)).toBe(false);
    expect(spaceChat("g1").staged).toHaveLength(2);
    expect(spaceChat("g2").staged).toEqual([]);
  });

  it("goes to the Bar that is up for its space, when one is: a file a Bar that has gone was still reading is shown, not kept where nobody reads", () => {
    const file = (name: string) => ({ id: name, name }) as never;
    // The person was away in another Profile and is back: a new Bar is up for g1, with what g1 was left with.
    const shown: string[] = [];
    const gone = takeStagedFor("g1", (attachment) => shown.push(attachment.name));
    // The file the old Bar was reading arrives now: the list on screen has it — and the kept one is not written
    // behind the Bar's back, to be overwritten when it next leaves.
    expect(stageInSpace("g1", file("late.png"), 1)).toBe(true);
    expect(shown).toEqual(["late.png"]);
    expect(spaceChat("g1").staged).toEqual([]);
    // Another space's is no business of this Bar's; and once it has gone, g1's are kept again.
    stageInSpace("g2", file("other.png"));
    expect(shown).toEqual(["late.png"]);
    gone();
    stageInSpace("g1", file("later.png"));
    expect(shown).toEqual(["late.png"]);
    expect(spaceChat("g1").staged.map((item) => item.name)).toEqual(["later.png"]);
  });

  it("has its words put into the field of the composer up for its space, or kept with the words the space was left with", () => {
    // A file taken into g1's context mentions itself in g1's message — once it has been taken in, which takes time.
    const typed: string[] = [];
    const gone = takeTextFor("g1", (text) => typed.push(text));
    insertInSpace("g1", "@plan.docx ");
    expect(typed).toEqual(["@plan.docx "]);
    expect(spaceChat("g1").draft).toBe("");
    // The person has gone on (no composer up for g1): the words join what g1's field held, a space between — and
    // the field of the space they went to is handed nothing.
    gone();
    const other: string[] = [];
    takeTextFor("g2", (text) => other.push(text));
    keepSpaceChat("g1", { draft: "Compare this with" });
    insertInSpace("g1", "@budget.xlsx ");
    expect(spaceChat("g1").draft).toBe("Compare this with @budget.xlsx ");
    insertInSpace("g1", "@notes.docx ");
    expect(spaceChat("g1").draft).toBe("Compare this with @budget.xlsx @notes.docx ");
    expect(other).toEqual([]);
    expect(typed).toEqual(["@plan.docx "]);
  });

  it("is the space's it was added in: elsewhere only when main names a space that is not the one in front", () => {
    expect(chatInsertElsewhere({ currentGroupId: "g2" }, "g1")).toBe(true);
    expect(chatInsertElsewhere({ currentGroupId: "g1" }, "g1")).toBe(false);
    // No space named (an older main, the web), or none in front: the field on screen, as ever.
    expect(chatInsertElsewhere({ currentGroupId: "g1" }, undefined)).toBe(false);
    expect(chatInsertElsewhere({ currentGroupId: null }, "g1")).toBe(false);
    expect(chatInsertElsewhere(null, "g1")).toBe(false);
  });

  it("goes to the field on screen for the space in front, and to the space's own keeping for one left behind", async () => {
    host();
    dispose = await useAppStore.getState().initialize();
    const picture = { kind: "image", name: "late.png", mediaType: "image/png", url: "data:image/png;base64,AAAA" } as const;
    // Added in g1, which is in front: the inbox the Bar drains.
    useAppStore.getState().receiveChatInsert(picture, "g1");
    expect(useAppStore.getState().takeChatInbox().inserts).toEqual([picture]);
    // Added in g2, read once the person is in g1: g2's, and the field on screen hears nothing — nor of a refusal.
    useAppStore.getState().receiveChatInsert(picture, "g2");
    useAppStore.getState().rejectChatInsert("That image could not be read", "g2");
    expect(useAppStore.getState().chatInbox).toEqual({ inserts: [], rejection: null });
    expect(spaceChat("g2").staged.map((item) => item.name)).toEqual(["late.png"]);
    expect(spaceChat("g1").staged).toEqual([]);
  });
});

describe("a space's messages", () => {
  afterEach(resetSpaceChats);

  it("go in the order they were sent, whichever composer sent each, and each space has its own line", async () => {
    const sent: string[] = [];
    let read: () => void = () => undefined;
    const reading = new Promise<void>((done) => (read = done));
    // The first has a file to read before it can go; the person leaves, comes back (a new composer) and sends a
    // second, which has nothing to wait for — and waits behind the first all the same.
    const first = queueSpaceSend("g1", async () => {
      await reading;
      sent.push("g1: first");
    });
    const second = queueSpaceSend("g1", async () => {
      sent.push("g1: second");
    });
    // Another space's message is not held behind them.
    await queueSpaceSend("g2", async () => {
      sent.push("g2: only");
    });
    expect(sent).toEqual(["g2: only"]);
    read();
    await Promise.all([first, second]);
    expect(sent).toEqual(["g2: only", "g1: first", "g1: second"]);
  });

  it("are not held up by one that failed", async () => {
    const sent: string[] = [];
    const failed = queueSpaceSend("g1", () => Promise.reject(new Error("the bridge is gone")));
    const next = queueSpaceSend("g1", async () => {
      sent.push("next");
    });
    await expect(failed).resolves.toBeUndefined();
    await next;
    expect(sent).toEqual(["next"]);
  });
});

describe("a cloud conversation started from a space's Bar", () => {
  afterEach(() => {
    resetCloudStarts();
    resetSpaceChats();
  });

  it("runs where it was asked: the Profile and the page in view as it was sent, named in the request", () => {
    const tabs = [{ id: "tab-1", url: "https://example.com/invoices" }, { id: "tab-2", url: "https://other.example/" }] as unknown as ShellSnapshot["tabs"];
    expect(cloudStartContext({ activeSpaceId: "work", activeTabId: "tab-1", tabs })).toEqual({ spaceId: "work", startUrl: "https://example.com/invoices" });
    // No tab in use (an empty space): the request says so itself — an empty address — rather than leave main to
    // take whichever page is in view by the time it is made.
    expect(cloudStartContext({ activeSpaceId: "work", activeTabId: null, tabs })).toEqual({ spaceId: "work", startUrl: "" });
    expect(cloudStartContext(null)).toEqual({ startUrl: "" });
  });

  it("is one at a time from a space, and each space's own", () => {
    expect(beginCloudStart("g1")).toBe(true);
    // A second Enter in the same space starts no second conversation; another space's is its own.
    expect(beginCloudStart("g1")).toBe(false);
    expect(beginCloudStart("g2")).toBe(true);
    expect(cloudStarting("g1")).toBe(true);
    // Refused, it is over: the words can be sent again.
    settleCloudStart("g1", { ok: false, error: "control is unreachable" }, () => undefined);
    expect(cloudStarting("g1")).toBe(false);
    expect(cloudStarting("g2")).toBe(true);
    expect(beginCloudStart("g1")).toBe(true);
  });

  it("tells whoever watches when a start begins and when it is over, so nothing else is offered from the space meanwhile", () => {
    // (The composer: its cloud toggle, and every send — to the cloud or to this Mac — wait while one is under way.)
    const seen: boolean[] = [];
    const stop = watchCloudStarts(() => seen.push(cloudStarting("g1")));
    beginCloudStart("g1");
    settleCloudStart("g1", { ok: true }, () => undefined);
    cloudStartArrived("g1");
    // Begun (under way), taken (under way still), arrived (over).
    expect(seen).toEqual([true, true, false]);
    beginCloudStart("g1");
    settleCloudStart("g1", { ok: false, error: "control is unreachable" }, () => undefined);
    expect(seen.slice(3)).toContain(false);
    expect(cloudStarting("g1")).toBe(false);
    stop();
    beginCloudStart("g1");
    expect(seen.at(-1)).toBe(false);
  });

  it("stays under way once control has taken it, until its conversation is in the space: a message sent meanwhile starts no second one", () => {
    vi.useFakeTimers();
    try {
      beginCloudStart("g1");
      settleCloudStart("g1", { ok: true }, () => undefined);
      // Taken — and the space still shows no conversation: its first event is on its way.
      expect(cloudStartTaken("g1")).toBe(true);
      expect(beginCloudStart("g1")).toBe(false);
      // The conversation reaches the space (the Bar sees its run): what is sent now is its next message.
      cloudStartArrived("g1");
      expect(cloudStartTaken("g1")).toBe(false);
      expect(cloudStarting("g1")).toBe(false);
      // One whose conversation never comes does not hold the Bar for good.
      expect(beginCloudStart("g1")).toBe(true);
      settleCloudStart("g1", { ok: true }, () => undefined);
      vi.advanceTimersByTime(CLOUD_ARRIVAL_MS - 1);
      expect(beginCloudStart("g1")).toBe(false);
      vi.advanceTimersByTime(1);
      expect(cloudStartTaken("g1")).toBe(false);
      expect(beginCloudStart("g1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is heard by its space's composer while one is up: the one that asked, or the one made when the person came back", () => {
    const heard: Array<[string, CloudStart]> = [];
    const gone = hearCloudStart("g1", (result) => heard.push(["first", result]));
    beginCloudStart("g1");
    // The person leaves (the composer goes) and comes back (a new one) before control answers.
    gone();
    hearCloudStart("g1", (result) => heard.push(["second", result]));
    // (The first composer's leaving, heard late, does not take the second's place.)
    gone();
    settleCloudStart("g1", { ok: false, error: "control is unreachable" }, () => heard.push(["elsewhere", { ok: true }]));
    expect(heard).toEqual([["second", { ok: false, error: "control is unreachable" }]]);
  });

  it("answers for the space that asked when the person has gone to another: its kept field emptied once taken, kept when refused", () => {
    // g1 was left with the words and a file still in its field (the start not yet answered); the person is in g2,
    // whose composer is the one up, with a draft of its own.
    const file = { id: "f1", name: "plan.pdf" } as never;
    keepSpaceChat("g1", { draft: "Book the flights", staged: [file] });
    keepSpaceChat("g2", { draft: "half a thought" });
    const heard: CloudStart[] = [];
    hearCloudStart("g2", (result) => heard.push(result));
    const said: string[] = [];
    beginCloudStart("g1");
    // Refused: g1 keeps what was typed, to send again, and the person is told where they are.
    settleCloudStart("g1", { ok: false, error: "this Profile has no key" }, (error) => said.push(error));
    expect(spaceChat("g1")).toMatchObject({ draft: "Book the flights", staged: [file] });
    expect(said).toEqual(["this Profile has no key"]);
    // Taken: g1's field is empty for when they are back — and g2's composer heard nothing of it, its draft as it was.
    beginCloudStart("g1");
    settleCloudStart("g1", { ok: true }, (error) => said.push(error));
    expect(spaceChat("g1")).toMatchObject({ draft: "", staged: [] });
    expect(spaceChat("g2").draft).toBe("half a thought");
    expect(heard).toEqual([]);
    expect(said).toHaveLength(1);
  });
});

/* ------------------------------ in the store ----------------------------- */

const RUN = { runId: "run-1", status: "running", messages: [], toolCalls: [] } as unknown as RunSummary;

const SNAPSHOT = {
  spaces: [{ id: "space-1", name: "Personal", color: "#8fbf6a", parentSpaceId: null, cloudEnabled: true }],
  activeSpaceId: "space-1",
  tabs: [{ id: "tab-1", url: "https://example.com/", title: "Example" }],
  activeTabId: "tab-1",
  visibleTabIds: ["tab-1"],
  wakingTabIds: [],
  splitGroups: [],
  recentlyClosed: null,
  sidebar: { pinned: [], favorites: [], folders: [], presets: [], collapsed: [] },
  tabGroups: [],
  currentGroupId: "g1",
  run: RUN,
  threads: [],
  spaceAgents: {},
  runSpace: "g1",
} as unknown as ShellSnapshot;

/** A host that answers the snapshot, refuses every other getter, and hands back the tab and run channels to publish on. */
function host(snapshot: ShellSnapshot = SNAPSHOT, answers: Record<string, () => Promise<unknown>> = {}): { publishTabs(tabs: ShellTabsSnapshot): void; publishRun(run: ShellRunSnapshot): void } {
  const listeners = new Map<string, (value: unknown) => void>();
  const api = new Proxy(
    {},
    {
      get: (_target, member) => {
        if (typeof member !== "string") return undefined;
        if (member === "getSnapshot") return () => Promise.resolve(snapshot);
        if (answers[member] !== undefined) return answers[member];
        if (member.startsWith("get")) return () => Promise.reject(new Error("not asked"));
        if (member.startsWith("on"))
          return (listener: (value: unknown) => void) => {
            listeners.set(member, listener);
            return () => listeners.delete(member);
          };
        return undefined;
      },
    },
  );
  setShellApi(api as unknown as ShellApiBridge);
  return { publishTabs: (tabs) => listeners.get("onSnapshot")?.(tabs), publishRun: (run) => listeners.get("onRun")?.(run) };
}

function tabsIn(groupId: string, from: ShellSnapshot = SNAPSHOT): ShellTabsSnapshot {
  const { run: _run, threads: _threads, spaceAgents: _agents, runSpace: _space, ...rest } = from;
  return { ...rest, currentGroupId: groupId } as ShellTabsSnapshot;
}

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
  setShellApi({} as unknown as ShellApiBridge);
  useAppStore.setState({ snapshot: null, evidence: null });
});

describe("whose conversation the snapshot holds", () => {
  it("is the space in front's once main's word is for it, and nobody's for the moment between", async () => {
    const shell = host();
    dispose = await useAppStore.getState().initialize();
    expect(selectRunSettled(useAppStore.getState())).toBe(true);
    expect(selectSpaceRun(useAppStore.getState())?.runId).toBe("run-1");

    // The person goes to another space: the tabs say so first, the run that is held still the last space's.
    shell.publishTabs(tabsIn("g2"));
    expect(useAppStore.getState().snapshot?.run?.runId).toBe("run-1");
    expect(selectRunSettled(useAppStore.getState())).toBe(false);
    expect(selectSpaceRun(useAppStore.getState())).toBeNull();

    // Main's word of g2's conversation: none yet — and g1's goes on there, its tile's to say.
    shell.publishRun({ run: null, threads: [], spaceAgents: { g1: "working" }, runSpace: "g2" });
    expect(selectRunSettled(useAppStore.getState())).toBe(true);
    expect(selectSpaceRun(useAppStore.getState())).toBeNull();
    expect(useAppStore.getState().snapshot?.spaceAgents).toEqual({ g1: "working" });

    // A tab's title ticks: the run side is the run publish's, and stays as it was.
    shell.publishTabs({ ...tabsIn("g2"), tabs: [{ ...SNAPSHOT.tabs[0]!, title: "Example — loaded" }] } as ShellTabsSnapshot);
    expect(useAppStore.getState().snapshot?.spaceAgents).toEqual({ g1: "working" });
    expect(useAppStore.getState().snapshot?.runSpace).toBe("g2");

    // Back in g1: nothing of g2's for the moment between, then g1's own again, with what it did meanwhile.
    shell.publishRun({ run: { ...RUN, runId: "run-2" }, threads: [], spaceAgents: { g1: "working" }, runSpace: "g2" });
    shell.publishTabs(tabsIn("g1"));
    expect(selectSpaceRun(useAppStore.getState())).toBeNull();
    shell.publishRun({ run: { ...RUN, status: "completed" } as RunSummary, threads: [], spaceAgents: {}, runSpace: "g1" });
    expect(selectSpaceRun(useAppStore.getState())).toMatchObject({ runId: "run-1", status: "completed" });
    expect(useAppStore.getState().snapshot?.spaceAgents).toEqual({});
  });

  it("is a tab's own space's or not, whoever is in front: a page that shows its tab's conversation takes no other space's for it", async () => {
    // A Home tab (a space of its own, hidden) whose page is its conversation, and a drawn space with another tab.
    const groups = {
      tabGroups: [{ id: "g1", tabIds: ["tab-1"] }],
      looseGroups: [{ id: "loose-2", tabIds: ["tab-2"] }],
    } as unknown as Partial<ShellSnapshot>;
    const shell = host({ ...SNAPSHOT, ...groups, currentGroupId: "loose-2", runSpace: "loose-2" } as ShellSnapshot);
    dispose = await useAppStore.getState().initialize();
    expect(selectRunIsOfTab(useAppStore.getState(), "tab-2")).toBe(true);
    expect(selectRunIsOfTab(useAppStore.getState(), "tab-1")).toBe(false);
    // The person goes to g1: the tabs say so first — the run held is still the Home tab's, and is said to be —
    // and then main's word of g1's own conversation, which is nothing to the Home tab's page (still drawn, on its
    // way out): its chat is not over for g1 having another.
    shell.publishTabs({ ...tabsIn("g1"), ...groups } as ShellTabsSnapshot);
    expect(selectRunIsOfTab(useAppStore.getState(), "tab-2")).toBe(true);
    shell.publishRun({ run: { ...RUN, runId: "run-2" }, threads: [], spaceAgents: { "loose-2": "working" }, runSpace: "g1" });
    expect(selectRunIsOfTab(useAppStore.getState(), "tab-2")).toBe(false);
    expect(selectRunIsOfTab(useAppStore.getState(), "tab-1")).toBe(true);
    // A tab in no space, or none named: asked of the space in front.
    expect(selectRunIsOfTab(useAppStore.getState(), "tab-9")).toBe(true);
    expect(selectRunIsOfTab(useAppStore.getState(), null)).toBe(true);
  });

  it("has its activity record shown only over itself: asked for in one space and answered once the person is in another, it is dropped", async () => {
    let answer: (entries: unknown[]) => void = () => undefined;
    const shell = host(SNAPSHOT, { getEvidence: () => new Promise((resolve) => (answer = resolve)) });
    dispose = await useAppStore.getState().initialize();
    // Asked for in g1; the person is in g2, with its own conversation, by the time main answers.
    const late = useAppStore.getState().loadEvidence();
    shell.publishTabs(tabsIn("g2"));
    shell.publishRun({ run: { ...RUN, runId: "run-2" }, threads: [], spaceAgents: {}, runSpace: "g2" });
    answer([{ id: "g1-entry" }]);
    await late;
    expect(useAppStore.getState().evidence).toBeNull();
    // Asked for and answered where the person is: shown.
    const here = useAppStore.getState().loadEvidence();
    answer([{ id: "g2-entry" }]);
    await here;
    expect(useAppStore.getState().evidence).toEqual([{ id: "g2-entry" }]);
  });

  it("is always the one held where a host names no space for it (the web)", async () => {
    const { spaceAgents: _agents, runSpace: _space, currentGroupId: _group, ...web } = SNAPSHOT;
    const shell = host(web as ShellSnapshot);
    dispose = await useAppStore.getState().initialize();
    expect(selectRunSettled(useAppStore.getState())).toBe(true);
    expect(selectSpaceRun(useAppStore.getState())?.runId).toBe("run-1");
    shell.publishRun({ run: { ...RUN, runId: "run-2" }, threads: [] });
    expect(selectSpaceRun(useAppStore.getState())?.runId).toBe("run-2");
    expect(useAppStore.getState().snapshot?.spaceAgents).toBeUndefined();
    // Main with no space to name (a Profile with none): the run it publishes is the one to draw.
    shell.publishRun({ run: RUN, threads: [], spaceAgents: {}, runSpace: null });
    expect(selectSpaceRun(useAppStore.getState())?.runId).toBe("run-1");
    expect(selectRunIsOfTab(useAppStore.getState(), "tab-1")).toBe(true);
  });
});
