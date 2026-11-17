// "When my stand-up starts, bring the Team space back" (stage 5's gate, docs/primitives.md §5), on the public API
// alone. The extension never reads the calendar: it declares a signal — an event with "stand-up" in its name — and
// Pistachio tells it one thing, whether that holds. An interval that runs while it holds keeps a row beside the Bar
// current, with no timer here and no worker kept up. What it heard is left in storage for a spec to read.

pistachio.bar.onCommand("standup", async ({ spaceId }) => {
  // Running it here is what gives the extension this space.
  await pistachio.storage.local.set({ space: spaceId });
  const state = await pistachio.triggers.get("standup");
  // (Not known — no calendar connected — is not "no meeting": leave the space where it is.)
  if (state.known) await apply(state);
});

// Pistachio calls this when the answer is not the one it last heard; a failure here is tried again later.
pistachio.triggers.on("standup", async (state) => {
  const { heard = [] } = await pistachio.storage.local.get("heard");
  await pistachio.storage.local.set({ heard: [...heard, state.holds] });
  return apply(state);
});

// Every minute while the stand-up is on: how long it has run, in the row. One call for however many minutes passed.
pistachio.triggers.on("minute", async ({ at }) => {
  if (at === null) return;
  const { marks = [] } = await pistachio.storage.local.get("marks");
  const next = [...marks, at];
  await pistachio.storage.local.set({ marks: next });
  await show(`${next.length} min`);
});

pistachio.triggers.on("unplugged", async ({ holds }) => {
  const { power = [] } = await pistachio.storage.local.get("power");
  await pistachio.storage.local.set({ power: [...power, holds] });
});

async function apply({ holds }) {
  const { space } = await pistachio.storage.local.get("space");
  if (holds) await show("now");
  else await pistachio.ui.band.clear();
  if (!space) return;
  return holds ? pistachio.spaces.bringBack(space) : pistachio.spaces.sendAway(space);
}

function show(value) {
  return pistachio.ui.band.set({ rows: [{ mark: { tone: "green" }, text: "Stand-up", value }] });
}
