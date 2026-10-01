import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strFromU8 } from "fflate";
import { docxText, openDocx, saveDocx, type DocxBlock, type DocxDoc, type DocxInline, type DocxParagraph, type DocxTable } from "../src/index.js";
import { ListCounter } from "../src/docx/numbering.js";
import { readZip } from "../src/zip.js";
import { docxFixture, PIXEL_PNG } from "./fixtures.js";

const HEADING = '<w:p w14:paraId="1A2B3C4D"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Lisbon trip</w:t></w:r></w:p>';
const PLAIN =
  '<w:p w14:paraId="00000002"><w:bookmarkStart w:id="0" w:name="arrival"/><w:r><w:t xml:space="preserve">We land at </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>11:05</w:t></w:r><w:r><w:t xml:space="preserve"> on Friday.</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>';
const LINK =
  '<w:p><w:r><w:t xml:space="preserve">Hotel: </w:t></w:r><w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t>Casa do Rio</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve">, after 15:00.</w:t></w:r></w:p>';
const BULLETS =
  '<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>Pack the adapter</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>Print the boarding pass</w:t></w:r></w:p>';
const NUMBERED =
  '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Check in</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Online</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>At the desk</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Board</w:t></w:r></w:p>';
const FIELD =
  '<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> of the plan</w:t></w:r></w:p>';
const TRACKED = '<w:p><w:r><w:t>Kept </w:t></w:r><w:ins w:id="5" w:author="Ann" w:date="2026-01-01T00:00:00Z"><w:r><w:t>added</w:t></w:r></w:ins><w:del w:id="6" w:author="Ann"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>';
const TABLE =
  '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
  '<w:tr><w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>Day</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/><w:shd w:val="clear" w:fill="D9E2F3"/></w:tcPr><w:p><w:r><w:t>Plan</w:t></w:r></w:p></w:tc></w:tr>' +
  '<w:tr><w:tc><w:p><w:r><w:t>Friday</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Alfama walk</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
const PICTURE =
  '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="Picture 1" descr="The route"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdPic"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
const SECTION = '<w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr><w:r><w:t>End of part one</w:t></w:r></w:p>';

const RELS =
  '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/hotel" TargetMode="External"/>' +
  '<Relationship Id="rIdPic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>';

function fixture(body: string): Uint8Array {
  return docxFixture(body, { rels: RELS, media: { "word/media/image1.png": PIXEL_PNG } });
}

/** The document part's body, as written: its paragraphs' outer XML. */
function bodyXml(bytes: Uint8Array): string {
  const xml = strFromU8(readZip(bytes).get("word/document.xml")!);
  return xml.slice(xml.indexOf("<w:body>"), xml.indexOf("</w:body>"));
}

function paragraphsOf(bytes: Uint8Array): string[] {
  return bodyXml(bytes).match(/<w:p[ >].*?<\/w:p>|<w:p\/>/g) ?? [];
}

function blocks(doc: DocxDoc): DocxBlock[] {
  return doc.content;
}

function paragraph(doc: DocxDoc, index: number): DocxParagraph {
  const block = blocks(doc)[index];
  if (block?.type !== "docxParagraph") throw new Error(`block ${String(index)} is ${block?.type ?? "missing"}`);
  return block;
}

function textOf(content: readonly DocxInline[] | undefined): string {
  return (content ?? []).map((node) => (node.type === "text" ? node.text : node.type === "docxBreak" ? "\n" : node.type === "docxLocked" ? `[${node.attrs.text}]` : "[img]")).join("");
}

/** A copy of the editor's document, to change as an edit would. */
function edit(doc: DocxDoc): DocxDoc {
  return structuredClone(doc);
}

