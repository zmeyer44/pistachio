/**
 * What the live share says as notices (docs/live-share.md §1): someone at
 * the door ("Sam wants to join" — Admit), someone asking for a window ("Sam
 * asks to use GitHub" — Allow), a guest come or gone, a message while the
 * chat is not in view, and a share that ended on its own or could not start.
 * One notice for one happening, never a storm: knocks heard while a knock's
 * notice is up become one notice for all of them ("3 people want to join" —
 * Review, which opens the Live card), and so do asks and messages; a notice
 * whose knocks were all answered goes.
 *
 * Only what main's state holds is ever said: a knock is one main lists
 * (`LiveShareState.knocks`, confirmed against control's lobby), never
 * anything the room alone claims.
 *
 * Pure: `liveNoticesFor` reads two states; `LiveNotifier` keeps which
 * notices are up through the deps it is handed (the app store's notices, in
 * components/live/useLiveShareHost.ts), so test/live-notices.test.ts runs it
 * with a list of its own.
 */

import type { LiveChatMessage, LiveEndReason, LiveKnock, LiveShareState, LiveWindowAsk } from "@pistachio/shell-contracts/live-share";

export type LiveHappening =
  /** Someone new knocked: every knock still waiting. */
  | { kind: "knock"; knocks: readonly LiveKnock[] }
  /** Someone new asked for a window: every ask still waiting. */
  | { kind: "ask"; asks: readonly LiveWindowAsk[] }
  | { kind: "joined"; names: readonly string[] }
  | { kind: "left"; names: readonly string[] }
  /** Guests wrote: the messages new since the last state. */
  | { kind: "chat"; messages: readonly LiveChatMessage[] }
  /** The share ended, and not by the host's own hand. */
  | { kind: "ended"; reason: LiveEndReason }
  /** The share could not start. */
  | { kind: "failed"; error: string }
  /** No knocks wait any more (all answered, or the share ended): a knock's notice goes. */
  | { kind: "knocksDone" }
  | { kind: "asksDone" };

/** What changed between two states that the person should hear of. */
export function liveNoticesFor(previous: LiveShareState, next: LiveShareState): LiveHappening[] {
  const out: LiveHappening[] = [];
  if (previous.status === "starting" && next.status === "error") out.push({ kind: "failed", error: next.error ?? "something went wrong" });
  const wasActive = previous.status === "live" || previous.status === "ending";
  if (wasActive && next.status === "idle" && next.ended !== null && SAID_ENDINGS.has(next.ended)) out.push({ kind: "ended", reason: next.ended });
  if (next.status === "live") {
    const knocked = new Set(previous.knocks.map((knock) => knock.requestId));
    if (next.knocks.some((knock) => !knocked.has(knock.requestId))) out.push({ kind: "knock", knocks: next.knocks });
    const asked = new Set(previous.asks.map(askKey));
    if (next.asks.some((ask) => !asked.has(askKey(ask)))) out.push({ kind: "ask", asks: next.asks });
    const before = new Set(previous.participants.map((guest) => guest.identity));
    const now = new Set(next.participants.map((guest) => guest.identity));
    const joined = next.participants.filter((guest) => !before.has(guest.identity)).map((guest) => guest.name);
    if (joined.length > 0) out.push({ kind: "joined", names: joined });
    const left = previous.participants.filter((guest) => !now.has(guest.identity)).map((guest) => guest.name);
    if (left.length > 0 && previous.status === "live") out.push({ kind: "left", names: left });
    const seen = new Set(previous.chat.map(messageKey));
    const messages = next.chat.filter((message) => message.from !== "host" && !seen.has(messageKey(message)));
    if (messages.length > 0) out.push({ kind: "chat", messages });
  }
  if (previous.knocks.length > 0 && (next.knocks.length === 0 || next.status !== "live")) out.push({ kind: "knocksDone" });
  if (previous.asks.length > 0 && (next.asks.length === 0 || next.status !== "live")) out.push({ kind: "asksDone" });
  return out;
}

/** The endings worth a word: the host's own (Stop sharing, quitting, the window closed) are not news to them. */
const SAID_ENDINGS: ReadonlySet<LiveEndReason> = new Set<LiveEndReason>(["space-closed", "profile-switched", "ended-elsewhere", "failed", "account-changed"]);

function askKey(ask: LiveWindowAsk): string {
  return `${ask.identity}\u0000${ask.windowId}`;
}

function messageKey(message: LiveChatMessage): string {
  return `${message.from}\u0000${message.id}`;
}

