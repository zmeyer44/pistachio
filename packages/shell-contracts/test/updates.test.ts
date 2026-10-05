import { describe, expect, it } from "vitest";
import {
  parseUpdateSnoozeRecord,
  snoozeUpdate,
  UPDATE_SNOOZE_MS,
  updatePrompt,
  type UpdateSnoozeRecord,
} from "../src/updates.js";

const BUILD = "0.0.30";
const NOW = new Date("2026-10-04T15:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("the update prompt", () => {
  it("is due for a release nobody has put off, offering only tomorrow", () => {
    expect(updatePrompt(null, BUILD, "0.0.31", NOW)).toEqual({ due: true, snoozes: 0 });
  });

  it("waits a day after tomorrow, then asks again with later on offer", () => {
    const record = snoozeUpdate(null, BUILD, "0.0.31", "tomorrow", NOW);
    expect(record.count).toBe(1);
    expect(updatePrompt(record, BUILD, "0.0.31", later(UPDATE_SNOOZE_MS - 1))).toEqual({ due: false, snoozes: 1 });
    expect(updatePrompt(record, BUILD, "0.0.31", later(UPDATE_SNOOZE_MS))).toEqual({ due: true, snoozes: 1 });
  });

  it("keeps a day's snooze over a newer release", () => {
    const record = snoozeUpdate(null, BUILD, "0.0.31", "tomorrow", NOW);
    expect(updatePrompt(record, BUILD, "0.0.32", later(60_000)).due).toBe(false);
  });

  it("holds later for that release alone", () => {
    const first = snoozeUpdate(null, BUILD, "0.0.31", "tomorrow", NOW);
    const record = snoozeUpdate(first, BUILD, "0.0.31", "later", later(UPDATE_SNOOZE_MS));
    expect(record).toEqual({ build: BUILD, version: "0.0.31", until: null, count: 2 });
    expect(updatePrompt(record, BUILD, "0.0.31", later(30 * UPDATE_SNOOZE_MS)).due).toBe(false);
    expect(updatePrompt(record, BUILD, "0.0.32", later(UPDATE_SNOOZE_MS))).toEqual({ due: true, snoozes: 2 });
  });

  it("starts over once an update is installed", () => {
    const record = snoozeUpdate(null, BUILD, "0.0.31", "later", NOW);
    expect(updatePrompt(record, "0.0.31", "0.0.32", NOW)).toEqual({ due: true, snoozes: 0 });
    expect(snoozeUpdate(record, "0.0.31", "0.0.32", "tomorrow", NOW).count).toBe(1);
  });
});

describe("the snooze record on disk", () => {
  const record: UpdateSnoozeRecord = { build: BUILD, version: "0.0.31", until: NOW.toISOString(), count: 1 };

  it("reads back what was written", () => {
    expect(parseUpdateSnoozeRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(parseUpdateSnoozeRecord({ ...record, until: null })).toEqual({ ...record, until: null });
  });

  it("refuses anything else", () => {
    expect(parseUpdateSnoozeRecord(null)).toBeNull();
    expect(parseUpdateSnoozeRecord({ ...record, until: "soon" })).toBeNull();
    expect(parseUpdateSnoozeRecord({ ...record, count: -1 })).toBeNull();
    expect(parseUpdateSnoozeRecord({ ...record, build: 30 })).toBeNull();
  });
});
