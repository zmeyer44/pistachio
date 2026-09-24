/**
 * POST /api/feedback — where the desktop console's feedback popover lands.
 *
 * Each report is one JSON file under FEEDBACK_DIR (default: apps/www/.data/
 * feedback, gitignored), named by arrival time and the client's id, so a
 * folder of them reads in order and a retried send overwrites rather than
 * duplicates. The run inside is stored whole: it is the conversation, tool
 * calls and all, and is what makes a report debuggable later.
 *
 * Local files are for local development. Deployed, point this at a real
 * store — the handler is the only place that knows where reports go.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isFeedbackReport } from "@pistachio/protocol";

export const runtime = "nodejs";

/** A report is mostly the run summary; a megabyte or two covers a long one. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function feedbackDirectory(): string {
  const configured = process.env["FEEDBACK_DIR"]?.trim() ?? "";
  return configured === "" ? join(process.cwd(), ".data", "feedback") : configured;
}

export async function POST(request: Request): Promise<Response> {
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    return Response.json({ error: "Feedback report is too large." }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Feedback must be JSON." }, { status: 400 });
  }
  if (!isFeedbackReport(body)) {
    return Response.json({ error: "Not a feedback report." }, { status: 400 });
  }

  const receivedAt = new Date().toISOString();
  const directory = feedbackDirectory();
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${receivedAt.replace(/[:.]/g, "-")}-${body.id}.json`);
  await writeFile(file, JSON.stringify({ receivedAt, ...body }, null, 2));

  const preview = body.message.length > 80 ? `${body.message.slice(0, 79)}…` : body.message;
  console.log(`[feedback] ${body.reaction ?? "no reaction"} · ${preview} → ${file}`);
  return Response.json({ id: body.id, receivedAt }, { status: 201 });
}
