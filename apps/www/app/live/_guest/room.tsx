/**
 * The room (docs/live-share.md §1 In the room, §7): the host's desk fitted
 * into the browser window, the layers over it — ink, pings, everyone's
 * pointers — the faces down the trailing edge, the toolbar at the foot, the
 * chat sliding in from the side, and a line at the top for what changed.
 *
 * The desk is laid out by the stage controller, by ref; React renders the
 * windows that exist and the room's furniture. The guest's own pointer is
 * the system's (a dot with a pen in hand), never drawn: what goes out is
 * `lv.cursor`, throttled, from every move over the stage.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { HOST_COLOR, RateLimiter, type LiveChatEntry, type LiveReaction, type LiveTool } from "@pistachio/live-share";
import {
  appendChat,
  BackgroundMenu,
  ChatPanel,
  chooseBackground,
  CursorLayer,
  DeviceMenu,
  describeBackgroundProblem,
  describeCameraHold,
  describeMediaProblem,
  FaceStack,
  InkLayer,
  mergeChat,
  newChatId,
  PingLayer,
  ReactionLayer,
  switchReadsOn,
  useAudioBlocked,
  useConnectionState,
  useDevices,
  useHostAbsence,
  useMediaSwitch,
  useParticipants,
  useRoomCursors,
  useRoomInk,
  useRoomPings,
  useRoomReactions,
  useTopic,
  type CameraHold,
  type CursorPerson,
  type HostAbsenceEnd,
  type InkPen,
  type LiveDeskNotice,
  type LiveGuestTicket,
  type LiveJoinInfo,
  type LiveRequestStatus,
  type MediaProblem,
} from "@pistachio/live-share/react";
import { BUILTIN_BACKGROUNDS, supportsBackgroundProcessors, type LiveBackground } from "@pistachio/live-share/effects";
import type { LiveRoom } from "@pistachio/live-share/room";
import { Banners, useTransientBanners, type Banner } from "./banners";
import type { GuestMedia } from "./guest-media";
import { BrandMark } from "./screens";
import { StageController } from "./stage-controller";
import { Toolbar } from "./toolbar";
import { useRoomDesk } from "./use-room-desk";
import { useRoomKeys } from "./use-room-keys";
import { useStagePointer } from "./use-stage-pointer";
import { WindowView, type WindowUser } from "./window-view";

export interface RoomProps {
  room: LiveRoom;
  share: LiveJoinInfo;
  ticket: LiveGuestTicket;
  media: GuestMedia;
  /** Why the camera stayed off as the page rejoined with no lobby (a reload): its background could not be put back. Said as the room comes up. */
  cameraHold: CameraHold | null;
  /** Where this guest's request stands with control, asked while the host is gone from the room. */
  checkShare(): Promise<LiveRequestStatus>;
  /** Control says the share is over for this guest, though the room is still up. */
  onShareOver(reason: HostAbsenceEnd): void;
  onLeave(): void;
}

/** Room around the stage: the tabs above windows, the toolbar, the faces, the chat. */
const EDGE = 20;
/** The top bar, and room for the label above a window at the stage's top edge. */
const TOP = 80;
/**
 * Up to this width the top bar has no room for a banner beside its own
 * content, so the banner gets a row of its own under the bar, and the stage
 * starts that much lower: a banner never lies over a window's label. (Wider,
 * it sits inside the bar, above where any label can be.) live.css's banner
 * rules use the same width.
 */
const BANNER_ROW_MAX_WIDTH = 1100;
const BANNER_ROW = 42;
const TOOLBAR = 88;
const FACES = 92;
const CHAT = 344;
const NARROW = 1000;
/** Chat from any one person shown at most 5 a second (10 at once): a flood is theirs to lose, not the room's to read. */
const CHAT_RATE = { rate: 5, burst: 10 };

const withoutAsk = (asked: ReadonlySet<string>, windowId: string): ReadonlySet<string> => {
  if (!asked.has(windowId)) return asked;
  const next = new Set(asked);
  next.delete(windowId);
  return next;
};

/** Why a switch did not come on, for the switch to say: it stays a click from trying again. */
function problemNote(kind: "microphone" | "camera", problem: MediaProblem | null): string | null {
  return problem === null ? null : describeMediaProblem(kind, problem);
}

