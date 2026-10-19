/**
 * What a live share says as notices (docs/live-share.md §1,
 * src/lib/live/notices.ts): a knock with Admit, an ask with Allow, a guest
 * come or gone, a message, a share that ended by itself or could not start —
 * one notice per happening and never a storm: several knocks are one notice
 * that opens the card, and a knock answered takes its notice with it.
 */

import { describe, expect, it } from "vitest";
import { idleLiveShare, type LiveGuest, type LiveKnock, type LiveShareState } from "@pistachio/shell-contracts/live-share";
import { LiveNotifier, liveNoticesFor, type LiveNoticeOptions } from "../src/lib/live/notices";

const live = (patch: Partial<LiveShareState> = {}): LiveShareState => ({ ...idleLiveShare(), status: "live", groupId: "space-a", shareId: "s", link: "https://x/live/t", startedAt: 1, ...patch });
const knock = (requestId: string, name: string): LiveKnock => ({ requestId, name, at: 1 });
const guest = (identity: string, name: string): LiveGuest => ({ identity, name, color: "#E54D2E", micOn: false, cameraOn: false });

function notifier(card: "live" | "chat" | null = null) {
  const shown: Array<{ id: number; message: string; options: LiveNoticeOptions }> = [];
  const calls: string[] = [];
  let serial = 0;
  const notify = new LiveNotifier({
    show: (message, options) => {
      serial += 1;
      shown.push({ id: serial, message, options });
      return serial;
    },
    dismiss: (id) => {
      const at = shown.findIndex((notice) => notice.id === id);
      if (at >= 0) shown.splice(at, 1);
    },
    isShown: (id) => shown.some((notice) => notice.id === id),
    card: () => card,
    windowName: (windowId) => (windowId === "tab-1" ? "GitHub" : "a window"),
    admit: (requestId) => calls.push(`admit ${requestId}`),
    allow: (ask) => calls.push(`allow ${ask.identity} ${ask.windowId}`),
    openCard: (tab) => calls.push(`card ${tab}`),
    retry: () => calls.push("retry"),
  });
  return { notify, shown, calls };
}

describe("knocks", () => {
  it("says who wants to join, and Admit lets them in", () => {
    const { notify, shown, calls } = notifier();
    notify.take(live(), live({ knocks: [knock("r1", "Sam")] }));
    expect(shown.map((notice) => notice.message)).toEqual(["Sam wants to join"]);
    shown[0]!.options.action!.run();
    expect(calls).toEqual(["admit r1"]);
  });

  it("makes several knocks one notice that opens the card", () => {
    const { notify, shown, calls } = notifier();
    const one = live({ knocks: [knock("r1", "Sam")] });
    const two = live({ knocks: [knock("r1", "Sam"), knock("r2", "Ann")] });
    const three = live({ knocks: [knock("r1", "Sam"), knock("r2", "Ann"), knock("r3", "Lee")] });
    notify.take(live(), one);
    notify.take(one, two);
    notify.take(two, three);
    expect(shown.map((notice) => notice.message)).toEqual(["3 people want to join"]);
    expect(shown[0]!.options.action!.label).toBe("Review");
    shown[0]!.options.action!.run();
    expect(calls).toEqual(["card live"]);
  });

  it("takes the notice away once every knock is answered", () => {
    const { notify, shown } = notifier();
    const knocking = live({ knocks: [knock("r1", "Sam")] });
    notify.take(live(), knocking);
    notify.take(knocking, live());
    expect(shown).toEqual([]);
  });

  it("says nothing of a knock the card in view already shows", () => {
    const { notify, shown } = notifier("live");
    notify.take(live(), live({ knocks: [knock("r1", "Sam")] }));
    expect(shown).toEqual([]);
  });

  it("says nothing of the same knocks published again", () => {
    expect(liveNoticesFor(live({ knocks: [knock("r1", "Sam")] }), live({ knocks: [knock("r1", "Sam")] }))).toEqual([]);
  });
});

