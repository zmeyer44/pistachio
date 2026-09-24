/**
 * The two sounds the keypad makes.
 *
 * Both are files, served from each app's own `public/audio` (the gate runs on
 * two sites, and a site can only fetch its own origin). They are played
 * through Web Audio rather than `<audio>` for one reason: an `Audio` element
 * schedules when it feels like it, and one of these has to land on a specific
 * frame of an animation.
 *
 * WHAT IS IN THEM, AND WHY THE ANIMATION IS BUILT AROUND IT. The unlock file
 * is not one sound but two, with its own gap: a soft scrape from about 40 ms,
 * silence through the middle, and then the CLICK at 638.75 ms — which is why
 * `UNLOCK_CLICK_MS` is exported and why the wrap is exactly that long. The
 * animation is timed to the audio, not the audio nudged at the animation, so
 * the circles close on the frame the latch bites and there is no fudge factor
 * left to drift.
 *
 * The wrong-PIN file is a low buzz: two lobes at roughly 50 ms and 155 ms with
 * the second the stronger, done by 520 ms. The shake is keyframed to those.
 *
 * LOADING, AUTOPLAY AND JANK, in that order. `preloadPinSounds` runs when the
 * keypad mounts — fetching and decoding need no gesture, only playing does, and
 * doing it there means the bytes are decoded long before six digits have been
 * typed. `primeUnlockSound` runs from the keystroke itself, which is the only
 * moment a browser will let a context start. By the time either sound plays —
 * on the same frame an animation begins — there is nothing left to do but
 * connect a buffer. Every call is wrapped: a browser that refuses audio is not
 * a browser that should fail to unlock.
 */

/** Where the click sits inside the unlock file. The wrap is built to match. */
export const UNLOCK_CLICK_MS = 638.75;

/** The files are near full scale, so this is the whole volume control. */
const UNLOCK_GAIN = 0.55;
const WRONG_GAIN = 0.6;

const SOURCES = {
  unlock: "/audio/pin-unlock.wav",
  wrong: "/audio/pin-wrong.wav",
} as const;

type Sound = keyof typeof SOURCES;

let context: AudioContext | null = null;
const buffers = new Map<Sound, AudioBuffer>();
/** In-flight loads, so a remount does not fetch the same file twice. */
const loading = new Map<Sound, Promise<void>>();

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    // Constructed suspended when there has been no gesture yet, which is fine:
    // decoding works on a suspended context, and `primeUnlockSound` resumes it.
    context ??= new AudioContext();
    return context;
  } catch {
    return null;
  }
}

function load(ctx: AudioContext, sound: Sound): Promise<void> {
  const already = loading.get(sound);
  if (already !== undefined) return already;
  const work = fetch(SOURCES[sound])
    .then((response) => {
      if (!response.ok) throw new Error(String(response.status));
      return response.arrayBuffer();
    })
    .then((bytes) => ctx.decodeAudioData(bytes))
    .then((decoded) => {
      buffers.set(sound, decoded);
    })
    .catch(() => {
      // A sound that will not load is a sound that does not play. The lock
      // still works, and the next attempt is free to try the fetch again.
      loading.delete(sound);
    });
  loading.set(sound, work);
  return work;
}

/**
 * Fetch and decode both files. Called when the keypad mounts: no gesture is
 * needed to load, and this is what keeps the first play instant.
 */
export function preloadPinSounds(): void {
  const ctx = audio();
  if (ctx === null) return;
  try {
    void load(ctx, "unlock");
    void load(ctx, "wrong");
  } catch {
    // As above.
  }
}

/**
 * Wake the audio context. MUST be called synchronously from a user gesture —
 * the keystroke that completes the PIN — or a browser that started the context
 * suspended will keep it that way and nothing will be heard.
 */
export function primeUnlockSound(): void {
  const ctx = audio();
  if (ctx === null) return;
  try {
    void ctx.resume().catch(() => undefined);
    // Belt and braces: a keypad that somehow never preloaded still gets its
    // sounds, a little later.
    preloadPinSounds();
  } catch {
    // As above.
  }
}

function play(sound: Sound, gain: number): void {
  const ctx = audio();
  if (ctx === null) return;
  try {
    const buffer = buffers.get(sound);
    if (buffer === undefined) {
      // Still decoding — rare, since the keypad has been mounted for as long
      // as it took to type six digits. Play it when it arrives rather than
      // dropping it: late by a few milliseconds beats silent.
      void load(ctx, sound).then(() => {
        if (buffers.has(sound)) play(sound, gain);
      });
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const amp = ctx.createGain();
    amp.gain.value = gain;
    source.connect(amp).connect(ctx.destination);
    source.start();
  } catch {
    // As above.
  }
}

/**
 * The unlock, started as the row begins to roll up. The file carries its own
 * timing: the scrape plays under the wrap and the click lands at
 * `UNLOCK_CLICK_MS`, which is where the ring closes.
 */
export function playUnlockSound(): void {
  play("unlock", UNLOCK_GAIN);
}

/** The wrong-PIN buzz, started with the shake it was keyframed against. */
export function playWrongSound(): void {
  play("wrong", WRONG_GAIN);
}
