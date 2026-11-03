import { describe, expect, it } from "vitest";
import { AudioMixer, Envelope, type PcmBlock, type PcmOpener, PcmReader, silentIntervals, silentZones, type SoundPlan, soundPlan } from "../src/export/audio.js";
import { piecewiseMap } from "./export-fixtures.js";

/** A source whose value at source time t is `value(t)`, decoded in blocks of 1024 at `rate`; counts how often it was opened. */
function synthetic(value: (t: number) => number, rate: number, duration: number, channels = 1): { open: PcmOpener; opens: number[] } {
  const opens: number[] = [];
  const open: PcmOpener = (from) => {
    opens.push(from);
    const frames = 1024;
    let index = Math.floor((from * rate) / frames);
    return {
      async next(): Promise<IteratorResult<PcmBlock>> {
        const timestamp = (index * frames) / rate;
        if (timestamp >= duration) return { done: true, value: undefined };
        const plane = new Float32Array(frames);
        for (let i = 0; i < frames; i++) plane[i] = value(timestamp + i / rate);
        index++;
        return { done: false, value: { timestamp, sampleRate: rate, channels: Array.from({ length: channels }, () => plane) } };
      },
    };
  };
  return { open, opens };
}

describe("where the sound falls silent", () => {
  const map = piecewiseMap([
    { length: 1, src: 0, rate: 1 },
    { length: 0.5, src: 1, rate: 4 }, // 2 s of source in half a second
    { length: 0.5, src: 3, rate: 1 },
    { length: 1, src: 8.5, rate: 1 }, // a cut: 3.5 → 8.5
  ]);

  it("finds the sped-up stretch and the cut, to the millisecond", () => {
    const zones = silentZones(map);
    expect(zones.spedUp).toHaveLength(1);
    expect(zones.spedUp[0]?.[0]).toBeCloseTo(1, 2);
    expect(zones.spedUp[0]?.[1]).toBeCloseTo(1.5, 2);
    expect(zones.cuts).toHaveLength(1);
    expect(zones.cuts[0]).toBeCloseTo(2, 2);
  });

  it("silences a source over both when muted while sped up, over the cut alone otherwise", () => {
    const zones = { spedUp: [[1, 1.5]] as [number, number][], cuts: [2, 1.2] };
    expect(silentIntervals(zones, true)).toEqual([
      [1, 1.5],
      [2, 2],
    ]);
    expect(silentIntervals(zones, false)).toEqual([
      [1.2, 1.2],
      [2, 2],
    ]);
  });
});

describe("the fade envelope", () => {
  const envelope = new Envelope(
    [
      [1, 1.5],
      [2, 2],
    ],
    0.03,
  );

  it("is 1 away from silences, 0 inside, and a raised cosine within 30 ms of each edge", () => {
    expect(envelope.at(0.5)).toBe(1);
    expect(envelope.at(0.97)).toBe(1);
    expect(envelope.at(0.985)).toBeCloseTo(0.5, 6);
    expect(envelope.at(1.2)).toBe(0);
    expect(envelope.at(1.515)).toBeCloseTo(0.5, 6);
    expect(envelope.at(2)).toBe(0);
    expect(envelope.at(2.03)).toBe(1);
  });

  it("gives the same answers read backwards", () => {
    const forward = [0.5, 0.985, 1.2, 1.515, 1.99, 2.01, 2.5].map((t) => new Envelope(envelope.intervals).at(t));
    const reader = new Envelope(envelope.intervals);
    const backward = [2.5, 2.01, 1.99, 1.515, 1.2, 0.985, 0.5].map((t) => reader.at(t)).reverse();
    expect(backward).toEqual(forward);
  });

  it("knows a span inside a silence", () => {
    expect(envelope.silentOver(1.1, 1.4)).toBe(true);
    expect(envelope.silentOver(0.9, 1.4)).toBe(false);
  });
});

describe("the PCM reader", () => {
  it("interpolates between samples and across blocks, and resamples", async () => {
    const source = synthetic((t) => t, 44_100, 10);
    const reader = new PcmReader(source.open);
    await reader.cover(0, 0.5);
    const out = new Float32Array(2);
    for (const t of [0.001, 1023.5 / 44_100, 0.25, 0.4999]) {
      reader.read(t, out);
      expect(out[0]).toBeCloseTo(t, 5);
      expect(out[1]).toBeCloseTo(t, 5); // mono fills both sides
    }
  });

  it("decodes on across a short gap and seeks past a long one", async () => {
    const source = synthetic(() => 0.5, 48_000, 60);
    const reader = new PcmReader(source.open);
    await reader.cover(0, 0.1);
    await reader.cover(1.5, 1.6);
    expect(source.opens).toHaveLength(1);
    await reader.cover(30, 30.1);
    expect(source.opens).toHaveLength(2);
    expect(source.opens[1]).toBeCloseTo(29.95, 6);
    const out = new Float32Array(2);
    reader.read(30.05, out);
    expect(out[0]).toBe(0.5);
  });

  it("is silent outside what the source holds", async () => {
    const source = synthetic(() => 1, 48_000, 1);
    const reader = new PcmReader(source.open);
    await reader.cover(0.9, 1.5);
    const out = new Float32Array(2);
    reader.read(1.2, out);
    expect([...out]).toEqual([0, 0]);
  });
});

