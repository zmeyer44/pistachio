/**
 * A preview stream of the panel's — the mic meter's, the camera's — one at a
 * time: opening again stops what was open, and a stream that arrives after a
 * stop (the panel closed while getUserMedia waited, a mic chosen twice) is
 * stopped as it arrives, never kept: the Mac's mic and camera light never
 * outlives the panel.
 */
export class PreviewSlot<T extends { getTracks(): { stop(): void }[] }> {
  #generation = 0;
  #stream: T | null = null;

  get stream(): T | null {
    return this.#stream;
  }

  /** Open through `start`; the stream, or null when it was not wanted by the time it came (`wanted` false, or a stop meanwhile). */
  async open(start: () => Promise<T>, wanted: () => boolean): Promise<T | null> {
    this.stop();
    const generation = this.#generation;
    let stream: T;
    try {
      stream = await start();
    } catch {
      return null;
    }
    if (generation !== this.#generation || !wanted()) {
      for (const track of stream.getTracks()) track.stop();
      return null;
    }
    this.#stream = stream;
    return stream;
  }

  stop(): void {
    this.#generation += 1;
    const stream = this.#stream;
    this.#stream = null;
    if (stream !== null) for (const track of stream.getTracks()) track.stop();
  }
}
