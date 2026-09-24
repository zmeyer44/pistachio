import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { BrowserMediaInfo } from "@pistachio/shell-contracts/media";
import { reconcileMediaPresence } from "../lib/media-presence";

function subscribeMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const motionSnapshot = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useMediaPresence(media: readonly BrowserMediaInfo[]) {
  const reducedMotion = useSyncExternalStore(
    subscribeMotion,
    motionSnapshot,
    () => true,
  );
  const [entries, setEntries] = useState(() =>
    reconcileMediaPresence([], media, Date.now(), reducedMotion),
  );
  useLayoutEffect(() => {
    setEntries((previous) => {
      const next = reconcileMediaPresence(
        previous,
        media,
        Date.now(),
        reducedMotion,
      );
      return next.length === previous.length &&
        next.every(
          (item, i) =>
            item.media === previous[i]?.media &&
            item.exitAt === previous[i]?.exitAt &&
            item.showVideo === previous[i]?.showVideo,
        )
        ? previous
        : next;
    });
  }, [media, reducedMotion]);
  useEffect(() => {
    const deadlines = entries.flatMap((entry) =>
      entry.exitAt === null ? [] : [entry.exitAt],
    );
    if (deadlines.length === 0) return;
    const timer = window.setTimeout(
      () => {
        setEntries((current) =>
          current.filter(
            (entry) => entry.exitAt === null || entry.exitAt > Date.now(),
          ),
        );
      },
      Math.max(0, Math.min(...deadlines) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [entries]);
  return entries;
}
