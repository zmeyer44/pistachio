import type { SpeechModel } from "ai";
import { describe, expect, it } from "vitest";
import {
  READ_ALOUD_CHUNK_CHARS,
  READ_ALOUD_FIRST_CHUNK_CHARS,
  ReadAloudService,
  audioDurationSeconds,
  modelSynthesizer,
  prepareReadAloudText,
  joinSpeechAudio,
  parseByteRange,
  readAloudPageHtml,
  splitForSpeech,
  splitForSpeechSpans,
  type ReadAloudClip,
  type SpeechSynthesizer,
} from "../src/main/read-aloud";

const request = {
  text: "Hello <world> & \"friends\"",
  sourceTitle: "Example <Page>",
  sourceUrl: "https://example.com/article",
  faviconUrl: "https://example.com/favicon.ico",
};

function synthesizer(result: { audio: Uint8Array; mediaType: string } | Error): SpeechSynthesizer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async synthesize(text) {
      calls.push(text);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe("prepareReadAloudText", () => {
  it("collapses runs of spaces but keeps a paragraph as its own line", () => {
    // A newline survives as the splitter's best seam, and as a spoken pause.
    expect(prepareReadAloudText("  one\n\n two\tthree  ")).toBe("one\ntwo three");
    expect(prepareReadAloudText("one   two")).toBe("one two");
  });

  it("preserves long selections unless a limit is explicitly requested", () => {
    const selection = "This is a sentence. ".repeat(4_000) + "The final selected sentence.";
    expect(prepareReadAloudText(selection) === selection).toBe(true);
  });

  it("honors an explicit limit at a sentence boundary", () => {
    const sentence = "This is a sentence. ";
    const text = prepareReadAloudText(sentence.repeat(1_000), 500);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith(".")).toBe(true);
  });
});

describe("modelSynthesizer", () => {
  it("is unavailable without a configured speech model, and offline under E2E", () => {
    const model = { specificationVersion: "v4" } as unknown as SpeechModel;
    expect(modelSynthesizer({}, () => null)).toBeNull();
    expect(modelSynthesizer({}, () => model)).not.toBeNull();
    expect(modelSynthesizer({ PISTACHIO_E2E: "1" }, () => model)).toBeNull();
  });
});

