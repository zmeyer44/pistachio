import { useEffect, useMemo, useRef } from "react";

/**
 * Object URLs for a viewer's blobs, made once per set and revoked once
 * nothing shows them — not on React's rehearsal unmount (StrictMode mounts,
 * unmounts and mounts again in development, and the URLs must survive it).
 */
export function useObjectUrls(blobs: Readonly<Record<string, Blob>>): Readonly<Record<string, string>> {
  const urls = useMemo(() => {
    const made: Record<string, string> = {};
    for (const [key, blob] of Object.entries(blobs)) made[key] = URL.createObjectURL(blob);
    return made;
  }, [blobs]);
  const current = useRef(urls);
  current.current = urls;
  const mounted = useRef(0);
  useEffect(() => {
    mounted.current += 1;
    const mine = urls;
    return () => {
      mounted.current -= 1;
      // A frame later: mounted again by then (StrictMode), with these same URLs, they stay.
      window.setTimeout(() => {
        if (current.current === mine && mounted.current > 0) return;
        for (const url of Object.values(mine)) URL.revokeObjectURL(url);
      }, 0);
    };
  }, [urls]);
  return urls;
}
