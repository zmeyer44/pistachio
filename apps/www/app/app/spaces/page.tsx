"use client";

import { useState, type ReactNode } from "react";
import { Button, Empty, Intro, Note, Page, Section, Status, Table, useSession } from "@pistachio/web-account";

export default function SpacesPage(): ReactNode {
  const { workspace, keys, spaces, hubState, relock, remembered } = useSession();
  const [relocking, setRelocking] = useState(false);
  const [relockError, setRelockError] = useState<string | null>(null);
  const unopened = keys?.unopened ?? [];
  const visibleSpaces = spaces.map((space) => {
    const synced = workspace.spaces.find((candidate) => candidate.id === space.id);
    return {
      ...space,
      purpose: synced?.purpose ?? "",
      egressPolicy: synced?.egressPolicy ?? "cloud",
      cloudEnabled: space.cloudEnabled,
    };
  });

  // Keys kept on this browser were derived once and never again, so a wrapper
  // re-wrapped on a Mac since then cannot reach them. Set the in-memory copy
  // aside, while preserving the reader's preference, and unlock to pick up
  // the repair.
  const retry = (): void => {
    setRelocking(true);
    setRelockError(null);
    void relock({ preserveRemembered: true }).catch((cause: unknown) => {
      setRelockError(
        cause instanceof Error
          ? `This browser could not return to Unlock: ${cause.message}`
          : "This browser could not return to Unlock.",
      );
      setRelocking(false);
    });
  };

  return (
    <Page>
      <Intro
        title="Spaces"
        lede="Each Space is a separate browsing context with its own cookies. What syncs, what the cloud browser may drive, and how each one reaches the internet."
      />

      {relockError === null ? null : <Note tone="alert">{relockError}</Note>}

      {unopened.length === 0 ? null : (
        <div className="pa-section">
          <Note tone="alert">
            {unopened.length === 1 ? "One Space's key" : `${String(unopened.length)} Spaces' keys`} could not be opened
            with this password. That happens after a password reset: sign in on the Mac that holds them and change your
            password there to re-wrap them.
            {remembered
              ? " This browser is using keys it opened earlier, so once they have been re-wrapped, unlock again to pick them up."
              : ""}
          </Note>
          {!remembered ? null : (
            <div>
              <Button type="button" disabled={relocking} onClick={retry}>
                {relocking ? "Locking…" : "Unlock again"}
              </Button>
            </div>
          )}
        </div>
      )}

      {visibleSpaces.length === 0 ? (
        <Empty title={hubState === "connected" ? "No Spaces yet" : "Waiting for your devices"}>
          <p>Create an account Space to separate a set of browsing sessions and agent tasks.</p>
        </Empty>
      ) : (
        <Section heading="Your Spaces">
          <Table
            caption={`${String(visibleSpaces.length)} Space${visibleSpaces.length === 1 ? "" : "s"} on this account.`}
            head={
              <>
                <th scope="col">Space</th>
                <th scope="col">Cloud browser</th>
                <th scope="col">Leaves your machine as</th>
                <th scope="col">Keys here</th>
              </>
            }
          >
            {visibleSpaces.map((space) => (
              // The id, not only the name: a Space's name comes from whichever
              // device last sealed a record for it, while the id is what every
              // device agrees on — including the browser app, whose shell
              // labels the same Space its own way (§15).
              <tr key={space.id} data-space={space.id}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  {space.name}
                  {space.purpose === "" ? null : <span className="pa-caption"> · {space.purpose}</span>}
                </th>
                <td>
                  <Status tone={space.cloudEnabled ? "good" : undefined}>
                    {space.cloudEnabled ? "Can run" : "Off"}
                  </Status>
                </td>
                <td className="pa-caption">
                  {space.egressPolicy === "identity" ? "Your own IP, through the gateway" : "This machine's connection"}
                </td>
                <td className="pa-caption">{keys?.spaces.has(space.id) === true ? "Unlocked" : "Not opened"}</td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      <Note>
        You can turn on the cloud browser from the Agent page. The Space key is wrapped in this browser before it is
        handed to the hosted agent; Pistachio&apos;s control service never sees the plaintext key.
      </Note>
    </Page>
  );
}
