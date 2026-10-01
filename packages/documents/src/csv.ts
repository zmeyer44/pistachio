/**
 * CSV (RFC 4180, and the ways it is written in practice): the table read,
 * and written back the way it came — the same delimiter, the same line
 * ending, a byte-order mark and a last newline kept or left out as they
 * were, and every row nobody edited exactly as it was written (its quotes
 * and spacing too) — so a cell edited is the only change in the file.
 */

export interface CsvTable {
  rows: string[][];
  delimiter: string;
  newline: "\n" | "\r\n";
  bom: boolean;
  /** The file ended with a newline. */
  trailingNewline: boolean;
  /** Each row as the file had it (without its newline); a row edited since, or added, has none. */
  raw: Array<string | null>;
}

const CANDIDATES = [",", ";", "\t", "|"] as const;
/** A table this long is read no further (the viewer says so, and will not write it back). */
export const MAX_CSV_ROWS = 200_000;

/** The delimiter the first lines agree on most (outside quotes), comma when none stands out. */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 16_384);
  let best: string = ",";
  let bestScore = 0;
  for (const candidate of CANDIDATES) {
    const counts: number[] = [];
    let count = 0;
    let quoted = false;
    for (let index = 0; index < sample.length && counts.length < 12; index += 1) {
      const char = sample[index]!;
      if (char === '"') quoted = !quoted;
      else if (!quoted && char === candidate) count += 1;
      else if (!quoted && char === "\n") {
        counts.push(count);
        count = 0;
      }
    }
    if (count > 0) counts.push(count);
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    // Lines that agree with the first, weighted by how many fields that makes.
    const agreeing = counts.filter((value) => value === first).length;
    const score = agreeing * Math.min(first, 20);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function parseCsv(input: string, delimiter?: string): CsvTable & { truncated: boolean } {
  const bom = input.charCodeAt(0) === 0xfeff;
  const text = bom ? input.slice(1) : input;
  const sep = delimiter ?? detectDelimiter(text);
  const newline: CsvTable["newline"] = /\r\n/.test(text.slice(0, 65_536)) ? "\r\n" : "\n";
  const rows: string[][] = [];
  const raw: string[] = [];
  let row: string[] = [];
  let rowStart = 0;
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let index = 0;
  let truncated = false;
  while (index < text.length) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      index += 1;
      continue;
    }
    if (char === sep) {
      row.push(field);
      field = "";
      fieldStarted = false;
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      row.push(field);
      rows.push(row);
      raw.push(text.slice(rowStart, index));
      row = [];
      field = "";
      fieldStarted = false;
      index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
      rowStart = index;
      if (rows.length >= MAX_CSV_ROWS && index < text.length) {
        truncated = true;
        break;
      }
      continue;
    }
    field += char;
    fieldStarted = true;
    index += 1;
  }
  const trailingNewline = text.endsWith("\n") || text.endsWith("\r");
  if (!truncated && (field !== "" || fieldStarted || row.length > 0)) {
    row.push(field);
    rows.push(row);
    raw.push(text.slice(rowStart));
  }
  return { rows, delimiter: sep, newline, bom, trailingNewline, raw, truncated };
}

/** A field as it is written: quoted only when it must be. */
function quoteField(value: string, delimiter: string): string {
  const needs = value.includes(delimiter) || value.includes('"') || value.includes("\n") || value.includes("\r");
  return needs ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serializeCsv(table: CsvTable): string {
  const lines = table.rows.map((row, index) => table.raw[index] ?? row.map((value) => quoteField(value, table.delimiter)).join(table.delimiter));
  const body = lines.join(table.newline);
  return `${table.bom ? "﻿" : ""}${body}${table.trailingNewline && lines.length > 0 ? table.newline : ""}`;
}

/** A cell set: the table grown as far as it must to hold it (a row padded no further than that cell), that row written afresh. */
export function setCsvCell(table: CsvTable, row: number, col: number, value: string): CsvTable {
  const rows = table.rows.slice();
  const raw = table.raw.slice();
  while (rows.length <= row) {
    rows.push([]);
    raw.push(null);
  }
  const target = [...rows[row]!];
  if ((target[col] ?? "") === value) return table;
  while (target.length <= col) target.push("");
  target[col] = value;
  rows[row] = target;
  raw[row] = null;
  return { ...table, rows, raw };
}

/** How many columns the widest row has. */
export function csvWidth(table: Pick<CsvTable, "rows">): number {
  let width = 0;
  for (const row of table.rows) if (row.length > width) width = row.length;
  return width;
}

/** The table as the agent reads it: tab-separated, a line a row. */
export function csvText(table: Pick<CsvTable, "rows">, maxChars: number): string {
  let out = "";
  for (const row of table.rows) {
    const line = `${row.join("\t")}\n`;
    if (out.length + line.length > maxChars) return `${out}[… cut at ${String(maxChars)} characters]`;
    out += line;
  }
  return out;
}
