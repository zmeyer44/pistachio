/**
 * A streaming Server-Sent Events parser for control's run event stream
 * (docs/cloud-sync-design.md §7.8 `GET /runs/:id/events`), shared by the desktop main process and the web app: fed chunks of
 * decoded text as they arrive, answers the frames that are complete.
 *
 * Pure, so the tests pin the framing rules without a socket: `id:` /
 * `event:` / `data:` fields, multi-line data joined with newlines, `: ping`
 * comments dropped, CRLF tolerated, and frames split across chunks at any
 * byte. Neither client uses EventSource (auth headers); both read the fetch body through this.
 */

export interface SseFrame {
  /** The frame's `id:` field, when it carried one. */
  id: string | null;
  /** The frame's `event:` field; null for the default event type. */
  event: string | null;
  /** Every `data:` line, joined with `\n`. */
  data: string;
}

export class SseParser {
  #buffer = "";
  #id: string | null = null;
  #event: string | null = null;
  #data: string[] = [];

  /** Feed the next chunk; answers the frames it completed, in order. */
  push(chunk: string): SseFrame[] {
    this.#buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) break;
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const frame = this.#line(line);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  #line(line: string): SseFrame | null {
    if (line === "") return this.#dispatch();
    if (line.startsWith(":")) return null; // a comment (`: ping`)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.#event = value;
        break;
      case "data":
        this.#data.push(value);
        break;
      case "id":
        if (!value.includes("\u0000")) this.#id = value;
        break;
      default:
        // `retry` and unknown fields are ignored.
        break;
    }
    return null;
  }

  #dispatch(): SseFrame | null {
    const data = this.#data;
    const frame: SseFrame | null =
      data.length === 0 ? null : { id: this.#id, event: this.#event, data: data.join("\n") };
    this.#id = null;
    this.#event = null;
    this.#data = [];
    return frame;
  }
}
