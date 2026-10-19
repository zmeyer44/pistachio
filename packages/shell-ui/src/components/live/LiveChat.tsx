import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { MAX_CHAT_LENGTH } from "@pistachio/live-share";
import type { LiveChatMessage } from "@pistachio/shell-contracts/live-share";
import { sendLive } from "../../lib/live/store";

/** Messages from the same person this close together read as one run: the name once. */
const RUN_MS = 2 * 60_000;

/**
 * The share's chat in the Live card: everyone's messages, oldest first, the
 * newest in view (kept at the foot as they come, unless the host scrolled
 * up to read), and a field to write in — Enter sends. The host's own go to
 * the room through main (`chat`), which keeps the share's last 200.
 */
export function LiveChat({ chat }: { chat: readonly LiveChatMessage[] }) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el !== null && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat]);
  const send = (): void => {
    const message = text.trim();
    if (message === "") return;
    setText("");
    pinned.current = true;
    void sendLive({ type: "chat", text: message });
  };
  return (
    <div className="live-chat" data-testid="live-chat">
      <div
        ref={listRef}
        className="live-chat-list scroll-thin"
        role="log"
        aria-label="Messages"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {chat.length === 0 ? (
          <p className="live-empty">Nothing said yet. Messages are for this share only and go when it ends.</p>
        ) : (
          chat.map((message, index) => {
            const before = chat[index - 1];
            const run = before !== undefined && before.from === message.from && message.at - before.at < RUN_MS;
            return (
              <div key={`${message.from}:${message.id}`} className="live-chat-message" data-run={run ? "" : undefined} data-testid="live-chat-message">
                {run ? null : (
                  <div className="live-chat-from">
                    <span style={{ color: message.color }}>{message.from === "host" ? "You" : message.name}</span>
                    <time dateTime={new Date(message.at).toISOString()}>{new Date(message.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                  </div>
                )}
                <p className="live-chat-text">{message.text}</p>
              </div>
            );
          })
        )}
      </div>
      <div className="live-chat-composer">
        <input
          type="text"
          value={text}
          data-testid="live-chat-input"
          aria-label="Message everyone"
          placeholder="Message everyone…"
          maxLength={MAX_CHAT_LENGTH}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-md bg-alpha-100 px-2 text-[12px] text-gray-1000 outline-none placeholder:text-gray-700 focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button type="button" aria-label="Send" title="Send" data-testid="live-chat-send" disabled={text.trim() === ""} className="live-chat-send" onMouseDown={(event) => event.preventDefault()} onClick={send}>
          <ArrowUp aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
