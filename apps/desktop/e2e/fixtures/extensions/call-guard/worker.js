// "Send Football away while a Meet call is open" (stage 5b's gate, docs/primitives.md §5), on the public API alone.
// The extension never watches the tabs: it declares a signal — a page under 127.0.0.1/call is open — and Pistachio
// tells it one thing, whether that holds. Events say what happened, once; a second signal says the screen is locked;
// and an instant opens a page with nobody there. What it heard is left in storage for a spec to read.

pistachio.bar.onCommand("guard", async ({ spaceId, arg }) => {
  // (`late:<tab>`: a tab for ten o'clock's handler to try to close once Pistachio has stopped waiting for it.)
  if (typeof arg === "string" && arg.startsWith("late:")) return pistachio.storage.local.set({ late: arg.slice(5) });
  // Running it here is what gives the extension this space. (`arg`: the page to open at nine.)
  await pistachio.storage.local.set({ space: spaceId, open: arg });
  // (The person's own command in hand, the microphone it was granted is the worker's to ask for.)
  await note("mic", `guard:${await microphone()}`);
  const state = await pistachio.triggers.get("call");
  if (state.known) await apply(state);
});

// Pistachio calls this when the answer is not the one it last heard; a failure here is tried again later.
pistachio.triggers.on("call", async (state) => {
  await note("heard", state.holds);
  return apply(state);
});

// The screen locked: nobody is at the Mac, so the space may go even from in front.
pistachio.triggers.on("locked", async (state) => {
  await note("locked", state.holds);
  return apply(state);
});

// Events: told what happened, once — which tab, never its address.
pistachio.triggers.on("opened", ({ events }) => note("opened", ...events.map((event) => event.tabId)));
pistachio.triggers.on("closed", ({ events }) => note("closed", ...events.map((event) => event.tabId)));
pistachio.triggers.on("arrived", async ({ events }) => {
  // (Reading the tab is tabs:read's to allow: the event itself said only which.)
  const tabs = await Promise.all(events.map((event) => pistachio.tabs.get(event.tabId).then((tab) => new URL(tab.url).pathname)));
  await note("arrived", ...tabs);
});

// Nine o'clock, with nobody there: the page opens behind what is in front, whatever is asked.
pistachio.triggers.on("nine", async ({ at }) => {
  if (at === null) return;
  // (With nobody there, the microphone is not the worker's, granted or not.)
  await note("mic", `nine:${await microphone()}`);
  const { open } = await pistachio.storage.local.get("open");
  if (!open) return;
  const tab = await pistachio.tabs.create({ url: open, show: true });
  await note("made", tab.id);
});

// Ten o'clock: a handler that runs past the ten seconds Pistachio waits for one. It has not answered, so what it
// calls when it goes on is still a trigger's — asked as with nobody there — whoever started the worker.
pistachio.triggers.on("ten", async ({ at }) => {
  if (at === null) return;
  const { late } = await pistachio.storage.local.get("late");
  if (!late) return;
  await pistachio.storage.local.set({ late: "" });
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  try {
    await pistachio.tabs.close(late);
    await note("late", "closed");
  } catch (error) {
    await note("late", error.code ?? error.name);
  }
});

async function apply({ holds }) {
  const { space } = await pistachio.storage.local.get("space");
  if (!space) return;
  return holds ? pistachio.spaces.sendAway(space) : pistachio.spaces.bringBack(space);
}

// Whether the microphone would be given now — the permission asked about, no device touched and nothing recorded.
async function microphone() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state;
  } catch (error) {
    return `error:${error.name}`;
  }
}

// (One key a kind of thing, so two handlers at once never write over each other.)
async function note(key, ...values) {
  const stored = await pistachio.storage.local.get(key);
  await pistachio.storage.local.set({ [key]: [...(stored[key] ?? []), ...values] });
}
