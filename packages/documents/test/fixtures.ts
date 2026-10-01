import { strToU8, zipSync } from "fflate";

/** A zip of these parts, in this order. */
export function zipOf(parts: Record<string, string | Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(parts)) files[path] = typeof content === "string" ? strToU8(content) : content;
  return zipSync(files);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const ROOT_RELS = (target: string) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;

/* --------------------------------- xlsx --------------------------------- */

export interface XlsxFixtureSheet {
  name: string;
  /** The sheetData's rows, as XML. */
  rows: string;
  extra?: string;
  before?: string;
  state?: "hidden";
}

export function xlsxFixture(options: { sheets: XlsxFixtureSheet[]; strings?: string[]; styles?: string; date1904?: boolean; theme?: string }): Uint8Array {
  const parts: Record<string, string> = {
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    "_rels/.rels": ROOT_RELS("xl/workbook.xml"),
  };
  const rels = options.sheets
    .map((_, index) => `<Relationship Id="rId${String(index + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`)
    .join("");
  const extraRels = [
    options.strings === undefined ? "" : `<Relationship Id="rId90" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`,
    options.styles === undefined ? "" : `<Relationship Id="rId91" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    options.theme === undefined ? "" : `<Relationship Id="rId92" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`,
  ].join("");
  parts["xl/_rels/workbook.xml.rels"] = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}${extraRels}</Relationships>`;
  parts["xl/workbook.xml"] =
    `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<workbookPr${options.date1904 === true ? ' date1904="1"' : ""}/><sheets>` +
    options.sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"${sheet.state === undefined ? "" : ` state="${sheet.state}"`}/>`).join("") +
    `</sheets></workbook>`;
  options.sheets.forEach((sheet, index) => {
    parts[`xl/worksheets/sheet${String(index + 1)}.xml`] =
      `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheet.before ?? ""}<sheetData>${sheet.rows}</sheetData>${sheet.extra ?? ""}</worksheet>`;
  });
  if (options.strings !== undefined)
    parts["xl/sharedStrings.xml"] = `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${options.strings.map((text) => (text.startsWith("<") ? `<si>${text}</si>` : `<si><t xml:space="preserve">${text}</t></si>`)).join("")}</sst>`;
  if (options.styles !== undefined) parts["xl/styles.xml"] = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${options.styles}</styleSheet>`;
  if (options.theme !== undefined) parts["xl/theme/theme1.xml"] = options.theme;
  return zipOf(parts);
}

/* --------------------------------- docx --------------------------------- */

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const DOCUMENT_OPEN =
  `<w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">';

export const DEFAULT_SECT = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';

export const STYLES =
  `${XML}<w:styles xmlns:w="${W_NS}">` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="2F5496"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>' +
  '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>' +
  '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style>' +
  "</w:styles>";

export const NUMBERING =
  `${XML}<w:numbering xmlns:w="${W_NS}">` +
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#xF0B7;"/><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
  '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
  "</w:numbering>";

/** A Word document whose body is `body` (a section's properties added at its end). */
export function docxFixture(body: string, options: { media?: Record<string, Uint8Array>; rels?: string; styles?: string; numbering?: string } = {}): Uint8Array {
  const parts: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>`,
    "_rels/.rels": ROOT_RELS("word/document.xml"),
    "word/document.xml": `${XML}${DOCUMENT_OPEN}<w:body>${body}${DEFAULT_SECT}</w:body></w:document>`,
    "word/styles.xml": options.styles ?? STYLES,
    "word/numbering.xml": options.numbering ?? NUMBERING,
    "word/_rels/document.xml.rels":
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
      (options.rels ?? "") +
      "</Relationships>",
  };
  for (const [path, data] of Object.entries(options.media ?? {})) parts[path] = data;
  return zipOf(parts);
}

/** The 1×1 transparent PNG. */
export const PIXEL_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);
