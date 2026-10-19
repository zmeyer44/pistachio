import { useEffect, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, Copy, Ellipsis, Link2, Mic, MicOff, UserX, Video, VideoOff, X } from "lucide-react";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import type { LiveAdmission, LiveGuest, LiveShareState, LiveWindowAsk } from "@pistachio/shell-contracts/live-share";
import { selectSpace } from "../../lib/desk/open";
import { deskGroups, useDeskStore, type SavedDesk } from "../../lib/desk/store";
import { setGuestsCanUse } from "../../lib/live/actions";
import { guestsCanBeLetUse, linkLabel, notStreamingReason, notUsableReason } from "../../lib/live/entries";
import { sendLive } from "../../lib/live/store";
import { useAppStore } from "../../store";
import { useContextMenu } from "../ContextMenu";
import { Favicon } from "../Favicon";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { LiveYou } from "./LiveYou";

/** The link's "copied" line stays this long after the share went live, or after Copy. */
const COPIED_MS = 4_000;

const NO_TABS: readonly BrowserTabInfo[] = [];

/**
 * The share in the Live card: the link and what guests see; who can join
 * and whether guests draw; anyone at the door and anyone asking for a window
 * (main's lists: a knock is shown only once control has it pending); the
 * people in the room; the space's windows, each with *Guests can use*; and
 * the host's own mic, camera, background and pen (LiveYou).
 */
export function LiveShareTab({ state, name }: { state: LiveShareState; name: string }) {
  // (The tab objects are the store's own, shared from one snapshot to the next: compared one by one.)
  const tabs = useAppStore(
    useShallow((store) => {
      const group = deskGroups(store.snapshot).find((candidate) => candidate.id === state.groupId);
      if (group === undefined || store.snapshot === null) return NO_TABS;
      return store.snapshot.tabs.filter((tab) => group.tabIds.includes(tab.id));
    }),
  );
  // (Which windows are masked: the space's arrangement as the desk keeps it.)
  const saved = useDeskStore((store) => (state.groupId === null ? undefined : store.saved[state.groupId]));
  const [errorSeen, setErrorSeen] = useState<string | null>(null);
  const menu = useContextMenu();
  const guestByIdentity = new Map(state.participants.map((guest) => [guest.identity, guest]));
  const titleOf = (windowId: string): string => tabs.find((tab) => tab.id === windowId)?.title || "a window";
  return (
    <>
      {state.error !== null && state.error !== errorSeen ? (
        <div role="status" data-testid="live-command-error" className="mx-1.5 mb-2 flex items-start gap-1.5 rounded-md bg-amber-100 px-2 py-1 text-[11px] leading-4 text-amber-900">
          <span className="min-w-0 flex-1">{state.error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setErrorSeen(state.error)} className="shrink-0 cursor-pointer rounded-xs p-0.5 hover:bg-amber-400">
            <X className="size-3" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {state.hostAway && state.groupId !== null ? (
        <div className="live-away" data-testid="live-away">
          <span className="min-w-0 flex-1">{`Guests see “${name}” as you left it while you're in another space.`}</span>
          <Button variant="secondary" size="xs" onMouseDown={(event) => event.preventDefault()} onClick={() => selectSpace(state.groupId!)}>
            Go back
          </Button>
        </div>
      ) : null}
      <LinkBlock link={state.link} startedAt={state.startedAt} />
      <div className="live-rows">
        <LiveRow label="Who can join">
          <AdmissionChoice value={state.admission} />
        </LiveRow>
        <LiveRow label="Guests can draw">
          <Switch label="Guests can draw" checked={state.guestsCanDraw} onChange={(allowed) => void sendLive({ type: "setGuestsCanDraw", allowed })} />
        </LiveRow>
      </div>
      {state.knocks.length === 0 ? null : (
        <LiveSection label="Waiting to join" count={state.knocks.length} testId="live-knocks">
          {state.knocks.map((knock) => (
            <div key={knock.requestId} className="live-row" data-testid="live-knock">
              <Avatar name={knock.name} color={null} />
              <span className="live-row-name">{knock.name}</span>
              <Button variant="tertiary" size="xs" data-testid="live-deny" onMouseDown={(event) => event.preventDefault()} onClick={() => void sendLive({ type: "deny", requestId: knock.requestId })}>
                Deny
              </Button>
              <Button size="xs" data-testid="live-admit" onMouseDown={(event) => event.preventDefault()} onClick={() => void sendLive({ type: "admit", requestId: knock.requestId })}>
                Admit
              </Button>
            </div>
          ))}
        </LiveSection>
      )}
      {state.asks.length === 0 ? null : (
        <LiveSection label="Asking to use a window" count={state.asks.length} testId="live-asks">
          {state.asks.map((ask) => (
            <AskRow key={`${ask.identity}:${ask.windowId}`} ask={ask} guest={guestByIdentity.get(ask.identity) ?? null} window={titleOf(ask.windowId)} />
          ))}
        </LiveSection>
      )}
      <LiveSection label="In the room" count={state.participants.length} testId="live-people">
        {state.participants.length === 0 ? (
          <p className="live-empty">No one yet. Send the link: {state.admission === "ask" ? "you'll be asked to let each person in." : "anyone with it comes straight in."}</p>
        ) : (
          state.participants.map((guest) => {
            const using = state.using.filter((use) => use.identity === guest.identity).map((use) => titleOf(use.windowId));
            return (
              <div key={guest.identity} className="live-row" data-testid="live-person">
                <Avatar name={guest.name} color={guest.color} speaking={guest.speaking === true} />
                <span className="live-row-name">
                  {guest.name}
                  {using.length === 0 ? null : <span className="live-row-note"> · using {using.join(", ")}</span>}
                </span>
                <MediaState on={guest.micOn} on-icon={<Mic aria-hidden="true" />} off-icon={<MicOff aria-hidden="true" />} label={guest.micOn ? "Mic on" : "Muted"} />
                <MediaState on={guest.cameraOn} on-icon={<Video aria-hidden="true" />} off-icon={<VideoOff aria-hidden="true" />} label={guest.cameraOn ? "Camera on" : "Camera off"} />
                <button
                  type="button"
                  aria-label={`${guest.name}: more`}
                  title="More"
                  data-testid="live-person-more"
                  className="live-icon-button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    menu.open({ clientX: box.left, clientY: box.bottom + 4 }, [
                      {
                        label: `Remove ${guest.name}`,
                        icon: <UserX aria-hidden="true" />,
                        danger: true,
                        testId: "live-remove",
                        onSelect: () => void sendLive({ type: "remove", identity: guest.identity }),
                      },
                    ]);
                  }}
                >
                  <Ellipsis aria-hidden="true" />
                </button>
              </div>
            );
          })
        )}
      </LiveSection>
      <LiveSection label="Windows" aside="Guests can use" testId="live-windows">
        {tabs.length === 0 ? (
          <p className="live-empty">No windows in “{name}” yet.</p>
        ) : (
          tabs.map((tab) => <WindowRow key={tab.id} tab={tab} state={state} saved={saved} guestByIdentity={guestByIdentity} />)
        )}
      </LiveSection>
      <LiveYou state={state} />
      {menu.menu}
    </>
  );
}

