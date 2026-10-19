/**
 * The room's chat (docs/live-share.md §1, §4 Chat): the messages, grouped by
 * sender while they keep talking, and a composer — Return sends, Shift-Return
 * breaks the line. It follows the newest message unless the person has
 * scrolled up to read.
 */

import { ArrowUp, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { MAX_CHAT_LENGTH, type LiveChatEntry } from "../protocol.js";
import { chatKey } from "./chat-log.js";

export interface ChatPanelProps {
  messages: readonly LiveChatEntry[];
  /** My identity: my messages read "You". */
  me: string;
  onSend(text: string): void;
  onClose(): void;
  /** Can't send now (not connected); the composer says so. */
  disabled?: boolean;
  /** Take the keyboard as the panel opens. */
  autoFocus?: boolean;
  className?: string;
}

/** Messages from one person this close together share one header. */
const GROUP_MS = 3 * 60_000;
/** Pixels from the bottom that still count as "reading the newest". */
const STICK_PX = 48;

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function ChatPanel({ messages, me, onSend, onClose, disabled = false, autoFocus = false, className }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list !== null && stick.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

  // The composer grows with what is typed, up to a few lines.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120).toFixed(0)}px`;
  }, [draft]);

  const send = (): void => {
    const text = draft.trim();
    if (text === "" || disabled) return;
    onSend(text.slice(0, MAX_CHAT_LENGTH));
    setDraft("");
    stick.current = true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const left = MAX_CHAT_LENGTH - draft.length;
  return (
    <section className={["lv-chat", className].filter(Boolean).join(" ")} aria-label="Chat">
      <header className="lv-chat-head">
        <h2 className="lv-chat-title">Chat</h2>
        <button type="button" className="lv-icon-button" aria-label="Close chat" title="Close chat" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div
        ref={listRef}
        className="lv-chat-list"
        role="log"
        aria-live="polite"
        onScroll={(event) => {
          const list = event.currentTarget;
          stick.current = list.scrollHeight - list.scrollTop - list.clientHeight < STICK_PX;
        }}
      >
        {messages.length === 0 ? (
          <p className="lv-chat-empty">Messages here go to everyone in the share.</p>
        ) : (
          messages.map((message, index) => {
            const previous = messages[index - 1];
            const grouped = previous !== undefined && previous.from === message.from && Math.abs(message.at - previous.at) < GROUP_MS;
            const mine = message.from === me;
            return (
              <article key={chatKey(message)} className="lv-chat-message" data-grouped={grouped ? "" : undefined} data-mine={mine ? "" : undefined} style={{ "--lv-chat-color": message.color } as CSSProperties}>
                {grouped ? null : (
                  <header className="lv-chat-meta">
                    <span className="lv-chat-dot" aria-hidden="true" />
                    <span className="lv-chat-name">{mine ? "You" : message.name}</span>
                    <time className="lv-chat-time" dateTime={new Date(message.at).toISOString()}>
                      {time.format(message.at)}
                    </time>
                  </header>
                )}
                <p className="lv-chat-text">{message.text}</p>
              </article>
            );
          })
        )}
      </div>
      <form
        className="lv-chat-compose"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          ref={inputRef}
          className="lv-chat-input"
          rows={1}
          value={draft}
          maxLength={MAX_CHAT_LENGTH}
          placeholder={disabled ? "Reconnecting…" : "Message everyone"}
          aria-label="Message"
          disabled={disabled}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        {left < 200 ? <span className="lv-chat-left">{left}</span> : null}
        <button type="submit" className="lv-chat-send" aria-label="Send" title="Send" disabled={disabled || draft.trim() === ""}>
          <ArrowUp aria-hidden="true" />
        </button>
      </form>
    </section>
  );
}
