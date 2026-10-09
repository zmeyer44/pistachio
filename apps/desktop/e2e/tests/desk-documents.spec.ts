/**
 * Documents on the desk end to end (docs/desk-documents.md): files dragged
 * over the desk put up its drop targets (from a live page too); dropped on
 * the workspace, each joins the group's context and opens where it was let
 * go, in the viewer for its kind — text, markdown, a Word document, a
 * workbook, a CSV, a picture, a PDF — and an edit is saved back into the
 * file. A document put away goes into the Stack and comes out of it again;
 * one @mentioned in the Bar rides with the message; the agent arranges a
 * document window as it arranges a tab's; the desk keeps them when it
 * passes to another space and back. A document tiled and cascaded with the tabs, and
 * minimized as a tab's window is, are desk-documents.test's and
 * desk-minimize.spec's.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type JSHandle, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { docxFixture, xlsxFixture } from "../../../../packages/documents/test/fixtures";
import { api, box, createGroup, INVOICES, launchDesk, selectSpace, openTabs, reachBar, screenshots, selectTab, settled, snapshot, VENDOR, windowSelector } from "./desk-harness";

const capture = screenshots("desk-documents");

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/* ------------------------------- the files ------------------------------- */

interface FileSpec {
  name: string;
  type: string;
  base64: string;
}

function file(name: string, type: string, content: string | Uint8Array): FileSpec {
  return { name, type, base64: Buffer.from(typeof content === "string" ? Buffer.from(content, "utf8") : content).toString("base64") };
}

