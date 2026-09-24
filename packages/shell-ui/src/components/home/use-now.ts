import { useEffect, useState } from "react";
import { msUntilNextMinute } from "../../lib/home";

/**
 * The time, read again the moment each minute turns — so the clock never
 * lags the system's by up to a minute — and whenever the page comes back
 * into view or focus, since a hidden page's timers are throttled and may
 * have slept through several minutes (or midnight).
 */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      const next = new Date();
      setNow(next);
      window.clearTimeout(timer);
      // A few ms past the boundary, so the new minute has certainly begun.
      timer = window.setTimeout(tick, msUntilNextMinute(next) + 20);
    };
    timer = window.setTimeout(tick, msUntilNextMinute(new Date()) + 20);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);
  return now;
}
