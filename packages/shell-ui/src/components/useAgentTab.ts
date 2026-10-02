import { agentDrivenTabId } from "@pistachio/shell-contracts/agent-glow";
import { useDeskChrome } from "../lib/desk/chrome";
import { useAppStore } from "../store";

/**
 * Whether the agent is working in `tabId` right now
 * (@pistachio/shell-contracts/agent-glow `agentDrivenTabId`) — the console's,
 * or a desk's (lib/desk/chrome.ts). A boolean, so a tab row re-renders only
 * when the agent moves into or out of its tab, not on every publish of the run.
 */
export function useAgentWorkingIn(tabId: string | null): boolean {
  const fromConsole = useAppStore((state) => tabId !== null && agentDrivenTabId(state.snapshot?.run ?? null) === tabId);
  const fromDesk = useDeskChrome((state) => tabId !== null && state.agentTab === tabId);
  return fromConsole || fromDesk;
}
