"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Button,
  type ControlChannel,
  createChannel,
  deleteChannel,
  Empty,
  Field,
  Intro,
  listChannels,
  Note,
  Page,
  Section,
  Table,
  useSession,
  When,
} from "@pistachio/web-account";

const idOf = (channel: ControlChannel): string => channel.linkId ?? channel.id ?? "";

export default function ChannelsPage(): ReactNode {
  const { token, spaces } = useSession();
  const [channels, setChannels] = useState<ControlChannel[]>([]);
  const [name, setName] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cloudSpaces = spaces.filter((space) => space.cloudEnabled);

  const refresh = useCallback(async (): Promise<void> => {
    if (token === null) return;
    try {
      setChannels((await listChannels(token)).channels);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read your channels.");
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (spaceId === "" && cloudSpaces[0] !== undefined) setSpaceId(cloudSpaces[0].id);
  }, [cloudSpaces, spaceId]);

  const create = (event: FormEvent): void => {
    event.preventDefault();
    if (token === null || name.trim() === "" || spaceId === "") return;
    setBusy(true);
    setError(null);
    void createChannel(token, { name: name.trim(), spaceId })
      .then(async (created) => {
        setSecret(created.secret);
        setName("");
        await refresh();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "That channel could not be created.");
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Page>
      <Intro
        title="Channels"
        lede="A webhook that can start a run without you being here. Anything that can POST — a shortcut, a script, a bot — can hand your agent a task."
      />

      {error === null ? null : <Note tone="alert">{error}</Note>}

      {secret === null ? null : (
        <Section heading="Your new channel's secret">
          <Note tone="alert">This is shown once and is not stored anywhere you can read it again. Copy it now.</Note>
          <p className="pa-mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
            {secret}
          </p>
          <div>
            <Button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(secret);
              }}
            >
              Copy
            </Button>
          </div>
        </Section>
      )}

      {cloudSpaces.length === 0 ? (
        <Empty title="No Space can run yet">
          <p>A channel starts a cloud run, so turn on the cloud browser from the Agent page first.</p>
        </Empty>
      ) : (
        <Section heading="New channel">
          <form onSubmit={create} className="pa-section">
            <Field
              label="What is it for?"
              help="A name you will recognise later, like “iOS shortcut” or “home server”."
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
            {cloudSpaces.length === 1 ? null : (
              <div className="pa-field">
                <label htmlFor="channel-space">Space it runs in</label>
                <select
                  id="channel-space"
                  className="pa-input"
                  value={spaceId}
                  onChange={(event) => setSpaceId(event.target.value)}
                >
                  {cloudSpaces.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <Button type="submit" variant="primary" disabled={busy || name.trim() === ""}>
                {busy ? "Creating…" : "Create channel"}
              </Button>
            </div>
          </form>
        </Section>
      )}

      {channels.length === 0 ? null : (
        <Section heading="Channels">
          <Table
            caption={`${String(channels.length)} channel${channels.length === 1 ? "" : "s"} that can start a run.`}
            head={
              <>
                <th scope="col">Name</th>
                <th scope="col">Space</th>
                <th scope="col" className="pa-n">Created</th>
                <th scope="col" />
              </>
            }
          >
            {channels.map((channel) => (
              <tr key={idOf(channel)}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  {channel.name}
                </th>
                <td className="pa-caption">
                  {spaces.find((space) => space.id === channel.spaceId)?.name ?? channel.spaceId}
                </td>
                <td className="pa-n">
                  <When iso={channel.createdAt} relative />
                </td>
                <td>
                  <Button
                    type="button"
                    variant="alert"
                    onClick={() => {
                      if (token === null || !confirm(`Delete ${channel.name}? Anything using it stops working.`)) return;
                      void deleteChannel(token, idOf(channel)).then(refresh);
                    }}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        </Section>
      )}
    </Page>
  );
}
