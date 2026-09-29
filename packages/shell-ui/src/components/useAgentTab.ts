import { agentDrivenTabId } from "@pistachio/shell-contracts/agent-glow";
import { useAppStore } from "../store";

/**
 * Whether the agent is working in `tabId` right now
 * (@pistachio/shell-contracts/agent-glow `agentDrivenTabId`). A boolean, so a
 * tab row re-renders only when the agent moves into or out of its tab, not
 * on every publish of the run.
 */
export function useAgentWorkingIn(tabId: string | null): boolean {
  return useAppStore((state) => tabId !== null && agentDrivenTabId(state.snapshot?.run ?? null) === tabId);
}