describe("asks", () => {
  it("says who asks for which window, and Allow lets them", () => {
    const { notify, shown, calls } = notifier();
    notify.take(live({ participants: [guest("g_1", "Sam")] }), live({ participants: [guest("g_1", "Sam")], asks: [{ identity: "g_1", name: "Sam", windowId: "tab-1", at: 1 }] }));
    expect(shown.map((notice) => notice.message)).toEqual(["Sam asks to use GitHub"]);
    shown[0]!.options.action!.run();
    expect(calls).toEqual(["allow g_1 tab-1"]);
  });
});

describe("guests coming and going", () => {
  it("says who joined and who left, quietly, together when they come together", () => {
    const { notify, shown } = notifier();
    const two = live({ participants: [guest("g_1", "Sam"), guest("g_2", "Ann")] });
    notify.take(live(), two);
    notify.take(two, live({ participants: [guest("g_2", "Ann")] }));
    expect(shown.map((notice) => [notice.message, notice.options.action])).toEqual([
      ["Sam and Ann joined", undefined],
      ["Sam left", undefined],
    ]);
  });

  it("does not say every guest left when the share ends", () => {
    expect(liveNoticesFor(live({ participants: [guest("g_1", "Sam")] }), { ...idleLiveShare(), ended: "stopped" })).toEqual([]);
  });
});

describe("chat", () => {
  it("says a message while the chat is out of sight, and gathers the next ones into one notice", () => {
    const { notify, shown, calls } = notifier();
    const message = (id: string, text: string) => ({ id, from: "g_1", name: "Sam", color: "#E54D2E", text, at: 1 });
    const one = live({ chat: [message("1", "hello there")] });
    const two = live({ chat: [message("1", "hello there"), message("2", "can you see it?")] });
    notify.take(live(), one);
    expect(shown.map((notice) => notice.message)).toEqual(["Sam: hello there"]);
    notify.take(one, two);
    expect(shown.map((notice) => notice.message)).toEqual(["2 new messages in the live chat"]);
    shown[0]!.options.action!.run();
    expect(calls).toEqual(["card chat"]);
  });

  it("says nothing of the host's own messages, or with the chat in view", () => {
    expect(liveNoticesFor(live(), live({ chat: [{ id: "host:1", from: "host", name: "Zach", color: "#3E63DD", text: "hi", at: 1 }] }))).toEqual([]);
    const { notify, shown } = notifier("chat");
    notify.take(live(), live({ chat: [{ id: "1", from: "g_1", name: "Sam", color: "#E54D2E", text: "hi", at: 1 }] }));
    expect(shown).toEqual([]);
  });
});

describe("the share ending", () => {
  it("says why when it ended by itself, and takes what it asked with it", () => {
    const { notify, shown } = notifier();
    const knocking = live({ knocks: [knock("r1", "Sam")] });
    notify.take(live(), knocking);
    notify.take(knocking, { ...idleLiveShare(), ended: "space-closed" });
    expect(shown.map((notice) => [notice.message, notice.options.tone])).toEqual([["Live share ended: its space was closed", "warning"]]);
  });

  it("says the share ended with the account that signed out, or that another took its place", () => {
    const { notify, shown } = notifier();
    notify.take(live({ status: "ending" }), { ...idleLiveShare(), ended: "account-changed" });
    expect(shown.map((notice) => notice.message)).toEqual(["Live share ended: the account on this Mac changed"]);
  });

  it("says nothing when the host stopped it", () => {
    expect(liveNoticesFor(live(), { ...idleLiveShare(), ended: "stopped" })).toEqual([]);
    expect(liveNoticesFor(live({ status: "ending" }), { ...idleLiveShare(), ended: "quit" })).toEqual([]);
  });

  it("says why a share could not start, with Try again, when the card is not there to say it", () => {
    const starting = { ...idleLiveShare(), status: "starting" as const, groupId: "space-a" };
    const failed = { ...starting, status: "error" as const, error: "Pistachio couldn't reach your account." };
    const { notify, shown, calls } = notifier();
    notify.take(starting, failed);
    expect(shown.map((notice) => notice.message)).toEqual(["Couldn't start sharing: Pistachio couldn't reach your account."]);
    shown[0]!.options.action!.run();
    expect(calls).toEqual(["retry"]);
    const withCard = notifier("live");
    withCard.notify.take(starting, failed);
    expect(withCard.shown).toEqual([]);
  });
});
