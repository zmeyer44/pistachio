/** The recorded fixture events (`fixtures/events-*.jsonl`), read through Vite's `?raw` so the tests need no Node types. */
import click from "./fixtures/events-click.jsonl?raw";
import idle from "./fixtures/events-idle.jsonl?raw";
import nav from "./fixtures/events-nav.jsonl?raw";
import password from "./fixtures/events-password.jsonl?raw";
import scroll from "./fixtures/events-scroll.jsonl?raw";
import torn from "./fixtures/events-torn.jsonl?raw";
import typing from "./fixtures/events-typing.jsonl?raw";
import { type Recording, parseEvents } from "../src/lib/events.js";

export const FIXTURE_TEXT = { click, idle, nav, password, scroll, torn, typing };
export type FixtureName = keyof typeof FIXTURE_TEXT;
export const FIXTURES: FixtureName[] = ["click", "idle", "nav", "password", "scroll", "typing"];

export function load(name: FixtureName): Recording {
  return parseEvents(FIXTURE_TEXT[name]);
}

/** 50 Hz linear RMS levels: −60 dBFS of room tone, −26 dBFS where someone speaks. */
export function micLevels(seconds: number, speech: [number, number][], hz = 50): Float32Array {
  const levels = new Float32Array(Math.round(seconds * hz));
  for (let i = 0; i < levels.length; i++) {
    const t = i / hz;
    levels[i] = speech.some(([a, b]) => t >= a && t < b) ? 0.05 : 0.001;
  }
  return levels;
}
