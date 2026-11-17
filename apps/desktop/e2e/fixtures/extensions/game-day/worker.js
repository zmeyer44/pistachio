// Game day, as docs/primitives.md §6 writes it: no timer, no catch-up, no time zone — the window is declared, main
// keeps the clock, and the handler makes the space match what it is told. What it heard is left in storage for a
// spec to read.

pistachio.bar.onCommand("gameday", async ({ spaceId }) => {
  // Running it here is what gives the extension this space.
  await pistachio.storage.local.set({ space: spaceId });
  await apply(await pistachio.triggers.get("sunday"));
});

// Main calls this when the answer is not the one it last heard; a failure here is tried again later.
pistachio.triggers.on("sunday", async (state) => {
  const { heard = [] } = await pistachio.storage.local.get("heard");
  // With nobody there, what cannot be undone is refused: staying up is one such thing.
  let alone = "allowed";
  try {
    await pistachio.runtime.keepAlive("stay");
  } catch (error) {
    alone = error?.code ?? String(error);
  }
  await pistachio.storage.local.set({ heard: [...heard, { holds: state.holds, changesAt: state.changesAt }], alone });
  return apply(state);
});

async function apply({ holds }) {
  const { space } = await pistachio.storage.local.get("space");
  if (!space) return;
  return holds ? pistachio.spaces.bringBack(space) : pistachio.spaces.sendAway(space);
}
