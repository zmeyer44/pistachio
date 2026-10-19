"use client";

/**
 * The guest page (docs/live-share.md §1 The guest, §5, §7): one link, and
 * every screen it leads through — the share as it opens, the lobby, the wait
 * at the door, the room, and the ways out. `guestFlow` decides which screen
 * is up; this runs what each one needs: fetch the share (and, after a
 * reload, where this tab's request stands), knock, poll every 1.5 s while
 * the host decides, join the room with the lobby's camera and microphone,
 * leave.
 *
 * The request (`{ requestId, secret }`) is kept per link in sessionStorage,
 * so a reload rejoins without knocking while the guest is still admitted;
 * the name and the camera, microphone, devices and background are
 * remembered across visits. A reload that rejoins brings the camera back
 * behind the background remembered, or keeps it off and the room says why.
 */

import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { sanitizeName } from "@pistachio/live-share";
import { BUILTIN_BACKGROUNDS, supportsBackgroundProcessors, type LiveImageBackground } from "@pistachio/live-share/effects";
import {
  GuestMediaMemory,
  guestFlow,
  INITIAL_GUEST_SCREEN,
  joinRoom,
  restoreMedia,
  type CameraHold,
  type GuestEvent,
  type GuestLobbyError,
  type HostAbsenceEnd,
  type LiveGuestRequest,
  type LiveRequestStatus,
} from "@pistachio/live-share/react";
import { LivePreview, LiveRoom } from "@pistachio/live-share/room";
import { knock, leaveRequest, LiveControlError, pollRequest, takeJoinInfo } from "../../../lib/live/control";
import { rememberedMedia, rememberedName, rememberedRequest, rememberMedia, rememberName, rememberRequest } from "../../../lib/live/memory";
import { Lobby } from "./lobby";
import { Room } from "./room";
import { GuestShell, LoadingScreen, OverScreen } from "./screens";

const POLL_MS = 1_500;

/** A knock control refused, as the lobby says it. */
function knockError(error: unknown): GuestLobbyError | "ended" | "not_found" | "full" | "unavailable" {
  if (!(error instanceof LiveControlError)) return "network";
  switch (error.code) {
    case "live_ended":
      return "ended";
    case "live_not_found":
      return "not_found";
    case "live_full":
      return error.reason === "lobby" ? "lobby_full" : "full";
    case "live_rate_limited":
      return "rate_limited";
    case "invalid_body":
      return "name";
    case "live_unavailable":
      return "unavailable";
    default:
      return "network";
  }
}

/** The person's own background picture: an object URL, let go when another replaces it or the page closes. */
function useCustomBackground(): { custom: LiveImageBackground | null; upload(file: File): LiveImageBackground } {
  const [custom, setCustom] = useState<LiveImageBackground | null>(null);
  const current = useRef<string | null>(null);
  const upload = useCallback((file: File): LiveImageBackground => {
    if (current.current !== null) URL.revokeObjectURL(current.current);
    const image: LiveImageBackground = { kind: "image", url: URL.createObjectURL(file), label: "Your picture" };
    current.current = image.url;
    setCustom(image);
    return image;
  }, []);
  useEffect(
    () => () => {
      if (current.current !== null) URL.revokeObjectURL(current.current);
    },
    [],
  );
  return { custom, upload };
}

const TITLES: Readonly<Record<string, string>> = {
  loading: "Live share",
  lobby: "Join",
  knocking: "Waiting to join",
  joining: "Joining",
  room: "Live",
};

