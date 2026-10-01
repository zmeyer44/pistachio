import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { columnName, type CellStyle, type SheetRange } from "@pistachio/documents";
import { cn } from "../../../lib/cn";
import { nextVisibleColumn } from "./grid-navigation";

/** A row, and the row of column letters; the gutter the row numbers stand in. */
export const ROW_H = 24;
const HEADER_H = 24;
const GUTTER_W = 48;
/** Rows and columns drawn past what is in view, so a scroll never shows a blank edge. */
const OVERSCAN_ROWS = 8;
const OVERSCAN_PX = 240;

export interface GridCell {
  text: string;
  numeric: boolean;
  style?: CellStyle;
}

export interface GridModel {
  rows: number;
  cols: number;
  cell(row: number, col: number): GridCell | null;
  width(col: number): number;
  hiddenCols?: ReadonlySet<number>;
  hiddenRows?: ReadonlySet<number>;
  merges?: readonly SheetRange[];
}

function cellCss(cell: GridCell): CSSProperties {
  const style = cell.style ?? {};
  const decorations = [style.underline === true ? "underline" : "", style.strike === true ? "line-through" : ""].filter((part) => part !== "");
  return {
    ...(style.bold === true ? { fontWeight: 650 } : {}),
    ...(style.italic === true ? { fontStyle: "italic" } : {}),
    ...(decorations.length > 0 ? { textDecoration: decorations.join(" ") } : {}),
    ...(style.color === undefined ? {} : { color: style.color }),
    ...(style.fill === undefined ? {} : { backgroundColor: style.fill }),
    ...(style.size === undefined || style.size === 11 ? {} : { fontSize: `${String(Math.min(28, Math.max(7, style.size)))}pt` }),
    justifyContent: style.align === "center" ? "center" : style.align === "right" || (style.align === undefined && cell.numeric) ? "flex-end" : "flex-start",
    textAlign: style.align === "center" ? "center" : style.align === "right" || (style.align === undefined && cell.numeric) ? "right" : "left",
    alignItems: style.valign === "top" ? "flex-start" : style.valign === "middle" ? "center" : "flex-end",
    whiteSpace: style.wrap === true ? "normal" : "nowrap",
  };
}

/** Where each visible column starts (hidden ones take no room), and the whole width. */
function columnOffsets(model: GridModel): Float64Array {
  const offsets = new Float64Array(model.cols + 1);
  for (let col = 0; col < model.cols; col += 1) offsets[col + 1] = offsets[col]! + (model.hiddenCols?.has(col) === true ? 0 : model.width(col));
  return offsets;
}

