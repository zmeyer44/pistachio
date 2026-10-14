/**
 * What the double sidebar's controls do (docs/double-sidebar.md §1), apart
 * from React: Home on the rail, a Today row's +, and a row let go on the
 * rail. Each goes through main's own commands — `select`, `newTab`,
 * `addTab`, `removeTab`, `create` — as the single sidebar's did.
 */

import { currentSpace, newTabAsChosen, selectSpace } from "../../lib/desk/open";
import { deskGroups } from "../../lib/desk/store";
import { useAppStore } from "../../store";
import { useHomeMemory } from "./column-state";
import { isHomeSpace } from "./rail-model";

/** How long a space chosen may take to become the current one before what follows gives up. */
const SELECT_WAIT_MS = 1500;

/** Wait for main to make `groupId` the current space (its snapshot says so); false if it does not in time. */
async function untilCurrent(groupId: string): Promise<boolean> {
  const until = performance.now() + SELECT_WAIT_MS;
  while (currentSpace() !== groupId) {
    if (performance.now() > until) return false;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return true;
}

/** The space a tab is in: a drawn one, a loose tab's, or a page's (deskGroups). */
function spaceOf(tabId: string): string | null {
  return deskGroups(useAppStore.getState().snapshot).find((group) => group.tabIds.includes(tabId))?.id ?? null;
}

/**
 * A Today row's + (*Open a window beside it*): its space chosen, then the
 * same new tab ⌘T makes there (newTabAsChosen) — which makes a Home tab a
 * space of two, and it goes up onto the rail (main's).
 */
export async function openBeside(tabId: string): Promise<void> {
  const groupId = spaceOf(tabId);
  if (groupId === null) return;
  if (currentSpace() !== groupId) {
    selectSpace(groupId);
    if (!(await untilCurrent(groupId))) return;
  }
  newTabAsChosen();
}

/**
 * Home on the rail: the Home tab used last (useHomeMemory, noted as it was
 * in use), its space chosen — or, that one gone or no longer Home's, the
 * Home tab used most recently — or, with no Home tab at all, a new tab in
 * Home: made straight into a loose space of its own, current with it
 * (createTab's `group: "loose"`), as General › New tabs says a new tab opens
 * (⌘T's newTabAsChosen): at the address named there, or the home page — and
 * for "the address bar", the home page with the bar open on it, the bar
 * having no Home of its own to put a tab in. (Until 2026-10-13 it was made
 * in the space in use and taken out of it after: the space's desk and
 * naming saw it come and go.)
 */
export async function chooseHome(): Promise<void> {
  const store = useAppStore.getState();
  const snapshot = store.snapshot;
  if (snapshot === null) return;
  const current = currentSpace();
  if (current !== null && isHomeSpace(current, snapshot)) return;
  const homeOf = (tabId: string): string | null => {
    const groupId = spaceOf(tabId);
    return groupId !== null && isHomeSpace(groupId, snapshot) ? groupId : null;
  };
  const remembered = useHomeMemory.getState().tabId;
  const known = remembered === null ? null : homeOf(remembered);
  if (known !== null) {
    selectSpace(known);
    return;
  }
  const latest = [...snapshot.tabs].filter((tab) => homeOf(tab.id) !== null).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
  if (latest !== undefined) {
    const groupId = homeOf(latest.id);
    if (groupId !== null) selectSpace(groupId);
    return;
  }
  const { newTab, newTabUrl, homeUrl } = store.settings.general;
  await store.createTab(newTab === "url" && newTabUrl !== "" ? newTabUrl : homeUrl, { group: "loose" });
  if (newTab === "address") useAppStore.getState().openUrlBar();
}
