import { useEffect, useRef, useState } from "react";

/**
 * Live LAYOUT width of the referenced element, tracked with a ResizeObserver.
 *
 * Layout, never getBoundingClientRect(): that folds in any transform on the
 * element or its ancestors, and callers use this width to draw a shape sized
 * to the element (the tab's folder silhouette). The strip scale-animates a tab
 * in when it appears, so a rect measurement taken during that would come back
 * 0.96× the real width and never be corrected. borderBoxSize is the
 * untransformed box and keeps sub-pixel precision.
 */
export function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(el.offsetWidth);
    const ro = new ResizeObserver((entries) => {
      const inline = entries[0]?.borderBoxSize?.[0]?.inlineSize;
      setWidth(inline ?? el.offsetWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