/** The visible rows, in order (hidden ones left out): row numbers by place. */
function visibleRows(model: GridModel): { count: number; at(index: number): number; indexOf(row: number): number } {
  const hidden = model.hiddenRows;
  if (hidden === undefined || hidden.size === 0) return { count: model.rows, at: (index) => index, indexOf: (row) => row };
  const rows: number[] = [];
  for (let row = 0; row < model.rows; row += 1) if (!hidden.has(row)) rows.push(row);
  return {
    count: rows.length,
    at: (index) => rows[index] ?? index,
    indexOf: (row) => {
      let lo = 0;
      let hi = rows.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid]! < row) lo = mid + 1;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

function firstColumnAt(offsets: Float64Array, x: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

export interface GridSelection {
  row: number;
  col: number;
}

/**
 * A sheet's cells, drawn only where they are in view (a workbook may have
 * tens of thousands of rows), under a row of column letters and beside the
 * row numbers. One cell is selected; the arrows, Tab and Enter move it, ⌘C
 * copies it. `onChange` makes it editable: Enter, a double click or typing
 * starts an edit in place, Enter or Tab keeps it, Escape gives it up, and
 * Delete clears the cell.
 */
/** The sheet grown to fill the window with empty rows and columns, as a spreadsheet's grid does (a little past, so it scrolls on). */
function filled(model: GridModel, width: number, height: number): GridModel {
  const rows = Math.max(model.rows, Math.ceil(height / ROW_H) + 2);
  let cols = model.cols;
  let across = 0;
  for (let col = 0; col < model.cols; col += 1) across += model.hiddenCols?.has(col) === true ? 0 : model.width(col);
  while (across < width && cols < model.cols + 200) {
    across += model.width(cols);
    cols += 1;
  }
  return rows === model.rows && cols === model.cols ? model : { ...model, rows, cols };
}

export const SheetGrid = memo(function SheetGrid({
  model: source,
  label,
  focusSignal,
  onChange,
}: {
  model: GridModel;
  label: string;
  focusSignal: number;
  onChange?: (row: number, col: number, value: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, width: 0, height: 0 });
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const [editing, setEditingState] = useState<{ row: number; col: number; value: string } | null>(null);
  // The edit as it is this moment: Escape gives it up before focus moves (the field's blur would keep it otherwise).
  const editingRef = useRef<{ row: number; col: number; value: string } | null>(null);
  const setEditing = useCallback((next: { row: number; col: number; value: string } | null) => {
    editingRef.current = next;
    setEditingState(next);
  }, []);
  const model = useMemo(() => filled(source, view.width, view.height), [source, view.width, view.height]);
  const offsets = useMemo(() => columnOffsets(model), [model]);
  const rows = useMemo(() => visibleRows(model), [model]);
  const totalW = offsets[model.cols] ?? 0;
  const totalH = rows.count * ROW_H;

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    let frame = 0;
    const read = (): void => {
      frame = 0;
      setView({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight });
    };
    const onScroll = (): void => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (focusSignal > 0) scrollerRef.current?.focus({ preventScroll: true });
  }, [focusSignal]);

  // What is in view: rows by their place, columns by where they start.
  const bodyTop = Math.max(0, view.top);
  const firstIndex = Math.max(0, Math.floor(bodyTop / ROW_H) - OVERSCAN_ROWS);
  const lastIndex = Math.min(rows.count - 1, Math.ceil((bodyTop + view.height) / ROW_H) + OVERSCAN_ROWS);
  const firstCol = firstColumnAt(offsets, Math.max(0, view.left - OVERSCAN_PX));
  const lastCol = Math.min(model.cols - 1, firstColumnAt(offsets, view.left + view.width + OVERSCAN_PX));

  // Merged cells: each drawn once, at its first cell, across the rest.
  const merges = useMemo(() => model.merges ?? [], [model.merges]);
  const covered = useMemo(() => {
    const set = new Set<number>();
    for (const merge of merges) {
      if ((merge.bottom - merge.top + 1) * (merge.right - merge.left + 1) > 50_000) continue;
      for (let row = merge.top; row <= merge.bottom; row += 1)
        for (let col = merge.left; col <= merge.right; col += 1) if (row !== merge.top || col !== merge.left) set.add(row * 16_384 + col);
    }
    return set;
  }, [merges]);
  const mergeAt = useMemo(() => new Map(merges.map((merge) => [merge.top * 16_384 + merge.left, merge])), [merges]);

  const cellBox = useCallback(
    (row: number, col: number): { x: number; y: number; w: number; h: number } => {
      const merge = mergeAt.get(row * 16_384 + col);
      const index = rows.indexOf(row);
      if (merge === undefined) return { x: offsets[col]!, y: index * ROW_H, w: (offsets[col + 1] ?? 0) - offsets[col]!, h: ROW_H };
      const bottom = rows.indexOf(Math.min(model.rows - 1, merge.bottom));
      return { x: offsets[col]!, y: index * ROW_H, w: (offsets[Math.min(model.cols, merge.right + 1)] ?? totalW) - offsets[col]!, h: (bottom - index + 1) * ROW_H };
    },
    [mergeAt, model.cols, model.rows, offsets, rows, totalW],
  );

  const scrollIntoView = useCallback(
    (row: number, col: number) => {
      const el = scrollerRef.current;
      if (el === null) return;
      // (The body starts below the letters and beside the numbers, which stay in view.)
      const box = cellBox(row, col);
      if (box.y < el.scrollTop) el.scrollTop = box.y;
      else if (box.y + box.h > el.scrollTop + el.clientHeight - HEADER_H) el.scrollTop = box.y + box.h - el.clientHeight + HEADER_H;
      if (box.x < el.scrollLeft) el.scrollLeft = box.x;
      else if (box.x + box.w > el.scrollLeft + el.clientWidth - GUTTER_W) el.scrollLeft = box.x + box.w - el.clientWidth + GUTTER_W;
    },
    [cellBox],
  );

  const move = useCallback(
    (row: number, col: number, from?: number) => {
      // Past hidden columns the way it moves (from where it was).
      const start = from ?? col;
      const nextCol = nextVisibleColumn(start, col - start, model.hiddenCols, model.cols);
      const index = Math.max(0, Math.min(rows.count - 1, rows.indexOf(Math.max(0, row))));
      const nextRow = rows.at(index);
      setSelection({ row: nextRow, col: nextCol });
      scrollIntoView(nextRow, nextCol);
    },
    [model.cols, model.hiddenCols, rows, scrollIntoView],
  );

  const commit = (then: "down" | "right" | "stay"): void => {
    const edit = editingRef.current;
    if (edit === null) return;
    setEditing(null);
    onChange?.(edit.row, edit.col, edit.value);
    if (then === "down") move(rows.at(rows.indexOf(edit.row) + 1), edit.col);
    else if (then === "right") move(edit.row, edit.col + 1, edit.col);
    scrollerRef.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (editing !== null) return;
    const at = selection ?? { row: rows.at(0), col: 0 };
    const index = rows.indexOf(at.row);
    const page = Math.max(1, Math.floor((view.height - HEADER_H) / ROW_H) - 1);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        return move(rows.at(index + (event.metaKey ? rows.count : 1)), at.col);
      case "ArrowUp":
        event.preventDefault();
        return move(rows.at(event.metaKey ? 0 : index - 1), at.col);
      case "ArrowRight":
        event.preventDefault();
        return move(at.row, event.metaKey ? model.cols - 1 : at.col + 1, at.col);
      case "ArrowLeft":
        event.preventDefault();
        return move(at.row, event.metaKey ? 0 : at.col - 1, at.col);
      case "PageDown":
        event.preventDefault();
        return move(rows.at(index + page), at.col);
      case "PageUp":
        event.preventDefault();
        return move(rows.at(index - page), at.col);
      case "Tab":
        event.preventDefault();
        return move(at.row, at.col + (event.shiftKey ? -1 : 1), at.col);
      case "Enter":
        event.preventDefault();
        if (onChange !== undefined && selection !== null) setEditing({ ...selection, value: model.cell(selection.row, selection.col)?.text ?? "" });
        else move(rows.at(index + (event.shiftKey ? -1 : 1)), at.col);
        return;
      case "Backspace":
      case "Delete":
        if (onChange !== undefined && selection !== null) {
          event.preventDefault();
          onChange(selection.row, selection.col, "");
        }
        return;
      default:
        break;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && selection !== null) {
      event.preventDefault();
      void navigator.clipboard?.writeText(model.cell(selection.row, selection.col)?.text ?? "").catch(() => undefined);
      return;
    }
    // Typing into a selected cell replaces what it holds.
    if (onChange !== undefined && selection !== null && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setEditing({ ...selection, value: event.key });
    }
  };

  const cells: React.ReactNode[] = [];
  const drawn = new Set<number>();
  const draw = (row: number, col: number): void => {
    const key = row * 16_384 + col;
    if (drawn.has(key) || covered.has(key)) return;
    drawn.add(key);
    const cell = model.cell(row, col);
    const merge = mergeAt.get(key);
    if (cell === null && merge === undefined) return;
    const box = cellBox(row, col);
    cells.push(
      <div
        key={key}
        className={cn("desk-sheet-cell", merge !== undefined && "desk-sheet-merged")}
        data-row={row}
        data-col={col}
        style={{ left: box.x, top: box.y, width: box.w, height: box.h, ...(cell === null ? {} : cellCss(cell)) }}
      >
        <span className="desk-sheet-text">{cell?.text ?? ""}</span>
      </div>,
    );
  };
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const row = rows.at(index);
    for (let col = firstCol; col <= lastCol; col += 1) if (model.hiddenCols?.has(col) !== true) draw(row, col);
  }
  // A merge begun above what is in view still shows across it.
  for (const merge of merges) {
    const top = rows.indexOf(merge.top);
    const bottom = rows.indexOf(merge.bottom);
    if (top < firstIndex && bottom >= firstIndex && merge.right >= firstCol && merge.left <= lastCol) draw(merge.top, merge.left);
  }

  // Each column's line, drawn down the whole sheet (the cells draw theirs; the empty ground has none of its own).
  const columnLines: React.ReactNode[] = [];
  for (let col = firstCol; col <= lastCol; col += 1) {
    if (model.hiddenCols?.has(col) === true) continue;
    columnLines.push(<div key={col} className="desk-sheet-colline" aria-hidden="true" style={{ left: (offsets[col + 1] ?? 0) - 1 }} />);
  }
  const columnHeads: React.ReactNode[] = [];
  for (let col = firstCol; col <= lastCol; col += 1) {
    if (model.hiddenCols?.has(col) === true) continue;
    columnHeads.push(
      <div key={col} className="desk-sheet-head" data-on={selection?.col === col ? "" : undefined} style={{ left: offsets[col]!, width: (offsets[col + 1] ?? 0) - offsets[col]! }}>
        {columnName(col)}
      </div>,
    );
  }
  const rowHeads: React.ReactNode[] = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const row = rows.at(index);
    rowHeads.push(
      <div key={row} className="desk-sheet-rowhead" data-on={selection?.row === row ? "" : undefined} style={{ top: index * ROW_H, height: ROW_H }}>
        {row + 1}
      </div>,
    );
  }
  const selectedBox = selection === null ? null : cellBox(selection.row, selection.col);

  return (
    <div
      ref={scrollerRef}
      role="grid"
      aria-label={label}
      aria-rowcount={source.rows}
      aria-colcount={source.cols}
      tabIndex={0}
      data-testid="desk-sheet-grid"
      className="desk-sheet scroll-thin"
      onKeyDown={onKeyDown}
    >
      {/* Sticky: the letters stay at the top, the numbers at the side, as the sheet scrolls under them. */}
      <div className="desk-sheet-heads" style={{ width: GUTTER_W + totalW, height: HEADER_H }}>
        <div className="desk-sheet-corner" style={{ width: GUTTER_W, height: HEADER_H }} />
        <div className="relative" style={{ width: totalW, height: HEADER_H }}>
          {columnHeads}
        </div>
      </div>
      <div className="flex" style={{ width: GUTTER_W + totalW, height: totalH }}>
        <div className="desk-sheet-rowheads" style={{ width: GUTTER_W, height: totalH }}>
          {rowHeads}
        </div>
        <div
          className="desk-sheet-body"
          style={{ width: totalW, height: totalH }}
          onPointerDown={(event) => {
            const target = (event.target as HTMLElement).closest<HTMLElement>(".desk-sheet-cell");
            const box = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - box.left;
            const y = event.clientY - box.top;
            const row = target === null ? rows.at(Math.floor(y / ROW_H)) : Number(target.dataset["row"]);
            const col = target === null ? firstColumnAt(offsets, x) : Number(target.dataset["col"]);
            if (editing !== null && (editing.row !== row || editing.col !== col)) commit("stay");
            setSelection({ row, col });
          }}
          onDoubleClick={() => {
            if (onChange !== undefined && selection !== null) setEditing({ ...selection, value: model.cell(selection.row, selection.col)?.text ?? "" });
          }}
        >
          {columnLines}
          {cells}
          {selectedBox === null ? null : (
            <div className="desk-sheet-selection" data-testid="desk-sheet-selection" style={{ left: selectedBox.x - 1, top: selectedBox.y - 1, width: selectedBox.w + 1, height: selectedBox.h + 1 }} />
          )}
          {editing === null || selectedBox === null ? null : (
            <input
              autoFocus
              data-testid="desk-sheet-editor"
              aria-label={`${columnName(editing.col)}${String(editing.row + 1)}`}
              className="desk-sheet-input"
              style={{ left: selectedBox.x, top: selectedBox.y, width: Math.max(selectedBox.w, 120), height: selectedBox.h }}
              value={editing.value}
              onChange={(event) => setEditing({ ...editing, value: event.target.value })}
              onBlur={() => commit("stay")}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit("down");
                } else if (event.key === "Tab") {
                  event.preventDefault();
                  commit("right");
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  // Given up at once, so the blur that focusing the sheet causes finds nothing to keep.
                  setEditing(null);
                  scrollerRef.current?.focus({ preventScroll: true });
                }
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
});
