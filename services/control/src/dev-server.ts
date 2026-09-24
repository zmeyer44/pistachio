/**
 * Local-dev entry (`pnpm dev`, docs/cloud-sync-design.md §7.7). Fills in
 * defaults a developer has no local copy of, then boots the real server.
 * The defaults live here, not in `server.ts`, on purpose: a production boot
 * runs `server.ts`, where a missing signing key or mailer still fails closed.
 *
 * `??=` throughout: a value already in the environment always wins. The
 * precedence is shell > monorepo-root `.env` > the defaults below.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The monorepo root `.env`, when there is one. The shell still wins:
// `process.loadEnvFile` does not overwrite a variable that is already set,
// and the `??=` defaults below only fill what neither supplied.
const rootEnv = path.resolve(fileURLToPath(import.meta.url), "../../../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

import { DEV_ALLOWED_ORIGINS } from "./app.js";
import { generateSigningKeyEnv } from "./keys-provider.js";

if (!process.env["CONTROL_TOKEN_SK"] || !process.env["CONTROL_TOKEN_PK"]) {
  const pair = await generateSigningKeyEnv();
  process.env["CONTROL_TOKEN_SK"] = pair.sk;
  process.env["CONTROL_TOKEN_PK"] = pair.pk;
  console.warn(
    "\n" +
      "==================================================================\n" +
      " WARNING: CONTROL_TOKEN_SK/PK unset — using an EPHEMERAL signing\n" +
      " keypair. Every device token dies when this process exits, and no\n" +
      " other control instance can verify them. Local development only.\n" +
      "==================================================================\n",
  );
}

/**
 * A dev boot must never run DDL against someone's remote database. The root
 * `.env` is shared with other tooling, so a Postgres URL found there is far
 * more likely to belong to another project than to be an intentional target
 * for control's schema. Fall back to the embedded database and say so;
 * `CONTROL_DEV_ALLOW_REMOTE_DB=1` opts in deliberately.
 */
function remoteDatabase(url: string): boolean {
  if (url === "" || url.startsWith("pglite")) return false;
  try {
    const host = new URL(url).hostname;
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return false;
  }
}

if (remoteDatabase(process.env["DATABASE_URL"] ?? "") && process.env["CONTROL_DEV_ALLOW_REMOTE_DB"] !== "1") {
  const host = new URL(process.env["DATABASE_URL"] ?? "").hostname;
  console.warn(
    "\n" +
      "==================================================================\n" +
      ` NOTE: DATABASE_URL names a remote host (${host}).\n` +
      " A dev boot creates tables, so it is using the embedded database\n" +
      " instead. Set CONTROL_DEV_ALLOW_REMOTE_DB=1 to use the remote one.\n" +
      "==================================================================\n",
  );
  delete process.env["DATABASE_URL"];
}

if (!process.env["AI_GATEWAY_API_KEY"]) {
  console.warn("AI_GATEWAY_API_KEY unset: the desktop's model calls (/v1/ai/*) will answer 503");
}
process.env["MAILER"] ??= "log";
process.env["DATABASE_URL"] ??= "pglite:./.pglite";
process.env["EGRESS_STATIC_HOST"] ??= "127.0.0.1";
process.env["EGRESS_STATIC_PORT"] ??= "8443";
// The two web apps (docs/web-browser-design.md §15): `www` on 3000, the
// browser app on 3001. Both are browser origins that call control with a
// device token, so both go on the CORS allowlist.
process.env["PISTACHIO_WEB_URL"] ??= "http://localhost:3000";
process.env["PISTACHIO_BROWSER_URL"] ??= "http://localhost:3001";
process.env["CONTROL_ALLOWED_ORIGINS"] ??= DEV_ALLOWED_ORIGINS;
process.env["PORT"] ??= "8787";

await import("./server.js");