describe("the mix", () => {
  const collect = async (mixer: AudioMixer): Promise<Float32Array[]> => {
    const left = new Float32Array(mixer.total);
    const right = new Float32Array(mixer.total);
    let at = 0;
    for (let block = await mixer.next(); block !== null; block = await mixer.next()) {
      left.set(block.data.subarray(0, block.frames), at);
      right.set(block.data.subarray(block.frames), at);
      at += block.frames;
    }
    return [left, right];
  };

  it("carries a source through the time map with its gain, 48 kHz from 44.1", async () => {
    const map = piecewiseMap([{ length: 1, src: 0, rate: 1 }]);
    const source = synthetic(() => 0.5, 44_100, 2);
    const mixer = new AudioMixer(map, [{ reader: new PcmReader(source.open), gain: 0.5, envelope: new Envelope([]) }], 1);
    const [left, right] = await collect(mixer);
    expect(mixer.total).toBe(48_000);
    expect(left?.[100]).toBeCloseTo(0.25, 6);
    expect(right?.[47_000]).toBeCloseTo(0.25, 6);
  });

  it("drops the mic where time is sped up (muted while sped up) and fades it around the stretch and the cut", async () => {
    const map = piecewiseMap([
      { length: 1, src: 0, rate: 1 },
      { length: 0.5, src: 1, rate: 4 },
      { length: 0.5, src: 3, rate: 1 },
      { length: 1, src: 20, rate: 1 },
    ]);
    const mic = synthetic((t) => (t < 3.5 ? 0.8 : -0.8), 48_000, 30);
    const zones = silentZones(map);
    const mixer = new AudioMixer(map, [{ reader: new PcmReader(mic.open), gain: 1, envelope: new Envelope(silentIntervals(zones, true)) }], map.duration);
    const [left] = (await collect(mixer)) as [Float32Array];
    const at = (t: number): number => left[Math.round(t * 48_000)] as number;
    expect(at(0.5)).toBeCloseTo(0.8, 5);
    expect(at(1.25)).toBe(0); // inside the 4× stretch
    expect(Math.abs(at(0.985))).toBeLessThan(0.8);
    expect(at(1.75)).toBeCloseTo(0.8, 5);
    expect(Math.abs(at(2))).toBeLessThan(0.05); // the cut
    expect(at(2.5)).toBeCloseTo(-0.8, 5); // past the cut: source 20.5 s
    // The cut jumped 16.5 s ahead: the reader sought instead of decoding through.
    expect(mic.opens.length).toBeGreaterThanOrEqual(2);
  });

  describe("each source's place, from the project's Audio settings", () => {
    // A second at 1×, half a second of 4× (source 1 → 3), half a second at 1×.
    const map = piecewiseMap([
      { length: 1, src: 0, rate: 1 },
      { length: 0.5, src: 1, rate: 4 },
      { length: 0.5, src: 3, rate: 1 },
    ]);
    const zones = silentZones(map);
    /** The mic (its value at source time t is t / 10) mixed alone by its plan; the left channel at output time t. */
    const mixMic = async (plan: SoundPlan): Promise<(t: number) => number> => {
      const mic = synthetic((t) => t / 10, 48_000, 10);
      const [left] = (await collect(new AudioMixer(map, [{ reader: new PcmReader(mic.open), gain: plan.gain, envelope: new Envelope(plan.silences) }], map.duration))) as [Float32Array];
      return (t) => left[Math.round(t * 48_000)] as number;
    };

    it("keeps the mic over a speed-up, sped up in step, when Mute while sped up is off — as the preview plays it", async () => {
      const plan = soundPlan({ mic: 1, page: 0.6, muteSpedUp: false }, zones);
      expect(plan.mic).not.toBeNull();
      expect(plan.mic?.silences).toEqual(plan.page?.silences);
      const at = await mixMic(plan.mic as SoundPlan);
      expect(at(0.5)).toBeCloseTo(0.05, 4);
      // 1.25 s out is source 2 s inside the 4× stretch: the mic is heard there, read through the map.
      expect(at(1.25)).toBeCloseTo(0.2, 4);
      expect(at(1.75)).toBeCloseTo(0.325, 4);
    });

    it("mutes the mic and the page's sound over a speed-up when it is on (the default)", async () => {
      const plan = soundPlan({ mic: 1, page: 0.6, muteSpedUp: true }, zones);
      expect(plan.mic?.silences).toEqual(plan.page?.silences);
      const at = await mixMic(plan.mic as SoundPlan);
      expect(at(0.5)).toBeCloseTo(0.05, 4);
      expect(at(1.25)).toBe(0);
      expect(at(1.75)).toBeCloseTo(0.325, 4);
    });

    it("leaves out a source turned all the way down, and carries each one's gain", () => {
      expect(soundPlan({ mic: 0, page: 0.6, muteSpedUp: true }, zones).mic).toBeNull();
      expect(soundPlan({ mic: 1, page: 0, muteSpedUp: false }, zones).page).toBeNull();
      const plan = soundPlan({ mic: 1.5, page: 0.6, muteSpedUp: false }, zones);
      expect([plan.mic?.gain, plan.page?.gain]).toEqual([1.5, 0.6]);
    });
  });

  it("clamps the mix to full scale", async () => {
    const map = piecewiseMap([{ length: 0.1, src: 0, rate: 1 }]);
    const loud = (): { reader: PcmReader; gain: number; envelope: Envelope } => ({ reader: new PcmReader(synthetic(() => 0.9, 48_000, 1).open), gain: 1, envelope: new Envelope([]) });
    const [left] = (await collect(new AudioMixer(map, [loud(), loud()], 0.1))) as [Float32Array];
    expect(Math.max(...left)).toBe(1);
  });
});
