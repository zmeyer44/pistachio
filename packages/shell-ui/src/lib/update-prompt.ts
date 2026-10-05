import type { UpdateState } from "@pistachio/shell-contracts/updates";
import type { Overlay } from "../store";

/**
 * When the update dialog (components/update-prompt) goes up over the page.
 *
 * Main says whether it is due (`UpdatePrompt`); the shell only picks the
 * moment. It never takes the screen from something the person opened — the
 * address bar, a page of settings, a site's request, a Glance, the first-run
 * wizard — and waits for the screen to be free instead, so a check that
 * lands mid-edit is offered the moment the edit is done.
 */
export function updatePromptWaiting(screen: {
  update: UpdateState;
  overlay: Overlay;
  onboardingOpen: boolean;
  glanceOpen: boolean;
  deskUp: boolean;
}): boolean {
  return (
    screen.update.status === "available" &&
    screen.update.prompt.due &&
    screen.overlay === "none" &&
    !screen.onboardingOpen &&
    !screen.glanceOpen &&
    !screen.deskUp
  );
}

/**
 * Whether the open dialog still has something to say. It follows an update
 * it started through download and restart, and a failure or a retry on the
 * way; any other state (a re-check found nothing, updates went away) puts it
 * down.
 */
export function updatePromptShows(update: UpdateState): boolean {
  switch (update.status) {
    case "available":
    case "downloading":
    case "ready":
    case "error":
    case "checking":
      return true;
    default:
      return false;
  }
}