export function Room({ room, share, ticket, media, cameraHold, checkShare, onShareOver, onLeave }: RoomProps) {
  const controller = useMemo(() => new StageController(), []);
  const participants = useParticipants(room);
  const connection = useConnectionState(room);
  const cursors = useRoomCursors(room);
  const ink = useRoomInk(room, () => controller.frame()?.guestsCanDraw !== false);
  const { feed: pingFeed, ping } = useRoomPings(room);
  const reactions = useRoomReactions(room);
  const { banners: transientBanners, push: pushBanner, dismiss: dismissBanner } = useTransientBanners();

  const [tool, setTool] = useState<LiveTool>("pointer");
  const [inkColor, setInkColor] = useState(ticket.color);
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<readonly LiveChatEntry[]>([]);
  const [unread, setUnread] = useState(0);
  const [facesFolded, setFacesFolded] = useState(false);
  const [fill, setFill] = useState<string | null>(null);
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  const audioBlocked = useAudioBlocked(room);
  const [viewportWidth, setViewportWidth] = useState(0);

  const me = participants.find((p) => p.isLocal);
  const host = participants.find((p) => p.role === "host");
  const hostName = host?.name ?? share.hostName ?? "The host";
  // The host gone from the room a while: control is asked whether the share still stands, and the room waits on them.
  const waitingForHost = useHostAbsence(host !== undefined, checkShare, onShareOver);
  const myColor = me?.color ?? ticket.color;
  const people = useMemo(() => new Map<string, CursorPerson>(participants.map((p) => [p.identity, { name: p.name, color: p.color }])), [participants]);

  const toolRef = useRef(tool);
  const chatOpenRef = useRef(chatOpen);
  useLayoutEffect(() => {
    toolRef.current = tool;
    chatOpenRef.current = chatOpen;
  });

  // ── The desk ────────────────────────────────────────────────────────────

  const onNotices = useCallback(
    (notices: LiveDeskNotice[]) => {
      for (const notice of notices) {
        switch (notice.kind) {
          case "back":
            pushBanner({ id: "back", icon: "back", text: <>{hostName} is back</> });
            break;
          case "granted":
            // The answer to an ask: the ask's own line goes, and its button is free again.
            dismissBanner(`ask:${notice.windowId}`);
            setAsked((current) => withoutAsk(current, notice.windowId));
            pushBanner({ id: `use:${notice.windowId}`, icon: "hand", text: <>{hostName} let you use <em>{notice.title || "a window"}</em></> });
            break;
          case "revoked":
            pushBanner({ id: `use:${notice.windowId}`, icon: "hand", text: <><em>{notice.title || "A window"}</em> is back in {hostName}’s hands</> });
            break;
          case "drawing":
            pushBanner({ id: "drawing", icon: notice.allowed ? "drawing-on" : "drawing-off", text: notice.allowed ? <>{hostName} turned drawing back on</> : <>{hostName} turned drawing off</> });
            break;
        }
      }
    },
    [hostName, pushBanner, dismissBanner],
  );
  const onHistory = useCallback((history: readonly LiveChatEntry[]) => setMessages((current) => mergeChat(current, history)), []);
  const desk = useRoomDesk(room, controller, ink.store, { onHistory, onNotices });

  // The host said no to an ask of ours (sent to us alone): the ask's line gives way to the answer, its button is free.
  useTopic(room, "lv.refused", ({ w }) => {
    dismissBanner(`ask:${w}`);
    setAsked((current) => withoutAsk(current, w));
    const title = controller.frame()?.windows.find((window) => window.id === w)?.title;
    pushBanner({ id: `use:${w}`, icon: "hand", text: <>{hostName} said no to <em>{title || "the window"}</em></> });
  });
  const facts = desk.facts;
  const drawingOff = facts !== null && !facts.guestsCanDraw ? `${hostName} turned drawing off` : null;

  // Drawing taken away puts the pointer back in hand.
  useEffect(() => {
    if (drawingOff !== null) setTool("pointer");
  }, [drawingOff]);

  // The host's pointer belongs to the shared desk: in another space it goes at once, and comes back with their next move.
  const hostAway = facts !== null && !facts.hostPresent;
  const hostIdentity = host?.identity ?? "host";
  useEffect(() => {
    cursors.hold(hostIdentity, hostAway);
  }, [cursors, hostIdentity, hostAway]);

  // The controller's own record of the filled window; React mirrors it for the tab's button.
  useEffect(() => controller.subscribe(() => setFill(controller.filled())), [controller]);
  const fillWindow = useCallback((windowId: string | null) => controller.setFill(windowId), [controller]);

  const usable = useCallback(
    (windowId: string): boolean => {
      const frame = controller.frame();
      const filled = controller.filled();
      if (frame === null || !frame.hostPresent || toolRef.current !== "pointer" || (filled !== null && filled !== windowId)) return false;
      return frame.windows.find((each) => each.id === windowId)?.controllable === true;
    },
    [controller],
  );

  // ── Layout ──────────────────────────────────────────────────────────────

  const areaRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const wellRef = useRef<HTMLDivElement>(null);
  const overlaysRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const well = wellRef.current;
    const overlays = overlaysRef.current;
    controller.attachRoot(rootRef.current);
    controller.attachStage(well !== null && overlays !== null ? { well, overlays } : null);
    return () => {
      controller.attachStage(null);
      controller.attachRoot(null);
    };
  }, [controller]);

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (area === null) return;
    const measure = (): void => {
      controller.setViewport(area.clientWidth, area.clientHeight);
      setViewportWidth(area.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    measure();
    return () => observer.disconnect();
  }, [controller]);

  const narrow = viewportWidth > 0 && viewportWidth < NARROW;
  const bannerRow = viewportWidth > 0 && viewportWidth <= BANNER_ROW_MAX_WIDTH;
  const facesShown = participants.length > 0;
  const facesWidth = facesShown ? (facesFolded ? 0 : FACES) : 0;
  const settled = useRef(false);
  useLayoutEffect(() => {
    // On a narrow window the chat lies over the desk rather than shrinking it to nothing.
    const right = EDGE + facesWidth + (chatOpen && !narrow ? CHAT : 0);
    controller.setInsets({ top: TOP + (bannerRow ? BANNER_ROW : 0), right, bottom: TOOLBAR, left: EDGE }, settled.current);
    settled.current = true;
  }, [controller, facesWidth, chatOpen, narrow, bannerRow]);

  // ── My pointer, pings ───────────────────────────────────────────────────

  useStagePointer({ room, controller, area: areaRef, tool: toolRef, ping, usable });

  // ── Chat ────────────────────────────────────────────────────────────────

  const chatRate = useMemo(() => new RateLimiter(CHAT_RATE), []);
  useTopic(room, "lv.chat", (body, from) => {
    if (from.identity === null || !chatRate.take(from.identity, performance.now())) return;
    const sender = room.participants().find((p) => p.identity === from.identity);
    const entry: LiveChatEntry = { id: body.id, from: from.identity, name: sender?.name ?? "Someone", color: sender?.color ?? "#8B8D98", text: body.text, at: Date.now() };
    setMessages((current) => appendChat(current, entry));
    if (!chatOpenRef.current) setUnread((count) => count + 1);
  });

  const sendChat = useCallback(
    (text: string) => {
      const id = newChatId(room.identity);
      setMessages((current) => appendChat(current, { id, from: room.identity, name: me?.name ?? "You", color: myColor, text, at: Date.now() }));
      room.send("lv.chat", { id, text }).catch(() => undefined);
    },
    [room, me?.name, myColor],
  );

  const toggleChat = useCallback(() => {
    setChatOpen((open) => !open);
    setUnread(0);
  }, []);

  // ── Media ───────────────────────────────────────────────────────────────

  const switcher = useMediaSwitch(room);
  const { set: setMedia, forget: forgetProblem, wentOff } = switcher;
  // What the room has on — while it joins again too, so a switch reads as the guest left it, not off until it is back.
  const micOn = me?.micOn ?? false;
  const cameraOn = me?.cameraOn ?? false;
  // One coming on (its prompt, a camera's background loading) reads as on at its switch: turned off, it never goes out live.
  const micSwitchOn = switchReadsOn(switcher, "microphone", micOn);
  const cameraSwitchOn = switchReadsOn(switcher, "camera", cameraOn);
  const microphones = useDevices("audioinput", micOn);
  const cameras = useDevices("videoinput", cameraOn);
  const speakers = useDevices("audiooutput", micOn);
  // Remembered once each took, over the choices as they stand then: one made meanwhile is kept.
  const { prefs, memory } = media;

  const toggle = useCallback(
    (kind: "microphone" | "camera") => {
      void memory.switch(setMedia, kind, kind === "microphone" ? !micSwitchOn : !cameraSwitchOn);
    },
    [memory, setMedia, micSwitchOn, cameraSwitchOn],
  );

  // A camera or microphone chosen that took answers why the last on did not: its switch no longer says so.
  const chooseDevice = useCallback(
    (kind: MediaDeviceKind, deviceId: string) => {
      void room.switchDevice(kind, deviceId).then(
        () => {
          memory.remember({ [kind]: deviceId });
          if (kind !== "audiooutput") forgetProblem(kind === "audioinput" ? "microphone" : "camera");
        },
        () => undefined,
      );
    },
    [room, memory, forgetProblem],
  );

  // A background that cannot be put on leaves the camera behind the one it had: the menu says that one again, and why.
  const { onBackground } = media;
  const pickBackground = useCallback(
    (background: LiveBackground) => {
      onBackground(background);
      chooseBackground(room, background, (shown, problem) => {
        onBackground(shown);
        pushBanner({ id: "background", icon: "background", text: describeBackgroundProblem(problem) });
      });
    },
    [room, onBackground, pushBanner],
  );

  // Rejoined with the camera kept off for its background: why, as the room comes up.
  useEffect(() => {
    if (cameraHold !== null) pushBanner({ id: "background", icon: "background", text: describeCameraHold(cameraHold) });
  }, [cameraHold, pushBanner]);

  // The room took the camera or the microphone out, unable to put it out again after the connection dropped: its
  // switch reads off and says why, a click from trying again, and a line says what happened.
  useEffect(
    () =>
      room.on("mediaFailed", ({ kind, error }) => {
        wentOff(kind, error);
        pushBanner(
          kind === "camera"
            ? { id: "media:camera", icon: "camera-off", text: "Your camera went off: it didn’t come back after the connection dropped." }
            : { id: "media:microphone", icon: "mic-off", text: "Your microphone went off: it didn’t come back after the connection dropped." },
        );
      }),
    [room, wentOff, pushBanner],
  );

  // ── Keys ────────────────────────────────────────────────────────────────

  const chooseTool = useCallback(
    (next: LiveTool) => {
      if (next !== "pointer" && drawingOff !== null) return;
      setTool(next);
    },
    [drawingOff],
  );

  useRoomKeys({
    toggleMicrophone: () => toggle("microphone"),
    toggleCamera: () => toggle("camera"),
    chooseTool,
    toggleChat,
    escape: () => {
      if (controller.filled() === null) return false;
      controller.setFill(null);
      return true;
    },
  });

  // ── Banners ─────────────────────────────────────────────────────────────

  // One line shows at a time: the one that began last (`Banners`).
  const banners: Banner[] = [];
  if (connection === "reconnecting") banners.push({ id: "state:reconnecting", icon: "reconnecting", text: "Reconnecting…", persistent: true });
  if (facts !== null && !facts.hostPresent) banners.push({ id: "state:away", icon: "away", text: <>{hostName} is in another space</>, persistent: true });
  if (waitingForHost) banners.push({ id: "state:waiting", icon: "away", text: <>Waiting for {share.hostName ?? "the host"}</>, persistent: true });
  if (audioBlocked) {
    banners.push({
      id: "state:sound",
      icon: "sound",
      text: "Sound is off in this tab",
      action: { label: "Turn on", run: () => void room.startAudio().catch(() => undefined) },
      persistent: true,
    });
  }
  banners.push(...transientBanners);

  const ask = useCallback(
    (windowId: string, title: string) => {
      room.send("lv.ask", { w: windowId }).catch(() => undefined);
      setAsked((current) => new Set(current).add(windowId));
      pushBanner({ id: `ask:${windowId}`, icon: "hand", text: <>Asked {hostName} to use <em>{title || "the window"}</em></> });
      // Unanswered, the button is free again after a while (an answer frees it at once).
      setTimeout(() => setAsked((current) => withoutAsk(current, windowId)), 20_000);
    },
    [room, hostName, pushBanner],
  );

  // ── Render ──────────────────────────────────────────────────────────────

  const pen: InkPen | null = tool === "pointer" || drawingOff !== null ? null : { tool, color: inkColor };
  const users = new Map<string, WindowUser>();
  for (const [windowId, identity] of desk.grants) {
    const person = participants.find((p) => p.identity === identity);
    if (person !== undefined) users.set(windowId, { name: person.name, color: person.color, isMe: person.isLocal });
  }
  // Stacking follows the desk's order; the DOM order stays stable so a video is never moved (which would pause it).
  const stacked = facts === null ? [] : facts.windows.map((window, order) => ({ window, order })).filter(({ window }) => !window.minimized);
  const rendered = [...stacked].sort((a, b) => (a.window.id < b.window.id ? -1 : a.window.id > b.window.id ? 1 : 0));

  return (
    <div
      ref={rootRef}
      className="lvg-room"
      data-tool={tool}
      data-chat={chatOpen ? "" : undefined}
      data-narrow={narrow ? "" : undefined}
      data-host-away={facts !== null && !facts.hostPresent ? "" : undefined}
      style={{ "--lvg-me": myColor, "--lvg-host": host?.color ?? HOST_COLOR, "--lvg-space": facts?.space.color ?? "transparent" } as CSSProperties}
    >
      <header className="lvg-topbar">
        <BrandMark />
        <span className="lvg-topbar-sep" aria-hidden="true" />
        <span className="lvg-space">
          <span className="lvg-space-dot" aria-hidden="true" />
          <span className="lvg-space-title">{facts?.space.title ?? share.title}</span>
          <span className="lvg-space-host">{hostName}</span>
        </span>
        <span className="lvg-live-chip" data-state={connection}>
          <span className="lvg-live-dot" aria-hidden="true" />
          {connection === "reconnecting" ? "Reconnecting" : "Live"}
        </span>
      </header>

      <div ref={areaRef} className="lvg-stage-area">
        <div ref={wellRef} className="lvg-well" data-testid="live-stage" />
        {facts === null ? (
          <div className="lvg-stage-wait">
            <span className="lv-spin lvg-stage-wait-spinner" aria-hidden="true" />
            Getting {hostName}’s desk…
          </div>
        ) : null}
        <div className="lvg-windows">
          {rendered.map(({ window, order }) => (
            <WindowView
              key={window.id}
              window={window}
              order={order}
              room={room}
              controller={controller}
              hostName={hostName}
              hostPresent={facts?.hostPresent ?? false}
              user={users.get(window.id) ?? null}
              myColor={myColor}
              filled={fill === window.id}
              usable={usable}
              onFill={fillWindow}
              onAsk={ask}
              asked={asked.has(window.id)}
            />
          ))}
        </div>
        <div ref={overlaysRef} className="lvg-overlays">
          <InkLayer store={ink.store} box={controller.box} identity={room.identity} pen={pen} onOp={ink.emit} />
          <PingLayer feed={pingFeed} box={controller.box} />
          <CursorLayer feed={cursors} people={people} box={controller.box} />
        </div>
      </div>

      <Banners banners={banners} onDismiss={dismissBanner} />

      {facesShown ? (
        <aside className="lvg-faces" data-folded={facesFolded ? "" : undefined}>
          <FaceStack participants={participants} collapsed={facesFolded} onCollapsedChange={setFacesFolded} />
        </aside>
      ) : null}

      <div className="lvg-chat-panel" data-open={chatOpen ? "" : undefined} inert={!chatOpen}>
        <ChatPanel messages={messages} me={room.identity} onSend={sendChat} onClose={toggleChat} disabled={connection !== "connected"} autoFocus={chatOpen} />
      </div>

      <Toolbar
        microphone={{
          on: micSwitchOn,
          busy: switcher.busy.microphone,
          problem: problemNote("microphone", switcher.problem.microphone),
          onToggle: () => toggle("microphone"),
          menu: (
            <>
              <DeviceMenu title="Microphone" devices={microphones} selected={prefs.audioinput} onSelect={(id) => chooseDevice("audioinput", id)} />
              <DeviceMenu title="Speaker" devices={speakers} selected={prefs.audiooutput} onSelect={(id) => chooseDevice("audiooutput", id)} />
            </>
          ),
        }}
        camera={{
          on: cameraSwitchOn,
          busy: switcher.busy.camera,
          problem: problemNote("camera", switcher.problem.camera),
          onToggle: () => toggle("camera"),
          menu: (
            <>
              <DeviceMenu title="Camera" devices={cameras} selected={prefs.videoinput} onSelect={(id) => chooseDevice("videoinput", id)} />
              <BackgroundMenu
                value={media.background}
                onChange={pickBackground}
                backgrounds={BUILTIN_BACKGROUNDS}
                custom={media.custom}
                onUpload={(file) => pickBackground(media.onUpload(file))}
                supported={supportsBackgroundProcessors()}
              />
            </>
          ),
        }}
        tool={tool}
        onTool={chooseTool}
        drawingOff={drawingOff}
        inkColor={inkColor}
        myColor={myColor}
        onInkColor={setInkColor}
        onClearMine={() => ink.emit({ op: "clear", scope: "mine" })}
        onReact={(emoji: LiveReaction) => reactions.react(emoji)}
        chatOpen={chatOpen}
        unread={unread}
        onChat={toggleChat}
        participants={participants}
        onLeave={onLeave}
      />

      <ReactionLayer
        feed={reactions.feed}
        originOf={(identity) => {
          const face = document.querySelector(`.lvg-faces [data-face="${CSS.escape(identity)}"]`);
          if (face === null) return null;
          const rect = face.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }}
        fallback={() => {
          const button = document.querySelector("[data-reactions]");
          const rect = button?.getBoundingClientRect();
          return rect === undefined ? { x: window.innerWidth / 2, y: window.innerHeight - 80 } : { x: rect.left + rect.width / 2, y: rect.top };
        }}
      />
    </div>
  );
}