/** The link (Copy puts all of it on the clipboard, through main), and what guests will see. */
function LinkBlock({ link, startedAt }: { link: string | null; startedAt: number | null }) {
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  // Main copied the link as the share went live (§1): the card says so, a moment.
  const since = Math.max(copiedAt ?? Number.NEGATIVE_INFINITY, startedAt ?? Number.NEGATIVE_INFINITY);
  const [now, setNow] = useState(() => Date.now());
  const copied = now - since < COPIED_MS;
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, since + COPIED_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [copied, since]);
  if (link === null) return null;
  return (
    <div className="live-link-block">
      <div className="live-link-row">
        <span className="live-link" title={link} data-testid="live-link">
          <Link2 aria-hidden="true" />
          <span className="min-w-0 truncate">{linkLabel(link)}</span>
        </span>
        <Button
          variant="secondary"
          size="xs"
          data-testid="live-copy"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            void sendLive({ type: "copyLink" });
            const at = Date.now();
            setCopiedAt(at);
            setNow(at);
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="live-link-note" data-testid="live-link-note">
        {copied ? <span className="live-link-copied">Link copied · </span> : null}
        Guests see every window in this space.
      </p>
    </div>
  );
}

/** Who can join: knock and be let in (the default), or anyone with the link. */
function AdmissionChoice({ value }: { value: LiveAdmission }) {
  const choose = (admission: LiveAdmission): void => {
    if (admission !== value) void sendLive({ type: "setAdmission", admission });
  };
  return (
    <div className="desk-segmented" role="radiogroup" aria-label="Who can join" data-testid="live-admission" data-value={value}>
      <button type="button" role="radio" aria-checked={value === "ask"} title="Each person knocks, and you let them in" onMouseDown={(event) => event.preventDefault()} onClick={() => choose("ask")}>
        Ask me
      </button>
      <button type="button" role="radio" aria-checked={value === "open"} title="Anyone who has the link comes straight in" onMouseDown={(event) => event.preventDefault()} onClick={() => choose("open")}>
        Anyone with the link
      </button>
    </div>
  );
}

