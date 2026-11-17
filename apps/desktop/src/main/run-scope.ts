import type { RunSummary } from "@pistachio/protocol";

/**
 * Whether the conversation main holds is shown in the Profile (Space) in
 * view (BrowserController.snapshot).
 *
 * While the agent is driving a tab, the run belongs to that tab's Profile:
 * one that is paused, waiting or finished is a conversation, not a tab, and
 * shows wherever the person is (after its tab closed, too). That rule is
 * for a conversation nobody placed — a host with no space to name for it.
 *
 * `here`: the conversation is the one of the space in front, as the hub has
 * it (RunHub.frontGroup, docs/desk-agent.md §3): started there, or chosen
 * there from the past chats — a conversation at work in another Profile
 * among them, shown here too, live, with its Stop. It is shown whatever tab
 * it started on; hiding it for its tab's Profile would leave the space the
 * person chose it in showing none until it ended.
 */
export function runInView(
  run: Pick<RunSummary, "control" | "status"> | null,
  tabProfile: string | null,
  activeProfile: string,
  here: boolean,
): boolean {
  if (run === null) return false;
  if (here) return true;
  const driving = run.control === "agent" && run.status === "running";
  return !driving || tabProfile === null || tabProfile === activeProfile;
}
