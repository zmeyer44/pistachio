/**
 * The guest's toolbar, a glass pill at the foot of the room (docs/live-share.md
 * §1 In the room): microphone and camera (devices, and the camera's
 * background, behind their chevrons); pointer, pen, highlighter, laser, the
 * ink's colour and "clear mine"; reactions; chat with its unread count; who
 * is here; leave. Keys: M, V, P, D, H, L, Esc, ⌘/.
 */

import { Eraser, Highlighter, LogOut, MessageCircle, MicOff, MousePointer2, PenLine, SmilePlus, Users, VideoOff } from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LIVE_COLORS, LIVE_REACTIONS, type LiveReaction, type LiveTool } from "@pistachio/live-share";
import { Popover, type MediaButtonProps, MediaButton } from "@pistachio/live-share/react";
import type { LiveParticipant } from "@pistachio/live-share/room";

function LaserIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" opacity="0.55" />
    </svg>
  );
}

const TOOLS: ReadonlyArray<{ tool: LiveTool; label: string; key: string; icon: ReactNode }> = [
  { tool: "pointer", label: "Pointer", key: "P", icon: <MousePointer2 aria-hidden="true" /> },
  { tool: "pen", label: "Pen", key: "D", icon: <PenLine aria-hidden="true" /> },
  { tool: "highlighter", label: "Highlighter", key: "H", icon: <Highlighter aria-hidden="true" /> },
  { tool: "laser", label: "Laser", key: "L", icon: <LaserIcon /> },
];

/** The ink's colours: mine first, then the room's palette, then white and ink-black for any page. */
function inkColors(mine: string): string[] {
  return [mine, ...LIVE_COLORS.filter((color) => color.toLowerCase() !== mine.toLowerCase()), "#FFFFFF", "#1C1D21"];
}

export interface ToolbarProps {
  microphone: Omit<MediaButtonProps, "kind" | "variant">;
  camera: Omit<MediaButtonProps, "kind" | "variant">;
  tool: LiveTool;
  onTool(tool: LiveTool): void;
  /** Why the ink tools are off (the host turned drawing off), or null. */
  drawingOff: string | null;
  inkColor: string;
  myColor: string;
  onInkColor(color: string): void;
  onClearMine(): void;
  onReact(emoji: LiveReaction): void;
  chatOpen: boolean;
  unread: number;
  onChat(): void;
  participants: readonly LiveParticipant[];
  onLeave(): void;
}

function useToggle(): [boolean, (value?: boolean) => void] {
  const [open, setOpen] = useState(false);
  return [open, (value?: boolean) => setOpen((current) => value ?? !current)];
}

