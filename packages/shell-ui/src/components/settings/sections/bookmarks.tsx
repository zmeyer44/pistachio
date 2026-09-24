/**
 * Settings → Bookmarks: the switches around saving. What is saved lives on
 * its own page (pistachio://bookmarks), which this one points at.
 */

import { Bookmark } from "lucide-react";
import { copyFor } from "../../../lib/surface-copy";
import { useAppStore } from "../../../store";
import { useSurface } from "../../../surface";
import { Button } from "../../ui/button";
import { Kbd } from "../../ui/kbd";
import { Switch } from "../../ui/switch";
import { Fixed, Group, Page, Row } from "../parts";

export function BookmarksSettingsPage() {
  const bookmarks = useAppStore((state) => state.settings.bookmarks);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const openBookmarks = useAppStore((state) => state.openBookmarks);
  const saved = useAppStore((state) => state.bookmarks.bookmarks.length);
  const copy = copyFor(useSurface().kind).bookmarks;
  return (
    <Page
      title="Bookmarks"
      description="A bookmark is the thing a page is about — the product, the book, the recipe, the article — not the page. Pistachio reads the page for it, and the agent can search and save them for you."
    >
      <Group
        title="Saving"
        note="Tap shift twice on any web page to save it. The card that appears lets you fix any field before it goes."
        footer={`${String(saved)} ${saved === 1 ? "bookmark" : "bookmarks"} saved.`}
        footerAction={
          <Button variant="secondary" size="sm" prefix={<Bookmark aria-hidden="true" />} onClick={() => openBookmarks()}>
            Open bookmarks
          </Button>
        }
      >
        <Row
          label={
            <span className="inline-flex items-center gap-1.5">
              Save with <Kbd>⇧</Kbd> <Kbd>⇧</Kbd>
            </span>
          }
          note="A double tap of shift, with nothing else held. Off leaves the toolbar button, the command palette, and the agent as the ways to save."
        >
          <Switch checked={bookmarks.doubleShift} onChange={(doubleShift) => void updateSettings({ bookmarks: { doubleShift } })} label="Save with a double tap of shift" />
        </Row>
        <Row
          label="Ask the model what the page is about"
          note={copy.enrich}
        >
          <Switch checked={bookmarks.enrichWithModel} onChange={(enrichWithModel) => void updateSettings({ bookmarks: { enrichWithModel } })} label="Enrich bookmarks with the model" />
        </Row>
      </Group>
      <Group title="What a bookmark keeps">
        <Fixed label="The thing" note="Its kind — product, book, movie, recipe, article, place, software — with a title in its own name, a description, and a picture." />
        <Fixed label="Its facts" note="What the page stated: a price and brand, an author and year, a director and runtime, a cook time and servings." />
        <Fixed label="Your words" note="Keywords you would search by, and a note to yourself. Anything you edit is kept when the page is read again." />
        <Fixed label="The address" note="Cleaned of tracking parameters, so the same listing saves once however you reached it." badge="Always" />
      </Group>
    </Page>
  );
}
