import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, MessageSquare, Radio } from "lucide-react";
import { deskGroups } from "../../lib/desk/store";
import { shareSpace, spaceNameOf, stopSharing } from "../../lib/live/actions";
import { elapsedLabel, liveCardStatus, type LiveCardStatus } from "../../lib/live/entries";
import { sendLive, setLiveCardTab, useLiveShare, useLiveShareStore } from "../../lib/live/store";
import { useAppStore } from "../../store";
import { Button } from "../ui/button";
import { Note } from "../ui/note";
import { LiveChat } from "./LiveChat";
import { LiveShareTab } from "./LiveShareTab";

/** The Live card's width: the Stack's, a touch more for its rows of controls. */
const CARD_W = 320;

/**
 * The Live card (docs/live-share.md §1), a desk side card like the More
 * card and the Stack's (DeskSideCard: a cover, the pages under it giving way
 * to their stills; it goes on a press elsewhere or Escape). Its head is the
 * space shared, its live dot and how long it has been live; under it the
 * share (LiveShareTab: the link, who can join, the people, the windows,
 * the host's own mic, camera and pen) or its chat (LiveChat), and Stop
 * sharing. Starting, it says so; failed, it says why and offers to try again.
 */
export function LiveCard({
  ref,
  left,
  anchorTop,
  stageHeight,
  shown,
  onClose,
}: {
  ref: React.Ref<HTMLDivElement>;
  /** Its left edge in the stage. */
  left: number;
  /** Where its opener stands, in the stage: the card is level with it where it fits. */
  anchorTop: number;
  stageHeight: number;
  shown: boolean;
  onClose(): void;
}) {
  const state = useLiveShare((current) => current);
  const requested = useLiveShareStore((store) => store.requested);
  const tab = useLiveShareStore((store) => store.cardTab);
  const status = liveCardStatus(state, requested);
  const groupId = state.groupId ?? requested?.groupId ?? null;
  const name = useAppStore((store) => spaceNameOf(store.snapshot, groupId));
  const color = useAppStore((store) => deskGroups(store.snapshot).find((group) => group.id === groupId)?.color ?? "gray");
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (el === null) return;
    const measure = (): void => setHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The share over (stopped, ended, never started and put away): nothing left for the card to show.
  useEffect(() => {
    if (status === "idle") onClose();
  }, [status, onClose]);
  // The chat in view is read.
  const chatInView = shown && status === "live" && tab === "chat";
  useEffect(() => {
    if (chatInView && state.unread > 0) void sendLive({ type: "markRead" });
  }, [chatInView, state.unread]);

  const maxHeight = Math.max(160, stageHeight - 16);
  const top = Math.max(8, Math.min(anchorTop, stageHeight - Math.min(height, maxHeight) - 8));
  return (
    <div
      ref={(el) => {
        cardRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref !== null && ref !== undefined) (ref as React.RefObject<HTMLDivElement | null>).current = el;
      }}
      role="dialog"
      aria-label={`Live share: ${name}`}
      data-testid="live-card"
      data-shown={shown ? "" : undefined}
      data-status={status}
      data-group-color={color}
      className="desk-dock-menu live-card tab-group-tone"
      style={{ left, top, width: CARD_W, maxHeight }}
    >
      <LiveCardHead name={name} status={status} startedAt={state.startedAt} reconnecting={state.connection === "reconnecting"} />
      {status === "live" ? <LiveCardTabs tab={tab} unread={state.unread} /> : null}
      <div className="live-card-body scroll-thin">
        {status === "starting" ? (
          <LiveCardWaiting text={`Making a link for “${name}”…`} />
        ) : status === "ending" ? (
          <LiveCardWaiting text="Ending the share…" />
        ) : status === "error" ? (
          <LiveCardFailed error={state.error} onRetry={groupId === null ? null : () => void shareSpace(groupId)} />
        ) : status === "live" && tab === "chat" ? (
          <LiveChat chat={state.chat} />
        ) : status === "live" ? (
          <LiveShareTab state={state} name={name} />
        ) : null}
      </div>
      {status === "live" || status === "starting" ? (
        <div className="live-card-foot">
          <Button variant="error" size="xs" className="w-full" data-testid="live-stop" onMouseDown={(event) => event.preventDefault()} onClick={stopSharing}>
            {status === "starting" ? "Cancel" : "Stop sharing"}
          </Button>
        </div>
      ) : status === "error" ? (
        <div className="live-card-foot">
          <Button variant="secondary" size="xs" className="w-full" onMouseDown={(event) => event.preventDefault()} onClick={stopSharing}>
            Close
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The space shared, its live dot (pulsing once live; the room lost a moment, it says so), and how long it has been live. */
function LiveCardHead({ name, status, startedAt, reconnecting }: { name: string; status: LiveCardStatus; startedAt: number | null; reconnecting: boolean }) {
  const word = status === "live" ? (reconnecting ? "Reconnecting" : "Live") : status === "starting" ? "Starting" : status === "ending" ? "Ending" : status === "error" ? "Not live" : "";
  return (
    <div className="live-card-head">
      <span className="live-card-badge" data-status={status} data-reconnecting={reconnecting ? "" : undefined} data-testid="live-badge">
        <span className="live-dot" aria-hidden="true" />
        {word}
      </span>
      <span className="live-card-title" title={name}>
        {name}
      </span>
      {status === "live" && startedAt !== null ? <Elapsed since={startedAt} /> : null}
    </div>
  );
}

/** How long the share has been live, ticking once a second (its own render only). */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const label = elapsedLabel(now - since);
  return (
    <span className="live-card-elapsed" data-testid="live-elapsed" title={`Live for ${label}`}>
      {label}
    </span>
  );
}

/** The share, or its chat (with what is unread on it). */
function LiveCardTabs({ tab, unread }: { tab: "live" | "chat"; unread: number }) {
  return (
    <div className="live-card-tabs">
      <div className="desk-segmented" role="tablist" aria-label="Live card">
        <button type="button" role="tab" aria-selected={tab === "live"} data-testid="live-tab-share" onMouseDown={(event) => event.preventDefault()} onClick={() => setLiveCardTab("live")}>
          <Radio aria-hidden="true" />
          Share
        </button>
        <button type="button" role="tab" aria-selected={tab === "chat"} data-testid="live-tab-chat" onMouseDown={(event) => event.preventDefault()} onClick={() => setLiveCardTab("chat")}>
          <MessageSquare aria-hidden="true" />
          Chat
          {unread > 0 && tab !== "chat" ? (
            <span className="live-unread" data-testid="live-unread" aria-label={`${String(unread)} unread`}>
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

function LiveCardWaiting({ text }: { text: string }) {
  return (
    <div className="live-card-waiting" role="status" data-testid="live-starting">
      <LoaderCircle className="animate-spin" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

function LiveCardFailed({ error, onRetry }: { error: string | null; onRetry: (() => void) | null }) {
  return (
    <div className="flex flex-col gap-2 px-1.5 pt-1 pb-2" data-testid="live-error">
      <Note type="error" size="sm">
        {`Couldn't start: ${error ?? "something went wrong"}`}
      </Note>
      {onRetry === null ? null : (
        <Button variant="default" size="xs" className="self-start" data-testid="live-retry" onMouseDown={(event) => event.preventDefault()} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
