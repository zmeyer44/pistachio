import type { EvidenceEntry } from "@pistachio/evidence";
import { isTerminalStatus, type AgentAttachment, type RunSummary, type ThreadListItem } from "@pistachio/protocol";
import type { DeskConversationCommand, SpaceAgentState } from "@pistachio/shell-contracts/desk-agent";
import { parseAuthorMarker } from "./extensions/agent";
import type { ScheduledAgentOutcome, ScheduledAgentRequest } from "./reminder-scheduler";
import { isCloudRun, RunController, TurnCheckpoints, type NoteRecordStore, type RunTurnOptions } from "./run-controller";

/**
 * What a cloud conversation is doing, for its space's tile: the cloud browser goes on without this Mac, and without
 * a console here, so its state is read from what control says of it (`RunHub.refreshRemote`).
 */
function remoteAgentState(run: RunSummary): Exclude<SpaceAgentState, "answered"> | null {
  if (!isCloudRun(run) || isTerminalStatus(run.status)) return null;
  const waits =
    run.pendingQuestion !== null ||
    run.pendingApproval !== null ||
    run.pendingTakeover !== null ||
    run.status === "waiting_for_approval" ||
    run.status === "waiting_for_judgment" ||
    run.status === "waiting_for_step_up" ||
    run.status === "human_control";
  if (waits) return "asking";
  return run.status !== "interrupted" && run.control === "agent" ? "working" : null;
}

/** What a console is made with; the hub says for itself when one's turn has ended. */
export type RunHubOptions = Omit<ConstructorParameters<typeof RunController>[0], "onSettled" | "checkpoints">;

export type { RunTurnOptions };

/**
 * The agent's conversations, each in its own space (docs/desk-agent.md §3,
 * "Conversations stay in their space"; since 2026-11-16).
 *
 * A console (RunController) holds one conversation: its thread, its model
 * history, the turn it is running. There was one console, and it followed
 * the person — a turn still running in the space they left went with them to
 * the next, and kept its Bar. Now the hub keeps a console for every
 * conversation that has something going, and shows the one of the space in
 * front:
 *
 * - **The space in front shows its own.** `followGroup` — main's current
 *   space changed — brings up the console holding the conversation bound to
 *   that space (DeskConversationStore), or opens it from the store, or an
 *   empty console where the space has none yet. Everything the shell asks
 *   (a message, an approval, Stop) is asked of that console.
 * - **A conversation with something going stays where it is.** The console
 *   the person left is kept, and goes on, while it is `engaged`: a turn
 *   acting, or a question, an approval or a takeover they have yet to
 *   answer. Nothing is cancelled for their having looked elsewhere, and
 *   nothing goes with them. An idle one is saved and set aside, as leaving a
 *   conversation always did (its research tabs closed), and its console is
 *   reused for the next space — so with no agent at work there is one
 *   console, as there always was.
 * - **Each goes at its own pace.** Two spaces' turns run side by side, each
 *   in its own tabs (a desk turn is scoped to its space's: DeskScope). A
 *   desk not in view cannot be read or arranged — the shell draws one desk —
 *   and its turn is told so by the tool, and goes on with the rest.
 * - **A reminder's task is no space's.** It runs in a console of its own,
 *   never in front by itself: it takes nobody's conversation from them. It
 *   is in the list of conversations as it works (Reminder), and choosing it
 *   there shows it — its console — in the space the person is in.
 *
 * One conversation is in one console at most (`#find`): a space bound to a
 * conversation at work in another shows that same console. The rail's tiles
 * say what goes on in the spaces nobody is looking at (`spaceAgent`).
 */