export function Toolbar(props: ToolbarProps) {
  const { tool, onTool, drawingOff, inkColor, myColor, onInkColor, onClearMine, onReact, chatOpen, unread, onChat, participants, onLeave } = props;
  const [colorsOpen, toggleColors] = useToggle();
  const [reactionsOpen, toggleReactions] = useToggle();
  const [peopleOpen, togglePeople] = useToggle();
  const colorRef = useRef<HTMLButtonElement>(null);
  const reactRef = useRef<HTMLButtonElement>(null);
  const peopleRef = useRef<HTMLButtonElement>(null);
  const inking = tool !== "pointer";

  return (
    <nav className="lvg-toolbar" aria-label="Room controls" style={{ "--lvg-ink": inkColor } as CSSProperties}>
      <div className="lvg-toolbar-group">
        <MediaButton kind="microphone" shortcut="M" {...props.microphone} />
        <MediaButton kind="camera" shortcut="V" {...props.camera} />
      </div>
      <span className="lvg-toolbar-divider" aria-hidden="true" />
      <div className="lvg-toolbar-group" role="radiogroup" aria-label="Tool">
        {TOOLS.map(({ tool: each, label, key, icon }) => {
          const off = each !== "pointer" && drawingOff !== null;
          return (
            <button
              key={each}
              type="button"
              role="radio"
              aria-checked={tool === each}
              aria-label={label}
              className="lvg-tool"
              data-tool={each}
              disabled={off}
              title={off ? (drawingOff ?? label) : `${label} (${key})`}
              onClick={() => onTool(each)}
            >
              {icon}
            </button>
          );
        })}
        <div className="lv-popover-anchor">
          <button
            ref={colorRef}
            type="button"
            className="lvg-tool lvg-swatch-button"
            aria-label="Ink colour"
            aria-expanded={colorsOpen}
            title="Ink colour"
            disabled={drawingOff !== null}
            onClick={() => toggleColors()}
          >
            <span className="lvg-swatch" style={{ background: inkColor }} />
          </button>
          <Popover open={colorsOpen} onClose={() => toggleColors(false)} anchor={colorRef} label="Ink colour" className="lvg-colors">
            <div className="lvg-swatches" role="radiogroup" aria-label="Ink colour">
              {inkColors(myColor).map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={color.toLowerCase() === inkColor.toLowerCase()}
                  aria-label={color === myColor ? "Your colour" : color}
                  className="lvg-swatch-choice"
                  style={{ "--lvg-swatch": color } as CSSProperties}
                  onClick={() => {
                    onInkColor(color);
                    toggleColors(false);
                    if (!inking) onTool("pen");
                  }}
                />
              ))}
            </div>
          </Popover>
        </div>
        <button type="button" className="lvg-tool" aria-label="Clear my ink" title="Clear my ink" disabled={drawingOff !== null} onClick={onClearMine}>
          <Eraser aria-hidden="true" />
        </button>
      </div>
      <span className="lvg-toolbar-divider" aria-hidden="true" />
      <div className="lvg-toolbar-group">
        <div className="lv-popover-anchor">
          <button ref={reactRef} type="button" className="lvg-tool" aria-label="React" aria-expanded={reactionsOpen} title="React" onClick={() => toggleReactions()} data-reactions="">
            <SmilePlus aria-hidden="true" />
          </button>
          <Popover open={reactionsOpen} onClose={() => toggleReactions(false)} anchor={reactRef} label="Reactions" className="lvg-reactions">
            <div className="lvg-reaction-row">
              {LIVE_REACTIONS.map((emoji) => (
                <button key={emoji} type="button" className="lvg-reaction-choice" aria-label={`React ${emoji}`} onClick={() => onReact(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          </Popover>
        </div>
        <button type="button" className="lvg-tool" aria-label="Chat" aria-pressed={chatOpen} title="Chat (⌘/)" onClick={onChat}>
          <MessageCircle aria-hidden="true" />
          {unread > 0 && !chatOpen ? <span className="lvg-badge">{unread > 9 ? "9+" : unread}</span> : null}
        </button>
        <div className="lv-popover-anchor">
          <button ref={peopleRef} type="button" className="lvg-tool lvg-people-button" aria-label="People" aria-expanded={peopleOpen} title="People" onClick={() => togglePeople()}>
            <Users aria-hidden="true" />
            <span className="lvg-people-count">{participants.length}</span>
          </button>
          <Popover open={peopleOpen} onClose={() => togglePeople(false)} anchor={peopleRef} label="People" className="lvg-people" align="end">
            <div className="lv-menu-section">
              <div className="lv-menu-title">In the share</div>
              <ul className="lvg-people-list">
                {participants.map((person) => (
                  <li key={person.identity} className="lvg-person" style={{ "--lvg-person": person.color } as CSSProperties}>
                    <span className="lvg-person-face">{[...person.name][0]?.toLocaleUpperCase() ?? "?"}</span>
                    <span className="lvg-person-name">
                      {person.name}
                      {person.isLocal ? <span className="lvg-person-tag">You</span> : person.role === "host" ? <span className="lvg-person-tag">Host</span> : null}
                    </span>
                    <span className="lvg-person-media">
                      {person.micOn ? null : <MicOff aria-label="Muted" />}
                      {person.cameraOn ? null : <VideoOff aria-label="Camera off" />}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </Popover>
        </div>
      </div>
      <span className="lvg-toolbar-divider" aria-hidden="true" />
      <button type="button" className="lvg-leave" onClick={onLeave}>
        <LogOut aria-hidden="true" />
        <span>Leave</span>
      </button>
    </nav>
  );
}
