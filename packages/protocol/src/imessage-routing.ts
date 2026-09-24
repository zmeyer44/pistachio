import type { RunControlEvent, RunEventInput, SealedRunEvent } from "./run-events.js";
import type { TaskStatus } from "./index.js";

/**
 * The narrow slice of a run event stream sent to the cloud-side iMessage
 * router. Content remains sealed until it reaches a device holding the
 * Space key; control-class user commands are already plaintext at control.
 */
export type IMessageRoutingEvent = Omit<RunEventInput, "event"> & {
  event:
    | SealedRunEvent
    | Pick<Extract<RunControlEvent, { t: "cmd.message" }>, "t" | "text">
    | Extract<RunControlEvent, { t: "cmd.answer" }>;
};

export interface IMessageThreadRouteRequest {
  candidate: {
    runId: string;
    userId: string;
    spaceId: string;
    intent: string;
    status: TaskStatus;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    lastIMessageAt: string;
  };
  incoming: {
    text: string;
    receivedAt: string;
  };
  /** Chronological, bounded event history for `candidate.runId`. */
  events: IMessageRoutingEvent[];
}

export interface IMessageThreadRouteResult {
  decision: "continue" | "new";
  confidence: number;
}