export class RunHub {
  readonly #options: RunHubOptions;
  /** Every console that holds a conversation, and the one in front (which may hold none). */
  readonly #consoles: RunController[] = [];
  /** The console of the space in front: what the shell is shown, and what it asks things of. */
  #front: RunController;
  /** The space (tab group) in front, as main last said; null while it has none to name. */
  #group: string | null = null;
  /** Consoles a reminder's task is still to be heard from: never let go of meanwhile (startScheduled). */
  readonly #held = new Set<RunController>();
  /** The reminder's task running now, if one is: they run one at a time. */
  #scheduled: RunController | null = null;
  #notes: NoteRecordStore | null = null;
  /**
   * Spaces whose conversation ended a turn while they were not in front, and which conversation it was, until the
   * person looks (`spaceAgents`). It says so only for as long as that is still the space's conversation: deleted,
   * or the space given another (or gone, or merged away), there is nothing left there to read.
   */
  readonly #answered = new Map<string, string>();
  /** What the thread list last said of each console not in front: only a change of it is worth a publish. */
  readonly #lastLive = new WeakMap<RunController, string>();
  /** What the rail was last told goes on in the spaces. */
  #lastSpaces = "";
  /** Each conversation's last turn as it was started, for Retry: the conversation's, not its console's of the moment. */
  readonly #checkpoints = new TurnCheckpoints();
  /**
   * Cloud conversations started from a space's Bar whose first event is yet to be folded (`cloudStarted`): bound
   * to their space already, with no thread in the store yet — on its way, not deleted.
   */
  readonly #arriving = new Set<string>();
  /**
   * Cloud conversations with something going, by run, as control last said (`refreshRemote`). They go on in the
   * cloud browser whether or not a console here holds them — a console is let go of when the person leaves a cloud
   * conversation's space, having nothing of its own going — so their spaces' tiles are told from here.
   */
  readonly #remote = new Map<string, Exclude<SpaceAgentState, "answered">>();

  constructor(options: RunHubOptions) {
    this.#options = options;
    this.#front = this.#make();
    this.#consoles.push(this.#front);
  }

  #make(): RunController {
    const made: RunController = new RunController({
      ...this.#options,
      onChange: () => this.#changed(made),
      onSettled: () => this.#settled(made),
      // (The conversations' own, whichever console each is in at the time: a turn that ended behind the person, its
      // console let go of, can still be retried when they are back.)
      checkpoints: this.#checkpoints,
    });
    made.setNoteStore(this.#notes);
    return made;
  }

