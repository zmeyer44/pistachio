import { ARTIFACT_DOCUMENT_CSP, CONTROL_URL } from "@pistachio/web-account";
// A published note is served exactly as a published artifact is: the same
// proxy, the same sandbox policy, the same refusal to accept a device token
// or a key. Only the upstream path differs (docs/notes.md §8).
const SHARE_ID_RE = /^[A-Za-z0-9_-]{24}$/u;

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": ARTIFACT_DOCUMENT_CSP,
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ shareId: string }> },
): Promise<Response> {
  const { shareId } = await context.params;
  if (!SHARE_ID_RE.test(shareId)) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  let upstream: Response;
  try {
    upstream = await fetch(`${CONTROL_URL}/v1/public/notes/${shareId}`, { cache: "no-store" });
  } catch {
    return new Response("Note temporarily unavailable", { status: 503, headers: SECURITY_HEADERS });
  }
  if (!upstream.ok) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  return new Response(await upstream.text(), {
    status: 200,
    headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}
