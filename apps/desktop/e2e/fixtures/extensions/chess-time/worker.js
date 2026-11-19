// Chess time, as docs/primitives.md §2.7 writes it: the half hour is declared, main keeps the clock, and the handler
// makes the world match what it is told — a space while the window is on, none once it is over. The id of the space
// it made is all it keeps. What it heard is left in storage for a spec to read.

const PAGE = "https://www.chess.com/";

pistachio.triggers.on("chess", async ({ holds }) => {
  const { space, heard = [] } = await pistachio.storage.local.get(["space", "heard"]);
  await pistachio.storage.local.set({ heard: [...heard, holds] });
  if (holds && !space) {
    // Made behind what is in front; it is this extension's own from here on.
    const made = await pistachio.spaces.create({ name: "Chess time", tabs: [PAGE] });
    await pistachio.storage.local.set({ space: made.id });
  }
  if (!holds && space) {
    try {
      await pistachio.spaces.close(space);
    } catch (error) {
      // (Closed by the person already: there is nothing left to close. Anything else is tried again.)
      if (error?.code !== "NOT_FOUND") throw error;
    }
    await pistachio.storage.local.remove("space");
  }
});
