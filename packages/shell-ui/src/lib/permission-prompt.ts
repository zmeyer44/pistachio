import type { BrowserControlsSnapshot } from "@pistachio/shell-contracts/browser-controls";
import type { Overlay } from "../store";

/**
 * The overlays a site's request may interrupt. Anything else — the address
 * bar mid-edit, the settings page, a Glance — is the person's own doing and
 * keeps the screen; the prompt waits in the site-info button (amber) and
 * opens with the next request, or from there.
 */
const INTERRUPTIBLE: ReadonlySet<Overlay> = new Set<Overlay>(["none", "status", "site-info"]);

function pendingIds(controls: BrowserControlsSnapshot | null): Set<string> {
  const ids = new Set<string>();
  if (controls === null) return ids;
  for (const request of controls.pendingPermissions) ids.add(request.id);
  for (const request of controls.pendingPasskeyRequests) ids.add(request.id);
  return ids;
}

/**
 * Which overlay the shell should show after a browser-controls snapshot, or
 * null to leave it alone.
 *
 * A NEW request — an id the previous snapshot did not carry — raises the
 * permission prompt (components/PermissionPromptDialog.tsx) over the page;
 * a snapshot that merely re-lists a request the person already dismissed
 * does not, or dismissing would be impossible. The prompt is a modal over
 * the page rather than a page of its own, so when the last request is
 * answered (or the tab closes, or the active tab changes — a snapshot is
 * per active tab) it steps aside and the page is where it was.
 */
export function permissionPromptOverlay(
  previous: BrowserControlsSnapshot | null,
  next: BrowserControlsSnapshot,
  overlay: Overlay,
): Overlay | null {
  const nextIds = pendingIds(next);
  if (nextIds.size === 0) return overlay === "permission" ? "none" : null;
  if (overlay === "permission") return null;
  if (!INTERRUPTIBLE.has(overlay)) return null;
  const previousIds = pendingIds(previous);
  for (const id of nextIds) if (!previousIds.has(id)) return "permission";
  return null;
}