describe("reading a Word document", () => {
  it("reads paragraphs, runs and their look through the styles", () => {
    const { view } = openDocx(fixture(HEADING + PLAIN));
    const heading = paragraph(view.doc, 0);
    expect(heading.attrs.role).toBe("h1");
    expect(textOf(heading.content)).toBe("Lisbon trip");
    const headingRun = heading.content![0]!;
    expect(headingRun.type === "text" && headingRun.marks![0]!.attrs.css).toContain("font-size:16pt");
    expect(headingRun.type === "text" && headingRun.marks![0]!.attrs.css).toContain("color:#2F5496");
    const plain = paragraph(view.doc, 1);
    expect(textOf(plain.content)).toBe("We land at 11:05 on Friday.");
    const bold = plain.content![1]!;
    expect(bold.type === "text" && bold.marks![0]!.attrs.css).toContain("font-weight:700");
    expect(view.page.width).toBe(816);
    expect(view.page.margin.left).toBe(96);
    expect(view.baseCss).toContain('font-family:"Calibri"');
  });

  it("numbers lists as Word does, a deeper level starting again under each item", () => {
    const { view } = openDocx(fixture(BULLETS + NUMBERED));
    const counter = new ListCounter(view.lists);
    const markers = blocks(view.doc).map((block) => (block.type === "docxParagraph" ? counter.next(block.attrs.numId, block.attrs.ilvl) : null));
    expect(markers).toEqual(["•", "•", "1.", "a)", "b)", "2."]);
  });

  it("keeps a field, a picture and tracked changes as they are, and says so", () => {
    const { view } = openDocx(fixture(FIELD + PICTURE + TRACKED));
    const field = paragraph(view.doc, 0);
    expect(textOf(field.content)).toBe("Page [3] of the plan");
    const image = paragraph(view.doc, 1).content![0]!;
    expect(image).toMatchObject({ type: "docxImage", attrs: { src: "word/media/image1.png", width: 100, height: 50, alt: "The route" } });
    expect(view.media["word/media/image1.png"]).toBe("image/png");
    const tracked = blocks(view.doc)[2]!;
    expect(tracked).toMatchObject({ type: "docxLockedBlock", attrs: { label: "Tracked changes", text: "Kept added" } });
    expect(view.locked).toBe(2);
  });

  it("reads tables, their cells' widths and fills, and their borders from the table's style", () => {
    const { view } = openDocx(fixture(TABLE));
    const table = blocks(view.doc)[0] as DocxTable;
    expect(table.type).toBe("docxTable");
    expect(table.content.map((row) => row.content.map((cell) => textOf((cell.content[0] as DocxParagraph).content)))).toEqual([
      ["Day", "Plan"],
      ["Friday", "Alfama walk"],
    ]);
    const plan = table.content[0]!.content[1]!;
    expect(plan.attrs.css).toContain("width:266.7px");
    expect(plan.attrs.css).toContain("background-color:#D9E2F3");
    expect(plan.attrs.css).toContain("border:1px solid");
  });

  it("reads what macOS writes (textutil), with no styles part", () => {
    const { view } = openDocx(readFileSync(join(import.meta.dirname, "files/cocoa-trip.docx")));
    const texts = blocks(view.doc).map((block) => (block.type === "docxParagraph" ? textOf(block.content) : block.type));
    expect(texts[0]).toBe("Lisbon trip");
    expect(texts[1]).toBe("We land at 11:05 on Friday, then take the metro to Baixa.");
    // (textutil writes an HTML table's cells as paragraphs, and a list's markers as text.)
    expect(texts).toContain("\t•\tPack the adapter");
    expect(texts.at(-1)).toBe("Hotel: Casa do Rio, check-in after 15:00.");
  });

  it("gives the agent the document as markdown", () => {
    const text = docxText(fixture(HEADING + PLAIN + BULLETS + NUMBERED + TABLE + FIELD), 10_000);
    expect(text).toBe(
      [
        "# Lisbon trip",
        "We land at 11:05 on Friday.",
        "- Pack the adapter",
        "- Print the boarding pass",
        "1. Check in",
        "  a) Online",
        "  b) At the desk",
        "2. Board",
        "| Day | Plan |",
        "| Friday | Alfama walk |",
        "Page 3 of the plan",
      ].join("\n"),
    );
  });

  it("refuses what is not a Word document", () => {
    expect(() => openDocx(new Uint8Array([80, 75, 3, 4]))).toThrow(/not a readable Office document/);
  });
});

