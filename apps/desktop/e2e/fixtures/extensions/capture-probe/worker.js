// /probe: record the window in use for two seconds through the public API alone (capture.hold, capture.tab,
// input.subscribe, a MediaRecorder into files.data), then say what came: each step leaves a line in the log
// (`.pistachio/log.ndjson` beside this file, "probe: …") and a marker in storage.local, which a spec reads back.

const RECORD_MS = 2_000;

const say = (step, data) => {
  pistachio.runtime.log("info", `probe: ${step}`, data ?? null);
  return pistachio.storage.local.set({ [`probe.${step}`]: data ?? true });
};

async function countFrames(track, ms) {
  const copy = track.clone();
  const reader = new MediaStreamTrackProcessor({ track: copy }).readable.getReader();
  const until = performance.now() + ms;
  let frames = 0;
  let size = null;
  while (performance.now() < until) {
    const next = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve({ done: true }), until - performance.now()))]);
    if (next.done) break;
    frames += 1;
    size ??= { width: next.value.displayWidth, height: next.value.displayHeight };
    next.value.close();
  }
  await reader.cancel().catch(() => undefined);
  copy.stop();
  return { frames, size };
}

function record(stream, ms) {
  const type = ["video/webm;codecs=vp8", "video/webm", "video/mp4"].find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
  const recorder = new MediaRecorder(stream, type === "" ? {} : { mimeType: type });
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  return new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
    recorder.onerror = (event) => reject(event.error ?? new Error("the recorder failed"));
    recorder.start(250);
    setTimeout(() => recorder.stop(), ms);
  });
}

async function probe(tabId) {
  try {
    await say("started", { tabId, at: pistachio.runtime.now() });
    const desk = await pistachio.desk.state();
    const window = desk.windows.find((candidate) => candidate.tabId === tabId) ?? null;
    await say("desk", { windows: desk.windows.length, box: window?.box ?? null, inUse: window?.inUse ?? null });
    const release = await pistachio.capture.hold(tabId);
    const subscription = await pistachio.input.subscribe(tabId);
    const kinds = {};
    const keys = [];
    const focus = [];
    let target = null;
    subscription.onEvent((event) => {
      kinds[event.k] = (kinds[event.k] ?? 0) + 1;
      if (event.k === "key") keys.push(event);
      if (event.k === "focus") focus.push({ secret: event.secret, at: keys.length });
      if (event.k === "down" && event.target !== undefined) target = event.target;
    });
    const stream = await pistachio.capture.tab(tabId, { audio: false, scale: 1, frameRate: 30 });
    const settings = stream.getVideoTracks()[0].getSettings();
    await say("capturing", { width: settings.width, height: settings.height, surface: settings.displaySurface });
    const [counted, recording] = await Promise.all([countFrames(stream.getVideoTracks()[0], RECORD_MS), record(stream, RECORD_MS)]);
    await pistachio.files.data.write("probe/recording.webm", recording);
    for (const track of stream.getTracks()) track.stop();
    await subscription.stop();
    release();
    await say("result", { frames: counted.frames, size: counted.size, bytes: recording.size, kinds, keys, focus, target });
  } catch (error) {
    await say("failed", { message: String(error?.message ?? error), code: error?.code ?? null });
  }
}

// /probe hold: the stream taken past the runtime — the raw wire's `capture.arm`, then getDisplayMedia itself — and
// never stopped, deaf to `capture.ended` (the runtime ends only the streams it handed out): what a careless or an
// unkind worker does. The person's Stop must end it all the same, from main.
async function hold(tabId) {
  try {
    const wire = globalThis.__pistachioWire;
    const release = await pistachio.capture.hold(tabId);
    const armed = await wire.call("capture.arm", { tabId, audio: false, scale: 1, frameRate: 30 });
    if (!armed.ok) throw new Error(armed.message ?? "capture.arm refused");
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: armed.v.width }, height: { ideal: armed.v.height }, frameRate: { ideal: 30 } }, audio: false });
    // The window's input watched too, counted (`__held.events`): what main must end when the extension is put off here.
    const subscription = await pistachio.input.subscribe(tabId);
    const events = { count: 0 };
    subscription.onEvent(() => (events.count += 1));
    globalThis.__held = { stream, release, subscription, events };
    await say("holding", { tracks: stream.getTracks().length });
  } catch (error) {
    await say("failed", { message: String(error?.message ?? error), code: error?.code ?? null });
  }
}

// /probe sources: what capture.sources() hands a worker with no chooser open — the list, and which came with a picture.
async function sources(tabId) {
  try {
    const list = await pistachio.capture.sources();
    await say("sources", { invoked: tabId, list: list.map((source) => ({ tabId: source.tabId, url: source.url, still: source.still !== null })) });
  } catch (error) {
    await say("failed", { message: String(error?.message ?? error), code: error?.code ?? null });
  }
}

// /probe frame: the stream taken past the runtime as `hold` does, its track cloned through an about:blank frame's own
// realm (a `MediaStreamTrack.prototype.clone` the preload's guard never wrapped), the original stopped and the frame
// removed — the guard then counts no live track while the clone records on. Main must not believe it.
async function frame(tabId) {
  try {
    const wire = globalThis.__pistachioWire;
    const release = await pistachio.capture.hold(tabId);
    const armed = await wire.call("capture.arm", { tabId, audio: false, scale: 1, frameRate: 30 });
    if (!armed.ok) throw new Error(armed.message ?? "capture.arm refused");
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: armed.v.width }, height: { ideal: armed.v.height }, frameRate: { ideal: 30 } }, audio: false });
    const [track] = stream.getVideoTracks();
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const clone = iframe.contentWindow.MediaStreamTrack.prototype.clone.call(track);
    track.stop();
    iframe.remove();
    globalThis.__framed = { clone, release };
    await say("framed", { clone: clone.readyState, original: track.readyState, guard: globalThis.__pistachioLiveCaptures().length });
  } catch (error) {
    await say("failed", { message: String(error?.message ?? error), code: error?.code ?? null });
  }
}

// /probe panel-later: the worker opens its own panel on its own, well after the command's gesture has passed — the
// panel's capture.sources must then grant nothing (a chooser no one opened).
function panelLater() {
  setTimeout(() => {
    pistachio.ui.openPanel().then(() => say("panel-opened", {}), (error) => say("failed", { message: String(error?.message ?? error) }));
  }, 6500);
  void say("panel-scheduled", {});
}

pistachio.bar.onCommand("probe", ({ tabId, arg }) => {
  // (Answered at once: the recording goes on after the command's own time.)
  if (tabId === null) return void say("failed", { message: "no window in use" });
  if (typeof arg === "string" && arg.trim() === "hold") return void hold(tabId);
  if (typeof arg === "string" && arg.trim() === "sources") return void sources(tabId);
  if (typeof arg === "string" && arg.trim() === "frame") return void frame(tabId);
  if (typeof arg === "string" && arg.trim() === "panel-later") return void panelLater();
  void probe(tabId);
});

pistachio.bar.onCommand("ask", async () => {
  await pistachio.agent.ask("What does this page say about invoices?");
  await say("asked", {});
});

pistachio.commands.onCommand("probe-key", async ({ tabId, spaceId }) => {
  await say("key", { tabId, spaceId });
});

pistachio.commands.onCommand("steal", async () => {
  await say("stolen", {});
});
