import { describe, expect, it } from "vitest";
import { guestFlow, INITIAL_GUEST_SCREEN, type GuestEvent, type GuestScreen, type LiveJoinInfo } from "../src/react/index.js";

const share: LiveJoinInfo = { title: "Launch plan", hostName: "Zach", admission: "ask", status: "live" };
const request = { requestId: "Rq1", secret: "s3cret" };
const ticket = { url: "wss://lk", token: "t", identity: "g_Rq1", color: "#E54D2E" };

const run = (events: GuestEvent[], from: GuestScreen = INITIAL_GUEST_SCREEN): GuestScreen => events.reduce(guestFlow, from);

describe("guestFlow", () => {
  it("walks a link from the lobby through the knock into the room", () => {
    const lobby = run([{ type: "loaded", share }]);
    expect(lobby).toEqual({ kind: "lobby", share, busy: false, error: null });
    const knocking = run([{ type: "knock" }, { type: "knocked", request, answer: { status: "pending", ticket: null } }], lobby);
    expect(knocking).toEqual({ kind: "knocking", share, request });
    expect(run([{ type: "polled", answer: { status: "pending", ticket: null } }], knocking)).toEqual(knocking);
    const joining = run([{ type: "polled", answer: { status: "admitted", ticket } }], knocking);
    expect(joining).toEqual({ kind: "joining", share, request, ticket });
    expect(run([{ type: "connected" }], joining)).toEqual({ kind: "room", share, request, ticket });
  });

  it("joins at once when anyone with the link may", () => {
    const open = { ...share, admission: "open" as const };
    const screen = run([{ type: "loaded", share: open }, { type: "knock" }, { type: "knocked", request, answer: { status: "admitted", ticket } }]);
    expect(screen.kind).toBe("joining");
  });

  it("shows an ended share or a dead link, not a lobby", () => {
    expect(run([{ type: "loaded", share: { ...share, status: "ended" } }])).toMatchObject({ kind: "over", reason: "ended" });
    expect(run([{ type: "loadFailed", reason: "not_found" }])).toEqual({ kind: "over", reason: "not_found", share: null });
  });

  it("rejoins after a reload without knocking while still admitted", () => {
    expect(run([{ type: "resumed", share, request, answer: { status: "admitted", ticket } }])).toEqual({ kind: "joining", share, request, ticket });
    expect(run([{ type: "resumed", share, request, answer: { status: "pending", ticket: null } }])).toEqual({ kind: "knocking", share, request });
    // Left, or a request control no longer knows: a fresh lobby.
    expect(run([{ type: "resumed", share, request, answer: { status: "left", ticket: null } }]).kind).toBe("lobby");
    expect(run([{ type: "resumed", share, request, answer: null }]).kind).toBe("lobby");
  });

  it("ends the wait on the host's answer", () => {
    const knocking: GuestScreen = { kind: "knocking", share, request };
    expect(run([{ type: "polled", answer: { status: "denied", ticket: null } }], knocking)).toMatchObject({ kind: "over", reason: "denied" });
    expect(run([{ type: "polled", answer: { status: "ended", ticket: null } }], knocking)).toMatchObject({ kind: "over", reason: "ended" });
    expect(run([{ type: "cancel" }], knocking)).toEqual({ kind: "lobby", share, busy: false, error: null });
  });

  it("keeps the lobby for a knock worth trying again, and leaves it for one that is not", () => {
    const busy = run([{ type: "loaded", share }, { type: "knock" }]);
    expect(busy).toMatchObject({ kind: "lobby", busy: true });
    expect(run([{ type: "knockFailed", error: "rate_limited" }], busy)).toEqual({ kind: "lobby", share, busy: false, error: "rate_limited" });
    expect(run([{ type: "knockFailed", error: "full" }], busy)).toMatchObject({ kind: "over", reason: "full" });
    expect(run([{ type: "knockFailed", error: "ended" }], busy)).toMatchObject({ kind: "over", reason: "ended" });
  });

  it("names how the room ended", () => {
    const room: GuestScreen = { kind: "room", share, request, ticket };
    expect(run([{ type: "roomEnded", reason: "ended" }], room)).toMatchObject({ kind: "over", reason: "ended" });
    expect(run([{ type: "roomEnded", reason: "removed" }], room)).toMatchObject({ kind: "over", reason: "removed" });
    expect(run([{ type: "roomEnded", reason: "left" }], room)).toMatchObject({ kind: "over", reason: "left" });
    expect(run([{ type: "roomEnded", reason: "replaced" }], room)).toMatchObject({ kind: "over", reason: "replaced" });
    expect(run([{ type: "roomEnded", reason: "failed" }], room)).toMatchObject({ kind: "over", reason: "lost" });
    expect(run([{ type: "restart" }], room)).toEqual(INITIAL_GUEST_SCREEN);
  });

  it("ignores events that do not belong to the screen", () => {
    const lobby: GuestScreen = { kind: "lobby", share, busy: false, error: null };
    expect(run([{ type: "connected" }, { type: "polled", answer: { status: "admitted", ticket } }, { type: "cancel" }], lobby)).toEqual(lobby);
  });
});
