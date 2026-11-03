// The panel: the current space's tabs, each with a Show button.
// Needs "tabs:read" (query, spaces, the events) and "tabs:write" (show).

const list = document.getElementById("tabs");
const empty = document.getElementById("empty");
const heading = document.getElementById("space");

async function render() {
  const space = await pistachio.spaces.current();
  const spaceId = space ? space.id : null;
  const tabs = (await pistachio.tabs.query()).filter((tab) => tab.spaceId === spaceId);
  heading.textContent = space ? space.name : "Home";
  list.replaceChildren(
    ...tabs.map((tab) => {
      const row = document.createElement("li");
      if (tab.active) row.className = "active";
      // The page's CSP loads images only from the folder, data: and blob: — never a remote favicon.
      if (tab.favIconUrl && tab.favIconUrl.startsWith("data:")) {
        const icon = document.createElement("img");
        icon.src = tab.favIconUrl;
        icon.alt = "";
        row.append(icon);
      }
      const title = document.createElement("span");
      title.textContent = tab.title || tab.url;
      title.title = tab.url;
      const show = document.createElement("button");
      show.textContent = "Show";
      show.addEventListener("click", () => pistachio.tabs.show(tab.id));
      row.append(title, show);
      return row;
    }),
  );
  empty.hidden = tabs.length > 0;
}

// Tabs change often: one render per burst of events.
let pending = null;
function soon() {
  clearTimeout(pending);
  pending = setTimeout(() => render().catch((error) => pistachio.runtime.log("error", error.message)), 50);
}

pistachio.tabs.onCreated(soon);
pistachio.tabs.onUpdated(soon);
pistachio.tabs.onRemoved(soon);
pistachio.tabs.onActivated(soon);
pistachio.spaces.onCurrentChanged(soon);
soon();
