import type { LiveAdmission } from "@pistachio/shell-contracts/live-share";
import { ControlError, type ControlClient, type ControlLiveShare } from "../account/control-client";

/**
 * Live share's side of control (docs/live-share.md §5), as the service needs
 * it: the account's control client narrowed to the host's routes, with the
 * answers it reads checked and control's refusals turned into words a person
 * can read. Any device token will do — a signed-out Mac's anonymous account
 * hosts as well as a signed-in one.
 */
export interface LiveControl {
  create(input: { title: string; hostName?: string }): Promise<LiveShareCreated>;
  /**
   * The share's status, the knocks waiting on it, the identities of the
   * guests it let in (an answer that names none lets nobody in), and what it
   * holds of the host's choices (none when the answer does not say).
   */
  get(shareId: string): Promise<{ ended: boolean; knocks: Array<{ requestId: string; name: string }>; admitted: Set<string>; settings?: LiveShareSettings }>;
  /** Who may join, the share's name in the guests' lobby (the space was renamed), or both. */
  update(shareId: string, patch: Partial<LiveShareSettings>): Promise<void>;
  /**
   * Still hosting, and what the share holds of the host's choices; a fresh
   * host token when the one control last minted is near its end, or when
   * `ask` asks for one (the room must join again: the answer that brought
   * the last may have been lost) — control bounds how often it says yes.
   */
  heartbeat(shareId: string, ask?: { refresh: boolean }): Promise<{ token: string | null; settings?: LiveShareSettings }>;
  decide(shareId: string, requestId: string, decision: "admit" | "deny"): Promise<void>;
  remove(shareId: string, identity: string): Promise<void>;
  end(shareId: string): Promise<void>;
}

/** What the host chooses of the share that control keeps: who may join, and its name in the guests' lobby. */
export interface LiveShareSettings {
  admission: LiveAdmission;
  title: string;
}

export interface LiveShareCreated {
  shareId: string;
  link: string;
  admission: LiveAdmission;
  livekit: { url: string; token: string };
}

export function liveControl(client: ControlClient): LiveControl {
  return {
    async create(input) {
      const out = await client.createLiveShare(input);
      if (typeof out.share?.id !== "string" || typeof out.link !== "string" || typeof out.livekit?.url !== "string" || typeof out.livekit.token !== "string")
        throw new Error("control answered a live share without its link or room");
      return {
        shareId: out.share.id,
        link: out.link,
        admission: out.share.admission === "open" ? "open" : "ask",
        livekit: { url: out.livekit.url, token: out.livekit.token },
      };
    },
    async get(shareId) {
      const out = await client.liveShare(shareId);
      const knocks = Array.isArray(out.knocks) ? out.knocks : [];
      return {
        ended: out.share?.status === "ended",
        knocks: knocks.filter((knock) => typeof knock.requestId === "string" && typeof knock.name === "string").map(({ requestId, name }) => ({ requestId, name })),
        admitted: new Set((Array.isArray(out.admitted) ? out.admitted : []).map((guest) => guest.identity).filter((identity) => typeof identity === "string")),
        settings: settingsOf(out.share),
      };
    },
    async update(shareId, patch) {
      await client.updateLiveShare(shareId, patch);
    },
    async heartbeat(shareId, ask) {
      const out = await client.liveShareHeartbeat(shareId, ask);
      if (out.share?.status === "ended") throw new ControlError(409, "live_ended", "POST", "/v1/live/shares/:id/heartbeat");
      return { token: typeof out.livekit?.token === "string" ? out.livekit.token : null, settings: settingsOf(out.share) };
    },
    decide: (shareId, requestId, decision) => client.decideLiveRequest(shareId, requestId, decision),
    remove: (shareId, identity) => client.removeLiveParticipant(shareId, identity),
    end: (shareId) => client.endLiveShare(shareId),
  };
}

/** What a share control answered holds of the host's choices; undefined when it does not say. */
function settingsOf(share: ControlLiveShare | undefined): LiveShareSettings | undefined {
  if (share === undefined || (share.admission !== "ask" && share.admission !== "open") || typeof share.title !== "string") return undefined;
  return { admission: share.admission, title: share.title };
}

/** No control to share through: its message is for the person ("Sign-in services are off"). */
export class LiveUnavailableError extends Error {
  override name = "LiveUnavailableError";
}

/** Control says the share is over: it ended (from another place, or the sweep), or it is gone. */
export function liveShareEnded(error: unknown): boolean {
  return error instanceof ControlError && (error.status === 404 || (error.status === 409 && error.code === "live_ended"));
}

/** What a failed live-share request says to the person. */
export function describeLiveError(error: unknown): string {
  if (error instanceof LiveUnavailableError) return error.message;
  if (!(error instanceof ControlError)) return "Couldn't reach Pistachio. Check your connection and try again.";
  switch (error.code) {
    case "live_unavailable":
      return error.status === 502 ? "That didn't reach the room. Try again." : "Live share isn't available right now.";
    case "live_too_many_shares":
      return "You're already sharing live from another Mac.";
    case "live_rate_limited":
      return "Too many shares in a short time. Try again in a minute.";
    case "live_full":
      return "The share is full.";
    case "live_ended":
    case "live_not_found":
      return "The share has ended.";
    default:
      return error.status === 401 || error.status === 403 ? "Pistachio couldn't confirm this Mac. Try again in a moment." : "Something went wrong with the share. Try again.";
  }
}
