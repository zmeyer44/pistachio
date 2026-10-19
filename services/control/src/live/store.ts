/**
 * Live share's queries (docs/live-share.md §5). Every rule that has to hold
 * across concurrent requests — the per-account share cap, the admitted-guest
 * cap, the lobby's size, which colours are taken — is decided here inside a
 * transaction that holds the row it is about (the account, or the share), so
 * two knocks or two admits at once cannot both take the last place.
 */

import { and, eq, inArray, isNotNull, isNull, lt, lte, ne, notInArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  liveRequests,
  liveShares,
  users,
  type LiveAdmission,
  type LiveRequestStatus,
} from "../db/schema.js";
import {
  MAX_LIVE_SHARES_PER_USER,
  MAX_PENDING_KNOCKS,
  ROOM_CLOSE_RETRY_MAX_MS,
  ROOM_CLOSE_RETRY_MS,
  nextGuestColor,
  roomFor,
} from "./lobby.js";

export type LiveShareRow = typeof liveShares.$inferSelect;
export type LiveRequestRow = typeof liveRequests.$inferSelect;

/** Statuses that hold a place: in the room, or waiting at the door. */
const HOLDING: LiveRequestStatus[] = ["pending", "admitted"];

/**
 * What every way a share ends writes: its room is due to close from that
 * moment, and stays due until LiveKit says it is gone (`roomClosed`).
 */
function ending(when: Date) {
  return { status: "ended" as const, endedAt: when, updatedAt: when, roomCloseDueAt: when };
}

export interface NewShare {
  id: string;
  userId: string;
  deviceId: string;
  tokenHash: string;
  title: string;
  hostName: string | null;
  at: number;
  hostTokenExpiresAt: number;
}

export type CreateOutcome =
  /** `ended`: the ids of this device's shares that ended with it, their rooms to close. */
  | { kind: "created"; share: LiveShareRow; ended: string[] }
  | { kind: "too_many" };

export interface RoomToClose {
  shareId: string;
  room: string;
  /**
   * Tries so far, this one included — which also names this try: its answer
   * settles the room only while no later one has been claimed (`roomClosed`).
   */
  attempts: number;
}

export interface NewRequest {
  shareId: string;
  id: string;
  name: string;
  secretHash: string;
  at: number;
  maxGuests: number;
}

export type KnockOutcome =
  | { kind: "created"; request: LiveRequestRow }
  | { kind: "ended" }
  | { kind: "full"; reason: "guests" | "lobby" };

export type DecideOutcome =
  | { kind: "decided"; request: LiveRequestRow }
  | { kind: "not_found" }
  | { kind: "ended" }
  | { kind: "not_pending"; status: LiveRequestStatus }
  | { kind: "full" };

export class LiveStore {
  constructor(private readonly db: Db) {}

