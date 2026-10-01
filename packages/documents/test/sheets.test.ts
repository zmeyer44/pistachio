import { describe, expect, it } from "vitest";
import { csvText, detectDelimiter, parseCsv, serializeCsv, setCsvCell } from "../src/csv.js";
import { cellKey, columnName, formatNumber, generalNumber, parseRef, readXlsx, xlsxText } from "../src/xlsx.js";
import { xlsxFixture } from "./fixtures.js";

describe("CSV", () => {
  it("reads quoted fields, doubled quotes and newlines inside quotes", () => {
    const table = parseCsv('name,notes\n"Smith, J","said ""hi""\nthen left"\nLee,\n');
    expect(table.rows).toEqual([
      ["name", "notes"],
      ["Smith, J", 'said "hi"\nthen left'],
      ["Lee", ""],
    ]);
    expect(table.trailingNewline).toBe(true);
    expect(table.newline).toBe("\n");
  });

  it("finds the delimiter the lines agree on", () => {
    expect(detectDelimiter("a;b;c\n1;2;3\n")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(detectDelimiter("a,b\n1,2\n")).toBe(",");
    expect(detectDelimiter("just one column\nstill one\n")).toBe(",");
    expect(detectDelimiter('"x;y",z\n"1;2",3\n')).toBe(",");
  });

  it("writes back every row nobody edited exactly as it was", () => {
    const source = '﻿id ; "name"\r\n1 ; "Ann"\r\n2;"Bo"\r\n';
    const table = parseCsv(source);
    expect(table.bom).toBe(true);
    expect(table.newline).toBe("\r\n");
    expect(serializeCsv(table)).toBe(source);
    const edited = setCsvCell(table, 2, 1, "Bob; Jr");
    expect(serializeCsv(edited)).toBe('﻿id ; "name"\r\n1 ; "Ann"\r\n2;"Bob; Jr"\r\n');
  });

  it("grows the table to hold a cell set past its end, and leaves a missing last newline missing", () => {
    const table = parseCsv("a,b\n1,2");
    expect(table.trailingNewline).toBe(false);
    const grown = setCsvCell(table, 3, 2, "x");
    expect(serializeCsv(grown)).toBe("a,b\n1,2\n\n,,x");
    expect(setCsvCell(table, 0, 0, "a")).toBe(table);
  });

  it("gives the agent tab-separated rows, cut at its limit", () => {
    const table = parseCsv("a,b\n1,2\n3,4\n");
    expect(csvText(table, 1_000)).toBe("a\tb\n1\t2\n3\t4\n");
    expect(csvText(table, 6)).toContain("[… cut at 6 characters]");
  });
});

describe("number formats", () => {
  it.each([
    [1234.5, "General", "1234.5"],
    [0.1 + 0.2, "General", "0.3"],
    [1234.5, "0", "1235"],
    [1234.5, "0.00", "1234.50"],
    [1234567.891, "#,##0.00", "1,234,567.89"],
    [0.256, "0%", "26%"],
    [0.256, "0.0%", "25.6%"],
    [-1234, "#,##0;(#,##0)", "(1,234)"],
    [0, '#,##0;(#,##0);"-"', "-"],
    [1234.5, '"$"#,##0.00', "$1,234.50"],
    [1234.5, "[$€-407] #,##0.00", "€ 1,234.50"],
    [-5, "0", "-5"],
    [12345, "0.00E+00", "1.23E+04"],
    [3.5, "#,##0.##", "3.5"],
    [3, "#,##0.##", "3"],
  ])("%s as %s is %s", (value, code, shown) => {
    expect(formatNumber(value, code)).toBe(shown);
  });

  it("pads a number to the digits its format requires (postal codes, ids)", () => {
    expect(formatNumber(123, "00000")).toBe("00123");
    expect(formatNumber(5.25, "000.0")).toBe("005.3");
    expect(formatNumber(1234, "#,##0")).toBe("1,234");
    expect(formatNumber(7, "#,##000")).toBe("007");
  });

  it("reads minutes after elapsed hours as minutes", () => {
    expect(formatNumber(1.5, "[h]:mm")).toBe("36:00");
    expect(formatNumber(1.5 + 5 / 1440, "[h]:mm")).toBe("36:05");
  });

  it("reads dates and times from serial days", () => {
    // 45566 is 1 October 2024.
    expect(formatNumber(45566, "m/d/yyyy")).toBe("10/1/2024");
    expect(formatNumber(45566, "yyyy-mm-dd")).toBe("2024-10-01");
    expect(formatNumber(45566, "d-mmm-yy")).toBe("1-Oct-24");
    expect(formatNumber(45566, "dddd, mmmm d")).toBe("Tuesday, October 1");
    expect(formatNumber(45566.75, "h:mm AM/PM")).toBe("6:00 PM");
    expect(formatNumber(45566.5, "m/d/yyyy h:mm")).toBe("10/1/2024 12:00");
    expect(formatNumber(0.5 + 30 / 1440, "hh:mm")).toBe("12:30");
    expect(formatNumber(1.5, "[h]:mm:ss")).toBe("36:00:00");
    // The 1904 system counts from 1 January 1904.
    expect(formatNumber(0, "yyyy-mm-dd", true)).toBe("1904-01-01");
  });

  it("writes General as Excel does", () => {
    expect(generalNumber(100)).toBe("100");
    expect(generalNumber(1 / 3)).toBe("0.3333333333");
    expect(generalNumber(123456789012)).toBe("1.23457E+11");
    expect(generalNumber(0.0000001)).toBe("1E-07");
    expect(generalNumber(-2.5)).toBe("-2.5");
  });
});

describe("xlsx", () => {
  it("names columns and cell references", () => {
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
    expect(columnName(16_383)).toBe("XFD");
    expect(parseRef("B12")).toEqual({ row: 11, col: 1 });
    expect(parseRef("$AA$3")).toEqual({ row: 2, col: 26 });
    expect(parseRef("nope")).toBeNull();
  });

  const styles =
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><i/><sz val="14"/><color rgb="FFFF0000"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="0.5"/></patternFill></fill></fills>' +
    '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="164" fontId="0" fillId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="1" fillId="2"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="9" fontId="0" fillId="0"/></cellXfs>';

  it("reads cells as Excel shows them: strings, numbers through their formats, dates, booleans, formulas' values", () => {
    const bytes = xlsxFixture({
      strings: ["Item", "Price", "<r><t>Rich </t></r><r><rPr><b/></rPr><t>text</t></r>"],
      styles,
      sheets: [
        {
          name: "Budget",
          before: '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="20" customWidth="1"/><col min="3" max="3" width="5" hidden="1"/></cols>',
          rows:
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="2"><v>1234.5</v></c><c r="C2" s="1"><v>45566</v></c></row>' +
            '<row r="3"><c r="A3" t="inlineStr"><is><t>inline</t></is></c><c r="B3" t="b"><v>1</v></c><c r="C3" t="str"><f>A1&amp;"!"</f><v>Item!</v></c><c r="D3" s="3"><f>B2/1000</f><v>0.25</v></c></row>' +
            '<row r="5"><c r="E5" t="e"><v>#N/A</v></c></row>',
          extra: '<mergeCells count="1"><mergeCell ref="A5:C5"/></mergeCells>',
        },
        { name: "Secret", rows: '<row r="1"><c r="A1"><v>1</v></c></row>', state: "hidden" },
      ],
    });
    const book = readXlsx(bytes);
    expect(book.sheets.map((sheet) => sheet.name)).toEqual(["Budget", "Secret"]);
    const [budget, secret] = book.sheets;
    expect(secret!.hidden).toBe(true);
    const text = (ref: string): string | undefined => {
      const at = parseRef(ref)!;
      return budget!.cells.get(cellKey(at.row, at.col))?.text;
    };
    expect(text("A1")).toBe("Item");
    expect(text("A2")).toBe("Rich text");
    expect(text("B2")).toBe("1,234.50");
    expect(text("C2")).toBe("2024-10-01");
    expect(text("A3")).toBe("inline");
    expect(text("B3")).toBe("TRUE");
    expect(text("C3")).toBe("Item!");
    expect(text("D3")).toBe("25%");
    expect(text("E5")).toBe("#N/A");
    expect(budget!.rowCount).toBe(5);
    expect(budget!.colCount).toBe(5);
    expect(budget!.frozen).toEqual({ rows: 1, cols: 0 });
    expect(budget!.colWidths.get(0)).toBe(145);
    expect(budget!.hiddenCols.has(2)).toBe(true);
    expect(budget!.merges).toEqual([{ top: 4, left: 0, bottom: 4, right: 2 }]);
    const b2 = budget!.cells.get(cellKey(1, 1))!;
    expect(b2.numeric).toBe(true);
    expect(book.styles[b2.style]).toMatchObject({ bold: true, italic: true, size: 14, color: "#FF0000", align: "center", wrap: true });
    // Accent 1 (#4472C4) half tinted toward white.
    expect(book.styles[b2.style]!.fill).toBe("#A2B8E2");
  });

  it("gives the agent each visible sheet's rows, with their row numbers", () => {
    const bytes = xlsxFixture({
      sheets: [
        { name: "One", rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="B1"><v>2</v></c></row><row r="3"><c r="B3"><v>3</v></c></row>' },
        { name: "Hidden", rows: '<row r="1"><c r="A1"><v>9</v></c></row>', state: "hidden" },
      ],
    });
    expect(xlsxText(bytes, 10_000)).toBe("## Sheet “One” (3 rows × 2 columns)\n1\ta\t2\n3\t\t3");
  });

  it("reads a sparse sheet by its cells, not its whole rectangle, and names far cells by reference", () => {
    const bytes = xlsxFixture({
      sheets: [{ name: "Far", rows: '<row r="2"><c r="A2" t="inlineStr"><is><t>near</t></is></c></row><row r="10000"><c r="XFD10000" t="inlineStr"><is><t>far</t></is></c></row>' }],
    });
    const started = performance.now();
    const text = xlsxText(bytes, 10_000);
    expect(performance.now() - started).toBeLessThan(500);
    expect(text).toBe("## Sheet “Far” (10000 rows × 16384 columns)\n2\tnear\n10000\tXFD10000=far");
  });

  it("refuses a file that is not a workbook", () => {
    expect(() => readXlsx(new Uint8Array([1, 2, 3]))).toThrow(/not a readable Office document/);
  });
});
