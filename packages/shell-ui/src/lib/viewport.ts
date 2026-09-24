/**
 * Whether a pointer position is inside this page's viewport, with a small
 * margin so a position on the very edge — where a real departure reports
 * it — counts as outside. A chrome view's page uses it to tell a pointer
 * that went onto a native control drawn above the view from one that left.
 */
export function isInsideViewport(point: { clientX: number; clientY: number }, margin = 2): boolean {
  return (
    point.clientX > margin &&
    point.clientY > margin &&
    point.clientX < window.innerWidth - margin &&
    point.clientY < window.innerHeight - margin
  );
}
