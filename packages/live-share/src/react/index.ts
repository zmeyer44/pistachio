/**
 * The React pieces of live share (docs/live-share.md §8), drawn by the web
 * guest page and the desktop's live-host app alike: the layers over the
 * stage (pointers, ink, pings, reactions), the faces, the media switches and
 * their menus, the chat, and hooks over a `LiveRoom`. Every layer draws
 * through a `StageBox` — where the stage lies in its own pixels — so each
 * end maps the stage its own way. Styles: `@pistachio/live-share/styles.css`
 * (`lv-` classes, tokens on `.lv-theme`).
 *
 * Browser-only, like the room. Imports from the room and the effects are
 * types only: loading this module loads neither livekit-client nor MediaPipe.
 */

export { createEmitter, type Emitter } from "./emitter.js";
export { boxPoint, createStageBox, type StageBox, type StageBoxSource } from "./stage-box.js";
export { placeRect, relativeRect, stageArea, stageLayout, type Insets, type StageLayout } from "./stage-view.js";
export { CursorFeed } from "./cursor-feed.js";
export { InkStore } from "./ink-store.js";
export { appendChat, mergeChat, newChatId, CHAT_KEEP } from "./chat-log.js";
export { deskFacts, deskNotices, sameFacts, type LiveDeskAllowance, type LiveDeskFacts, type LiveDeskNotice, type LiveWindowFacts } from "./desk-facts.js";
export {
  guestFlow,
  INITIAL_GUEST_SCREEN,
  type GuestEvent,
  type GuestLobbyError,
  type GuestOverReason,
  type GuestScreen,
  type LiveGuestRequest,
  type LiveGuestTicket,
  type LiveJoinInfo,
  type LiveRequestAnswer,
  type LiveRequestStatus,
} from "./guest-flow.js";
export { GuestDesk } from "./guest-desk.js";
export { joinRoom, restoreMedia, type JoinedRoom, type JoinOutcome, type RestoredMemory, type RestoredRoom } from "./guest-join.js";
export { describeMediaProblem, mediaProblemOf, type MediaProblem } from "./media-errors.js";
export { chooseBackground, describeBackgroundProblem, describeCameraHold, type BackgroundControl, type BackgroundProblem, type CameraHold } from "./background-choice.js";
export { MediaSwitches, switchReadsOn, type MediaAvailability, type MediaControl, type MediaSwitchKind, type MediaSwitchOn, type MediaSwitchOutcome, type MediaSwitchState } from "./media-switch.js";
export { GuestMediaMemory, readBackground, type BackgroundOffer, type GuestMediaPrefs, type RememberedBackground } from "./media-prefs.js";
export { HOST_ABSENT_GRACE_MS, HOST_ABSENT_POLL_MS, HostAbsence, type HostAbsenceEnd, type HostAbsenceOptions } from "./host-absence.js";
export { attachWindowInput, type WindowInputOptions } from "./window-input.js";
export {
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
  type LivePingEvent,
  type LiveReactionEvent,
  type LocalMediaSwitch,
  type RoomInk,
} from "./hooks.js";
export { CursorLayer, type CursorLayerProps, type CursorPerson } from "./CursorLayer.js";
export { InkLayer, penCursor, type InkLayerProps, type InkPen } from "./InkLayer.js";
export { PingLayer, type PingLayerProps } from "./PingLayer.js";
export { ReactionLayer, type ReactionLayerProps } from "./ReactionLayer.js";
export { FaceStack, FaceTile, type FaceStackProps, type FaceTileProps } from "./FaceStack.js";
export { MediaButton, type MediaButtonProps } from "./MediaButton.js";
export { DeviceMenu, deviceLabel, type DeviceMenuProps } from "./DeviceMenu.js";
export { BackgroundMenu, type BackgroundMenuProps } from "./BackgroundMenu.js";
export { ChatPanel, type ChatPanelProps } from "./ChatPanel.js";
export { Popover, type PopoverProps } from "./Popover.js";