/** A one-page PDF, written out by hand: a title and a line of text in Helvetica. */
function pdfFixture(title: string, line: string): Buffer {
  const escape = (text: string): string => text.replace(/[\\()]/g, (char) => `\\${char}`);
  const content = `BT /F1 30 Tf 72 700 Td (${escape(title)}) Tj /F1 14 Tf 0 -40 Td (${escape(line)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const TRIP_DOCX = docxFixture(
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Lisbon trip</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">We land at </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>11:05</w:t></w:r><w:r><w:t xml:space="preserve"> on Friday, then take the metro to Baixa.</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>Pack the adapter</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>Print the boarding pass</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Check in online</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Book the tram tour</w:t></w:r></w:p>' +
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="5200"/></w:tblGrid>' +
    '<w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:fill="D9E2F3"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Day</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:shd w:val="clear" w:fill="D9E2F3"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Plan</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>Friday</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Alfama walk, fado at night</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>Saturday</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sintra by train</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:p><w:r><w:t xml:space="preserve">Hotel: </w:t></w:r><w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t>Casa do Rio</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve">, check-in after 15:00.</w:t></w:r></w:p>',
  { rels: '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/hotel" TargetMode="External"/>' },
);

const BUDGET_XLSX = xlsxFixture({
  strings: ["Item", "Cost", "Paid", "Flights", "Hotel", "Tram tour", "Total"],
  styles:
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;€&quot;#,##0.00"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2F5496"/></patternFill></fill></fills>' +
    '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="0" fontId="1" fillId="2"/><xf numFmtId="164" fontId="0" fillId="0"/><xf numFmtId="14" fontId="0" fillId="0"/></cellXfs>',
  sheets: [
    {
      name: "Budget",
      before: '<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="3" width="14" customWidth="1"/></cols>',
      rows:
        '<row r="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c><c r="C1" s="1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="2"><v>412.5</v></c><c r="C2" s="3"><v>45566</v></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" s="2"><v>1240</v></c><c r="C3" s="3"><v>45580</v></c></row>' +
        '<row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4" s="2"><v>38</v></c></row>' +
        '<row r="6"><c r="A6" s="1" t="s"><v>6</v></c><c r="B6" s="2"><f>SUM(B2:B4)</f><v>1690.5</v></c></row>',
    },
    { name: "Packing", rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>Adapter</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Sunscreen</t></is></c></row>' },
  ],
});

const FILES = {
  plan: file("plan.txt", "text/plain", "Lisbon plan\nFriday: Alfama walk\nSaturday: Sintra\n"),
  notes: file("notes.md", "text/markdown", "# Trip notes\n\n- Pack the adapter\n- Print the boarding pass\n"),
  trip: file("trip.docx", DOCX_TYPE, TRIP_DOCX),
  budget: file("budget.xlsx", XLSX_TYPE, BUDGET_XLSX),
  stops: file("stops.csv", "text/csv", "stop,time\nBaixa,10:00\nAlfama,12:30\n"),
  brochure: file("brochure.pdf", "application/pdf", pdfFixture("Lisbon walking tours", "Meet at Praca do Comercio, 10:00 every day.")),
};

/** A 64×40 PNG, orange: made into a HEIC by macOS for the spec. */
const PNG_64x40 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAPUlEQVR42u3PQQkAAAgEsItjRGMbwQw+hcEKLNP1WgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELhY9WqDiWm5MwQAAAABJRU5ErkJggg==";

/** Files as the drag carries them, built in the shell's page (a picture drawn there too). */
function transfer(shell: Page, specs: readonly FileSpec[], picture = false): Promise<JSHandle<DataTransfer>> {
  return shell.evaluateHandle(
    async ({ specs, picture }) => {
      const data = new DataTransfer();
      for (const spec of specs) data.items.add(new File([Uint8Array.from(atob(spec.base64), (char) => char.charCodeAt(0))], spec.name, { type: spec.type }));
      if (picture) {
        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 300;
        const context = canvas.getContext("2d")!;
        const gradient = context.createLinearGradient(0, 0, 480, 300);
        gradient.addColorStop(0, "#f59e0b");
        gradient.addColorStop(1, "#be185d");
        context.fillStyle = gradient;
        context.fillRect(0, 0, 480, 300);
        context.fillStyle = "#fff";
        context.font = "bold 44px sans-serif";
        context.fillText("Miradouro", 40, 170);
        const blob = await new Promise<Blob>((done) => canvas.toBlob((made) => done(made!), "image/png"));
        data.items.add(new File([blob], "view.png", { type: "image/png" }));
      }
      return data;
    },
    { specs, picture },
  );
}

/** Files dragged over the desk and let go on the workspace at a point: the drop zone comes up first, as for a person's drag. */
async function dropOnDesk(shell: Page, data: JSHandle<DataTransfer>, at: { x: number; y: number }): Promise<void> {
  await shell.dispatchEvent(".desk-stage", "dragenter", { dataTransfer: data, clientX: at.x, clientY: at.y });
  await expect(shell.locator('[data-testid="desk-drop-zone"][data-up]')).toHaveCount(1);
  for (const type of ["dragenter", "dragover", "drop"]) await shell.dispatchEvent('[data-testid="desk-drop-zone"]', type, { dataTransfer: data, clientX: at.x, clientY: at.y });
}

async function itemId(shell: Page, name: string): Promise<string> {
  let found: string | undefined;
  await expect
    .poll(async () => {
      const contexts = await api(shell, (pistachio) => pistachio.getGroupContexts());
      found = contexts.find((context) => context.groupId === "desk-docs")?.items.find((item) => item.kind === "file" && item.name === name)?.id;
      return found;
    })
    .toBeTruthy();
  return found!;
}

/**
 * The editor (a ProseMirror view: Tiptap hangs its editor on the view's
 * element) has taken a click's caret into the block reading `text`: it
 * adopts the DOM's selection a moment after the click, and keys struck
 * before then land where its caret was — the document's start.
 */
async function caretIn(shell: Page, editorSelector: string, text: string): Promise<void> {
  type WithEditor = HTMLElement & { editor?: { state: { selection: { $from: { parent: { textContent: string } } } } } };
  await expect.poll(() => shell.locator(editorSelector).first().evaluate((el) => (el as WithEditor).editor?.state.selection.$from.parent.textContent ?? null)).toBe(text);
}

/** A context file's text as it is saved now. */
function savedText(shell: Page, id: string): Promise<string> {
  return shell.evaluate(async (itemId) => {
    const content = await (window as unknown as { pistachio: PistachioApi }).pistachio.readGroupFile("desk-docs", itemId);
    return content === null ? "" : new TextDecoder().decode(content.bytes);
  }, id);
}

/** A context file as a message would carry it (a Word document's text, say). */
function readAsMessage(shell: Page, id: string): Promise<string> {
  return shell.evaluate(async (itemId) => {
    const reading = await (window as unknown as { pistachio: PistachioApi }).pistachio.groupFileForMessage("desk-docs", itemId);
    return reading.kind === "text" ? reading.text : reading.kind;
  }, id);
}

/** The agent's model: one turn that puts the mentioned notes beside the invoice, and says so. */
const SCRIPT = {
  steps: [
    {
      tools: [
        {
          name: "desk_arrange",
          input: {
            layout: null,
            place: [
              { tabId: "file:{{item:notes.md}}", zone: "left", box: null },
              { tabId: "{{tab:Northstar}}", zone: "right", box: null },
            ],
            bringOut: null,
            putAway: null,
          },
        },
      ],
    },
    { text: "Your trip notes are on the left, beside the invoice. Two things left to pack." },
  ],
};

test("documents on the desk: drop targets, a viewer for each kind, edits saved, the Stack, @mentions, the agent's hand", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(180_000);
  const { app, shell, userData } = await launchDesk({ name: "documents", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } });
  try {
    // Nothing the shell does here may throw.
    const pageErrors: string[] = [];
    shell.on("pageerror", (error) => pageErrors.push(`${error.message}\n${error.stack ?? ""}`));
    const [invoice, vendor] = (await openTabs(shell, [INVOICES, VENDOR])) as [string, string];
    await createGroup(shell, "desk-docs", [invoice, vendor], "Northstar", "blue");
    await selectTab(shell, invoice);
    await selectSpace(shell, "desk-docs");
    await expect(shell.locator('[data-testid="tab-group"] [role="tab"]')).toHaveCount(2);
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    await shell.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.4);
    const docs = shell.locator('[data-testid="desk-window"][data-window-kind="file"]');

    // ── 1. Files dragged over a live page: the page says so, the desk puts up its targets, and the page gives way ─
    const dragFile = join(userData, "dragged.txt");
    await writeFile(dragFile, "dragged over a page");
    const dragged = await app.evaluate(async ({ webContents }, { url, path }) => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      if (page === undefined) return "no page";
      try {
        page.debugger.attach("1.3");
      } catch {
        return "attached";
      }
      const data = { items: [], files: [path], dragOperationsMask: 1 };
      await page.debugger.sendCommand("Input.dispatchDragEvent", { type: "dragEnter", x: 200, y: 200, data });
      await page.debugger.sendCommand("Input.dispatchDragEvent", { type: "dragOver", x: 210, y: 210, data });
      await page.debugger.sendCommand("Input.dispatchDragEvent", { type: "dragCancel", x: 210, y: 210, data });
      page.debugger.detach();
      return "dragged";
    }, { url: INVOICES, path: dragFile });
    expect(dragged).toBe("dragged");
    await expect(shell.locator('[data-testid="desk-drop-zone"][data-up]')).toHaveCount(1);
    await expect(shell.locator(`${windowSelector(invoice)}[data-drawn]`)).toHaveCount(1);
    // Nothing comes: the targets go again.
    await expect(shell.locator('[data-testid="desk-drop-zone"][data-up]')).toHaveCount(0, { timeout: 5_000 });

    // ── 2. Over the shell's desk: the workspace, the Bar and the Stack are each a target ─
    const plan = await transfer(shell, [FILES.plan]);
    await shell.dispatchEvent(".desk-stage", "dragenter", { dataTransfer: plan });
    const hold = setInterval(() => void shell.dispatchEvent(".desk-stage", "dragover", { dataTransfer: plan }).catch(() => undefined), 150);
    try {
      await expect(shell.locator('[data-testid="desk-drop-zone"][data-shown]')).toHaveCount(1);
      await expect(shell.locator('[data-testid="desk-bar"][data-drop-target]')).toHaveCount(1);
      await expect(shell.getByTestId("desk-bar-input")).toHaveAttribute("placeholder", "Drop here to attach to your message");
      await expect(shell.locator('[data-testid="desk-stack"][data-drop-target]')).toHaveCount(1);
      await shell.dispatchEvent('[data-testid="desk-drop-zone"]', "dragenter", { dataTransfer: plan });
      await expect(shell.locator('[data-testid="desk-drop-zone"][data-inside]')).toHaveCount(1);
      await capture(app, shell, "01-drop-targets.png");
    } finally {
      clearInterval(hold);
    }

    // ── 3. Let go on the workspace: the file joins the Stack and opens where it was dropped, in its viewer ─
    const planAt = { x: stage.x + stage.width * 0.35, y: stage.y + stage.height * 0.45 };
    for (const type of ["dragover", "drop"]) await shell.dispatchEvent('[data-testid="desk-drop-zone"]', type, { dataTransfer: plan, clientX: planAt.x, clientY: planAt.y });
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "1");
    await expect(docs).toHaveCount(1);
    const planId = await itemId(shell, "plan.txt");
    const planWindow = windowSelector(`file:${planId}`);
    await settled(shell, app);
    const planBox = await box(shell, planWindow);
    expect(Math.abs(planBox.x + planBox.width / 2 - planAt.x)).toBeLessThan(40);
    await expect(shell.locator(`${planWindow} [data-testid="desk-window-title"]`)).toContainText("plan.txt");
    await expect(shell.locator(`${planWindow} [data-testid="desk-text-viewer"]`)).toHaveValue(/Friday: Alfama walk/);
    // In use: the window is focused, the tab in use is still the invoice (a document is no tab).
    await expect(shell.locator(`${planWindow}[data-focused]`)).toHaveCount(1);
    expect((await snapshot(shell)).activeTabId).toBe(invoice);

    // ── 4. Edited in place, and saved into the file ─
    const planText = shell.locator(`${planWindow} [data-testid="desk-text-viewer"]`);
    await planText.click();
    await shell.keyboard.press("Meta+ArrowDown");
    await shell.keyboard.type("Sunday: tram 28 to Graça\n");
    await expect(shell.locator(`${planWindow} [data-testid="desk-window-detail"]`)).toHaveText("Saved");
    expect(await savedText(shell, planId)).toBe("Lisbon plan\nFriday: Alfama walk\nSaturday: Sintra\nSunday: tram 28 to Graça\n");
    await capture(app, shell, "02-text-edited.png");

    // ── 5. Collapsed, it goes into the Stack; from the Stack it comes back, as it was left ─
    await shell.locator(`${planWindow} [data-testid="desk-collapse"]`).click();
    await settled(shell, app);
    await expect(docs).toHaveCount(0);
    await shell.getByTestId("desk-stack").click();
    await expect(shell.locator('[data-testid="desk-stack-card"][data-shown]')).toHaveCount(1);
    const planTile = shell.locator('[data-testid="desk-stack-file"]', { hasText: "plan.txt" });
    await expect(planTile).not.toHaveAttribute("data-open", "");
    await capture(app, shell, "03-in-the-stack.png");
    await planTile.locator("button").first().click();
    await expect(shell.getByTestId("desk-stack-card")).toHaveCount(0);
    await settled(shell, app);
    await expect(shell.locator(`${planWindow} [data-testid="desk-text-viewer"]`)).toHaveValue(/Sunday: tram 28 to Graça/);

    // ── 6. A markdown file: shown as the document it describes, edited as a note is, its source a click away ─
    await dropOnDesk(shell, await transfer(shell, [FILES.notes]), { x: stage.x + stage.width * 0.62, y: stage.y + stage.height * 0.45 });
    const notesId = await itemId(shell, "notes.md");
    const notesWindow = windowSelector(`file:${notesId}`);
    await settled(shell, app);
    await expect(shell.locator(`${notesWindow} [data-testid="desk-markdown-viewer"] h1`)).toHaveText("Trip notes");
    await shell.locator(`${notesWindow} [data-testid="desk-markdown-viewer"] li`).last().click();
    await caretIn(shell, `${notesWindow} [data-testid="desk-markdown-viewer"]`, "Print the boarding pass");
    await shell.keyboard.press("End");
    await shell.keyboard.press("Enter");
    await shell.keyboard.type("Book the tram tour");
    await expect(shell.locator(`${notesWindow} [data-testid="desk-window-detail"]`)).toHaveText("Saved");
    expect(await savedText(shell, notesId)).toContain("- Book the tram tour");
    await capture(app, shell, "04-markdown.png");
    await shell.locator(`${notesWindow} [data-testid="desk-markdown-source"]`).click();
    await expect(shell.locator(`${notesWindow} [data-testid="desk-markdown-source-text"]`)).toHaveValue(/- Book the tram tour/);
    await shell.locator(`${notesWindow} [data-testid="desk-markdown-rich"]`).click();

    // ── 7. A Word document: its page, its styles, lists and table; its text edited and written back in place ─
    await dropOnDesk(shell, await transfer(shell, [FILES.trip]), { x: stage.x + stage.width * 0.45, y: stage.y + stage.height * 0.5 });
    const tripId = await itemId(shell, "trip.docx");
    const tripWindow = windowSelector(`file:${tripId}`);
    await settled(shell, app);
    const tripPage = shell.locator(`${tripWindow} [data-testid="desk-document-viewer"]`);
    await expect(tripPage.locator("h1")).toHaveText("Lisbon trip");
    await expect(tripPage.locator(".docx-marker")).toHaveText(["•", "•", "1.", "2."]);
    await expect(tripPage.locator("td")).toHaveCount(6);
    await expect(shell.locator(`${tripWindow} [data-testid="desk-window-detail"]`)).toHaveText("Word document");
    await tripPage.locator("h1").click();
    await caretIn(shell, `${tripWindow} [data-testid="desk-document-viewer"]`, "Lisbon trip");
    await shell.keyboard.press("End");
    await shell.keyboard.type(" (final)");
    await expect(shell.locator(`${tripWindow} [data-testid="desk-window-detail"]`)).toHaveText("Saved");
    const tripText = await readAsMessage(shell, tripId);
    expect(tripText).toContain("# Lisbon trip (final)");
    expect(tripText).toContain("We land at 11:05 on Friday, then take the metro to Baixa.");
    expect(tripText).toContain("| Friday | Alfama walk, fado at night |");
    await capture(app, shell, "05-word-document.png");

    // ── 8. A workbook: its cells as Excel shows them, its sheets as tabs ─
    await dropOnDesk(shell, await transfer(shell, [FILES.budget]), { x: stage.x + stage.width * 0.55, y: stage.y + stage.height * 0.4 });
    const budgetId = await itemId(shell, "budget.xlsx");
    const budgetWindow = windowSelector(`file:${budgetId}`);
    await settled(shell, app);
    const grid = shell.locator(`${budgetWindow} [data-testid="desk-sheet-grid"]`);
    await expect(grid.locator('.desk-sheet-cell[data-row="2"][data-col="1"]')).toHaveText("€1,240.00");
    await expect(grid.locator('.desk-sheet-cell[data-row="1"][data-col="2"]')).toHaveText("10/1/2024");
    await expect(grid.locator('.desk-sheet-cell[data-row="5"][data-col="1"]')).toHaveText("€1,690.50");
    await expect(shell.locator(`${budgetWindow} [data-testid="desk-sheet-tab"]`)).toHaveText(["Budget", "Packing"]);
    await capture(app, shell, "06-workbook.png");
    await shell.locator(`${budgetWindow} [data-testid="desk-sheet-tab"]`, { hasText: "Packing" }).click();
    await expect(shell.locator(`${budgetWindow} [data-testid="desk-sheet-grid"] .desk-sheet-cell[data-row="1"][data-col="0"]`)).toHaveText("Sunscreen");

    // ── 9. A CSV: a cell edited in place, the rest of the file as it was ─
    await dropOnDesk(shell, await transfer(shell, [FILES.stops]), { x: stage.x + stage.width * 0.4, y: stage.y + stage.height * 0.55 });
    const stopsId = await itemId(shell, "stops.csv");
    const stopsWindow = windowSelector(`file:${stopsId}`);
    await settled(shell, app);
    await shell.locator(`${stopsWindow} .desk-sheet-cell[data-row="2"][data-col="1"]`).dblclick();
    await shell.locator(`${stopsWindow} [data-testid="desk-sheet-editor"]`).fill("13:00");
    await shell.keyboard.press("Enter");
    await expect(shell.locator(`${stopsWindow} [data-testid="desk-window-detail"]`)).toHaveText("Saved");
    expect(await savedText(shell, stopsId)).toBe("stop,time\nBaixa,10:00\nAlfama,13:00\n");
    // Escape gives an edit up: nothing is written.
    await shell.locator(`${stopsWindow} .desk-sheet-cell[data-row="1"][data-col="0"]`).dblclick();
    await shell.locator(`${stopsWindow} [data-testid="desk-sheet-editor"]`).fill("Rossio");
    await shell.keyboard.press("Escape");
    await expect(shell.locator(`${stopsWindow} [data-testid="desk-sheet-editor"]`)).toHaveCount(0);
    await expect(shell.locator(`${stopsWindow} .desk-sheet-cell[data-row="1"][data-col="0"]`)).toHaveText("Baixa");
    // (Past the save an edit would have waited for: document-session's SAVE_AFTER_MS, 700ms.)
    await shell.waitForTimeout(1_200);
    await expect(shell.locator(`${stopsWindow} [data-testid="desk-window-detail"]`)).toHaveText("Saved");
    expect(await savedText(shell, stopsId)).toBe("stop,time\nBaixa,10:00\nAlfama,13:00\n");

    // ── 10. A picture and a PDF, each fitted to its window ─
    await dropOnDesk(shell, await transfer(shell, [], true), { x: stage.x + stage.width * 0.7, y: stage.y + stage.height * 0.35 });
    const viewId = await itemId(shell, "view.png");
    await settled(shell, app);
    await expect(shell.locator(`${windowSelector(`file:${viewId}`)} [data-testid="desk-window-detail"]`)).toHaveText("480 × 300");
    await dropOnDesk(shell, await transfer(shell, [FILES.brochure]), { x: stage.x + stage.width * 0.5, y: stage.y + stage.height * 0.5 });
    const brochureId = await itemId(shell, "brochure.pdf");
    const brochureWindow = windowSelector(`file:${brochureId}`);
    await settled(shell, app);
    await expect(shell.locator(`${brochureWindow} [data-testid="desk-pdf-page-box"][data-drawn]`)).toHaveCount(1, { timeout: 15_000 });
    await expect(shell.locator(`${brochureWindow} [data-testid="desk-window-detail"]`)).toHaveText("1 page");
    await expect(shell.locator(`${brochureWindow} .textLayer`)).toContainText("Lisbon walking tours");
    await capture(app, shell, "07-pdf.png");
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "7");

    // ── 10b. What only macOS reads: a Word 97–2004 document (shown and edited as a .docx, kept a .doc) and a HEIC photo ─
    const made = await mkdtemp(join(tmpdir(), "pistachio-desk-legacy-"));
    await writeFile(join(made, "memo.html"), "<html><body><h1>Memo</h1><p>Budget review on Monday.</p></body></html>");
    execFileSync("/usr/bin/textutil", ["-convert", "doc", "-output", join(made, "memo.doc"), join(made, "memo.html")]);
    await writeFile(join(made, "dot.png"), Buffer.from(PNG_64x40, "base64"));
    execFileSync("/usr/bin/sips", ["-s", "format", "heic", join(made, "dot.png"), "--out", join(made, "sunset.heic")], { stdio: "ignore" });
    const legacy = [file("memo.doc", "application/msword", readFileSync(join(made, "memo.doc"))), file("sunset.heic", "image/heic", readFileSync(join(made, "sunset.heic")))];
    await dropOnDesk(shell, await transfer(shell, legacy), { x: stage.x + stage.width * 0.5, y: stage.y + stage.height * 0.45 });
    const memoId = await itemId(shell, "memo.doc");
    const memoWindow = windowSelector(`file:${memoId}`);
    const sunsetId = await itemId(shell, "sunset.heic");
    await settled(shell, app);
    await expect(shell.locator(`${memoWindow} [data-testid="desk-document-viewer"]`)).toContainText("Budget review on Monday.", { timeout: 15_000 });
    await expect(shell.locator(`${windowSelector(`file:${sunsetId}`)} [data-testid="desk-window-detail"]`)).toHaveText("64 × 40", { timeout: 15_000 });
    // (The photo, dropped with it, came out over it: its title bar brings it to the top.)
    await shell.locator(`${memoWindow} [data-testid="desk-window-title"]`).click();
    await shell.locator(`${memoWindow} [data-testid="desk-document-viewer"] p`, { hasText: "Budget review" }).click();
    await caretIn(shell, `${memoWindow} [data-testid="desk-document-viewer"]`, "Budget review on Monday.");
    await shell.keyboard.press("End");
    await shell.keyboard.type(" Bring the receipts.");
    await expect(shell.locator(`${memoWindow} [data-testid="desk-window-detail"]`)).toHaveText("Saved", { timeout: 15_000 });
    // Kept a .doc, its text what the edit made it.
    const memo = (await api(shell, (pistachio) => pistachio.getGroupContexts())).find((context) => context.groupId === "desk-docs")?.items.find((item) => item.id === memoId);
    expect(memo?.kind === "file" ? memo.mediaType : null).toBe("application/msword");
    expect(await readAsMessage(shell, memoId)).toContain("Budget review on Monday. Bring the receipts.");
    await capture(app, shell, "07b-doc-and-heic.png");

    // ── 12. @ in the Bar offers the context's files; the mention rides with the message; the agent arranges the document ─
    const input = shell.getByTestId("desk-bar-input");
    await reachBar(shell);
    await input.click();
    await input.pressSequentially("What's left to pack in @no");
    await expect(shell.locator('[data-testid="desk-mentions"][data-shown]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-mention").first()).toContainText("notes.md");
    await capture(app, shell, "09-mention-menu.png");
    await input.press("Enter");
    await expect(input).toHaveValue("What's left to pack in @notes.md ");
    await expect(shell.locator(".desk-bar-mention")).toHaveText("@notes.md");
    // Accepted, the mention is no longer being typed: the list goes, and Enter sends.
    await expect(shell.locator('[data-testid="desk-mentions"]')).toHaveCount(0);
    await capture(app, shell, "10-mention.png");
    await input.press("Enter");
    await expect(shell.getByTestId("desk-answer")).toContainText("Two things left to pack", { timeout: 15_000 });
    const asked = (await snapshot(shell)).run!.messages.find((message) => message.role === "user")!;
    expect(asked.content).toContain("What's left to pack in @notes.md\n\nAttached file");
    expect(asked.content).toContain("Attached file “notes.md”");
    expect(asked.content).toContain("- Book the tram tour");
    await settled(shell, app);
    const notesBox = await box(shell, notesWindow);
    const invoiceBox = await box(shell, windowSelector(invoice));
    expect(notesBox.x + notesBox.width).toBeLessThan(invoiceBox.x);
    await capture(app, shell, "11-agent-arranged.png");
    const tools = (await snapshot(shell)).run!.toolCalls.map((call) => call.name);
    expect(tools).toEqual(["desk.arrange"]);

    // ── 13. Passed to another space and back, the desk keeps its documents where they were ─
    const before = await box(shell, notesWindow);
    const [elsewhere] = (await openTabs(shell, ["pistachio://demo/auth/relying-party"])) as [string];
    await selectTab(shell, elsewhere);
    await expect(shell.locator('.desk-stage[data-phase="open"]:not([data-group-id="desk-docs"])')).toHaveCount(1);
    await expect(shell.locator(notesWindow)).toHaveCount(0);
    await selectSpace(shell, "desk-docs");
    await settled(shell, app);
    await expect(shell.locator(notesWindow)).toHaveCount(1);
    const after = await box(shell, notesWindow);
    expect(Math.abs(after.x - before.x)).toBeLessThan(4);
    expect(Math.abs(after.width - before.width)).toBeLessThan(4);
    await expect(shell.locator(`${notesWindow} [data-testid="desk-markdown-viewer"]`)).toContainText("Book the tram tour");
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-docs")?.tabIds).toEqual([invoice, vendor]);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
