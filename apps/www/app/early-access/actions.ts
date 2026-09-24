"use server";

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redirect } from "next/navigation";

/**
 * Early-access signups, posted by the hero form, the bottom-of-page form,
 * and the /early-access page itself.
 *
 * Each signup is one JSON file under SIGNUPS_DIR (default: apps/www/.data/
 * early-access, gitignored), named by a hash of the address so signing up
 * twice overwrites rather than duplicates. Local files are for local
 * development. Deployed, point this at a real store — this action is the
 * only place that knows where signups go.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signupDirectory(): string {
  const configured = process.env["SIGNUPS_DIR"]?.trim() ?? "";
  return configured === ""
    ? join(process.cwd(), ".data", "early-access")
    : configured;
}

export async function joinEarlyAccess(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const firstName = String(formData.get("firstName") ?? "")
    .trim()
    .slice(0, 200);
  const lastName = String(formData.get("lastName") ?? "")
    .trim()
    .slice(0, 200);

  if (email.length > 254 || !EMAIL_RE.test(email)) {
    redirect("/early-access?error=email");
  }

  const receivedAt = new Date().toISOString();
  const directory = signupDirectory();
  await mkdir(directory, { recursive: true });
  const id = createHash("sha256").update(email).digest("hex").slice(0, 16);
  const file = join(directory, `${id}.json`);
  await writeFile(
    file,
    JSON.stringify({ receivedAt, email, firstName, lastName }, null, 2),
  );

  console.log(`[early-access] ${email} → ${file}`);
  redirect("/early-access?joined=1");
}
