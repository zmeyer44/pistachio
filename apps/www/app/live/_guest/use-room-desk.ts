/**
 * The host's desk as this guest knows it (docs/live-share.md §4 `lv.desk`,
 * `lv.sync`, `lv.grant`, §7).
 *
 * Every desk frame goes to the stage controller, which places the windows by
 * ref; React hears only when what it renders changed (`deskFacts`). Joining
 * late, the guest asks the host for the room with `lv.hello` and asks again
 * every 2.5 s until a sync comes — the host's answer can be lost while it is
 * still setting the guest up — and again after the connection came back.
 * Every sync is merged as of the moment this asking began — an answer to
 * an earlier hello can come after a later one's, or after the connection
 * came back: its ink so that nothing erased or cleared since comes back
 * (`InkStore.load`'s `since`), its grants under those heard since
 * (`GuestDesk.asked`); its chat is merged by sender and id, and its desk
 * shown only if newer than the frame up.
 */

import { useEffect, useRef, useState } from "react";
import type { LiveChatEntry, LiveDeskFrame } from "@pistachio/live-share";
import {
  deskFacts,
  deskNotices,
  GuestDesk,
  sameFacts,
  useConnectionState,
  useParticipants,
  useTopic,
  type InkStore,
  type LiveDeskAllowance,
  type LiveDeskFacts,
  type LiveDeskNotice,
} from "@pistachio/live-share/react";
import type { LiveRoom } from "@pistachio/live-share/room";
import type { StageController } from "./stage-controller";

const HELLO_RETRY_MS = 2_500;
const HELLO_TRIES = 6;

export interface RoomDesk {
  facts: LiveDeskFacts | null;
  /** Who is using which window now (window id → identity). */
  grants: ReadonlyMap<string, string>;
}

export function useRoomDesk(
  room: LiveRoom,
  controller: StageController,
  ink: InkStore,
  handlers: { onHistory(chat: readonly LiveChatEntry[]): void; onNotices(notices: LiveDeskNotice[]): void },
): RoomDesk {
  const [facts, setFacts] = useState<LiveDeskFacts | null>(null);
  const [grants, setGrants] = useState<ReadonlyMap<string, string>>(new Map());
  const [desk] = useState(() => new GuestDesk());
  const factsRef = useRef<LiveDeskFacts | null>(null);
  const allowance = useRef<LiveDeskAllowance | null>(null);
  /** When this asking for the room began: joined, back from a reconnect, or the host back. */
  const askedAt = useRef<number | null>(null);
  const synced = useRef(false);
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const apply = (frame: LiveDeskFrame): void => {
    // Frames can cross (a sync is compressed before it goes, frames sent after it are not); an older one would move a window back.
    if (!desk.take(frame)) return;
    controller.setFrame(frame);
    const next = deskFacts(frame);
    if (!sameFacts(factsRef.current, next)) {
      factsRef.current = next;
      setFacts(next);
    }
    const changed = deskNotices(allowance.current, frame);
    allowance.current = changed.allowance;
    if (changed.notices.length > 0) handlersRef.current.onNotices(changed.notices);
  };

  useTopic(room, "lv.desk", apply);

  useTopic(room, "lv.sync", (sync) => {
    if (sync.desk !== null) apply(sync.desk);
    ink.load(sync.strokes, askedAt.current ?? performance.now());
    handlersRef.current.onHistory(sync.chat);
    setGrants(desk.synced(sync.grants));
    synced.current = true;
  });

  useTopic(room, "lv.grant", (grant) => setGrants(desk.grant(grant)));

  const participants = useParticipants(room);
  const hostHere = participants.some((p) => p.role === "host");

  const connection = useConnectionState(room);
  useEffect(() => {
    if (connection !== "connected" || !hostHere) return;
    // Joined, back from a reconnect, or the host is back: ask for the room.
    synced.current = false;
    askedAt.current = performance.now();
    desk.asked();
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const hello = (): void => {
      if (synced.current || tries >= HELLO_TRIES) return;
      tries += 1;
      room.send("lv.hello", {}).catch(() => undefined);
      timer = setTimeout(hello, HELLO_RETRY_MS);
    };
    hello();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [room, connection, hostHere, desk]);

  return { facts, grants };
}
