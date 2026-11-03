/**
 * A Chrome extension's action as the Ledge draws it (docs/extensions.md §4 "Chrome extensions"): what main folds
 * into the snapshot from electron-chrome-extensions' `browserAction.getState`, the `crx://` address of an icon, and a
 * `chrome.notifications` card as a notice's words. Pure — no Electron — so the tests read it directly; compat.ts
 * feeds it the library's answers.
 */

/** A Chrome extension id: 32 letters a–p (a hash of the store key, or of the folder's path when unpacked). */
export function isChromeExtensionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-p]{32}$/.test(value);
}

/** What an action carries, globally or for one tab (electron-chrome-extensions 4.10 `BrowserActionAPI`). */
export interface RawActionDetails {
  title?: string;
  /** The badge (`action.setBadgeText`). */
  text?: string;
  /** The badge's colour (`action.setBadgeBackgroundColor`): a CSS colour or `[r, g, b, a]` in 0–255. */
  color?: string | number[];
  /** The popup's path, relative to the extension, or an address; "" turns the popup off. */
  popup?: string;
  /** When `action.setIcon` last changed the icon (ms): a cache key for the icon's address. */
  iconModified?: number;
}

export interface RawAction extends RawActionDetails {
  id: string;
  /** Per-tab overrides, keyed by the tab's `webContents.id`. */
  tabs?: Record<string, RawActionDetails>;
}

/** `browserAction.getState()`'s answer. */
export interface RawActionState {
  activeTabId?: number;
  actions: RawAction[];
}

/** One Chrome action as the snapshot carries it. */
export interface ChromeActionState {
  extensionId: string;
  title: string;
  badge: string | null;
  badgeColor: string | null;
  /** A click opens a popup (else it fires `action.onClicked`). */
  hasPopup: boolean;
  /** `crx://extension-icon/…`, served from the default session (compat.ts `handleCRXProtocol`). */
  iconUrl: string;
}

/**
 * The address of an extension's action icon. The `crx` scheme is handled on the session that draws it (the shell's,
 * the default session) and answers from the extension's own Profile session, named by `partition`. `tabId` picks a
 * per-tab icon; `modified` only busts a cache when `setIcon` changed it.
 */
export function chromeIconUrl(
  extensionId: string,
  partition: string,
  options: { size?: number; tabId?: number | null; modified?: number | null } = {},
): string {
  const size = Math.max(16, Math.min(128, Math.round(options.size ?? 32)));
  const query = new URLSearchParams({ partition });
  if (typeof options.tabId === "number" && options.tabId >= 0) query.set("tabId", String(options.tabId));
  if (typeof options.modified === "number" && options.modified > 0) query.set("t", String(options.modified));
  return `crx://extension-icon/${extensionId}/${size}/1?${query.toString()}`;
}

/** A badge colour as CSS: a string as given, `[r, g, b, a]` (0–255) as `rgba()`. */
export function badgeColorCss(color: RawActionDetails["color"]): string | null {
  if (typeof color === "string") return color.trim() === "" ? null : color.trim();
  if (!Array.isArray(color) || color.length < 3) return null;
  const [r, g, b, a = 255] = color.map((n) => (Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : 0));
  return `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(3))})`;
}

/**
 * The actions as the Ledge shows them on one tab (the session's active tab by default): a tab's own title, badge,
 * colour and popup over the action's, as Chrome resolves them.
 */
export function chromeActionStates(raw: RawActionState, partition: string, tabId: number | null = raw.activeTabId ?? null): ChromeActionState[] {
  return raw.actions
    .filter((action) => isChromeExtensionId(action.id))
    .map((action) => {
      const tab = tabId === null ? undefined : action.tabs?.[String(tabId)];
      const pick = <K extends keyof RawActionDetails>(key: K): RawActionDetails[K] => (tab !== undefined && tab[key] !== undefined ? tab[key] : action[key]);
      const text = pick("text");
      const popup = pick("popup");
      return {
        extensionId: action.id,
        title: typeof pick("title") === "string" && pick("title") !== "" ? (pick("title") as string) : action.id,
        badge: typeof text === "string" && text !== "" ? text.slice(0, 8) : null,
        badgeColor: badgeColorCss(pick("color")),
        hasPopup: typeof popup === "string" && popup !== "",
        iconUrl: chromeIconUrl(action.id, partition, { tabId: tab?.iconModified !== undefined ? tabId : null, modified: pick("iconModified") ?? null }),
      };
    });
}

/** The manifest icon nearest `size` from above (else the largest), as a path inside the extension. */
export function pickManifestIcon(icons: Record<string, string> | string | undefined, size = 32): string | null {
  if (typeof icons === "string") return icons;
  if (icons === undefined || icons === null || typeof icons !== "object") return null;
  const sizes = Object.keys(icons)
    .map((key) => Number.parseInt(key, 10))
    .filter((n) => Number.isFinite(n) && typeof icons[String(n)] === "string")
    .sort((a, b) => a - b);
  if (sizes.length === 0) return null;
  const chosen = sizes.find((n) => n >= size) ?? sizes[sizes.length - 1]!;
  return icons[String(chosen)] ?? null;
}

/** `chrome.notifications.create`'s options, the part a notice shows. */
export interface ChromeNotificationOptions {
  type?: string;
  title?: string;
  message?: string;
  contextMessage?: string;
  items?: { title?: string; message?: string }[];
  iconUrl?: string;
  requireInteraction?: boolean;
}

/** A notification as a notice's words: never longer than a notice holds, the list type as lines. */
export function noticeText(options: ChromeNotificationOptions): { title: string; body: string } {
  const clip = (text: unknown, max: number): string => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const title = clip(options.title, 120);
  const lines =
    options.type === "list" && Array.isArray(options.items)
      ? options.items.slice(0, 5).map((item) => [clip(item.title, 60), clip(item.message, 120)].filter(Boolean).join(" — "))
      : [clip(options.message, 300)];
  const context = clip(options.contextMessage, 120);
  return { title, body: [...lines, ...(context === "" ? [] : [context])].filter(Boolean).join("\n") };
}
