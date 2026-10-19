/**
 * Control's whole use of LiveKit (docs/live-share.md §3, §5): sign join
 * tokens, and call five things on the server API — open the room, knock on
 * the host's door, see who is in the room, show a guest out, and close the
 * room.
 *
 * Signing is local (a JWT over the API secret) and always real, so a test
 * decodes exactly what a client would be handed. The server API is behind
 * `LiveRoomService`, which `RoomServiceClient` satisfies and a test fakes.
 */

import {
  AccessToken,
  DataPacket_Kind,
  RoomServiceClient,
  ServerError,
  TrackSource,
  type CreateOptions,
  type ParticipantInfo,
  type Room,
  type SendDataOptions,
  type VideoGrant,
} from "livekit-server-sdk";
import { livekitFromEnv, type LiveKitConfig } from "./config.js";

export type LiveRole = "host" | "guest";

/** Host tokens last a sitting; heartbeats replace one before it runs out. */
export const HOST_TOKEN_TTL_SECONDS = 6 * 60 * 60;
/**
 * Guest tokens are short: LiveKit refreshes a connected participant's token
 * itself, so this bounds only how long a token handed out but not used, or a
 * guest since removed, could still get in.
 */
export const GUEST_TOKEN_TTL_SECONDS = 10 * 60;

/** A server API call that does not answer in this long has failed. */
const API_TIMEOUT_SECONDS = 5;

export interface LiveTokenRequest {
  room: string;
  identity: string;
  /** The display name (`Participant.name`); omitted when the host gave none. */
  name: string | null;
  role: LiveRole;
  color: string;
}

export interface LiveDataOptions {
  topic: string;
  destinationIdentities: string[];
}

export interface LiveRoomOptions {
  /** Everyone the room may hold at once: the guests and the host. */
  maxParticipants: number;
  /** How long LiveKit keeps the room with nobody in it — before anyone has joined, and after the last has left — before closing it itself. */
  idleSeconds: number;
}

/** The slice of LiveKit's room service control calls. */
export interface LiveRoomService {
  createRoom(options: CreateOptions): Promise<Room>;
  sendData(room: string, data: Uint8Array, kind: DataPacket_Kind, options: SendDataOptions): Promise<void>;
  listParticipants(room: string): Promise<ParticipantInfo[]>;
  removeParticipant(room: string, identity: string): Promise<void>;
  deleteRoom(room: string): Promise<void>;
}

export interface LiveKitApi {
  /** What clients dial, handed out with every token. */
  readonly url: string;
  token(request: LiveTokenRequest): Promise<string>;
  /**
   * Opens the room, or finds it open (LiveKit answers with the one it has).
   * With `room.auto_create` off (§11) a room control did not open cannot be
   * joined, so a token held past the share's end opens nothing.
   */
  createRoom(room: string, options: LiveRoomOptions): Promise<void>;
  /** A reliable data packet from the server itself (no participant sends it). */
  sendData(room: string, data: Uint8Array, options: LiveDataOptions): Promise<void>;
  /** The identities in the room now; a room that is not open holds nobody. */
  participants(room: string): Promise<Set<string>>;
  /** Disconnects one participant; resolves when they were not there. */
  removeParticipant(room: string, identity: string): Promise<void>;
  /** Disconnects everyone; resolves when the room was already gone. */
  deleteRoom(room: string): Promise<void>;
}

/**
 * What each side may do (§3). Metadata is the token's alone on both: a
 * participant that could rewrite its own could claim the host's role.
 */
export function grantFor(role: LiveRole, room: string): VideoGrant {
  const common: VideoGrant = {
    room,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
    canUpdateOwnMetadata: false,
  };
  if (role === "host") return common;
  return { ...common, canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE] };
}

/** LiveKit answers `not_found` for a participant who already left or a room already closed. */
function notFound(err: unknown): boolean {
  return err instanceof ServerError && (err.status === 404 || err.code === "not_found");
}

export function createLiveKitApi(
  config: LiveKitConfig,
  rooms: LiveRoomService = new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret, {
    requestTimeout: API_TIMEOUT_SECONDS,
  }),
): LiveKitApi {
  return {
    url: config.url,
    token: async (request) => {
      const token = new AccessToken(config.apiKey, config.apiSecret, {
        identity: request.identity,
        ...(request.name === null ? {} : { name: request.name }),
        metadata: JSON.stringify({ role: request.role, color: request.color }),
        ttl: request.role === "host" ? HOST_TOKEN_TTL_SECONDS : GUEST_TOKEN_TTL_SECONDS,
      });
      token.addGrant(grantFor(request.role, request.room));
      return token.toJwt();
    },
    createRoom: async (room, options) => {
      await rooms.createRoom({
        name: room,
        maxParticipants: options.maxParticipants,
        emptyTimeout: options.idleSeconds,
        departureTimeout: options.idleSeconds,
      });
    },
    sendData: (room, data, options) =>
      rooms.sendData(room, data, DataPacket_Kind.RELIABLE, {
        topic: options.topic,
        destinationIdentities: options.destinationIdentities,
      }),
    participants: async (room) => {
      try {
        return new Set((await rooms.listParticipants(room)).map((participant) => participant.identity));
      } catch (err) {
        if (notFound(err)) return new Set();
        throw err;
      }
    },
    removeParticipant: async (room, identity) => {
      try {
        await rooms.removeParticipant(room, identity);
      } catch (err) {
        if (!notFound(err)) throw err;
      }
    },
    deleteRoom: async (room) => {
      try {
        await rooms.deleteRoom(room);
      } catch (err) {
        if (!notFound(err)) throw err;
      }
    },
  };
}

/** The configured server's API, or null when `LIVEKIT_*` is unset; throws when half set. */
export function liveKitApiFromEnv(env: Record<string, string | undefined>): LiveKitApi | null {
  const config = livekitFromEnv(env);
  return config === null ? null : createLiveKitApi(config);
}