  get #desk(): NonNullable<RunHubOptions["desk"]> | null {
    return this.#options.desk ?? null;
  }

  /** The console holding a conversation, if one does. */
  #find(runId: string): RunController | null {
    return this.#consoles.find((candidate) => candidate.runId() === runId) ?? null;
  }

  /** A console may not be given another conversation, nor let go of: something is going on in it. */
  #kept(candidate: RunController): boolean {
    return candidate.engaged() || this.#held.has(candidate);
  }

  /**
   * A console changed. The one in front is what the shell shows: every change
   * of it is published (a streamed reply's words among them). One at work
   * elsewhere shows only in the list of conversations and on its space's
   * tile, so it is published when what those say changes — not for every
   * word of a reply nobody is reading.
   */
  #changed(console: RunController): void {
    const spaces = JSON.stringify(this.spaceAgents());
    const spacesChanged = spaces !== this.#lastSpaces;
    this.#lastSpaces = spaces;
    if (console !== this.#front && !spacesChanged) {
      const live = JSON.stringify(console.liveThread());
      if (this.#lastLive.get(console) === live) return;
      this.#lastLive.set(console, live);
    }
    this.#options.onChange();
  }

  /** A turn ended in `console`, which has finished with it. */
  #settled(console: RunController): void {
    const host = this.#desk;
    const runId = console.runId();
    // Ended with nothing left to ask, in a space nobody is looking at: its tile says there is something to read.
    if (console !== this.#front && runId !== null && host !== null && !console.engaged()) {
      for (const groupId of host.bindings.groupsOf(runId)) if (groupId !== this.#group) this.#answered.set(groupId, runId);
    }
    this.#sweep();
    this.#spacesChanged();
  }

  /**
   * Let go of every console nobody is looking at that has nothing going: its
   * conversation is saved and set aside (RunController.clear), to be opened
   * from the store when its space comes to the front.
   */
  #sweep(): void {
    let gone = false;
    for (const console of [...this.#consoles]) {
      if (console === this.#front || this.#kept(console)) continue;
      console.clear();
      this.#consoles.splice(this.#consoles.indexOf(console), 1);
      if (this.#scheduled === console) this.#scheduled = null;
      gone = true;
    }
    if (gone) this.#options.onChange();
  }

  /** The rail's tiles follow what goes on in the spaces: published when `spaceAgents` would say something else. */
  #spacesChanged(): void {
    const now = JSON.stringify(this.spaceAgents());
    if (now === this.#lastSpaces) return;
    this.#lastSpaces = now;
    this.#options.onChange();
  }

  /**
   * What the agent is doing in each space it has something going in, for the
   * rail's tiles (ShellSnapshot.spaceAgents): at work, waiting on the person,
   * or done with something they have not looked at since. A space bound to a
   * conversation at work in another space's console says what that one does.
   */
  spaceAgents(): Record<string, SpaceAgentState> {
    const host = this.#desk;
    const agents: Record<string, SpaceAgentState> = {};
    if (host === null) return agents;
    for (const [groupId, runId] of this.#answered) {
      if (host.bindings.get(groupId) === runId) agents[groupId] = "answered";
      else this.#answered.delete(groupId);
    }
    for (const console of this.#consoles) {
      const runId = console.runId();
      if (runId === null || !console.engaged()) continue;
      for (const groupId of host.bindings.groupsOf(runId)) agents[groupId] = console.acting() ? "working" : "asking";
    }
    for (const [runId, state] of this.#remote) for (const groupId of host.bindings.groupsOf(runId)) agents[groupId] = state;
    return agents;
  }

  /* ------------------------------ what is shown ------------------------------ */

  /** The space whose conversation is shown (ShellSnapshot.runSpace): the one in front, as last followed. */
  frontGroup(): string | null {
    return this.#group;
  }

  snapshot(): RunSummary | null {
    return this.#front.snapshot();
  }

  /** The conversation of the space in front, live and uncloned (RunController.peek). */
  peek(): Readonly<RunSummary> | null {
    return this.#front.peek();
  }

  evidence(): EvidenceEntry[] {
    return this.#front.evidence();
  }

  /** The space in front's conversation is running or waiting on the person. */
  busy(): boolean {
    return this.#front.busy();
  }

  timezone(): string {
    return this.#front.timezone();
  }

  /**
   * Every saved thread, newest first, each one a console holds reflecting
   * its live state — the one in front first, then any that started since the
   * store last wrote.
   */
  threads(): ThreadListItem[] {
    const saved = this.#options.threads?.list() ?? [];
    const live = new Map<string, ThreadListItem>();
    for (const console of this.#consoles) {
      const item = console.liveThread();
      if (item !== null) live.set(item.runId, item);
    }
    if (live.size === 0) return saved;
    const front = this.#front.liveThread();
    const rest = saved.filter((item) => item.runId !== front?.runId).map((item) => live.get(item.runId) ?? item);
    const known = new Set(rest.map((item) => item.runId));
    const fresh = [...live.values()].filter((item) => item.runId !== front?.runId && !known.has(item.runId));
    return [...(front === null ? [] : [front]), ...fresh, ...rest];
  }

  setNoteStore(store: NoteRecordStore | null): void {
    this.#notes = store;
    for (const console of this.#consoles) console.setNoteStore(store);
  }

  /* ------------------------------ which console ------------------------------ */

  /**
   * On launch: the conversation that was open when the app last quit comes
   * back (RunController.open marks a turn that was running then as paused) —
   * and then the current space's, once main names one (followGroup).
   */
  restore(): void {
    const latest = this.#options.threads?.latest() ?? null;
    if (latest === null) return;
    this.#front.open(latest);
    // At home in its own space from the start. One that still waits on the person is kept when the space in front
    // turns out to be another (followGroup), and an answer from afar then runs it where it belongs: in its space's
    // tabs, with its space's desk tools — not loose in the whole browser, as a console with no home is.
    const host = this.#desk;
    if (host !== null) this.#front.home(this.#homeOf(host, latest.run.runId, latest.run.groupId));
    this.#options.onChange();
  }

  /**
   * The space (tab group) in front changed, as main says (BrowserController
   * onCurrentGroupChange; docs/spaces.md §2): its conversation is the one
   * shown now. The console the person leaves stays as it is while it has
   * something going (`#kept`), in its own space. Null: main has no space to
   * name; nothing more is the desk's.
   */
  followGroup(groupId: string | null): void {
    const host = this.#desk;
    if (host === null) return;
    if (groupId === null) {
      if (this.#group === null) return;
      this.#group = null;
      host.bridge.cancelAll();
      if (!this.#kept(this.#front)) this.#front.home(null);
      this.#options.onChange();
      return;
    }
    if (this.#group === groupId) return;
    this.#group = groupId;
    this.#answered.delete(groupId);
    this.#show(this.#consoleOf(host, groupId));
    this.#spacesChanged();
    this.#options.onChange();
  }

  /**
   * The conversation bound to a space changed outside its console — a space
   * merged into it brought its own (main's moveGroupHoldings; docs/spaces.md
   * §1, "Merging spaces"): when that space is the one in front, its
   * conversation is shown now, which followGroup cannot do here, since the
   * space in front did not change. Any other space shows it when it comes to
   * the front.
   */
  groupConversationChanged(groupId: string): void {
    const host = this.#desk;
    if (host === null || this.#group !== groupId) return;
    this.#show(this.#consoleOf(host, groupId));
    this.#spacesChanged();
    this.#options.onChange();
  }

  /**
   * The console of a space: the one holding the conversation bound to it,
   * wherever that is at work; else that conversation opened from the store,
   * or nothing, in the console in front when it is free (what it held is set
   * aside) and in a new one when it is not.
   */
  #consoleOf(host: NonNullable<RunHubOptions["desk"]>, groupId: string): RunController {
    const bound = host.bindings.get(groupId);
    if (bound !== null) {
      const holder = this.#find(bound);
      if (holder !== null) return holder;
    }
    const record = bound === null ? null : (this.#options.threads?.get(bound) ?? null);
    // A thread deleted since it was bound leaves nothing to open. (One only just started in the cloud is on its way.)
    if (bound !== null && record === null && !this.#arriving.has(bound)) {
      host.bindings.unbind(groupId);
      host.browser.refreshSpaces?.();
    }
    const target = this.#kept(this.#front) ? this.#make() : this.#front;
    if (record === null) target.clear();
    else target.open(record);
    return target;
  }

  /** `next` is the console in front from now on, at home in the space in front; the one it replaces goes if nothing keeps it. */
  #show(next: RunController): void {
    if (!this.#consoles.includes(next)) this.#consoles.push(next);
    const changed = this.#front !== next;
    this.#front = next;
    if (this.#group !== null) next.home(this.#group);
    if (changed) this.#sweep();
  }

  /** The console of the space in front as main has it now (a message is that space's, whatever was last followed). */
  #current(): RunController {
    const host = this.#desk;
    if (host !== null) {
      const groupId = host.browser.currentGroupId();
      if (groupId !== this.#group) this.followGroup(groupId);
    }
    return this.#front;
  }

  /**
   * The console a message is for. The Bar says which space it was sent in
   * (`groupId`): the one in front, as a rule, and then its console is the
   * one shown. A message still on its way as the person left — a file it
   * mentions was being read — is its own space's all the same: it runs
   * there, behind them, in the console that space's conversation is in or
   * one opened for it. Nobody is moved, and the space they went to is not
   * handed words meant for another. (No space named: the space in front's,
   * as every message was until 2026-11-17.)
   */
  #consoleFor(groupId: string | undefined, fresh = false): RunController {
    const front = this.#current();
    const host = this.#desk;
    if (host === null || groupId === undefined || groupId === this.#group) {
      // (A conversation of its own begun in the space in front: one there that is another space's too, with
      // something going, is left to that space — `#leaveShared` — and this one has a console to itself.)
      if (fresh && this.#leaveShared()) return this.#front;
      return front;
    }
    if (host.browser.tabGroupSpaceId(groupId) === null) throw new Error("that space is no longer open, so the message was not sent");
    const bound = host.bindings.get(groupId);
    const holder = bound === null ? null : this.#find(bound);
    // (Wherever that console is at home — the conversation may be another space's too, the one in front's even: the
    // message says which space it is from, and its turn is that space's. RunController's `#deskTurn`.)
    //
    // Not so a message that begins a conversation of its own (`fresh`: the Bar's `/extension`). Begun in a console
    // at home in another space — the conversation shared, and shown there — it would take that space's conversation
    // from in front of the person, for one that is the sending space's. It has a console of its own, at home in the
    // space it was sent from, which it is bound to as it starts; the shared one stays where it is shown.
    const elsewhere = holder !== null && fresh && holder.homeGroup() !== groupId;
    if (holder !== null && !elsewhere) return holder;
    const record = bound === null || elsewhere ? null : (this.#options.threads?.get(bound) ?? null);
    // A thread deleted since it was bound leaves nothing to open. (One only just started in the cloud is on its way.)
    if (bound !== null && record === null && !elsewhere && !this.#arriving.has(bound)) {
      host.bindings.unbind(groupId);
      host.browser.refreshSpaces?.();
    }
    const made = this.#make();
    if (record !== null) made.open(record);
    made.home(groupId);
    this.#consoles.push(made);
    return made;
  }

  /**
   * A message to a console, which `#consoleFor` may have made for it: once it is taken — or refused before any turn
   * began — a console behind the space in front with nothing going is let go of (a turn's own end sweeps too,
   * `#settled`; a cloud conversation's message starts no turn here).
   */
  async #said(turn: () => Promise<void>): Promise<void> {
    try {
      await turn();
    } finally {
      this.#sweep();
      this.#spacesChanged();
    }
  }

  /**
   * Show a conversation in the space in front, which is its from now on (the
   * space it came from keeps it too). One at work in another console — its
   * own space's, or a reminder's — is that console, shown here as well. The
   * one that was here goes on if it is another space's too; else it is set
   * aside, as choosing another always set it aside.
   */
  #openHere(runId: string, verb: string): void {
    const host = this.#desk;
    const before = this.#front;
    if (before.runId() !== runId) {
      if (before.acting()) throw new Error(`pause or end the current task before ${verb} another conversation`);
      let target = this.#find(runId);
      if (target === null) {
        const record = this.#options.threads?.get(runId) ?? null;
        if (record === null) throw new Error("that conversation is no longer available");
        target = this.#kept(before) ? this.#make() : before;
        target.open(record);
      }
      this.#show(target);
    }
    if (host !== null && this.#group !== null) {
      host.bindings.bind(this.#group, runId);
      host.browser.refreshSpaces?.();
    }
    // (One whose turn is only now ending is left to end: the sweep lets go of it then.)
    if (before !== this.#front && this.#consoles.includes(before) && !this.#held.has(before) && !before.settling()) {
      const was = before.runId();
      if (was !== null && (host === null || host.bindings.groupsOf(was).length === 0)) {
        before.clear();
        this.#consoles.splice(this.#consoles.indexOf(before), 1);
      } else if (was !== null && host !== null) {
        // Another space's still: it goes on there, at home in that space — not in this one, which has let go of it.
        before.home(this.#homeOf(host, was, before.peek()?.groupId));
      }
    }
    this.#spacesChanged();
  }

  /** Open a saved thread in the space in front. Its conversation must not be acting. */
  openThread(runId: string): void {
    this.#openHere(runId, "opening");
    this.#options.onChange();
  }

  /** A fresh conversation for the space in front. A task still acting there is stopped first. */
  async newThread(): Promise<void> {
    const host = this.#desk;
    if (host !== null && this.#group !== null && host.bindings.get(this.#group) !== null) {
      host.bindings.unbind(this.#group);
      host.browser.refreshSpaces?.();
    }
    const front = this.#front;
    if (this.#leaveShared()) {
      this.#options.onChange();
    } else if (front.settling() && !front.acting()) {
      // Its last turn is done but still saying so (the notification, an answer sent on): it is left to, in its own
      // console, and the space has a new one for what comes next.
      this.#show(this.#make());
      this.#options.onChange();
    } else {
      await front.newThread();
    }
    this.#spacesChanged();
  }

  /**
   * The space in front is about to have another conversation in its console
   * — a new one, an author's thread. When the one there now is another
   * space's too (chosen there, or here) with something going — a turn at
   * work, a question, an approval — it is that space's still: left as it
   * stands, in its own console, at home there, and the space in front given
   * a console of its own. Clearing it for this space's sake would cancel
   * what the other space is waiting on. False when there is nothing to leave
   * so: the console in front is this space's to clear.
   */
  #leaveShared(): boolean {
    const host = this.#desk;
    const front = this.#front;
    const was = front.runId();
    if (host === null || was === null || !this.#kept(front)) return false;
    const others = host.bindings.groupsOf(was).filter((groupId) => groupId !== this.#group);
    if (others.length === 0) return false;
    this.#show(this.#make());
    const started = front.peek()?.groupId;
    front.home(started !== undefined && others.includes(started) ? started : (others.at(-1) ?? null));
    return true;
  }

  /** Forget a saved thread. One a console holds can go too, unless it is acting. */
  deleteThread(runId: string): void {
    (this.#find(runId) ?? this.#front).deleteThread(runId);
    this.#remote.delete(runId);
    this.#arriving.delete(runId);
    this.#sweep();
    this.#spacesChanged();
  }

  /**
   * What the person chose in the Bar (docs/desk-agent.md §1,
   * "Conversations"): a conversation to continue in this space, or a new
   * one — checked against main's space in front. (`enter` and `leave` are an
   * older shell's, and do nothing: main's current space is followed.)
   */
  async deskConversation(command: DeskConversationCommand): Promise<void> {
    const host = this.#desk;
    if (host === null) return;
    switch (command.type) {
      case "enter":
      case "leave":
        console.debug(`[desk] an older shell's "${command.type}" was ignored: the desk follows main's current space`);
        return;
      case "choose":
        if (host.browser.currentGroupId() !== command.groupId) throw new Error("that desk is not open");
        this.#current();
        this.#openHere(command.runId, "continuing");
        break;
      case "new":
        if (host.browser.currentGroupId() !== command.groupId) throw new Error("that desk is not open");
        this.#current();
        // The next message from the Bar starts the group's new conversation (RunController's #startFresh binds it).
        await this.newThread();
        return;
    }
    this.#options.onChange();
  }

  /**
   * Go to a conversation that is not the one in front (a notification about
   * it was pressed): its space comes to the front when it has one here, and
   * one that is no space's — a reminder's task — is shown in the space the
   * person is in. False when it could not be: gone, or the space in front is
   * busy with its own.
   */
  async reveal(runId: string): Promise<boolean> {
    if (this.#front.runId() === runId) return true;
    const host = this.#desk;
    if (host === null) return false;
    const record = this.#find(runId) !== null ? null : (this.#options.threads?.get(runId) ?? null);
    const groupId = this.#homeOf(host, runId, this.#find(runId)?.peek()?.groupId ?? record?.run.groupId);
    if (groupId !== null && host.browser.selectGroup !== undefined) {
      await host.browser.selectGroup(groupId).catch(() => undefined);
      this.#current();
      if (this.#front.runId() === runId) return true;
    }
    try {
      this.#current();
      this.#openHere(runId, "opening");
      this.#options.onChange();
      return true;
    } catch {
      return false;
    }
  }

  /** The space a conversation is at home in: the one it started in while still bound to it, else the last bound to it. */
  #homeOf(host: NonNullable<RunHubOptions["desk"]>, runId: string, started: string | undefined): string | null {
    if (started !== undefined && host.bindings.get(started) === runId) return started;
    return host.bindings.groupsOf(runId).at(-1) ?? null;
  }

  /* ------------------------------ the space in front's ------------------------------ */

  start(intent: string, attachments: AgentAttachment[] = [], options: RunTurnOptions = { page: true }): Promise<void> {
    return this.#said(() => this.#consoleFor(options.groupId, parseAuthorMarker(intent) !== null).start(intent, attachments, options));
  }

  message(content: string, attachments: AgentAttachment[] = [], options: RunTurnOptions = { page: true }): Promise<void> {
    return this.#said(() => this.#consoleFor(options.groupId, parseAuthorMarker(content) !== null).message(content, attachments, options));
  }

  answerQuestion(questionId: string, answer: string): Promise<void> {
    return this.#front.answerQuestion(questionId, answer);
  }

  retry(): Promise<void> {
    return this.#front.retry();
  }

  interrupt(): void {
    this.#front.interrupt();
  }

  approve(approvalId: string): Promise<void> {
    return this.#front.approve(approvalId);
  }

  reject(approvalId: string): Promise<void> {
    return this.#front.reject(approvalId);
  }

  takeControl(): void {
    this.#front.takeControl();
  }

  releaseControl(): Promise<void> {
    return this.#front.releaseControl();
  }

  revoke(): Promise<void> {
    return this.#front.revoke();
  }

  /* ------------------------------ from elsewhere ------------------------------ */

  /**
   * A reminder's agent task: a conversation of its own, in a console of its
   * own — no space's, and never in front by itself, so it takes nobody's
   * conversation from them (until 2026-11-16 it took the one console, and
   * waited while that was busy). It is in the list of conversations as it
   * works, and choosing it there shows it. Resolves `busy` at once while
   * another reminder's task is still going — they run one at a time, and the
   * scheduler asks again — and otherwise when the run reaches a terminal
   * state, however it gets there.
   */
  async startScheduled(request: ScheduledAgentRequest): Promise<ScheduledAgentOutcome> {
    if (this.#scheduled !== null && this.#consoles.includes(this.#scheduled) && this.#scheduled.busy()) return { status: "busy" };
    const console = this.#make();
    this.#consoles.push(console);
    this.#held.add(console);
    this.#scheduled = console;
    try {
      return await console.startScheduled(request);
    } finally {
      this.#held.delete(console);
      this.#sweep();
      this.#spacesChanged();
    }
  }

  /**
   * The cloud run observer folded more of a run's event stream (§10.4). When
   * a console holds that run, it follows; otherwise the thread store already
   * has it and nothing changes here.
   */
  refreshRemote(run: RunSummary): void {
    const holder = this.#find(run.runId);
    if (holder !== null) holder.refreshRemote(run);
    else this.#showArrived(run.runId);
    // Its space's tile, whoever holds it: at work, waiting on the person — and, once it has stopped with nothing
    // left to ask, something to read in a space nobody is looking at (as a turn that ended here says: `#settled`).
    const before = this.#remote.get(run.runId) ?? null;
    const now = remoteAgentState(run);
    if (now === null) this.#remote.delete(run.runId);
    else this.#remote.set(run.runId, now);
    const host = this.#desk;
    if (host !== null && before !== null && now === null) {
      for (const groupId of host.bindings.groupsOf(run.runId)) if (groupId !== this.#group) this.#answered.set(groupId, run.runId);
    }
    this.#spacesChanged();
  }

  /**
   * A cloud conversation was started from a space's Bar (the shell's
   * `startCloudRun`, which names the space): it is that space's conversation
   * from now — bound to it, shown in it, and what the next message there
   * continues. Control has only just made the run: its thread reaches the
   * store with its first event (CloudRunService), and it is shown as that
   * comes (`refreshRemote`). The person may be in another space by then, or
   * by now: it is bound all the same, and there when they are back. A space
   * that took up another conversation while control was answering keeps
   * that one; the cloud's is in the past chats. One exception: a space
   * still bound to an earlier start whose first event never came (the Bar
   * gave up waiting and let the person send again) takes the new one — the
   * earlier is nothing to keep, and would leave the space showing none while
   * a second cloud task ran.
   */
  cloudStarted(runId: string, groupId: string): void {
    const host = this.#desk;
    if (host === null || host.browser.tabGroupSpaceId(groupId) === null) return;
    const bound = host.bindings.get(groupId);
    if (bound !== null) {
      const never = this.#arriving.has(bound) && (this.#options.threads?.get(bound) ?? null) === null;
      if (!never) return;
      this.#arriving.delete(bound);
    }
    this.#arriving.add(runId);
    host.bindings.bind(groupId, runId);
    host.browser.refreshSpaces?.();
    this.#showArrived(runId);
  }

  /** A conversation bound to the space in front, which shows none yet, has its thread in the store now: shown. */
  #showArrived(runId: string): void {
    const record = this.#options.threads?.get(runId) ?? null;
    if (record === null) return;
    this.#arriving.delete(runId);
    const host = this.#desk;
    if (host === null || this.#group === null || host.bindings.get(this.#group) !== runId) return;
    if (this.#front.runId() !== null || this.#kept(this.#front)) return;
    this.#front.open(record);
    this.#spacesChanged();
    this.#options.onChange();
  }

  /**
   * A command from a desktop run's iMessage watcher, never from the model:
   * the person answered a question from afar. The conversation asking it is
   * in its console still (it waits there, in its space) — or, after a
   * restart, in the store, and then a console opens it, at home in the space
   * it is bound to. Either way the answer runs there, as a turn of that
   * space's, and nobody is moved: the space the person is in keeps its own
   * conversation. (Until 2026-11-16 the asking space was brought to the
   * front for it, and an answer that came while another conversation was
   * acting waited for that turn.) An answer to a question no longer asked is
   * dropped.
   */
  async answerIMessageQuestion(runId: string, questionId: string, value: string): Promise<void> {
    let console = this.#find(runId);
    if (console === null) {
      const record = this.#options.threads?.get(runId) ?? null;
      if (record === null || isCloudRun(record.run) || record.run.pendingQuestion?.id !== questionId) return;
      console = this.#make();
      console.open(record);
      const host = this.#desk;
      console.home(host === null ? null : this.#homeOf(host, runId, record.run.groupId));
      this.#consoles.push(console);
    }
    const run = console.peek();
    if (run === null || isCloudRun(run) || run.pendingQuestion?.id !== questionId) {
      this.#sweep();
      return;
    }
    await console.answerQuestion(questionId, value);
  }

  /* ------------------------------ quitting ------------------------------ */

  /** Write every open thread now — the app is quitting. */
  flush(): void {
    for (const console of this.#consoles) console.flush();
  }

  /** The window is closing: every console stops acting, and marks a running turn paused (RunController.shutdown). */
  shutdown(): void {
    for (const console of this.#consoles) console.shutdown();
  }
}