describe("ReadAloudService", () => {
  it("prefers the speech model and serves the clip over pistachio://read-aloud", async () => {
    const model = synthesizer({ audio: new Uint8Array([1, 2, 3]), mediaType: "audio/mpeg" });
    const device = synthesizer(new Error("unused"));
    const service = new ReadAloudService({ model: () => model, device });
    const { id, url, engine } = await service.speak(request);
    expect(engine).toBe("model");
    expect(url).toBe(`pistachio://read-aloud/${id}`);
    expect(model.calls).toEqual(['Hello <world> & "friends"']);
    expect(device.calls).toEqual([]);

    const audio = await service.respond(new URL(`${url}/audio`));
    expect(audio?.status).toBe(200);
    expect(audio?.headers.get("content-type")).toBe("audio/mpeg");
    // A known length and range support keep the player off its "live stream" path.
    expect(audio?.headers.get("content-length")).toBe("3");
    expect(audio?.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await audio!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const page = await service.respond(new URL(url));
    expect(page?.status).toBe(200);
    const html = await page!.text();
    // The page streams the pieces itself; the whole-clip address is its fallback.
    expect(html).toContain(`"base":"${url}"`);
    expect(html).toContain('data-media-type="audio/mpeg"');
    expect(html).toContain("Example &lt;Page&gt;");
    expect(html).not.toContain("<Page>");
  });

  it("serves byte ranges of the clip", async () => {
    const service = new ReadAloudService({
      model: () => synthesizer({ audio: new Uint8Array([1, 2, 3, 4, 5]), mediaType: "audio/mpeg" }),
      device: synthesizer(new Error("unused")),
    });
    const { url } = await service.speak(request);
    const audioUrl = new URL(`${url}/audio`);

    const part = await service.respond(audioUrl, new Headers({ range: "bytes=1-3" }));
    expect(part?.status).toBe(206);
    expect(part?.headers.get("content-range")).toBe("bytes 1-3/5");
    expect(part?.headers.get("content-length")).toBe("3");
    expect(new Uint8Array(await part!.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4]));

    // The open-ended probe Chromium opens playback with.
    const rest = await service.respond(audioUrl, new Headers({ range: "bytes=0-" }));
    expect(rest?.status).toBe(206);
    expect(rest?.headers.get("content-range")).toBe("bytes 0-4/5");

    const suffix = await service.respond(audioUrl, new Headers({ range: "bytes=-2" }));
    expect(new Uint8Array(await suffix!.arrayBuffer())).toEqual(new Uint8Array([4, 5]));

    const beyond = await service.respond(audioUrl, new Headers({ range: "bytes=9-" }));
    expect(beyond?.status).toBe(416);
    expect(beyond?.headers.get("content-range")).toBe("bytes */5");
  });

  it("falls back to the device voice when the model fails or is missing", async () => {
    const device = synthesizer({ audio: new Uint8Array([9]), mediaType: "audio/wav" });
    const failing = new ReadAloudService({ model: () => synthesizer(new Error("quota")), device });
    expect((await failing.speak(request)).engine).toBe("device");
    const absent = new ReadAloudService({ model: () => null, device });
    expect((await absent.speak(request)).engine).toBe("device");
    expect(device.calls).toHaveLength(2);
  });

  it("rejects empty selections and unknown clips", async () => {
    const service = new ReadAloudService({ model: () => null, device: synthesizer(new Error("unused")) });
    await expect(service.speak({ ...request, text: "  \n " })).rejects.toThrow("Nothing to read aloud.");
    expect(service.respond(new URL("pistachio://demo/invoices"))).toBeNull();
    expect((await service.respond(new URL("pistachio://read-aloud/not-a-clip")))?.status).toBe(404);
  });

  it("escapes page-owned strings in the player page", () => {
    const html = readAloudPageHtml({
      id: "00000000-0000-4000-8000-000000000000",
      mediaType: "audio/wav",
      engine: "device",
      request: { ...request, faviconUrl: 'https://example.com/"><script>alert(1)</script>' },
      pieces: [],
      done: true,
      error: null,
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("ReadAloudService cancellation", () => {
  it("does not fall back to the device voice once the job is aborted", async () => {
    const device = synthesizer({ audio: new Uint8Array([9]), mediaType: "audio/wav" });
    const abort = new AbortController();
    const model: SpeechSynthesizer = {
      async synthesize(_text, signal) {
        abort.abort(new Error("Read aloud cancelled."));
        throw signal.reason;
      },
    };
    const service = new ReadAloudService({ model: () => model, device });
    await expect(service.speak(request, abort.signal)).rejects.toThrow("Read aloud cancelled.");
    expect(device.calls).toEqual([]);
  });
});

describe("parseByteRange", () => {
  it("reads the forms a media element sends", () => {
    expect(parseByteRange(null, 10)).toBeNull();
    expect(parseByteRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
    expect(parseByteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    // An end past the clip is clamped, not refused.
    expect(parseByteRange("bytes=8-99", 10)).toEqual({ start: 8, end: 9 });
  });

  it("refuses ranges it cannot satisfy", () => {
    expect(parseByteRange("bytes=10-", 10)).toBe("invalid");
    expect(parseByteRange("bytes=5-2", 10)).toBe("invalid");
    expect(parseByteRange("bytes=-", 10)).toBe("invalid");
    expect(parseByteRange("bytes=0-1, 4-5", 10)).toBe("invalid");
    expect(parseByteRange("seconds=0-1", 10)).toBe("invalid");
  });
});

describe("splitForSpeech", () => {
  it("returns one piece when the text already fits", () => {
    expect(splitForSpeech("Short enough.", 100)).toEqual(["Short enough."]);
    expect(splitForSpeech("   ", 100)).toEqual([]);
  });

  it("prefers a paragraph break, then a sentence end, then a word gap", () => {
    const paragraphs = splitForSpeech("aaaa bbbb\ncccc dddd", 12);
    expect(paragraphs).toEqual(["aaaa bbbb", "cccc dddd"]);

    const sentences = splitForSpeech("One sentence. Two sentence.", 16);
    expect(sentences[0]).toBe("One sentence.");

    // No punctuation to lean on: it still never cuts inside a word.
    for (const piece of splitForSpeech("alpha bravo charlie delta echo", 12)) {
      expect(piece.startsWith(" ")).toBe(false);
      expect(piece.endsWith(" ")).toBe(false);
    }
  });

  it("covers the whole text, in order, within the limit", () => {
    const source = Array.from({ length: 400 }, (_, index) => `word${String(index)}`).join(" ");
    const pieces = splitForSpeech(source, 200);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(200);
    expect(pieces.join(" ")).toBe(source);
  });

  it("still advances on a single word longer than the limit", () => {
    const pieces = splitForSpeech("x".repeat(50), 10);
    expect(pieces.join("")).toBe("x".repeat(50));
    expect(pieces.length).toBe(5);
  });
});

/** A minimal RIFF/WAVE file carrying `data` as its samples. */
function wav(data: number[], sampleRate = 22_050): Uint8Array {
  const format = new Uint8Array(16);
  const formatView = new DataView(format.buffer);
  formatView.setUint16(0, 1, true);
  formatView.setUint16(2, 1, true);
  formatView.setUint32(4, sampleRate, true);
  formatView.setUint32(8, sampleRate * 2, true);
  formatView.setUint16(12, 2, true);
  formatView.setUint16(14, 16, true);
  const out = new Uint8Array(44 + data.length);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) out[offset + index] = text.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + data.length, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  out.set(format, 20);
  write(36, "data");
  view.setUint32(40, data.length, true);
  out.set(Uint8Array.from(data), 44);
  return out;
}

describe("joinSpeechAudio", () => {
  it("hands back a single piece untouched", () => {
    const only = { audio: new Uint8Array([1, 2, 3]), mediaType: "audio/mpeg" };
    expect(joinSpeechAudio([only])).toEqual(only);
  });

  it("rebuilds several WAV pieces around one header", () => {
    const joined = joinSpeechAudio([
      { audio: wav([1, 2, 3, 4]), mediaType: "audio/wav" },
      { audio: wav([5, 6]), mediaType: "audio/wav" },
    ]);
    expect(joined.mediaType).toBe("audio/wav");
    const view = new DataView(joined.audio.buffer, joined.audio.byteOffset, joined.audio.byteLength);
    // One header, one data chunk, both lengths restated for the whole clip.
    expect(joined.audio.byteLength).toBe(44 + 6);
    expect(view.getUint32(4, true)).toBe(36 + 6);
    expect(view.getUint32(40, true)).toBe(6);
    expect([...joined.audio.subarray(44)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("refuses to splice WAV pieces recorded in different formats", () => {
    const first = wav([1, 2], 22_050);
    const joined = joinSpeechAudio([
      { audio: first, mediaType: "audio/wav" },
      { audio: wav([3, 4], 44_100), mediaType: "audio/wav" },
    ]);
    // Better one correct piece than a clip that plays at the wrong pitch.
    expect(joined.audio).toEqual(first);
  });

  it("drops each MP3 piece's ID3 tags before concatenating its frames", () => {
    const id3 = (payload: number[]): Uint8Array =>
      Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 2, 0xaa, 0xbb, ...payload]);
    const withTrailer = Uint8Array.from([0xcc, 0xdd, 0x54, 0x41, 0x47, ...new Array(125).fill(0)]);
    const joined = joinSpeechAudio([
      { audio: id3([0x11, 0x22]), mediaType: "audio/mpeg" },
      { audio: withTrailer, mediaType: "audio/mpeg" },
    ]);
    expect([...joined.audio]).toEqual([0x11, 0x22, 0xcc, 0xdd]);
  });

  it("concatenates an unfamiliar format rather than losing it", () => {
    const joined = joinSpeechAudio([
      { audio: new Uint8Array([1]), mediaType: "audio/ogg" },
      { audio: new Uint8Array([2]), mediaType: "audio/ogg" },
    ]);
    expect([...joined.audio]).toEqual([1, 2]);
  });
});

describe("ReadAloudService with a long text", () => {
  it("speaks every piece with one synthesizer and serves one clip", async () => {
    const spoken: string[] = [];
    const device: SpeechSynthesizer = {
      async synthesize(text) {
        spoken.push(text);
        return { audio: wav([spoken.length]), mediaType: "audio/wav" };
      },
    };
    const service = new ReadAloudService({ model: () => null, device });
    const article = Array.from({ length: 900 }, (_, index) => `word${String(index)}.`).join(" ");
    const { url, settled } = await service.speak({ ...request, text: article, maxChars: 60_000 });
    await settled;

    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken.join(" ")).toBe(article);
    const audio = await service.respond(new URL(`${url}/audio`));
    // One clip: the sidebar card keeps a single duration, seek bar, and speed.
    expect(audio?.status).toBe(200);
    expect([...new Uint8Array(await audio!.arrayBuffer()).subarray(44)]).toEqual(
      spoken.map((_, index) => index + 1),
    );
  });

  it.each(["model", "device"] as const)("reads a full 10,000-word selection with the %s voice", async (engine) => {
    const spoken: string[] = [];
    const voice: SpeechSynthesizer = {
      async synthesize(text) {
        spoken.push(text);
        const samples = [spoken.length, 0];
        return engine === "device"
          ? { audio: wav(samples), mediaType: "audio/wav" }
          : { audio: Uint8Array.from(samples), mediaType: "audio/mpeg" };
      },
    };
    const service = new ReadAloudService({
      model: () => engine === "model" ? voice : null,
      device: engine === "device" ? voice : synthesizer(new Error("unused")),
    });
    const selection = Array.from({ length: 10_001 }, (_, index) => `word${String(index)}.`).join(" ");
    const { id, url, engine: actualEngine, settled } = await service.speak({ ...request, text: selection });
    await settled;

    // Exceeds both the old selection limit and reader view's article limit.
    expect(selection.length).toBeGreaterThan(60_000);
    expect(actualEngine).toBe(engine);
    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken.every((chunk) => chunk.length <= READ_ALOUD_CHUNK_CHARS)).toBe(true);
    expect(spoken.join(" ") === selection).toBe(true);
    expect(service.clip(id)?.request.text === selection).toBe(true);

    const response = await service.respond(new URL(`${url}/audio`));
    expect(response?.status).toBe(200);
    const audio = new Uint8Array(await response!.arrayBuffer());
    expect([...audio.subarray(engine === "device" ? 44 : 0)]).toEqual(
      spoken.flatMap((_, index) => [index + 1, 0]),
    );
  });

  it("still honors an explicitly requested total limit", async () => {
    const device = synthesizer({ audio: wav([1, 0]), mediaType: "audio/wav" });
    const service = new ReadAloudService({ model: () => null, device });
    const { settled } = await service.speak({ ...request, text: "sentence. ".repeat(2_000), maxChars: 500 });
    await settled;
    expect(device.calls.length).toBeGreaterThan(0);
    expect(device.calls.join(" ").length).toBeLessThanOrEqual(500);
  });
});

/** A synthesizer whose every call waits for the test to release it. */
function gatedSynthesizer(mediaType = "audio/mpeg"): SpeechSynthesizer & {
  calls: string[];
  release(): void;
  fail(message: string): void;
} {
  const calls: string[] = [];
  let pending: { resolve(): void; reject(error: Error): void } | null = null;
  return {
    calls,
    release() {
      pending?.resolve();
      pending = null;
    },
    fail(message) {
      pending?.reject(new Error(message));
      pending = null;
    },
    synthesize(text, signal) {
      calls.push(text);
      return new Promise((resolve, reject) => {
        const settle = (): void => {
          signal.removeEventListener("abort", onAbort);
        };
        const onAbort = (): void => {
          settle();
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending = {
          resolve: () => {
            settle();
            resolve({ audio: Uint8Array.from([calls.length]), mediaType });
          },
          reject: (error) => {
            settle();
            reject(error);
          },
        };
      });
    },
  };
}

const longText = Array.from({ length: 400 }, (_, index) => `word${String(index)}.`).join(" ");

/** Resolves on the next macrotask, so a pending promise's handlers have run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("ReadAloudService streaming", () => {
  it("resolves once the first piece is spoken and streams the rest as they arrive", async () => {
    const voice = gatedSynthesizer();
    const service = new ReadAloudService({ model: () => voice, device: synthesizer(new Error("unused")) });
    const progressed: number[] = [];
    service.onProgress((clip) => progressed.push(clip.pieces.length));

    const speaking = service.speak({ ...request, text: longText });
    await tick();
    expect(voice.calls).toHaveLength(1);
    // The opener is short, so the voice starts within a breath.
    expect(voice.calls[0]!.length).toBeLessThanOrEqual(READ_ALOUD_FIRST_CHUNK_CHARS);
    voice.release();
    const { id, url, settled } = await speaking;
    const clip = service.clip(id)!;
    expect(clip.pieces).toHaveLength(1);
    expect(clip.done).toBe(false);
    expect(progressed).toEqual([1]);

    // The page's first piece is ready; its second waits for the voice.
    const first = await service.respond(new URL(`${url}/piece/0`));
    expect(first?.status).toBe(200);
    expect(first?.headers.get("x-read-aloud-chars")).toBe(String(clip.pieces[0]!.charEnd));
    expect(first?.headers.get("x-read-aloud-total-chars")).toBe(String(longText.length));
    const second = service.respond(new URL(`${url}/piece/1`));
    expect(second).toBeInstanceOf(Promise);
    const stateLater = service.respond(new URL(`${url}/state?after=1`));
    expect(stateLater).toBeInstanceOf(Promise);
    await tick();
    expect(voice.calls).toHaveLength(2);
    voice.release();
    expect((await second)?.status).toBe(200);
    const state = await (await stateLater)!.json() as { done: boolean; pieces: unknown[] };
    expect(state.done).toBe(false);
    expect(state.pieces).toHaveLength(2);

    // Every remaining piece, one request at a time, then the end of the stream.
    for (;;) {
      await tick();
      if (service.clip(id)!.done) break;
      voice.release();
    }
    await settled;
    expect(service.clip(id)!.error).toBeNull();
    expect(voice.calls.join(" ")).toBe(longText);
    const end = await service.respond(new URL(`${url}/piece/${String(voice.calls.length)}`));
    expect(end?.status).toBe(204);
    expect(end?.headers.get("x-read-aloud-error")).toBeNull();
    const whole = await service.respond(new URL(`${url}/audio`));
    expect([...new Uint8Array(await whole!.arrayBuffer())]).toEqual(voice.calls.map((_, index) => index + 1));
  });

  it("tries a failed piece once more, then stops the clip early with the reason", async () => {
    const voice = gatedSynthesizer();
    const service = new ReadAloudService({
      model: () => voice,
      device: synthesizer(new Error("unused")),
      retryDelayMs: 0,
    });
    const speaking = service.speak({ ...request, text: longText });
    await tick();
    voice.release();
    const { id, url, settled } = await speaking;
    await tick();
    voice.fail("quota");
    await tick();
    await tick();
    expect(voice.calls).toHaveLength(3);
    expect(voice.calls[2]).toBe(voice.calls[1]);
    voice.fail("quota again");
    await settled;
    const clip = service.clip(id)!;
    expect(clip.done).toBe(true);
    expect(clip.error).toBe("quota again");
    expect(clip.pieces).toHaveLength(1);
    const end = await service.respond(new URL(`${url}/piece/1`));
    expect(end?.status).toBe(204);
    expect(end?.headers.get("x-read-aloud-error")).toBe("quota%20again");
  });

  it("abandoning a clip stops its voice and answers its waiting page", async () => {
    const voice = gatedSynthesizer();
    const service = new ReadAloudService({ model: () => voice, device: synthesizer(new Error("unused")) });
    const speaking = service.speak({ ...request, text: longText });
    await tick();
    voice.release();
    const { id, url, settled } = await speaking;
    const waiting = service.respond(new URL(`${url}/piece/1`));
    await tick();
    service.abandon(id);
    expect((await waiting)?.status).toBe(404);
    await settled;
    expect(service.clip(id)).toBeNull();
    expect((await service.respond(new URL(url)))?.status).toBe(404);
  });

  it("measures each piece so the words can be followed", async () => {
    const device: SpeechSynthesizer = {
      async synthesize() {
        return { audio: wav(new Array(22_050 * 2).fill(0)), mediaType: "audio/wav" };
      },
    };
    const service = new ReadAloudService({ model: () => null, device });
    const { id, settled } = await service.speak({ ...request, text: longText });
    await settled;
    const clip = service.clip(id)!;
    expect(clip.pieces.length).toBeGreaterThan(1);
    for (const piece of clip.pieces) expect(piece.seconds).toBeCloseTo(1, 6);
    // Pieces tile the text in order, without overlap.
    for (let index = 1; index < clip.pieces.length; index += 1) {
      expect(clip.pieces[index]!.charStart).toBeGreaterThan(clip.pieces[index - 1]!.charEnd);
    }
    expect(clip.pieces[clip.pieces.length - 1]!.charEnd).toBe(longText.length);
  });
});

describe("splitForSpeechSpans", () => {
  it("keeps the first piece short and the rest at the limit, tiling the text", () => {
    const spans = splitForSpeechSpans(longText, 200, 60);
    expect(spans[0]!.end - spans[0]!.start).toBeLessThanOrEqual(60);
    expect(spans.slice(1).every((span) => span.end - span.start <= 200)).toBe(true);
    expect(spans.some((span) => span.end - span.start > 60)).toBe(true);
    expect(spans.map((span) => longText.slice(span.start, span.end)).join(" ")).toBe(longText);
    expect(splitForSpeech(longText, 200, 60)).toEqual(spans.map((span) => longText.slice(span.start, span.end)));
  });
});

describe("audioDurationSeconds", () => {
  it("reads WAV, MPEG and ADTS streams and refuses what it does not know", () => {
    expect(audioDurationSeconds(wav(new Array(44_100).fill(0)), "audio/wav")).toBeCloseTo(1, 6);

    // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz: 417-byte frames of 1152 samples.
    const mp3Frame = new Uint8Array(417);
    mp3Frame.set([0xff, 0xfb, 0x90, 0x00]);
    const id3 = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 2, 0xaa, 0xbb]);
    const mp3 = new Uint8Array(id3.byteLength + mp3Frame.byteLength * 2);
    mp3.set(id3);
    mp3.set(mp3Frame, id3.byteLength);
    mp3.set(mp3Frame, id3.byteLength + mp3Frame.byteLength);
    expect(audioDurationSeconds(mp3, "audio/mpeg")).toBeCloseTo((2 * 1_152) / 44_100, 6);

    // ADTS, AAC-LC at 22.05 kHz (index 7), one 100-byte frame of 1024 samples.
    const adts = new Uint8Array(100);
    adts.set([0xff, 0xf9, 0x5c, 0x40 | (100 >> 11), (100 >> 3) & 0xff, (100 & 0x07) << 5, 0xfc]);
    expect(audioDurationSeconds(adts, "audio/aac")).toBeCloseTo(1_024 / 22_050, 6);

    expect(audioDurationSeconds(new Uint8Array([1, 2, 3]), "audio/ogg")).toBeNull();
    expect(audioDurationSeconds(new Uint8Array([1, 2, 3]), "audio/mpeg")).toBeNull();
  });
});

describe("clip page", () => {
  it("names the stream format for the player and the source for the card", () => {
    const clip: ReadAloudClip = {
      id: "00000000-0000-4000-8000-000000000000",
      mediaType: "audio/aac",
      engine: "device",
      request,
      pieces: [],
      done: false,
      error: null,
    };
    const html = readAloudPageHtml(clip);
    expect(html).toContain('data-media-type="audio/aac"');
    expect(html).toContain("media-src 'self' pistachio: blob:");
    expect(html).toContain("MediaSource.isTypeSupported");
  });
});