describe("writing a Word document back", () => {
  const BODY = HEADING + PLAIN + LINK + FIELD + TABLE + PICTURE;

  it("writes every paragraph back as it was when nothing changed", () => {
    const bytes = fixture(BODY);
    const { source, view } = openDocx(bytes);
    expect(paragraphsOf(saveDocx(source, view.doc))).toEqual(paragraphsOf(bytes));
  });

  it("changes only the run whose text changed, keeping its look, and leaves the other paragraphs untouched", () => {
    const bytes = fixture(BODY);
    const { source, view } = openDocx(bytes);
    const doc = edit(view.doc);
    const plain = paragraph(doc, 1);
    const bold = plain.content![1]!;
    if (bold.type !== "text") throw new Error("expected text");
    bold.text = "11:35";
    const saved = saveDocx(source, doc);
    const before = paragraphsOf(bytes);
    const after = paragraphsOf(saved);
    expect(after.length).toBe(before.length);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).toContain('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">11:35</w:t></w:r>');
    expect(after[1]).toContain('w14:paraId="00000002"');
    // Its bookmark goes with the paragraph's old content.
    expect(after[1]).not.toContain("bookmarkStart");
    const reread = openDocx(saved).view;
    expect(textOf(paragraph(reread.doc, 1).content)).toBe("We land at 11:35 on Friday.");
  });

  it("keeps an edited link's text inside its hyperlink", () => {
    const { source, view } = openDocx(fixture(BODY));
    const doc = edit(view.doc);
    const link = paragraph(doc, 2);
    const name = link.content![1]!;
    if (name.type !== "text") throw new Error("expected text");
    name.text = "Casa do Rio Lisboa";
    const after = paragraphsOf(saveDocx(source, doc))[2]!;
    expect(after).toMatch(/<w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:color w:val="0563C1"\/><w:u w:val="single"\/><\/w:rPr><w:t xml:space="preserve">Casa do Rio Lisboa<\/w:t><\/w:r><\/w:hyperlink>/);
  });

  it("keeps a field as it was when the text around it changes", () => {
    const { source, view } = openDocx(fixture(BODY));
    const doc = edit(view.doc);
    const field = paragraph(doc, 3);
    const last = field.content!.at(-1)!;
    if (last.type !== "text") throw new Error("expected text");
    last.text = " of the final plan";
    const after = paragraphsOf(saveDocx(source, doc))[3]!;
    expect(after).toContain('<w:fldChar w:fldCharType="begin"/>');
    expect(after).toContain("<w:instrText xml:space=\"preserve\"> PAGE </w:instrText>");
    expect(after).toContain(" of the final plan");
  });

  it("writes a paragraph split in two as two with the same properties, the copy without a paragraph id", () => {
    const { source, view } = openDocx(fixture(HEADING + PLAIN));
    const doc = edit(view.doc);
    const plain = paragraph(doc, 1);
    // As the editor splits "We land at | 11:05 on Friday.": both halves keep the paragraph's attributes.
    const first: DocxParagraph = { ...plain, content: [plain.content![0]!] };
    const second: DocxParagraph = { ...plain, content: plain.content!.slice(1) };
    doc.content.splice(1, 1, first, second);
    const after = paragraphsOf(saveDocx(source, doc));
    expect(after).toHaveLength(3);
    expect(after[1]).toContain('w14:paraId="00000002"');
    expect(after[2]).not.toContain("w14:paraId");
    expect(openDocx(saveDocx(source, doc)).view.doc.content.map((block) => (block.type === "docxParagraph" ? textOf(block.content) : ""))).toEqual([
      "Lisbon trip",
      "We land at ",
      "11:05 on Friday.",
    ]);
  });

  it("moves a section break to the last piece of a split paragraph", () => {
    const { source, view } = openDocx(fixture(SECTION));
    const doc = edit(view.doc);
    const whole = paragraph(doc, 0);
    const first = whole.content![0]!;
    const marks = first.type === "text" ? first.marks : undefined;
    const piece = (text: string): DocxParagraph => ({ ...whole, content: [{ type: "text", text, ...(marks === undefined ? {} : { marks }) }] });
    doc.content.splice(0, 1, piece("End of"), piece("part one"));
    const after = paragraphsOf(saveDocx(source, doc));
    expect(after[0]).not.toContain("w:sectPr");
    expect(after[1]).toContain("w:sectPr");
  });

  it("joins two paragraphs, runs from both kept, the second gone", () => {
    const { source, view } = openDocx(fixture(HEADING + PLAIN));
    const doc = edit(view.doc);
    const heading = paragraph(doc, 0);
    heading.content = [...heading.content!, ...paragraph(doc, 1).content!];
    doc.content.splice(1, 1);
    const after = paragraphsOf(saveDocx(source, doc));
    expect(after).toHaveLength(1);
    expect(after[0]).toContain("Lisbon trip");
    expect(after[0]).toContain("<w:b/>");
    expect(after[0]).toContain('<w:pStyle w:val="Heading1"/>');
  });

  it("gives text typed where there was no run the paragraph mark's look, and writes tabs and line breaks", () => {
    const bytes = fixture('<w:p><w:pPr><w:rPr><w:i/><w:ins w:id="1" w:author="A"/></w:rPr></w:pPr></w:p>');
    const { source, view } = openDocx(bytes);
    const doc = edit(view.doc);
    paragraph(doc, 0).content = [{ type: "text", text: "a\tb" }, { type: "docxBreak" }, { type: "text", text: " c " }];
    const after = paragraphsOf(saveDocx(source, doc))[0]!;
    expect(after).toContain('<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">a</w:t><w:tab/><w:t xml:space="preserve">b</w:t><w:br/><w:t xml:space="preserve"> c </w:t></w:r>');
    expect(after.match(/<w:ins /g)).toHaveLength(1);
  });

  it("takes out a deleted paragraph, and keeps an empty body a paragraph", () => {
    const { source, view } = openDocx(fixture(HEADING + PLAIN));
    const doc = edit(view.doc);
    doc.content.splice(0, 1);
    expect(paragraphsOf(saveDocx(source, doc))).toHaveLength(1);
    doc.content = [];
    expect(bodyXml(saveDocx(source, doc))).toMatch(/<w:body><w:p\/><w:sectPr>/);
  });

  it("rewrites only the table cell that changed, and keeps a cell ending in a paragraph", () => {
    const bytes = fixture(TABLE);
    const { source, view } = openDocx(bytes);
    const doc = edit(view.doc);
    const table = doc.content[0] as DocxTable;
    const cell = table.content[1]!.content[1]!;
    const text = (cell.content[0] as DocxParagraph).content![0]!;
    if (text.type !== "text") throw new Error("expected text");
    text.text = "Belém and the tower";
    const saved = saveDocx(source, doc);
    const xml = bodyXml(saved);
    expect(xml).toContain('<w:tblStyle w:val="TableGrid"/>');
    expect(xml).toContain('<w:shd w:val="clear" w:fill="D9E2F3"/>');
    expect(xml).toContain("Belém and the tower");
    expect(xml).not.toContain("Alfama walk");
    const reread = openDocx(saved).view.doc.content[0] as DocxTable;
    expect(reread.content[0]!.content.map((c) => textOf((c.content[0] as DocxParagraph).content))).toEqual(["Day", "Plan"]);
  });

  it("gives a copied picture its own drawing id", () => {
    const { source, view } = openDocx(fixture(PICTURE));
    const doc = edit(view.doc);
    doc.content.push(structuredClone(doc.content[0]!));
    const xml = bodyXml(saveDocx(source, doc));
    expect(xml.match(/<wp:docPr id="(\d+)"/g)).toEqual(['<wp:docPr id="1"', '<wp:docPr id="2"']);
  });

  it("round-trips what macOS writes: an edit shows, and the rest reads the same", () => {
    const bytes = readFileSync(join(import.meta.dirname, "files/cocoa-trip.docx"));
    const { source, view } = openDocx(bytes);
    const doc = edit(view.doc);
    const second = paragraph(doc, 1);
    const last = second.content!.at(-1)!;
    if (last.type !== "text") throw new Error("expected text");
    last.text = ", then walk to Baixa.";
    const reread = openDocx(saveDocx(source, doc)).view;
    const texts = (d: DocxDoc) => d.content.map((block) => (block.type === "docxParagraph" ? textOf(block.content) : block.type));
    const expected = texts(view.doc);
    expected[1] = "We land at 11:05 on Friday, then walk to Baixa.";
    expect(texts(reread.doc)).toEqual(expected);
  });
});
