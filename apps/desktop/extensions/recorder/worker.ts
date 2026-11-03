/** The Recorder's worker: the engine (docs/recorder.md §3). `src/engine/main.ts` holds it. */
import { startEngine } from "./src/engine/main.js";

await pistachio.runtime.ready;
startEngine();
