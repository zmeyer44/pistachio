import { useCallback, useEffect, useMemo, useState } from "react";
import { cellKey, csvWidth, parseCsv, readXlsx, serializeCsv, setCsvCell, type CsvTable, type Workbook } from "@pistachio/documents";
import { cn } from "../../../lib/cn";
import type { ViewerProps } from "./FileWindow";
import { SheetGrid, type GridModel } from "./SheetGrid";

/** A CSV's column, as wide as what it holds in its first rows. */
function csvColumnWidths(table: Pick<CsvTable, "rows">, cols: number): number[] {
  const widths = new Array<number>(cols).fill(0);
  for (const row of table.rows.slice(0, 200)) row.forEach((value, col) => (widths[col] = Math.max(widths[col] ?? 0, Math.min(value.length, 48))));
  return widths.map((chars) => Math.min(340, Math.max(72, chars * 7.4 + 18)));
}

/** A CSV's text: UTF-8 (its byte-order mark kept, for the table to write back), or, not UTF-8, shown and not edited. */
function readCsvText(bytes: Uint8Array): { text: string; foreign: boolean } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), foreign: false };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), foreign: true };
  }
}

/**
 * A spreadsheet: an Excel workbook, its sheets as tabs, its cells as Excel
 * shows them (read, not edited); or a CSV, its cells edited in place and
 * written back with every row nobody edited as it was.
 */
export default function SheetViewer({ item, content, focusSignal, onEdit, onDetail }: ViewerProps) {
  const csv = item.mediaType === "text/csv";
  return csv ? (
    <CsvSheet name={item.name} bytes={content.bytes} focusSignal={focusSignal} onEdit={onEdit} onDetail={onDetail} />
  ) : (
    <WorkbookSheets name={item.name} bytes={content.bytes} focusSignal={focusSignal} onDetail={onDetail} />
  );
}

function CsvSheet({ name, bytes, focusSignal, onEdit, onDetail }: { name: string; bytes: Uint8Array; focusSignal: number; onEdit: ViewerProps["onEdit"]; onDetail: ViewerProps["onDetail"] }) {
  const read = useMemo(() => {
    const { text, foreign } = readCsvText(bytes);
    return { table: parseCsv(text), foreign };
  }, [bytes]);
  const [table, setTable] = useState<CsvTable>(read.table);
  const readOnly = read.foreign || read.table.truncated;
  const width = csvWidth(table);
  const widths = useMemo(() => csvColumnWidths(read.table, Math.max(1, csvWidth(read.table)) + 1), [read]);
  useEffect(() => {
    const rows = table.rows.length;
    onDetail(read.table.truncated ? "First 200,000 rows · read only" : read.foreign ? "Read only: not UTF-8" : `${rows.toLocaleString()} ${rows === 1 ? "row" : "rows"}`);
  }, [onDetail, read, table.rows.length]);
  const model = useMemo<GridModel>(
    () => ({
      // A row and a column past the table's end, to write into.
      rows: table.rows.length + (readOnly ? 0 : 1),
      cols: Math.max(1, width) + (readOnly ? 0 : 1),
      cell: (row, col) => {
        const text = table.rows[row]?.[col];
        return text === undefined || text === "" ? null : { text, numeric: /^-?[\d,]*\.?\d+%?$/.test(text.trim()) };
      },
      width: (col) => widths[col] ?? 96,
    }),
    [readOnly, table, width, widths],
  );
  const onChange = useCallback(
    (row: number, col: number, value: string) => {
      setTable((current) => {
        const next = setCsvCell(current, row, col, value);
        if (next !== current) onEdit(() => new TextEncoder().encode(serializeCsv(next)));
        return next;
      });
    },
    [onEdit],
  );
  return (
    <div className="desk-viewer-column">
      <SheetGrid model={model} label={name} focusSignal={focusSignal} {...(readOnly ? {} : { onChange })} />
    </div>
  );
}

function WorkbookSheets({ name, bytes, focusSignal, onDetail }: { name: string; bytes: Uint8Array; focusSignal: number; onDetail: ViewerProps["onDetail"] }) {
  const book = useMemo((): { ok: true; book: Workbook } | { ok: false; message: string } => {
    try {
      return { ok: true, book: readXlsx(bytes) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "the workbook could not be read" };
    }
  }, [bytes]);
  const visible = book.ok ? book.book.sheets.filter((sheet) => !sheet.hidden) : [];
  const [chosen, setChosen] = useState(0);
  const sheet = visible[Math.min(chosen, visible.length - 1)];
  useEffect(() => {
    if (!book.ok || sheet === undefined) return;
    const rows = sheet.rowCount;
    onDetail(`${visible.length > 1 ? `${String(visible.length)} sheets · ` : ""}${rows.toLocaleString()} ${rows === 1 ? "row" : "rows"}${sheet.truncated ? " (more not shown)" : ""}`);
  }, [book, onDetail, sheet, visible.length]);
  const model = useMemo<GridModel | null>(() => {
    if (!book.ok || sheet === undefined) return null;
    const styles = book.book.styles;
    return {
      rows: Math.max(1, sheet.rowCount),
      cols: Math.max(1, sheet.colCount),
      cell: (row, col) => {
        const cell = sheet.cells.get(cellKey(row, col));
        if (cell === undefined) return null;
        const style = styles[cell.style];
        return { text: cell.text, numeric: cell.numeric, ...(style === undefined ? {} : { style }) };
      },
      width: (col) => sheet.colWidths.get(col) ?? sheet.defaultWidth,
      hiddenCols: sheet.hiddenCols,
      hiddenRows: sheet.hiddenRows,
      merges: sheet.merges,
    };
  }, [book, sheet]);
  if (!book.ok || model === null || sheet === undefined) {
    return (
      <div className="grid size-full place-items-center bg-background-100 p-6 text-center text-[12px] text-gray-800" data-testid="desk-sheet-error">
        This workbook could not be opened: {book.ok ? "it has no sheets to show" : book.message}. It may be damaged, or protected by a password.
      </div>
    );
  }
  return (
    <div className="desk-viewer-column">
      <SheetGrid key={sheet.name} model={model} label={`${name}: ${sheet.name}`} focusSignal={focusSignal} />
      {visible.length > 1 ? (
        <div className="desk-sheet-tabs scroll-thin" role="tablist" aria-label="Sheets">
          {visible.map((entry, index) => (
            <button
              key={entry.name}
              type="button"
              role="tab"
              aria-selected={entry === sheet}
              data-testid="desk-sheet-tab"
              className={cn("desk-sheet-tab")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setChosen(index)}
            >
              {entry.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