/** Names as a sentence's subject: "Sam", "Sam and Ann", "3 people". */
export function namesPhrase(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]!} and ${names[1]!}`;
  return `${String(names.length)} people`;
}

/** Why a share ended, as its notice says it. */
export function endedLine(reason: LiveEndReason): string {
  switch (reason) {
    case "space-closed":
      return "Live share ended: its space was closed";
    case "profile-switched":
      return "Live share ended: you switched Profile";
    case "ended-elsewhere":
      return "Live share ended: it was stopped elsewhere or timed out";
    case "failed":
      return "Live share stopped: its call window closed unexpectedly";
    case "account-changed":
      return "Live share ended: the account on this Mac changed";
    case "stopped":
    case "quit":
    case "window-closed":
      return "Live share ended";
  }
}

/** A message's notice: its sender and as much of it as reads in one line. */
export function chatLine(messages: readonly LiveChatMessage[]): string {
  if (messages.length > 1) return `${String(messages.length)} new messages in the live chat`;
  const message = messages[0]!;
  const text = message.text.replace(/\s+/g, " ").trim();
  return `${message.name}: ${[...text].length > 80 ? `${[...text].slice(0, 79).join("")}…` : text}`;
}

export interface LiveNoticeOptions {
  tone?: "neutral" | "success" | "warning";
  action?: { label: string; run(): void };
}

export interface LiveNotifierDeps {
  /** Say something; the notice's id, or null where none was made. */
  show(message: string, options: LiveNoticeOptions): number | null;
  dismiss(id: number): void;
  /** The notice is still up. */
  isShown(id: number): boolean;
  /** What the Live card shows now: what it shows needs no notice. */
  card(): "live" | "chat" | null;
  /** The name of a window guests asked for. */
  windowName(windowId: string): string;
  admit(requestId: string): void;
  allow(ask: LiveWindowAsk): void;
  /** Open the Live card (on its chat). */
  openCard(tab: "live" | "chat"): void;
  retry(): void;
}

/** Says the happenings, keeping one notice for the knocks, one for the asks and one for the chat. */
export class LiveNotifier {
  readonly #deps: LiveNotifierDeps;
  #knock: number | null = null;
  #ask: number | null = null;
  #chat: number | null = null;
  #unreadSinceNotice = 0;

  constructor(deps: LiveNotifierDeps) {
    this.#deps = deps;
  }

  take(previous: LiveShareState, next: LiveShareState): void {
    for (const happening of liveNoticesFor(previous, next)) this.#say(happening);
  }

  #say(happening: LiveHappening): void {
    const deps = this.#deps;
    switch (happening.kind) {
      case "knock": {
        if (deps.card() === "live") return;
        const knocks = happening.knocks;
        const only = knocks.length === 1 ? knocks[0]! : null;
        this.#knock = this.#replace(
          this.#knock,
          only !== null ? `${only.name} wants to join` : `${String(knocks.length)} people want to join`,
          only !== null ? { action: { label: "Admit", run: () => deps.admit(only.requestId) } } : { action: { label: "Review", run: () => deps.openCard("live") } },
        );
        return;
      }
      case "ask": {
        if (deps.card() === "live") return;
        const asks = happening.asks;
        const only = asks.length === 1 ? asks[0]! : null;
        this.#ask = this.#replace(
          this.#ask,
          only !== null ? `${only.name} asks to use ${deps.windowName(only.windowId)}` : `${String(asks.length)} asks to use a window`,
          only !== null ? { action: { label: "Allow", run: () => deps.allow(only) } } : { action: { label: "Review", run: () => deps.openCard("live") } },
        );
        return;
      }
      case "joined":
        deps.show(`${namesPhrase(happening.names)} joined`, {});
        return;
      case "left":
        deps.show(`${namesPhrase(happening.names)} left`, {});
        return;
      case "chat": {
        if (deps.card() === "chat") return;
        // Several while one is up: one notice that counts them all.
        const shown = this.#chat !== null && deps.isShown(this.#chat);
        this.#unreadSinceNotice = (shown ? this.#unreadSinceNotice : 0) + happening.messages.length;
        const line = this.#unreadSinceNotice === happening.messages.length ? chatLine(happening.messages) : `${String(this.#unreadSinceNotice)} new messages in the live chat`;
        this.#chat = this.#replace(this.#chat, line, { action: { label: "Reply", run: () => deps.openCard("chat") } });
        return;
      }
      case "ended":
        this.#drop();
        deps.show(endedLine(happening.reason), { tone: "warning" });
        return;
      case "failed":
        if (deps.card() !== null) return;
        deps.show(`Couldn't start sharing: ${happening.error}`, { tone: "warning", action: { label: "Try again", run: deps.retry } });
        return;
      case "knocksDone":
        this.#knock = this.#gone(this.#knock);
        return;
      case "asksDone":
        this.#ask = this.#gone(this.#ask);
        return;
    }
  }

  /** The notice `id` (if still up) gives way to this one. */
  #replace(id: number | null, message: string, options: LiveNoticeOptions): number | null {
    if (id !== null && this.#deps.isShown(id)) this.#deps.dismiss(id);
    return this.#deps.show(message, options);
  }

  #gone(id: number | null): null {
    if (id !== null && this.#deps.isShown(id)) this.#deps.dismiss(id);
    return null;
  }

  /** The share is over: what it asked of the person goes with it. */
  #drop(): void {
    this.#knock = this.#gone(this.#knock);
    this.#ask = this.#gone(this.#ask);
    this.#chat = this.#gone(this.#chat);
  }
}
