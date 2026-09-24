import { redirect } from "next/navigation";

import { downloadUrl } from "../../../lib/release";

/** Stable link for docs and emails: always points at the current DMG. */
export function GET() {
  redirect(downloadUrl);
}
