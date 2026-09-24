/**
 * The desktop's hands for a smart find (docs/smart-find.md §4): how the
 * session in @pistachio/smart-find reads and paints a tab's page here.
 *
 * The scripts run in an isolated world of their own, so the registry they
 * keep between a collect and its paints persists across calls and the page's
 * scripts can neither read nor alter it. The highlight colours go in with
 * `insertCSS`, which a strict page CSP cannot refuse and which leaves the
 * DOM untouched.
 */
import type { WebContents } from "electron";
import { isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";
import {
  SMART_FIND_CLEAR_SCRIPT,
  SMART_FIND_HIGHLIGHT_CSS,
  smartFindCollectScript,
  smartFindPaintScript,
  type SmartFindCollection,
  type SmartFindPage,
  type SmartFindPainted,
} from "@pistachio/smart-find";

/** Watchtower's capture runs in 991. */
const SMART_FIND_WORLD = 992;
/** The collect bounds itself to 150 ms of CPU; this is for a page that never answers. */
const SCRIPT_DEADLINE_MS = 4000;

export function smartFindPageFor(contents: WebContents): SmartFindPage {
  let cssKey: Promise<string> | null = null;
  const run = <T>(code: string): Promise<T> => {
    if (contents.isDestroyed()) return Promise.reject(new Error("The tab is gone."));
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The page did not answer.")), SCRIPT_DEADLINE_MS);
    });
    return Promise.race([contents.executeJavaScriptInIsolatedWorld(SMART_FIND_WORLD, [{ code }]) as Promise<T>, deadline]).finally(() =>
      clearTimeout(timer),
    );
  };
  return {
    collect: (known) => {
      const url = contents.isDestroyed() ? "" : contents.getURL();
      // Pistachio's own pages are not the web's prose, and are never sent anywhere.
      if (!/^(https?|file):/i.test(url) || isShellPageUrl(url)) return Promise.resolve(null);
      return run<SmartFindCollection | { generation: number; unchanged: true } | null>(smartFindCollectScript(known));
    },
    paint: async (paint) => {
      if (paint.matches.length > 0 && cssKey === null) cssKey = contents.insertCSS(SMART_FIND_HIGHLIGHT_CSS);
      await cssKey?.catch(() => undefined);
      return run<SmartFindPainted | null>(smartFindPaintScript(paint));
    },
    clear: async () => {
      const key = cssKey;
      cssKey = null;
      await run(SMART_FIND_CLEAR_SCRIPT).catch(() => undefined);
      if (key !== null && !contents.isDestroyed()) await key.then((value) => contents.removeInsertedCSS(value)).catch(() => undefined);
    },
  };
}
