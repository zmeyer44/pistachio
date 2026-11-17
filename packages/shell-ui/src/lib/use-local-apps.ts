/**
 * The web apps running on this Mac's ports (@pistachio/shell-contracts/local-apps),
 * for the address bar while it is open. Main does the looking; this asks it
 * as the bar opens and again every few seconds while it stays up, so a dev
 * server started meanwhile turns up. A stream surface has no local ports to
 * offer (nativeApi() is null there), so it gets none.
 *
 * The last answer is kept between openings: the bar opens with what was there
 * a moment ago, then settles on what is there now.
 */

import { useEffect, useState } from "react";
import type { LocalApp } from "@pistachio/shell-contracts/local-apps";
import { nativeApi } from "../api";

const RESCAN_MS = 4_000;
const NONE: LocalApp[] = [];

let lastKnown: LocalApp[] = NONE;

function sameApps(a: readonly LocalApp[], b: readonly LocalApp[]): boolean {
  return a.length === b.length && a.every((app, i) => JSON.stringify(app) === JSON.stringify(b[i]));
}

export function useLocalApps(open: boolean): LocalApp[] {
  const [apps, setApps] = useState<LocalApp[]>(() => (nativeApi() === null ? NONE : lastKnown));
  useEffect(() => {
    const native = nativeApi();
    if (!open || native === null) return;
    let current = true;
    const scan = (): void => {
      void native
        .localApps()
        .then((next) => {
          lastKnown = next;
          if (current) setApps((existing) => (sameApps(existing, next) ? existing : next));
        })
        .catch(() => undefined);
    };
    scan();
    const timer = window.setInterval(scan, RESCAN_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [open]);
  return apps;
}
