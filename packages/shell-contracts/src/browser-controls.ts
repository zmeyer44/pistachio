/**
 * Browser capabilities that can expose a person, their device, or company
 * data. This contract is shared by Chromium enforcement, the trusted shell,
 * and the persisted enterprise policy file.
 */

export const BROWSER_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "notifications",
  "clipboard-read",
  "clipboard-write",
  "display-capture",
  "midi",
  "idle-detection",
  /**
   * Handing a link to another app on the computer: `zoommtg:`, `slack:`,
   * `mailto:`. The site-level decision covers every such link; "always
   * allow" from the prompt is narrower and remembers one scheme only
   * (see `PendingPermissionRequest.externalApp`).
   */
  "external-app",
] as const;

export type BrowserPermission = (typeof BROWSER_PERMISSIONS)[number];
export type PermissionDecision = "ask" | "allow" | "block";

export const GUARDED_BROWSER_ACTIONS = ["download", "upload", "copy", "paste", "print"] as const;
export type GuardedBrowserAction = (typeof GUARDED_BROWSER_ACTIONS)[number];
export type ActionDecision = "allow" | "block";
export type PolicySource = "default" | "user" | "managed" | "task";

export interface BrowserPolicyVerdict<T extends PermissionDecision | ActionDecision> {
  decision: T;
  source: PolicySource;
  reason: string;
}

export interface EnterpriseSiteRule {
  /** Exact origin, hostname, `*.example.com`, or `*`. */
  pattern: string;
  permissions?: Partial<Record<BrowserPermission, PermissionDecision>>;
  actions?: Partial<Record<GuardedBrowserAction, ActionDecision>>;
}

export interface EnterpriseBrowserPolicy {
  version: 1;
  rules: EnterpriseSiteRule[];
}

export interface PendingPermissionRequest {
  id: string;
  tabId: string;
  origin: string;
  permission: BrowserPermission;
  /** One Chromium media request may contain both camera and microphone. */
  permissions: BrowserPermission[];
  requestedAt: number;
  /**
   * Present on an `external-app` request: which link scheme the page wants
   * to hand off, and the app the system would open for it. "Always allow"
   * on such a request is remembered for this site AND this scheme, so a
   * meeting page that may open Zoom never gets to open anything else.
   */
  externalApp?: ExternalAppTarget;
}

export interface ExternalAppTarget {
  /** The link scheme without its colon: `zoommtg`. */
  scheme: string;
  /** The system's default handler for the scheme: "zoom.us", "Mail". */
  appName: string;
}

/**
 * Capability detection reported by the isolated human-tab preload. This is
 * intentionally metadata-only: passkey material and credential IDs never
 * cross into the browser chrome.
 */
export interface TabPasskeySupport {
  webAuthnAvailable: boolean;
  platformAuthenticatorAvailable: boolean;
  conditionalMediationAvailable: boolean;
}

export interface PasskeyCapability extends TabPasskeySupport {
  /** Electron's macOS Touch ID / Secure Enclave authenticator was configured. */
  touchIdConfigured: boolean;
}

export interface PasskeyAccountOption {
  /** Opaque, request-scoped ID. This is not the WebAuthn credential ID. */
  id: string;
  name: string;
  displayName: string;
}

export interface PendingPasskeyRequest {
  id: string;
  tabId: string;
  origin: string;
  relyingPartyId: string;
  accounts: PasskeyAccountOption[];
  requestedAt: number;
}

export type BrowserDownloadState = "blocked" | "progress" | "completed" | "cancelled" | "interrupted";

export interface BrowserDownload {
  id: string;
  tabId: string;
  origin: string;
  url: string;
  fileName: string;
  receivedBytes: number;
  totalBytes: number;
  state: BrowserDownloadState;
  createdAt: number;
  /** When the transfer settled (completed, cancelled, interrupted, or blocked); null while live. */
  finishedAt: number | null;
  reason: string;
  source: PolicySource;
}

export interface BrowserPolicyEvent {
  id: string;
  tabId: string;
  origin: string;
  capability: BrowserPermission | GuardedBrowserAction | "passkey";
  decision: "allow" | "block" | "ask";
  source: PolicySource;
  reason: string;
  occurredAt: number;
}