  /**
   * A new live share. This device's previous one ends with it (one per Mac);
   * the account's other Macs count toward the cap and are left alone.
   */
  async createShare(input: NewShare): Promise<CreateOutcome> {
    return this.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("update");
      const others = await tx
        .select({ id: liveShares.id })
        .from(liveShares)
        .where(
          and(
            eq(liveShares.userId, input.userId),
            eq(liveShares.status, "live"),
            ne(liveShares.deviceId, input.deviceId),
          ),
        );
      if (others.length >= MAX_LIVE_SHARES_PER_USER) return { kind: "too_many" as const };
      const at = new Date(input.at);
      const ended = await tx
        .update(liveShares)
        .set(ending(at))
        .where(
          and(
            eq(liveShares.userId, input.userId),
            eq(liveShares.deviceId, input.deviceId),
            eq(liveShares.status, "live"),
          ),
        )
        .returning({ id: liveShares.id });
      const [share] = await tx
        .insert(liveShares)
        .values({
          id: input.id,
          userId: input.userId,
          deviceId: input.deviceId,
          tokenHash: input.tokenHash,
          room: roomFor(input.id),
          title: input.title,
          hostName: input.hostName,
          admission: "ask",
          status: "live",
          createdAt: at,
          updatedAt: at,
          hostSeenAt: at,
          hostTokenExpiresAt: new Date(input.hostTokenExpiresAt),
        })
        .returning();
      if (share === undefined) throw new Error("live share insert returned no row");
      return { kind: "created" as const, share, ended: ended.map((row) => row.id) };
    });
  }

  /** The share, if it is this account's; another account's reads as absent. */
  async ownedShare(id: string, userId: string): Promise<LiveShareRow | null> {
    const [row] = await this.db
      .select()
      .from(liveShares)
      .where(and(eq(liveShares.id, id), eq(liveShares.userId, userId)));
    return row ?? null;
  }

  async shareByToken(tokenHash: string): Promise<LiveShareRow | null> {
    const [row] = await this.db.select().from(liveShares).where(eq(liveShares.tokenHash, tokenHash));
    return row ?? null;
  }

  async pendingKnocks(shareId: string): Promise<LiveRequestRow[]> {
    return this.requestsIn(shareId, "pending");
  }

  /** The guests let in and not since gone (removed, left): who may be in the room. */
  async admittedGuests(shareId: string): Promise<LiveRequestRow[]> {
    return this.requestsIn(shareId, "admitted");
  }

  private async requestsIn(shareId: string, status: LiveRequestStatus): Promise<LiveRequestRow[]> {
    return this.db
      .select()
      .from(liveRequests)
      .where(and(eq(liveRequests.shareId, shareId), eq(liveRequests.status, status)))
      .orderBy(liveRequests.createdAt);
  }

  /** Applies to a live share only; null once it has ended. */
  async updateShare(
    id: string,
    patch: { admission?: LiveAdmission; title?: string },
    at: number,
  ): Promise<LiveShareRow | null> {
    const [row] = await this.db
      .update(liveShares)
      .set({ ...patch, updatedAt: new Date(at) })
      .where(and(eq(liveShares.id, id), eq(liveShares.status, "live")))
      .returning();
    return row ?? null;
  }

  /** The host is still there; with `tokenExpiresAt`, a fresh host token was minted too. */
  async heartbeat(id: string, at: number, tokenExpiresAt: number | null): Promise<LiveShareRow | null> {
    const seen = new Date(at);
    const [row] = await this.db
      .update(liveShares)
      .set({
        hostSeenAt: seen,
        updatedAt: seen,
        ...(tokenExpiresAt === null ? {} : { hostTokenExpiresAt: new Date(tokenExpiresAt) }),
      })
      .where(and(eq(liveShares.id, id), eq(liveShares.status, "live")))
      .returning();
    return row ?? null;
  }

  /** Ends the share; an already ended one is returned as it is. */
  async endShare(id: string, at: number): Promise<LiveShareRow | null> {
    const [ended] = await this.db
      .update(liveShares)
      .set(ending(new Date(at)))
      .where(and(eq(liveShares.id, id), eq(liveShares.status, "live")))
      .returning();
    if (ended !== undefined) return ended;
    const [row] = await this.db.select().from(liveShares).where(eq(liveShares.id, id));
    return row ?? null;
  }

  async request(shareId: string, id: string): Promise<LiveRequestRow | null> {
    const [row] = await this.db
      .select()
      .from(liveRequests)
      .where(and(eq(liveRequests.id, id), eq(liveRequests.shareId, shareId)));
    return row ?? null;
  }

  /**
   * A knock. With the share open it is admitted at once if there is room;
   * asking, it waits if the lobby has room. Either way it takes the next
   * free colour.
   */
  async knock(input: NewRequest): Promise<KnockOutcome> {
    return this.db.transaction(async (tx) => {
      const [share] = await tx
        .select({ status: liveShares.status, admission: liveShares.admission })
        .from(liveShares)
        .where(eq(liveShares.id, input.shareId))
        .for("update");
      if (share === undefined || share.status !== "live") return { kind: "ended" as const };
      const holding = await tx
        .select({ status: liveRequests.status, color: liveRequests.color })
        .from(liveRequests)
        .where(and(eq(liveRequests.shareId, input.shareId), inArray(liveRequests.status, HOLDING)));
      const admitted = holding.filter((row) => row.status === "admitted").length;
      const pending = holding.length - admitted;
      const open = share.admission === "open";
      if (open && admitted >= input.maxGuests) return { kind: "full" as const, reason: "guests" as const };
      if (!open && pending >= MAX_PENDING_KNOCKS) return { kind: "full" as const, reason: "lobby" as const };
      const at = new Date(input.at);
      const [request] = await tx
        .insert(liveRequests)
        .values({
          id: input.id,
          shareId: input.shareId,
          name: input.name,
          secretHash: input.secretHash,
          color: nextGuestColor(holding.map((row) => row.color)),
          status: open ? "admitted" : "pending",
          createdAt: at,
          decidedAt: open ? at : null,
        })
        .returning();
      if (request === undefined) throw new Error("live request insert returned no row");
      return { kind: "created" as const, request };
    });
  }

  /** The host's answer to a knock; admitting counts against the guest cap. */
  async decide(
    shareId: string,
    requestId: string,
    decision: "admit" | "deny",
    maxGuests: number,
    at: number,
  ): Promise<DecideOutcome> {
    return this.db.transaction(async (tx) => {
      const [share] = await tx
        .select({ status: liveShares.status })
        .from(liveShares)
        .where(eq(liveShares.id, shareId))
        .for("update");
      if (share === undefined) return { kind: "not_found" as const };
      if (share.status !== "live") return { kind: "ended" as const };
      const [request] = await tx
        .select()
        .from(liveRequests)
        .where(and(eq(liveRequests.id, requestId), eq(liveRequests.shareId, shareId)));
      if (request === undefined) return { kind: "not_found" as const };
      if (request.status !== "pending") return { kind: "not_pending" as const, status: request.status };
      if (decision === "admit") {
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(liveRequests)
          .where(and(eq(liveRequests.shareId, shareId), eq(liveRequests.status, "admitted")));
        if ((count?.n ?? 0) >= maxGuests) return { kind: "full" as const };
      }
      // Only while it still waits: a guest's cancel (`release`, which takes no
      // lock on the share) may have landed since the read above, and an admit
      // must not bring a cancelled request back.
      const [decided] = await tx
        .update(liveRequests)
        .set({ status: decision === "admit" ? "admitted" : "denied", decidedAt: new Date(at) })
        .where(and(eq(liveRequests.id, requestId), eq(liveRequests.status, "pending")))
        .returning();
      if (decided !== undefined) return { kind: "decided" as const, request: decided };
      const [since] = await tx.select({ status: liveRequests.status }).from(liveRequests).where(eq(liveRequests.id, requestId));
      return since === undefined ? { kind: "not_found" as const } : { kind: "not_pending" as const, status: since.status };
    });
  }

  /**
   * Moves a request still holding a place to `to` (`removed` by the host,
   * `left` by the guest) and returns it as it now stands; a request already
   * settled keeps its status.
   */
  async release(shareId: string, requestId: string, to: "removed" | "left", at: number): Promise<LiveRequestRow | null> {
    const [moved] = await this.db
      .update(liveRequests)
      .set({ status: to, decidedAt: new Date(at) })
      .where(
        and(
          eq(liveRequests.id, requestId),
          eq(liveRequests.shareId, shareId),
          inArray(liveRequests.status, HOLDING),
        ),
      )
      .returning();
    return moved ?? (await this.request(shareId, requestId));
  }

  /**
   * An admitted guest takes a token (joining, back after a reload, the room
   * reconnecting): they are about, whatever the room said of them before.
   * False when the request is no longer admitted — the sweep may have just
   * found them gone — and no token is to be handed out.
   */
  async guestAbout(shareId: string, requestId: string): Promise<boolean> {
    const [row] = await this.db
      .update(liveRequests)
      .set({ absentSince: null })
      .where(and(eq(liveRequests.id, requestId), eq(liveRequests.shareId, shareId), eq(liveRequests.status, "admitted")))
      .returning({ id: liveRequests.id });
    return row !== undefined;
  }

  /** Live shares with a guest admitted, and their rooms: those the sweep asks LiveKit about. */
  async roomsWithGuests(): Promise<Array<{ shareId: string; room: string }>> {
    return this.db
      .selectDistinct({ shareId: liveShares.id, room: liveShares.room })
      .from(liveShares)
      .innerJoin(liveRequests, eq(liveRequests.shareId, liveShares.id))
      .where(and(eq(liveShares.status, "live"), eq(liveRequests.status, "admitted")));
  }

  /**
   * A share's admitted guests by what its room says now (`present`: the
   * request ids of those in it). One in it is about. One missing is absent
   * from now, and one already absent since `goneBefore` or earlier went
   * without leaving: `left`, its place freed. Each change is conditional on
   * the row as it stands, so a token taken meanwhile (`guestAbout`) keeps the
   * guest. Returns how many were let go.
   */
  async settleGuests(shareId: string, present: ReadonlySet<string>, goneBefore: number, at: number): Promise<number> {
    const admitted = and(eq(liveRequests.shareId, shareId), eq(liveRequests.status, "admitted"));
    const here = [...present];
    const missing = here.length === 0 ? admitted : and(admitted, notInArray(liveRequests.id, here));
    if (here.length > 0) {
      await this.db
        .update(liveRequests)
        .set({ absentSince: null })
        .where(and(admitted, inArray(liveRequests.id, here), isNotNull(liveRequests.absentSince)));
    }
    const when = new Date(at);
    const gone = await this.db
      .update(liveRequests)
      .set({ status: "left", decidedAt: when })
      .where(and(missing, lte(liveRequests.absentSince, new Date(goneBefore))))
      .returning({ id: liveRequests.id });
    await this.db
      .update(liveRequests)
      .set({ absentSince: when })
      .where(and(missing, isNull(liveRequests.absentSince)));
    return gone.length;
  }

  /** Ends every share whose host has been silent since `silentSince` (their rooms due to close); returns how many. */
  async endSilent(silentSince: number, at: number): Promise<number> {
    const ended = await this.db
      .update(liveShares)
      .set(ending(new Date(at)))
      .where(and(eq(liveShares.status, "live"), lt(liveShares.hostSeenAt, new Date(silentSince))))
      .returning({ id: liveShares.id });
    return ended.length;
  }

  /**
   * The rooms due a try to close them at `at` (of the shares `ids` alone,
   * when given), claimed: each one's next try is put off before LiveKit is
   * asked — by `ROOM_CLOSE_RETRY_MS`, doubled for every try before, at most
   * `ROOM_CLOSE_RETRY_MAX_MS` — so a room is asked about once however many
   * sweeps and stops run at once, and a try that never answered is made
   * again in its turn.
   */
  async claimRoomCloses(at: number, ids?: readonly string[]): Promise<RoomToClose[]> {
    const due = and(isNotNull(liveShares.roomCloseDueAt), lte(liveShares.roomCloseDueAt, new Date(at)));
    return this.claimCloseTries(ids === undefined ? due : and(due, inArray(liveShares.id, [...ids])), at);
  }

  /**
   * The share's room was opened again at `at` (a heartbeat's, in case LiveKit
   * lost it). Should the share have ended meanwhile, the stop's close may
   * have come first: a try to close it again is claimed at once, whenever
   * the next was due, so an earlier try answering later cannot settle the
   * room this open made. Empty while the share is live.
   */
  async roomOpened(shareId: string, at: number): Promise<RoomToClose[]> {
    return this.claimCloseTries(and(eq(liveShares.id, shareId), eq(liveShares.status, "ended")), at);
  }

  private async claimCloseTries(which: SQL | undefined, at: number): Promise<RoomToClose[]> {
    const tries = liveShares.roomCloseAttempts;
    // (The right-hand side reads the row as it was: `tries` is the count before this one.)
    const wait = sql`least(${ROOM_CLOSE_RETRY_MS}::float8 * power(2, ${tries}), ${ROOM_CLOSE_RETRY_MAX_MS}::float8)`;
    return this.db
      .update(liveShares)
      .set({
        roomCloseAttempts: sql`${tries} + 1`,
        roomCloseDueAt: sql`${new Date(at).toISOString()}::timestamptz + ${wait} * interval '1 millisecond'`,
      })
      .where(which)
      .returning({ shareId: liveShares.id, room: liveShares.room, attempts: liveShares.roomCloseAttempts });
  }

  /**
   * LiveKit has closed the share's room, or has none by its name, at the try
   * claimed as `attempts`: nothing is left to close — unless a later try has
   * been claimed since, the room opened again in between (`roomOpened`), and
   * that one is still to say.
   */
  async roomClosed(shareId: string, attempts: number): Promise<void> {
    await this.db
      .update(liveShares)
      .set({ roomCloseDueAt: null })
      .where(and(eq(liveShares.id, shareId), eq(liveShares.roomCloseAttempts, attempts)));
  }

  /**
   * Deletes shares that ended before `endedBefore` (their requests go with
   * them). Returns how many, and the rooms among them LiveKit never said it
   * closed — no longer asked about.
   */
  async pruneEnded(endedBefore: number): Promise<{ pruned: number; unclosed: string[] }> {
    const pruned = await this.db
      .delete(liveShares)
      .where(and(eq(liveShares.status, "ended"), lt(liveShares.endedAt, new Date(endedBefore))))
      .returning({ room: liveShares.room, closeDueAt: liveShares.roomCloseDueAt });
    return { pruned: pruned.length, unclosed: pruned.flatMap((row) => (row.closeDueAt === null ? [] : [row.room])) };
  }
}
