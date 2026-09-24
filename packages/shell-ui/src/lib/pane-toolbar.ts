/**
 * Where each pane's cluster of controls sits along the pane toolbar
 * (components/PaneToolbar.tsx). Pure on purpose — no React, no DOM — so
 * vitest pins the layout under node.
 *
 * A cluster wants to sit over its pane, so a side-by-side split reads as
 * one toolbar per column. Panes that share a column (a stacked split, the
 * 2×2 grid's pairs) would put their clusters on top of one another, so
 * every run of panes whose spans overlap shares the run's total span, cut
 * into equal parts in PANE order — the order the tabs list them in.
 */

/** A pane's horizontal extent, in the toolbar's own coordinates. */
export interface PaneSpan {
  tabId: string;
  left: number;
  right: number;
}

export interface ToolbarCluster {
  tabId: string;
  left: number;
  width: number;
}

export function toolbarClusters(spans: readonly PaneSpan[]): ToolbarCluster[] {
  // Union-find over x-overlap: each pane joins every group it overlaps, and
  // overlapping groups merge, so a pane spanning two columns pulls both in.
  const groups: Array<{ left: number; right: number; members: number[] }> = [];
  spans.forEach((span, index) => {
    const overlapping = groups.filter((group) => span.left < group.right && group.left < span.right);
    const merged = {
      left: Math.min(span.left, ...overlapping.map((group) => group.left)),
      right: Math.max(span.right, ...overlapping.map((group) => group.right)),
      members: [...overlapping.flatMap((group) => group.members), index],
    };
    for (const group of overlapping) groups.splice(groups.indexOf(group), 1);
    groups.push(merged);
  });
  const clusters: ToolbarCluster[] = [];
  for (const group of groups) {
    const members = [...group.members].sort((a, b) => a - b);
    const width = Math.max(0, group.right - group.left) / members.length;
    members.forEach((index, slot) => {
      clusters.push({ tabId: spans[index]!.tabId, left: group.left + slot * width, width });
    });
  }
  // Pane order, whatever order the groups settled in.
  const order = new Map(spans.map((span, index) => [span.tabId, index]));
  return clusters.sort((a, b) => (order.get(a.tabId) ?? 0) - (order.get(b.tabId) ?? 0));
}
