import { Activity, AppWindow, Bell, Camera, Clipboard, ClipboardCopy, MapPin, Mic, MonitorUp, Music } from "lucide-react";
import type { BrowserPermission, PendingPermissionRequest } from "@pistachio/shell-contracts/browser-controls";

/**
 * How the chrome names and draws each site permission — shared by the full
 * Site controls page (SiteControlsPanel) and the quick popover on the active
 * tab (SiteInfoPopover), so the same capability never wears two names.
 */
export const PERMISSION_LABELS: Record<BrowserPermission, string> = {
  camera: "Camera",
  microphone: "Microphone",
  geolocation: "Location",
  notifications: "Notifications",
  "clipboard-read": "Read clipboard",
  "clipboard-write": "Write clipboard",
  "display-capture": "Screen capture",
  midi: "MIDI devices",
  "idle-detection": "Activity status",
  "external-app": "Open apps",
};

/**
 * What a site is asking to do, for the request prompt's title
 * (PermissionPromptDialog): "northstar.demo wants to use your camera".
 */
export const PERMISSION_REQUESTS: Record<BrowserPermission, string> = {
  camera: "use your camera",
  microphone: "use your microphone",
  geolocation: "know your location",
  notifications: "show notifications",
  "clipboard-read": "read your clipboard",
  "clipboard-write": "write to your clipboard",
  "display-capture": "capture your screen",
  midi: "use your MIDI devices",
  "idle-detection": "know when you are away",
  "external-app": "open another app",
};

export const PERMISSION_ICONS: Record<BrowserPermission, React.ReactNode> = {
  camera: <Camera />,
  microphone: <Mic />,
  geolocation: <MapPin />,
  notifications: <Bell />,
  "clipboard-read": <Clipboard />,
  "clipboard-write": <ClipboardCopy />,
  "display-capture": <MonitorUp />,
  midi: <Music />,
  "idle-detection": <Activity />,
  "external-app": <AppWindow />,
};

/**
 * A pending request as a question — "Allow camera and microphone?", or for a
 * link meant for another app, "Open zoom.us?". One wording for the prompt,
 * the site-info popover and the Site controls page.
 */
export function requestQuestion(request: PendingPermissionRequest): string {
  if (request.externalApp !== undefined) return `Open ${request.externalApp.appName}?`;
  return `Allow ${request.permissions.map((permission) => PERMISSION_LABELS[permission].toLowerCase()).join(" and ")}?`;
}

/**
 * What the three answers are called. Opening an app is an action rather
 * than a standing capability, and its "no" is not remembered, so it reads
 * as Cancel / Open once; "Always allow" is remembered for that kind of link
 * and skips the prompt from then on.
 */
export function requestAnswerLabels(request: PendingPermissionRequest): { block: string; once: string; always: string } {
  return request.externalApp !== undefined
    ? { block: "Cancel", once: "Open once", always: "Always allow" }
    : { block: "Block", once: "Allow once", always: "Always allow" };
}
