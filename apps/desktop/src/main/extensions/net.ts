/**
 * `net.fetch`'s answer, bounded: the body read as it comes and refused past
 * `limit` bytes — a Content-Length is a claim (absent, or short of a
 * compressed body's decoded size), and a body read whole first would sit in
 * main's memory past any limit before it was measured.
 */

/** The body whole, or null once it ran past `limit` (the stream cancelled then). */
export async function readBodyAtMost(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return whole;
}