export interface BrowserControlsSnapshot {
  tabId: string | null;
  tabKind: "human" | "agent" | null;
  origin: string;
  secure: boolean;
  zoomPercent: number;
  muted: boolean;
  permissions: Record<BrowserPermission, BrowserPolicyVerdict<PermissionDecision>>;
  /**
   * Link schemes this site may hand to another app without asking — what
   * "Always allow" on an `external-app` prompt remembered. They apply while
   * the site-level `external-app` decision is "ask".
   */
  externalAppSchemes: string[];
  actions: Record<GuardedBrowserAction, BrowserPolicyVerdict<ActionDecision>>;
  passkeys: PasskeyCapability;
  pendingPermissions: PendingPermissionRequest[];
  pendingPasskeyRequests: PendingPasskeyRequest[];
  downloads: BrowserDownload[];
  recentEvents: BrowserPolicyEvent[];
}

/** Narrow policy projection sent into an untrusted tab's isolated preload. */
export interface TabDataPolicy {
  copy: ActionDecision;
  paste: ActionDecision;
}

export type BrowserControlCommand =
  | {
      type: "resolvePermission";
      requestId: string;
      decision: "allow-once" | "allow" | "block";
    }
  | {
      type: "setPermission";
      permission: BrowserPermission;
      decision: PermissionDecision;
    }
  | { type: "clearPermissions" }
  | { type: "selectPasskey"; requestId: string; accountId: string | null }
  | { type: "zoomIn" | "zoomOut" | "zoomReset" | "toggleMute" | "print" }
  /** Put the active page's address on the clipboard, bare or as a Markdown link. */
  | { type: "copyUrl"; format: "plain" | "markdown" }
  | { type: "cancelDownload" | "showDownload"; downloadId: string }
  /** Open a finished download in its default app. */
  | { type: "openDownload"; downloadId: string }
  /** Fetch a cancelled or interrupted download again, from the tab it came from. */
  | { type: "retryDownload"; downloadId: string }
  /** Drop one finished record from the list; a live download must be cancelled first. */
  | { type: "removeDownload"; downloadId: string }
  /** Drop every finished record; live downloads stay. */
  | { type: "clearDownloads" };

/** `exact` is Chromium's own find; `smart` finds by meaning (docs/smart-find.md). */
export type FindMode = "exact" | "smart";

export type SmartFindStatus =
  /** Smart mode, nothing asked yet. */
  | "idle"
  /** Collecting the page's passages. */
  | "reading"
  /** Passages are with the model; matches arrive batch by batch. */
  | "ranking"
  | "done"
  /** Signed out, the model is off, or the setting is off. */
  | "unavailable"
  /** This page has no text smart find can read (a PDF, an internal page). */
  | "unreadable"
  | "failed";

export interface SmartFindProgress {
  status: SmartFindStatus;
  /** Passages judged so far, of `total` collected. */
  searched: number;
  total: number;
  /** The page exceeded the collect bounds; only its first part was searched. */
  truncated: boolean;
  /** Only "closest" matches were found, none the model is sure of. */
  weak: boolean;
  /** The page changed under the matches; searching again re-reads it. */
  stale: boolean;
  /** The active match's key sentence, for the bar's second line. */
  excerpt: string;
}

export interface FindState {
  open: boolean;
  query: string;
  activeMatchOrdinal: number;
  matches: number;
  mode: FindMode;
  /** Whether smart find can run at all; the bar hides its toggle when not. */
  smartAvailable: boolean;
  smart: SmartFindProgress;
}

export const IDLE_SMART_FIND: SmartFindProgress = {
  status: "idle",
  searched: 0,
  total: 0,
  truncated: false,
  weak: false,
  stale: false,
  excerpt: "",
};

export const CLOSED_FIND: FindState = {
  open: false,
  query: "",
  activeMatchOrdinal: 0,
  matches: 0,
  mode: "exact",
  smartAvailable: false,
  smart: IDLE_SMART_FIND,
};

export const SMART_FIND_QUERY_LIMIT = 400;

