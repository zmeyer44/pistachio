import { ARTIFACT_DOCUMENT_CSP, CONTROL_URL } from "@pistachio/web-account";
// One owner for where control lives: a proxy route pointing at a different
// host than the client would serve artifacts from another deployment.
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
    upstream = await fetch(`${CONTROL_URL}/v1/public/artifacts/${shareId}`, { cache: "no-store" });
  } catch {
    return new Response("Artifact temporarily unavailable", { status: 503, headers: SECURITY_HEADERS });
  }
  if (!upstream.ok) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  return new Response(await upstream.text(), {
    status: 200,
    headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}
