import { useEffect } from "react";
import { composerAttachmentFromInsert, MAX_COMPOSER_ATTACHMENTS } from "../../lib/chat-attachments";
import { useAppStore } from "../../store";
import type { useAttachmentDrop } from "./attachment-drop";

/**
 * "Add … to Chat" from a page's right-click menu — a selection, a picture —
 * lands in the chat's message field, staged like a file dropped on it
 * (main's chat-attach.ts; the store's `chatInbox`). Whichever chat is the
 * surface's takes it: the desk's Bar on the desktop (DeskBar), the sidebar's
 * console where there is no desk (AgentConsole). The inbox is drained on
 * arrival — and on mount, for the case where choosing the item is what
 * brought the chat out — and `arrived` puts the keyboard in the field.
 */
export function useChatInbox(drop: Pick<ReturnType<typeof useAttachmentDrop>, "staged" | "setStaged" | "reject">, arrived: () => void): void {
  const { staged, setStaged, reject } = drop;
  const chatInbox = useAppStore((state) => state.chatInbox);
  const takeChatInbox = useAppStore((state) => state.takeChatInbox);
  useEffect(() => {
    if (chatInbox.inserts.length === 0 && chatInbox.rejection === null) return;
    const inbox = takeChatInbox();
    const room = Math.max(0, MAX_COMPOSER_ATTACHMENTS - staged.length);
    const accepted = inbox.inserts.slice(0, room);
    if (inbox.rejection !== null) reject(inbox.rejection);
    else if (accepted.length < inbox.inserts.length) reject(`At most ${String(MAX_COMPOSER_ATTACHMENTS)} files per message`);
    if (accepted.length > 0) setStaged((prev) => [...prev, ...accepted.map(composerAttachmentFromInsert)]);
    arrived();
    // (`arrived` is the caller's of the moment: the inbox alone says when.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatInbox, staged.length, takeChatInbox, reject, setStaged]);
}
