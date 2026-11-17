// "Show today's games in a strip beside the Bar on Sundays" (stage 4's gate, docs/primitives.md §5), on the public API
// alone. The handler says which rows should be shown and where; Pistachio keeps them and draws them — its own rows,
// under this extension's icon — so they are there after this worker has stopped and after a restart. Nothing here
// draws anything, and nothing here waits.

const GAMES = [
  { id: "game:kc-buf", text: "KC 21 – BUF 17", detail: "3rd quarter", value: "4:12", tone: "red" },
  { id: "game:dal-phi", text: "DAL 3 – PHI 10", detail: "2nd quarter", value: "9:40", tone: "red" },
  { id: "game:sf-sea", text: "SF at SEA", detail: "4:25 PM", tone: "neutral" },
];

// Chosen from a space's menu, the item gives the extension that space: its sidebar section is for that space alone.
pistachio.contextMenus.onClicked("here", async ({ spaceId }) => {
  await pistachio.storage.local.set({ space: spaceId });
  await apply(await pistachio.triggers.get("sunday"));
});

// Chosen from a tab's own menu: the tab the item was chosen on.
pistachio.contextMenus.onClicked("follow", async ({ tabId, pageUrl, fromTab }) => {
  await pistachio.storage.local.set({ followed: { tabId, pageUrl, fromTab: fromTab === true } });
});

pistachio.triggers.on("sunday", apply);

// A press on a row, or on its button, in either place: the game it names is the one followed, and the rows say so.
const pressed = async (press) => {
  const { presses = [] } = await pistachio.storage.local.get("presses");
  await pistachio.storage.local.set({ presses: [...presses, press], following: press.row });
  await show();
};
pistachio.ui.band.onPress(pressed);
pistachio.ui.sidebar.onPress(pressed);

async function apply({ holds }) {
  const { space, heard = [] } = await pistachio.storage.local.get(["space", "heard"]);
  await pistachio.storage.local.set({ heard: [...heard, holds] });
  if (holds) return show();
  await pistachio.ui.band.clear();
  if (space) await pistachio.ui.sidebar.clear({ spaceId: space });
}

async function show() {
  const { space, following = null } = await pistachio.storage.local.get(["space", "following"]);
  // The strip, for every space: the two games on now.
  await pistachio.ui.band.set({
    rows: GAMES.slice(0, 2).map((game) => ({ id: game.id, mark: { tone: game.tone }, text: game.text, value: game.value, ...(game.id === following ? { detail: "Following" } : {}) })),
  });
  if (!space) return;
  // The section, for the space it was given: every game, each with a button.
  await pistachio.ui.sidebar.set({
    spaceId: space,
    title: "Today’s games",
    rows: GAMES.map((game) => ({
      id: game.id,
      mark: { tone: game.tone },
      text: game.text,
      detail: game.id === following ? "Following" : game.detail,
      value: game.value,
      buttons: [{ id: "open", title: "Open" }],
    })),
  });
}
