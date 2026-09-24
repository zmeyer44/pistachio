"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight, LockKeyhole, Search, Share2 } from "lucide-react";
import {
  Empty,
  type HostedArtifact,
  Intro,
  listHostedArtifacts,
  Page,
  Section,
  useSession,
  When,
} from "@pistachio/web-account";

export default function ArtifactsPage(): ReactNode {
  const { workspace, hubState, token } = useSession();
  const [query, setQuery] = useState("");
  const [hosting, setHosting] = useState<Map<string, HostedArtifact>>(new Map());

  useEffect(() => {
    if (token === null) return;
    let live = true;
    void listHostedArtifacts(token).then(({ artifacts }) => {
      if (live) setHosting(new Map(artifacts.map((artifact) => [artifact.artifactId, artifact])));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [token]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ""
      ? workspace.artifacts
      : workspace.artifacts.filter((artifact) => `${artifact.title} ${artifact.brief}`.toLowerCase().includes(needle));
  }, [query, workspace.artifacts]);

  return (
    <Page>
      <Intro
        title="Artifacts"
        lede="Interactive pages your agent has built. They stay private and end-to-end encrypted until you deliberately publish a share link."
      />

      {workspace.artifacts.length === 0 ? (
        <Empty title={hubState === "connected" ? "No pages yet" : "Waiting for your devices"}>
          <p>Ask the agent to build a dashboard, report, itinerary, or any other interactive page.</p>
        </Empty>
      ) : (
        <Section
          heading={`${String(workspace.artifacts.length)} page${workspace.artifacts.length === 1 ? "" : "s"}`}
          action={
            <label className="pa-artifact-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                placeholder="Filter pages"
                aria-label="Filter artifacts"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          }
        >
          {shown.length === 0 ? <p className="pa-caption">Nothing matches “{query}”.</p> : (
            <div className="pa-artifact-grid">
              {shown.map((artifact) => {
                const published = hosting.get(artifact.id)?.visibility === "public";
                return (
                  <Link className="pa-artifact-card" href={`/app/artifacts/${artifact.id}`} key={artifact.id}>
                    <span className="pa-artifact-card-top">
                      <span className="pa-artifact-glyph" aria-hidden="true">{artifact.title.slice(0, 1).toUpperCase()}</span>
                      <span className="pa-artifact-privacy" data-public={published || undefined}>
                        {published ? <Share2 size={12} /> : <LockKeyhole size={12} />}
                        {published ? "Public" : "Private"}
                      </span>
                    </span>
                    <span className="pa-artifact-card-copy">
                      <strong>{artifact.title}</strong>
                      <span>{artifact.brief || "Interactive HTML page"}</span>
                    </span>
                    <span className="pa-artifact-card-foot">
                      <span>Revision {artifact.revision} · <When iso={artifact.updatedAt} relative /></span>
                      <ArrowUpRight size={15} aria-hidden="true" />
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </Section>
      )}
    </Page>
  );
}
