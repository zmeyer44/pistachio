"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Empty, Intro, Page, Section, Table, useSession, When } from "@pistachio/web-account";

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function BookmarksPage(): ReactNode {
  const { workspace, hubState } = useSession();
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return workspace.bookmarks;
    return workspace.bookmarks.filter((bookmark) =>
      [bookmark.title, bookmark.url, bookmark.note, bookmark.siteName, ...bookmark.keywords]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [workspace.bookmarks, query]);

  return (
    <Page>
      <Intro
        title="Bookmarks"
        lede="Everything you have kept, from every Mac signed in to this account. Saved and read end to end encrypted; the server stores only ciphertext."
      />

      {workspace.bookmarks.length === 0 ? (
        <Empty title={hubState === "connected" ? "Nothing saved yet" : "Waiting for your devices"}>
          <p>
            {hubState === "connected"
              ? "Bookmarks you keep in Pistachio on any Mac appear here."
              : "Connecting to your account's sync. If this does not settle, check that a Mac has signed in at least once."}
          </p>
        </Empty>
      ) : (
        <Section
          heading={`${String(workspace.bookmarks.length)} saved`}
          action={
            <input
              className="pa-input"
              style={{ width: 220 }}
              type="search"
              placeholder="Filter"
              aria-label="Filter bookmarks"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          }
        >
          {shown.length === 0 ? (
            <p className="pa-caption">Nothing matches “{query}”.</p>
          ) : (
            <Table
              caption={`${String(shown.length)} bookmark${shown.length === 1 ? "" : "s"}, most recently saved first.`}
              head={
                <>
                  <th scope="col">Page</th>
                  <th scope="col">Site</th>
                  <th scope="col">Note</th>
                  <th scope="col" className="pa-n">Saved</th>
                </>
              }
            >
              {shown.map((bookmark) => (
                <tr key={bookmark.id}>
                  <th scope="row" style={{ fontWeight: 400 }}>
                    <a href={bookmark.url} target="_blank" rel="noreferrer noopener">
                      {bookmark.title === "" ? host(bookmark.url) : bookmark.title}
                    </a>
                  </th>
                  <td className="pa-caption">{bookmark.siteName === "" ? host(bookmark.url) : bookmark.siteName}</td>
                  <td className="pa-caption">{bookmark.note}</td>
                  <td className="pa-n">
                    <When iso={bookmark.createdAt} relative />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      )}
    </Page>
  );
}
