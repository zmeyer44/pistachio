// "A stadium backdrop on the Football space while the games are on" (stage 3's gate, docs/primitives.md §5), on the public
// API alone: the space is given by its own menu, the window is declared, and the handler says what should be shown.
// Nothing here draws anything, and nothing here waits: the shell draws what main keeps.

pistachio.contextMenus.onClicked("here", async ({ spaceId }) => {
  // Chosen from a space's menu, the item gives the extension that space.
  await pistachio.storage.local.set({ space: spaceId });
  await apply(await pistachio.triggers.get("sunday"));
});

pistachio.triggers.on("sunday", apply);

async function apply({ holds }) {
  const { space, heard = [] } = await pistachio.storage.local.get(["space", "heard"]);
  await pistachio.storage.local.set({ heard: [...heard, holds] });
  if (!space) return;
  if (holds) {
    await pistachio.theme.set({ spaceId: space, backdrop: { image: "field.svg", dim: 0.2 }, colors: { accent: "#1f8a4c" } });
    await pistachio.spaces.setMark(space, { glyph: "🏈", tone: "green", label: "Games on" });
  } else {
    await pistachio.theme.clear({ spaceId: space });
    await pistachio.spaces.setMark(space, null);
  }
}
