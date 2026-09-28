/**
 * How the tab switcher's cards fit the window: up to five to a row and three
 * rows, each card as wide as the window allows within its bounds. What does
 * not fit is left out — the cards come in visit order, so what is dropped is
 * what was visited longest ago.
 */

const MAX_COLUMNS = 5;
const MAX_ROWS = 3;
const MIN_CARD = 168;
const MAX_CARD = 236;
/** Space between cards. */
export const TAB_SWITCHER_GAP = 4;
/** The panel's inset around the grid. */
export const TAB_SWITCHER_PADDING = 12;
/** Kept clear between the panel and the window's edges. */
const WINDOW_MARGIN = 32;
/** A card's own inset around its thumbnail and label. */
const CARD_INSET = 8;
/** The label row under the thumbnail. */
const LABEL_HEIGHT = 30;

export interface TabSwitcherGrid {
  columns: number;
  cardWidth: number;
  /** The most cards this window has room for. */
  capacity: number;
  /** The panel's outer width for `count` cards. */
  panelWidth: number;
}

export function tabSwitcherGrid(viewportWidth: number, viewportHeight: number, count: number): TabSwitcherGrid {
  const inner = (outer: number) => Math.max(0, outer - 2 * WINDOW_MARGIN - 2 * TAB_SWITCHER_PADDING);
  const width = inner(viewportWidth);
  const fitColumns = Math.floor((width + TAB_SWITCHER_GAP) / (MIN_CARD + TAB_SWITCHER_GAP));
  const maxColumns = Math.max(1, Math.min(MAX_COLUMNS, fitColumns));
  const cardWidth = Math.max(
    Math.min(MIN_CARD, width),
    Math.min(MAX_CARD, Math.floor((width - TAB_SWITCHER_GAP * (maxColumns - 1)) / maxColumns)),
  );
  const thumbnailWidth = cardWidth - 2 * CARD_INSET;
  const cardHeight = (thumbnailWidth * 10) / 16 + LABEL_HEIGHT + 2 * CARD_INSET;
  const fitRows = Math.floor((inner(viewportHeight) + TAB_SWITCHER_GAP) / (cardHeight + TAB_SWITCHER_GAP));
  const rows = Math.max(1, Math.min(MAX_ROWS, fitRows));
  const capacity = maxColumns * rows;
  const columns = Math.max(1, Math.min(maxColumns, count));
  return {
    columns,
    cardWidth,
    capacity,
    panelWidth: columns * cardWidth + (columns - 1) * TAB_SWITCHER_GAP + 2 * TAB_SWITCHER_PADDING,
  };
}
