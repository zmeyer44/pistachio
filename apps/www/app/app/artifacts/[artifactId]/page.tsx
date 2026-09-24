"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Globe2, LockKeyhole } from "lucide-react";
import {
  Button,
  Empty,
  type HostedArtifact,
  isolatedArtifactDocument,
  listHostedArtifacts,
  Note,
  Page,
  publicArtifactPath,
  putArtifactRevision,
  setArtifactVisibility,
  useSession,
  When,
} from "@pistachio/web-account";

export default function ArtifactPage(): ReactNode {
  const { artifactId } = useParams<{ artifactId: string }>();
  const { workspace, hubState, token } = useSession();
  const artifact = workspace.artifacts.find((candidate) => candidate.id === artifactId) ?? null;
  const [hosting, setHosting] = useState<HostedArtifact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (token === null) return;
    let live = true;
    void listHostedArtifacts(token).then(({ artifacts }) => {
      if (live) setHosting(artifacts.find((entry) => entry.artifactId === artifactId) ?? null);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [artifactId, token]);

  // Heal a public snapshot if this browser sees a newer encrypted revision
  // than the publisher managed to upload while the producing device was
  // offline. A private artifact never enters this path.
  useEffect(() => {
    if (token === null || artifact === null || hosting?.visibility !== "public" || hosting.revision >= artifact.revision) return;
    let live = true;
    void putArtifactRevision(token, artifact.id, {
      revision: artifact.revision,
      html: artifact.html,
    }).then((result) => {
      if (live && result.artifact !== undefined) setHosting(result.artifact);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [artifact, hosting, token]);

  const document = useMemo(() => artifact === null ? "" : isolatedArtifactDocument(artifact), [artifact]);
  const sharePath = hosting?.visibility === "public" ? publicArtifactPath(hosting) : null;

  if (artifact === null) {
    return (
      <Page>
        <Link className="pa-artifact-back" href="/app/artifacts"><ArrowLeft size={14} /> Artifacts</Link>
        <Empty title={hubState === "connected" ? "Artifact not found" : "Loading the encrypted page"}>
          <p>{hubState === "connected" ? "It may have been removed on another device." : "This page will appear after workspace sync finishes."}</p>
        </Empty>
      </Page>
    );
  }

  const setVisibility = async (visibility: "private" | "public"): Promise<void> => {
    if (token === null) return;
    if (visibility === "public" && !window.confirm("Publish this artifact? Anyone with the link will be able to read its current HTML without signing in.")) return;
    setBusy(true);
    setError(null);
    try {
      const { artifact: next } = await setArtifactVisibility(token, artifact.id, {
        revision: artifact.revision,
        visibility,
        ...(visibility === "public" ? { html: artifact.html } : {}),
      });
      setHosting(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update sharing.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (sharePath === null) return;
    await navigator.clipboard.writeText(new URL(sharePath, window.location.origin).href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="pa-artifact-page">
      <header className="pa-artifact-toolbar">
        <div className="pa-artifact-identity">
          <Link className="pa-artifact-back" href="/app/artifacts"><ArrowLeft size={14} /> Artifacts</Link>
          <div>
            <h1>{artifact.title}</h1>
            <p>Revision {artifact.revision} · updated <When iso={artifact.updatedAt} relative /></p>
          </div>
        </div>
        <div className="pa-artifact-actions">
          {sharePath === null ? (
            <Button variant="primary" disabled={busy} onClick={() => { void setVisibility("public"); }}>
              <Globe2 size={14} /> Publish link
            </Button>
          ) : (
            <>
              <Button disabled={busy} onClick={() => { void copy(); }}>
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy link"}
              </Button>
              <a className="pa-btn" data-variant="default" href={sharePath} target="_blank" rel="noreferrer noopener">
                <ExternalLink size={14} /> Open public page
              </a>
              <Button variant="quiet" disabled={busy} onClick={() => { void setVisibility("private"); }}>
                <LockKeyhole size={14} /> Make private
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="pa-artifact-disclosure" data-public={sharePath !== null || undefined}>
        {sharePath === null ? <LockKeyhole size={15} /> : <Globe2 size={15} />}
        <div>
          <strong>{sharePath === null ? "Private and encrypted" : "Published to the web"}</strong>
          <span>{sharePath === null
            ? "Only signed-in devices that can unlock your workspace can render this page."
            : "Anyone with the link can read this plaintext snapshot. Making it private revokes the link immediately."}</span>
        </div>
      </div>
      {error === null ? null : <Note tone="alert">{error}</Note>}

      <div className="pa-artifact-stage">
        <iframe
          title={artifact.title}
          srcDoc={document}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}