function AskRow({ ask, guest, window }: { ask: LiveWindowAsk; guest: LiveGuest | null; window: string }) {
  return (
    <div className="live-row" data-testid="live-ask">
      <Avatar name={ask.name} color={guest?.color ?? null} />
      <span className="live-row-name">
        {ask.name}
        <span className="live-row-note"> · {window}</span>
      </span>
      <Button
        variant="tertiary"
        size="xs"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void sendLive({ type: "answerAsk", identity: ask.identity, windowId: ask.windowId, allow: false })}
      >
        Deny
      </Button>
      <Button
        size="xs"
        data-testid="live-allow"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void sendLive({ type: "answerAsk", identity: ask.identity, windowId: ask.windowId, allow: true })}
      >
        Allow
      </Button>
    </div>
  );
}

/**
 * One of the space's windows with *Guests can use*. A page the shell draws
 * (home, notes, a brief, a terminal) guests watch but cannot use, and a
 * masked window is on the host's screen alone (docs/live-share.md §3, §6.6):
 * nothing to hand over, and the row says which under the window's name. A
 * page that does not stream now (minimized, or under the eight that do) can
 * be handed over for when it does, and the row says why it is not yet.
 */
function WindowRow({ tab, state, saved, guestByIdentity }: { tab: BrowserTabInfo; state: LiveShareState; saved: SavedDesk | undefined; guestByIdentity: ReadonlyMap<string, LiveGuest> }) {
  const usable = guestsCanBeLetUse(tab, saved);
  const why = usable ? notStreamingReason(state, tab.id) : notUsableReason(tab);
  const title = tab.title || "Untitled";
  const use = state.using.find((candidate) => candidate.windowId === tab.id);
  const user = use === undefined ? null : (guestByIdentity.get(use.identity) ?? null);
  return (
    <div className="live-row" data-testid="live-window" data-window-id={tab.id} data-usable={usable ? "" : undefined}>
      <Favicon src={tab.faviconUrl} seed={tab.url || title} />
      <span className="live-row-name">
        {title}
        {user === null ? null : (
          <span className="live-row-note" style={{ color: user.color }}>
            {" "}
            · {user.name}
          </span>
        )}
        {why === null ? null : (
          <span className="live-row-why" data-testid="live-window-why">
            {why}
          </span>
        )}
      </span>
      <Switch label={`Guests can use ${title}`} checked={usable && state.controllable.includes(tab.id)} disabled={!usable} onChange={(allowed) => setGuestsCanUse(tab.id, allowed)} />
    </div>
  );
}

/** A section of the card: its label (and how many), then its rows. */
export function LiveSection({ label, count, aside, testId, children }: { label: string; count?: number; aside?: string; testId?: string; children: ReactNode }) {
  return (
    <section className="live-section" data-testid={testId} aria-label={label}>
      <div className="live-section-label">
        <span>
          {label}
          {count === undefined || count === 0 ? null : <span className="live-section-count"> · {count}</span>}
        </span>
        {aside === undefined ? null : <span className="live-section-aside">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** A setting's row: its name, and its control at the trailing edge. */
export function LiveRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="live-row">
      <span className="live-row-label">{label}</span>
      {children}
    </div>
  );
}

/** A person: their initial on their colour (grey for someone not in yet), ringed while they speak. */
function Avatar({ name, color, speaking = false }: { name: string; color: string | null; speaking?: boolean }) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span
      className="live-avatar"
      aria-hidden="true"
      data-guest={color === null ? undefined : ""}
      data-speaking={speaking ? "" : undefined}
      style={color === null ? undefined : ({ background: color, "--live-guest": color } as React.CSSProperties)}
    >
      {initial}
    </span>
  );
}

/** A guest's mic or camera, as a sign. */
function MediaState(props: { on: boolean; "on-icon": ReactNode; "off-icon": ReactNode; label: string }) {
  return (
    <span className="live-media-state" data-on={props.on ? "" : undefined} role="img" aria-label={props.label} title={props.label}>
      {props.on ? props["on-icon"] : props["off-icon"]}
    </span>
  );
}