export default function GuestApp({ token }: { token: string }) {
  const [screen, dispatch] = useReducer(guestFlow, INITIAL_GUEST_SCREEN);
  const [room, setRoom] = useState<LiveRoom | null>(null);
  const [preview, setPreview] = useState<LivePreview | null>(null);
  const [name, setName] = useState(rememberedName);
  // The background remembered is the page's from the start; one it cannot put back holds the camera off (`held`).
  const [memory] = useState(() => new GuestMediaMemory(rememberedMedia(), rememberMedia, { scenes: BUILTIN_BACKGROUNDS, supported: supportsBackgroundProcessors() }));
  const prefs = useSyncExternalStore(memory.subscribe, memory.current, memory.current);
  const background = useSyncExternalStore(memory.subscribe, memory.background, memory.background);
  const held = useSyncExternalStore(memory.subscribe, memory.held, memory.held);
  const { custom, upload } = useCustomBackground();
  // Why a rejoin with no lobby kept the camera off, for the room to say as it comes up.
  const [cameraHold, setCameraHold] = useState<CameraHold | null>(null);

  const latest = useRef({ screen });
  useEffect(() => {
    latest.current = { screen };
  });

  // The share, and after a reload, where this tab's request stands.
  useEffect(() => {
    if (screen.kind !== "loading") return;
    let live = true;
    const done = (event: GuestEvent): void => {
      if (live) dispatch(event);
    };
    void (async () => {
      try {
        const share = await takeJoinInfo(token);
        const request = rememberedRequest(token);
        if (request === null || share.status !== "live") {
          done({ type: "loaded", share });
          return;
        }
        const answer = await pollRequest(token, request).catch((error: unknown) => {
          // A request control no longer knows (404, 401) starts afresh; anything else is a failure to load.
          if (error instanceof LiveControlError && (error.status === 404 || error.status === 401)) return null;
          throw error;
        });
        if (answer === null || answer.status === "left") rememberRequest(token, null);
        done({ type: "resumed", share, request, answer });
      } catch (error) {
        done({ type: "loadFailed", reason: error instanceof LiveControlError && error.status === 404 ? "not_found" : "unavailable" });
      }
    })();
    return () => {
      live = false;
    };
  }, [screen.kind, token]);

  // The lobby's camera and microphone, from the lobby until the room takes them.
  const wantsPreview = screen.kind === "lobby" || screen.kind === "knocking";
  useEffect(() => {
    if (wantsPreview && preview === null) setPreview(new LivePreview());
  }, [wantsPreview, preview]);

  // Waiting at the door: ask every 1.5 s.
  const waitingOn = screen.kind === "knocking" ? screen.request : null;
  useEffect(() => {
    if (waitingOn === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try {
        const answer = await pollRequest(token, waitingOn);
        if (!live) return;
        if (answer.status !== "pending" && answer.status !== "admitted") rememberRequest(token, null);
        dispatch({ type: "polled", answer });
      } catch (error) {
        // Gone (the share was pruned): as good as ended. A network blip: ask again next time.
        if (live && error instanceof LiveControlError && error.status === 404) dispatch({ type: "polled", answer: { status: "ended", ticket: null } });
      }
      if (live) timer = setTimeout(() => void poll(), POLL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [waitingOn, token]);

  // Admitted: join the room with the lobby's tracks (or, after a reload, as the camera and mic were, the camera behind its background).
  const joiningWith = screen.kind === "joining" ? screen : null;
  useEffect(() => {
    if (joiningWith === null) return;
    const { ticket, request } = joiningWith;
    let cancelled = false;
    const handed = preview;
    // The speaker remembered plays the room from its first sound, joined from the lobby or after a reload.
    const speaker = memory.current().audiooutput;
    const refreshToken = async (): Promise<string> => {
      const answer = await pollRequest(token, request);
      if (answer.status === "admitted" && answer.ticket !== null) return answer.ticket.token;
      // The share ended or this guest was removed while the connection was down: say so now, not after the retries.
      if (answer.status === "ended" || answer.status === "removed") dispatch({ type: "roomEnded", reason: answer.status });
      throw new Error(`no longer admitted (${answer.status})`);
    };
    const restored: { hold: CameraHold | null } = { hold: null };
    void (async () => {
      try {
        // The room can end, or this page stop wanting it, while a reload's camera comes back: `joinRoom` loses neither.
        const outcome = await joinRoom({
          connect: () => LiveRoom.connect({ url: ticket.url, token: ticket.token, role: "guest", refreshToken, ...(handed === null ? {} : { preview: handed }), ...(speaker === null ? {} : { audioOutput: speaker }) }),
          restore: handed === null ? async (joined) => void (restored.hold = await restoreMedia(joined, memory)) : null,
          cancelled: () => cancelled,
        });
        if (outcome.kind === "cancelled") return;
        setPreview(null);
        if (outcome.kind === "ended") {
          dispatch({ type: "roomEnded", reason: outcome.reason });
          return;
        }
        setRoom(outcome.room);
        setCameraHold(restored.hold);
        dispatch({ type: "connected" });
      } catch {
        if (!cancelled) dispatch({ type: "connectFailed" });
      }
    })();
    return () => {
      cancelled = true;
    };
    // The preview at the moment of joining is the one handed over; a later one is not this join's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joiningWith?.ticket, token]);

  // The room's end, whatever ended it.
  useEffect(() => {
    if (room === null) return;
    return room.on("disconnected", (reason) => dispatch({ type: "roomEnded", reason }));
  }, [room]);

  // Out: let go of the room and the camera; forget a request that cannot be rejoined. (A reload ends the room as
  // lost on its way out — LiveKit lets it go as the page goes — and the page that comes next rejoins with it.)
  const overReason = screen.kind === "over" ? screen.reason : null;
  useEffect(() => {
    if (overReason === null) return;
    if (overReason !== "lost" && overReason !== "replaced") rememberRequest(token, null);
    setRoom(null);
    setPreview(null);
  }, [overReason, token]);

  // A room or a preview let go of — out, or the page closing — is ended with it. (A preview the
  // room took is the room's: stopping it then does nothing.) The request stays, for a reload.
  useEffect(() => () => void room?.disconnect(), [room]);
  useEffect(() => () => preview?.stop(), [preview]);

  useEffect(() => {
    const title = screen.kind === "over" ? "Live share" : (TITLES[screen.kind] ?? "Live share");
    const space = "share" in screen && screen.share !== null ? ` · ${screen.share.title}` : "";
    document.title = `${title}${space}`;
  }, [screen]);

  const join = useCallback(
    async (raw: string) => {
      const clean = sanitizeName(raw);
      if (clean === null) {
        dispatch({ type: "knockFailed", error: "name" });
        return;
      }
      rememberName(clean);
      setName(clean);
      dispatch({ type: "knock" });
      try {
        const { request, answer } = await knock(token, clean);
        rememberRequest(token, request);
        dispatch({ type: "knocked", request, answer });
      } catch (error) {
        dispatch({ type: "knockFailed", error: knockError(error) });
      }
    },
    [token],
  );

  const cancel = useCallback(() => {
    const current = latest.current.screen;
    if (current.kind !== "knocking") return;
    rememberRequest(token, null);
    void leaveRequest(token, current.request).catch(() => undefined);
    dispatch({ type: "cancel" });
  }, [token]);

  // The host gone from the room a while: where this guest's request stands, the room perhaps outliving the share (§7).
  const checkRequest = useCallback(
    async (request: LiveGuestRequest): Promise<LiveRequestStatus> => {
      try {
        return (await pollRequest(token, request)).status;
      } catch (error) {
        // Gone (the share was pruned): as good as ended. Anything else is asked again next time.
        if (error instanceof LiveControlError && error.status === 404) return "ended";
        throw error;
      }
    },
    [token],
  );
  // Out as control says: the over screen lets go of the room, which disconnects it.
  const shareOver = useCallback((reason: HostAbsenceEnd) => dispatch({ type: "roomEnded", reason }), []);

  const leave = useCallback(
    (request: LiveGuestRequest) => {
      rememberRequest(token, null);
      void leaveRequest(token, request).catch(() => undefined);
      // Disconnecting ends the room as "left".
      void room?.disconnect();
    },
    [room, token],
  );

  const media = { prefs, memory, background, onBackground: memory.chooseBackground, held, custom, onUpload: upload };

  switch (screen.kind) {
    case "loading":
      return <LoadingScreen />;
    case "lobby":
    case "knocking":
    case "joining":
      // Joining, the lobby stays up until the room is in. From the moment the room has the lobby's tracks, the
      // lobby's switches, devices and background are the room's, and it shows what the room has on (`LivePreview`).
      return preview === null ? (
        <LoadingScreen text={screen.kind === "joining" ? "Joining…" : undefined} />
      ) : (
        <Lobby
          key="lobby"
          phase={screen.kind}
          share={screen.share}
          preview={preview}
          media={media}
          name={name}
          onName={setName}
          busy={screen.kind === "lobby" && screen.busy}
          error={screen.kind === "lobby" ? screen.error : null}
          onJoin={(value) => void join(value)}
          onCancel={cancel}
        />
      );
    case "room":
      return room === null ? (
        <LoadingScreen text="Joining…" />
      ) : (
        <GuestShell screen="room">
          <Room
            room={room}
            share={screen.share}
            ticket={screen.ticket}
            media={media}
            cameraHold={cameraHold}
            checkShare={() => checkRequest(screen.request)}
            onShareOver={shareOver}
            onLeave={() => leave(screen.request)}
          />
        </GuestShell>
      );
    case "over":
      return <OverScreen reason={screen.reason} share={screen.share} onAction={() => dispatch({ type: "restart" })} />;
  }
}
