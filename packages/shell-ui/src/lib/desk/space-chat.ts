import type { ComposerAttachment } from "../chat-attachments";
import type { FloatSpot } from "./answer-float";

/**
 * A space's (tab group's) chat as the person left it, for this run of the
 * app (docs/desk-agent.md §1, "The chat is its space's"; since 2026-11-16):
 * whether its answer card was up, and what was in its message field — the
 * words typed and the files staged. The Bar is one, drawn for whichever
 * space is in front; passing to another space puts this away and takes out
 * that one's, so nothing of one space's chat shows in another. (Where the
 * card stands — docked, floating, at the side — is kept across launches:
 * answer-float.ts's spots.)
 */
export interface SpaceChat {
  /**
   * The answer card was up when the person left. Absent for a space not left
   * yet this run: `chatUpOnArrival` says what stands then. The space's own —
   * a tab of Home's is a space of its own here, so the chat up beside one tab
   * is not up beside the next (2026-11-17; until then it was kept with the
   * place the card stands in, which every tab of Home shares, and a chat at
   * Home's side came up again with every change of tab).
   */
  open?: boolean;
  /** "Whole conversation" was chosen in it. */
  whole: boolean;
  /** The message field's words, unsent. */
  draft: string;
  /** The files staged for the next message. */
  staged: ComposerAttachment[];
  /**
   * Its conversation as it was when the person left: which, how much had
   * been said, and what stood asked of them (null: none). Come back to with
   * more said, or something newly asked, its card comes up to show it.
   * Absent for a space not left yet.
   */
  left?: LeftChat | null;
}

/** A conversation as its space was left with it. `asking`: the question, takeover or approval that stood open then, by its id. */
export interface LeftChat {
  runId: string;
  messages: number;
  asking?: string | null;
}

const EMPTY: SpaceChat = { whole: false, draft: "", staged: [] };

const chats = new Map<string, SpaceChat>();

export function spaceChat(groupId: string): SpaceChat {
  return chats.get(groupId) ?? EMPTY;
}

export function keepSpaceChat(groupId: string, patch: Partial<SpaceChat>): void {
  chats.set(groupId, { ...spaceChat(groupId), ...patch });
}

/**
 * Whether a space's chat is up as the desk comes to it (docs/desk-agent.md
 * §1, "The chat is its space's"): as the person left it — up, or put away,
 * and one they closed stays closed. A change of tab or of space never opens
 * it by itself.
 *
 * Not left yet this run of the app, it is up only where it stood at its own
 * space's side when Pistachio was last open and was not closed there
 * (`FloatSpot.shut`): the chat a space keeps beside its windows. A tab of
 * Home's stands in Home's place, not one of its own (`place` is not its id),
 * and has no such word: where Home's chat stands says where one would come
 * up, never that it does.
 */
export function chatUpOnArrival(groupId: string, place: string, spot: Pick<FloatSpot, "floating" | "zone" | "shut"> | null): boolean {
  const left = chats.get(groupId)?.open;
  if (left !== undefined) return left;
  if (place !== groupId) return false;
  return spot !== null && spot.floating && spot.zone === "chat" && spot.shut !== true;
}

/**
 * Whether a conversation come back to has something new for the person
 * (`SpaceChat.left`), and so brings its card up by itself: more said than
 * when they left — the agent went on in the background — or something asked
 * of them that was not asked then. A question that already stood open when
 * they left, its card put away, is not asked again by every return.
 */
export function newSinceLeft(was: LeftChat | null, now: { runId: string; messages: number; asking: string | null }): boolean {
  const same = was !== null && was.runId === now.runId;
  if (same && now.messages > was.messages) return true;
  return now.asking !== null && !(same && was.asking === now.asking);
}

const takers = new Map<string, (attachment: ComposerAttachment) => void>();

/**
 * The Bar that is up for a space takes what is staged for it from elsewhere
 * (`stageInSpace`); returns the way to stop. A file may still be on its way
 * from a Bar that has gone — read while the person was in another Profile,
 * the desk made anew on their return (ContentArea's DeskMount): the Bar up
 * for its space now is the one to show it, not a list nobody reads again.
 */
export function takeStagedFor(groupId: string, take: (attachment: ComposerAttachment) => void): () => void {
  takers.set(groupId, take);
  return () => {
    if (takers.get(groupId) === take) takers.delete(groupId);
  };
}

/**
 * Stage a file for a space from outside its composer — one read, or added
 * from a page, after the person left it. A Bar up for that space takes it
 * into its list (`takeStagedFor`); with none, it is kept with what the space
 * was left with, for when they are back. False when the kept message
 * already holds `max`.
 */
export function stageInSpace(groupId: string, attachment: ComposerAttachment, max = Number.POSITIVE_INFINITY): boolean {
  const take = takers.get(groupId);
  if (take !== undefined) {
    take(attachment);
    return true;
  }
  const staged = spaceChat(groupId).staged;
  if (staged.length >= max) return false;
  keepSpaceChat(groupId, { staged: [...staged, attachment] });
  return true;
}

const writers = new Map<string, (text: string) => void>();

/**
 * The composer that is up for a space takes words put into its field from
 * elsewhere (`insertInSpace`); returns the way to stop.
 */
export function takeTextFor(groupId: string, insert: (text: string) => void): () => void {
  writers.set(groupId, insert);
  return () => {
    if (writers.get(groupId) === insert) writers.delete(groupId);
  };
}

/**
 * Put words into a space's message field from outside its composer — the
 * mention of a file just taken into the space's context, which took its
 * time. The composer up for that space has them at its caret; with none
 * (the person has gone to another space, or Profile), they join the words
 * the space was left with, a space between.
 */
export function insertInSpace(groupId: string, text: string): void {
  const insert = writers.get(groupId);
  if (insert !== undefined) {
    insert(text);
    return;
  }
  const draft = spaceChat(groupId).draft;
  keepSpaceChat(groupId, { draft: draft === "" || /\s$/u.test(draft) ? `${draft}${text}` : `${draft} ${text}` });
}

const sends = new Map<string, Promise<void>>();

/**
 * A space's messages go to main in the order they were sent. One may have
 * something to fetch first (a file it @mentions is read), and the next is
 * held behind it — whichever composer sent each: the Bar's composer is made
 * anew when the desk passes to another space and back, and a message sent
 * from the new one must not overtake one the old one is still reading a
 * file for. Each space has its own line; a send that fails holds nobody up.
 *
 * `go` is done when the message has been handed to main — never when main
 * has answered it, which is when the turn it started has ended: a message
 * sent while the agent works is a steer of that turn, and must not wait in
 * line for it to finish.
 */
export function queueSpaceSend(groupId: string, go: () => Promise<void>): Promise<void> {
  const next = (sends.get(groupId) ?? Promise.resolve()).then(go, go).catch(() => undefined);
  sends.set(groupId, next);
  void next.then(() => {
    if (sends.get(groupId) === next) sends.delete(groupId);
  });
  return next;
}

/** Tests: every space's chat as it was at launch. */
export function resetSpaceChats(): void {
  chats.clear();
  sends.clear();
  takers.clear();
  writers.clear();
}