/**
 * The find bar's card. Its host (the desktop overlay view, the web pane's
 * corner) is larger by FIND_BAR_ROOM on each side: the card's shadow paints
 * into that transparent margin instead of being clipped to a hard rectangle.
 */
export const FIND_BAR = { height: 40, detailHeight: 30, width: 360, smartWidth: 480, inset: 12 } as const;
export const FIND_BAR_ROOM = { top: 6, side: 12, bottom: 20 } as const;

export type FindCommand =
  /** `mode` absent means the bar's current mode, so older callers keep working. */
  /**
   * `draft` is smart mode's "the text changed but nothing is being asked
   * yet": the old matches come down, and nothing is sent anywhere.
   */
  | { type: "search"; query: string; forward: boolean; mode?: FindMode; draft?: boolean }
  /** Open the bar in (or switch it to) a mode, keeping the typed text. */
  | { type: "mode"; mode: FindMode }
  | { type: "close" };

const PERMISSION_SET = new Set<string>(BROWSER_PERMISSIONS);
const ACTION_SET = new Set<string>(GUARDED_BROWSER_ACTIONS);

export function isBrowserPermission(value: unknown): value is BrowserPermission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

export function isGuardedBrowserAction(value: unknown): value is GuardedBrowserAction {
  return typeof value === "string" && ACTION_SET.has(value);
}

export function isPermissionDecision(value: unknown): value is PermissionDecision {
  return value === "ask" || value === "allow" || value === "block";
}

export function isActionDecision(value: unknown): value is ActionDecision {
  return value === "allow" || value === "block";
}

export function isBrowserControlCommand(value: unknown): value is BrowserControlCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as Record<string, unknown>;
  switch (command["type"]) {
    case "resolvePermission":
      return (
        typeof command["requestId"] === "string" &&
        (command["decision"] === "allow-once" || command["decision"] === "allow" || command["decision"] === "block")
      );
    case "setPermission":
      return isBrowserPermission(command["permission"]) && isPermissionDecision(command["decision"]);
    case "clearPermissions":
    case "zoomIn":
    case "zoomOut":
    case "zoomReset":
    case "toggleMute":
    case "print":
      return true;
    case "copyUrl":
      return command["format"] === "plain" || command["format"] === "markdown";
    case "selectPasskey":
      return typeof command["requestId"] === "string" && (typeof command["accountId"] === "string" || command["accountId"] === null);
    case "cancelDownload":
    case "showDownload":
    case "openDownload":
    case "retryDownload":
    case "removeDownload":
      return typeof command["downloadId"] === "string";
    case "clearDownloads":
      return true;
    default:
      return false;
  }
}

export function normalizeTabPasskeySupport(value: unknown): TabPasskeySupport | null {
  if (typeof value !== "object" || value === null) return null;
  const report = value as Record<string, unknown>;
  if (
    typeof report["webAuthnAvailable"] !== "boolean" ||
    typeof report["platformAuthenticatorAvailable"] !== "boolean" ||
    typeof report["conditionalMediationAvailable"] !== "boolean"
  ) {
    return null;
  }
  return {
    webAuthnAvailable: report["webAuthnAvailable"],
    platformAuthenticatorAvailable: report["platformAuthenticatorAvailable"],
    conditionalMediationAvailable: report["conditionalMediationAvailable"],
  };
}

export function isFindCommand(value: unknown): value is FindCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as Record<string, unknown>;
  const mode = command["mode"];
  if (command["type"] === "close") return true;
  if (command["type"] === "mode") return mode === "exact" || mode === "smart";
  return (
    command["type"] === "search" &&
    typeof command["query"] === "string" &&
    typeof command["forward"] === "boolean" &&
    (mode === undefined || mode === "exact" || mode === "smart") &&
    (command["draft"] === undefined || typeof command["draft"] === "boolean")
  );
}

/** Custom protocols serialize their origin as `null`; policy needs a stable site key. */
export function browserOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    return url.host === "" ? `${url.protocol}//` : `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

export function isSecureBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    // A page's source is as secure as the page it was fetched from.
    if (url.protocol === "view-source:")
      return isSecureBrowserUrl(value.slice("view-source:".length));
    return url.protocol === "https:" || url.protocol === "pistachio:";
  } catch {
    return false;
  }
}
