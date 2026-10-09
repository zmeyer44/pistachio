import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { openDocx } from "@pistachio/documents";
import { docxFixture } from "../../documents/test/fixtures";
import { docxExtensions } from "../src/components/desk/files/docx-schema";
import { formatAttachmentText, formatSelectionText, splitAttachedText } from "../src/lib/chat-attachments";

const TRIP =
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Lisbon trip</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t xml:space="preserve">We land at </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>11:05</w:t></w:r><w:r><w:br/><w:t>on Friday.</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>Pack the adapter</w:t></w:r></w:p>' +
  '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="5200"/></w:tblGrid>' +
  '<w:tr><w:tc><w:p><w:r><w:t>Day</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>' +
  '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
  '<w:p><w:r><w:t>Kept </w:t></w:r><w:ins w:id="1" w:author="A"><w:r><w:t>added</w:t></w:r></w:ins></w:p>';

describe("the document viewer's editor", () => {
  const extensions = docxExtensions({ docId: "doc-1", media: {}, lists: {}, markerCss: {} });
  const schema = getSchema(extensions);

  it("takes every document the reader makes, as the reader made it", () => {
    for (const bytes of [docxFixture(TRIP), readFileSync(join(import.meta.dirname, "../../documents/test/files/cocoa-trip.docx"))]) {
      const { view } = openDocx(bytes);
      const doc = schema.nodeFromJSON(view.doc);
      doc.check();
      // Read back, it is the JSON it was made from: nothing the writer needs is lost on the way in.
      expect(doc.toJSON()).toEqual(view.doc);
    }
  });
});


describe("a message's attached text", () => {
  it("comes apart from the person's words, each block its own", () => {
    const content = [
      "What's left to pack in @notes.md ?",
      formatAttachmentText("notes.md", "# Trip notes\n\n- Pack the adapter"),
      "“scan.pdf” is in this space's context as abc: read it with context_read.",
      formatSelectionText("Hotel", "https://hotel.example/", "Check-in from 15:00"),
    ].join("\n\n");
    expect(splitAttachedText(content)).toEqual({
      text: "What's left to pack in @notes.md ?\n\n“scan.pdf” is in this space's context as abc: read it with context_read.",
      attached: [
        { kind: "file", name: "notes.md", text: "# Trip notes\n\n- Pack the adapter" },
        { kind: "selection", name: "Hotel (https://hotel.example/)", text: "Check-in from 15:00" },
      ],
    });
    expect(splitAttachedText("Just words")).toEqual({ text: "Just words", attached: [] });
  });
});
